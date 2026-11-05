import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";

/**
 * Unknown request keys are refused, not dropped (`API_UNKNOWN_PARAMS=reject`, the default).
 *
 * zod strips an undeclared key silently, so a typo'd or unsupported param used to be
 * accepted and ignored. `parseRequest` runs the route's own schema unchanged, then walks
 * that schema beside the RAW input and names every key the schema does not declare —
 * nested objects and array items included. Free-form values (`z.record`, a `.catchall`
 * of anything: metadata, custom_fields, credentials…) are not walked into.
 *
 * `API_UNKNOWN_PARAMS=warn` is the kill switch: log the route and keys, then carry on
 * with zod's stripped result exactly as before.
 */

const log = createLogger("api");

/** `.catchall(cfKeys)`: the object accepts `cf_<name>` custom-field keys and nothing else extra. */
export const cfKeys = z.unknown();

/**
 * A key a live caller sends that the route does not act on. Declared so strict mode
 * leaves the caller working; the value is never read. Every use needs a comment naming
 * the caller.
 */
export const acceptedAndIgnored = () => z.unknown().optional();

const lenient = new WeakSet<z.ZodType>();
/**
 * A stored JSON object the dashboard reads, edits and PATCHes back whole. Keys inside it
 * are not checked: a key an older release stored must not make every later save fail.
 */
export function roundTripped<T extends z.ZodType>(schema: T): T {
  lenient.add(schema);
  return schema;
}

const routeStore = new AsyncLocalStorage<{ route: string }>();

/** onRequest hook: remembers the route pattern for the warn-mode log line. */
export function strictParamsRouteHook(req: FastifyRequest, _reply: unknown, done: () => void) {
  routeStore.enterWith({ route: `${req.method} ${req.routeOptions?.url ?? req.url}` });
  done();
}

type Def = {
  type: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
  getter?: () => z.ZodType;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  element?: z.ZodType;
  items?: z.ZodType[];
  rest?: z.ZodType | null;
  options?: z.ZodType[];
  left?: z.ZodType;
  right?: z.ZodType;
  valueType?: z.ZodType;
};

const defOf = (s: z.ZodType) => (s as unknown as { _zod: { def: Def } })._zod.def;
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const join = (path: string, key: string | number) =>
  typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key;

/** Paths of keys in `value` that `schema` does not declare. */
export function unknownParams(schema: z.ZodType, value: unknown, path = ""): string[] {
  if (value === undefined || value === null || lenient.has(schema)) return [];
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
    case "success":
      return unknownParams(def.innerType!, value, path);
    case "lazy":
      return unknownParams(def.getter!(), value, path);
    case "pipe":
      // A preprocess (transform → schema) is checked against its target shape.
      return unknownParams(defOf(def.in!).type === "transform" ? def.out! : def.in!, value, path);
    case "array":
      return Array.isArray(value)
        ? value.flatMap((v, i) => unknownParams(def.element!, v, join(path, i)))
        : [];
    case "tuple":
      return Array.isArray(value)
        ? value.flatMap((v, i) => {
            const item = def.items![i] ?? def.rest;
            return item ? unknownParams(item, v, join(path, i)) : [];
          })
        : [];
    case "record":
      return isPlainObject(value)
        ? Object.entries(value).flatMap(([k, v]) => unknownParams(def.valueType!, v, join(path, k)))
        : [];
    case "union": {
      // The branch zod itself picks: the first that accepts the value.
      const branch = def.options!.find((o) => o.safeParse(value).success);
      return branch ? unknownParams(branch, value, path) : [];
    }
    case "intersection": {
      const right = new Set(unknownParams(def.right!, value, path));
      return unknownParams(def.left!, value, path).filter((p) => right.has(p));
    }
    case "object": {
      if (!isPlainObject(value)) return [];
      const shape = def.shape!;
      const catchall = def.catchall;
      // `never` is `.strict()`: zod reports those keys itself.
      const extraAllowed = (k: string) =>
        catchall === undefined
          ? false
          : catchall === cfKeys
            ? k.startsWith("cf_")
            : defOf(catchall).type !== "never";
      const out: string[] = [];
      for (const [k, v] of Object.entries(value)) {
        if (Object.hasOwn(shape, k)) out.push(...unknownParams(shape[k]!, v, join(path, k)));
        else if (!extraAllowed(k)) out.push(join(path, k));
      }
      return out;
    }
    default:
      return [];
  }
}

export const UNKNOWN_PARAMETER = "unknown_parameter";

/**
 * `schema.safeParse(input)`, refusing keys the schema does not declare. The refusal is a
 * ZodError whose issues carry `params.reason = "unknown_parameter"`; `badRequest` turns
 * it into `Unknown parameter: <path>`.
 */
export function parseRequest<S extends z.ZodType>(
  schema: S,
  input: unknown,
): z.ZodSafeParseResult<z.output<S>> {
  const result = schema.safeParse(input);
  const unknown = unknownParams(schema, input);
  if (unknown.length === 0) return result;
  if (config.API_UNKNOWN_PARAMS === "warn") {
    log.warn("request carried unknown parameters", {
      event: "request_unknown_parameters",
      route: routeStore.getStore()?.route ?? "(unknown)",
      params: unknown,
    });
    return result;
  }
  const error = new z.ZodError(
    unknown.map((p) => ({
      code: "custom" as const,
      path: p.split(/\.|\[(\d+)\]/).filter(Boolean),
      message: `Unknown parameter: ${p}`,
      params: { reason: UNKNOWN_PARAMETER, param: p },
      input: undefined,
    })),
  ) as z.ZodError<z.output<S>>;
  return { success: false, error } as z.ZodSafeParseResult<z.output<S>>;
}

/** The unknown-key paths in a failed parse (ours, or a `.strict()` schema's), else []. */
export function unknownParamsIn(err: z.ZodError): string[] {
  const out: string[] = [];
  for (const iss of err.issues) {
    const params = (iss as { params?: { reason?: string; param?: string } }).params;
    if (iss.code === "custom" && params?.reason === UNKNOWN_PARAMETER && params.param)
      out.push(params.param);
    else if (iss.code === "unrecognized_keys") {
      const base = iss.path
        .map((k) => (typeof k === "number" ? `[${k}]` : `.${String(k)}`))
        .join("")
        .replace(/^\./, "");
      for (const k of iss.keys) out.push(base ? `${base}.${k}` : k);
    }
  }
  return out;
}
