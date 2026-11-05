/**
 * Emit `sdk/schema.d.ts` from the OpenAPI document — in plain string generation, with no
 * dependency on the TypeScript compiler API.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────────
 * This replaced `openapi-typescript`, which cannot run here any more. 7.13.0 is its latest
 * release, it peer-depends on `typescript@^5.x`, and it calls `ts.factory` at module load.
 * TypeScript 7 is the native port: `require("typescript")` exports exactly two things,
 * `version` and `versionMajorMinor`. There is no factory to shim and no newer release to
 * upgrade to, so any generator built on the TS compiler API is a dead end on this repo's
 * compiler. Generating text needs no compiler at all, which is why this cannot break again
 * on a TypeScript upgrade.
 *
 * ── Scope: the whole document ─────────────────────────────────────────────────────
 * `paths` AND `components`. An earlier cut emitted `components` alone, reasoning that
 * `sdk/index.ts:30` is this repo's only importer and takes nothing else. That reasoning was
 * scoped to the wrong repo: `sdk/**` is on the OSS publish allowlist
 * (`scripts/oss-manifest.json`), so this file ships to people who do not have our code. They
 * are exactly the consumers who need `paths` — it is what types a request by URL and method
 * in a generated client. "Nothing here imports it" is not "nothing imports it".
 *
 * Equivalence with the old output is proven by the compiler, not by eye — see
 * `test/unit/sdk-schema-emitter.test.ts`.
 */

type Schema = Record<string, unknown>;

const RESERVED = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A property key, quoted only when it is not a plain identifier. */
function key(name: string): string {
  return RESERVED.test(name) ? name : JSON.stringify(name);
}

function refName(ref: string): string {
  const name = ref.split("/").pop();
  if (!name) throw new Error(`unparseable $ref: ${ref}`);
  return `components["schemas"][${JSON.stringify(name)}]`;
}

const lit = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));

/**
 * JSDoc above a property, matching the shape the previous generator emitted: one line when
 * there is a single tag, a block when there is more than one. Kept because these are the
 * only descriptions an SDK consumer ever sees in editor hover.
 */
function docComment(s: Schema, indent: string): string {
  const tags: string[] = [];
  if (typeof s["format"] === "string") tags.push(`Format: ${s["format"]}`);
  if (typeof s["description"] === "string") tags.push(...describe(s["description"]));
  if (s["default"] !== undefined) tags.push(`@default ${String(s["default"])}`);
  if (Array.isArray(s["enum"]) && typeof s["type"] === "string") tags.push(`@enum {${s["type"]}}`);
  if (s["example"] !== undefined && typeof s["example"] !== "object")
    tags.push(`@example ${String(s["example"])}`);

  if (tags.length === 0) return "";
  if (tags.length === 1 && !tags[0]!.includes("\n")) return `${indent}/** ${tags[0]} */\n`;
  const body = tags
    .join("\n")
    .split("\n")
    .map((l) => (l ? `${indent} * ${l}` : `${indent} *`))
    .join("\n");
  return `${indent}/**\n${body}\n${indent} */\n`;
}

/**
 * A description as JSDoc lines. Paragraph breaks SURVIVE — a blank comment line, then the
 * next paragraph indented four spaces — because several descriptions in the document are
 * three or four paragraphs of contract and collapsing them to one line is how a reader stops
 * reading them. Single newlines inside a paragraph are joined, since the document builds
 * those by string concatenation.
 */
function describe(text: string): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
  if (paras.length === 0) return [];
  const [first, ...rest] = paras;
  return [`@description ${first}` + rest.map((p) => `\n\n    ${p}`).join("")];
}

/**
 * One schema as a TypeScript type.
 *
 * ⚠️ A sibling key next to `$ref` is DROPPED, which is what the previous generator did and
 * is what the JSON Schema draft the document targets requires. It matters: several places
 * in the spec write `{ $ref, nullable: true }` expecting an optional-null type and have
 * never produced one. `allOf: [{ $ref }]` with a sibling `nullable` is a different shape and
 * DOES nullify, because there the sibling sits next to `allOf`, not next to `$ref`.
 */
type Opts = { inRequestBody?: boolean };

function typeOf(s: Schema, indent: string, opts: Opts = {}): string {
  if (typeof s["$ref"] === "string") return refName(s["$ref"]);

  const nullable = s["nullable"] === true;
  const nullify = (t: string) => (nullable ? `${t} | null` : t);

  if (Array.isArray(s["allOf"])) {
    const parts = (s["allOf"] as Schema[]).map((m) => typeOf(m, indent, opts));
    return nullify(parts.length === 1 ? parts[0]! : parts.join(" & "));
  }
  // `oneOf`/`anyOf` are both a union here: TypeScript cannot express "exactly one of",
  // and the document uses oneOf for genuinely disjoint request bodies (a currency set to
  // `manual` carries a rate; set to `auto` it carries nothing).
  for (const kw of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(s[kw])) {
      const parts = (s[kw] as Schema[]).map((m) => typeOf(m, indent, opts));
      return nullify(parts.length === 1 ? parts[0]! : parts.join(" | "));
    }
  }
  if (Array.isArray(s["enum"])) {
    return nullify((s["enum"] as unknown[]).map(lit).join(" | "));
  }

  switch (s["type"]) {
    case "array": {
      const items = (s["items"] as Schema | undefined) ?? {};
      const inner = typeOf(items, indent, opts);
      // Parenthesise unions and intersections so `A | B[]` cannot be read for `(A | B)[]`.
      return nullify(/[|&]/.test(inner) ? `(${inner})[]` : `${inner}[]`);
    }
    case "integer":
    case "number":
      return nullify("number");
    case "boolean":
      return nullify("boolean");
    case "string":
      return nullify("string");
    case "object":
    default: {
      const props = s["properties"] as Record<string, Schema> | undefined;
      const add = s["additionalProperties"];
      const inner = `${indent}    `;

      // `additionalProperties: true` means "any other key, any value"; an object schema
      // means "any other key, of THIS type". Both become an index signature, and when the
      // schema also names properties the two are INTERSECTED rather than merged — an index
      // signature in the same literal would have to subsume every named property's type.
      const index =
        add === true
          ? `{\n${inner}[key: string]: unknown;\n${indent}}`
          : add && typeof add === "object"
            ? `{\n${inner}[key: string]: ${typeOf(add as Schema, inner, opts)};\n${indent}}`
            : null;

      if (!props || Object.keys(props).length === 0) {
        // An object with neither properties nor a value schema carries no information.
        return nullify(index ?? "Record<string, never>");
      }

      const required = new Set((s["required"] as string[] | undefined) ?? []);
      const body = Object.entries(props)
        .map(([name, ps]) => {
          // A property with a `default` is never absent from a RESPONSE, so it is emitted
          // non-optional even when `required` omits it. Inside a request body the opposite
          // holds: the default is the server's job precisely because the caller may omit it.
          const defaulted = ps["default"] !== undefined && !opts.inRequestBody;
          const opt = required.has(name) || defaulted ? "" : "?";
          // `readOnly` is a modifier on the property, not a change to its type.
          const ro = ps["readOnly"] === true ? "readonly " : "";
          return `${docComment(ps, inner)}${inner}${ro}${key(name)}${opt}: ${typeOf(ps, inner, opts)};`;
        })
        .join("\n");
      const shape = `{\n${body}\n${indent}}`;
      return nullify(index ? `${shape} & ${index}` : shape);
    }
  }
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const PARAM_GROUPS = [
  ["query", "query"],
  ["header", "header"],
  ["path", "path"],
  ["cookie", "cookie"],
] as const;

/** A summary/description pair above an operation, the way the previous generator wrote it. */
function opComment(op: Schema, indent: string): string {
  const summary = typeof op["summary"] === "string" ? op["summary"] : "";
  const desc =
    typeof op["description"] === "string" ? op["description"].replace(/\s*\n\s*/g, " ").trim() : "";
  if (!summary && !desc) return "";
  if (summary && !desc) return `${indent}/** ${summary} */\n`;
  const lines = [summary && `${indent} * ${summary}`, desc && `${indent} * @description ${desc}`]
    .filter(Boolean)
    .join("\n");
  return `${indent}/**\n${lines}\n${indent} */\n`;
}

/**
 * One `query` / `header` / `path` / `cookie` group.
 *
 * The group is OPTIONAL exactly when nothing in it is required — `header?: {…}` for a lone
 * optional `Idempotency-Key`, but `query: {…}` when a list endpoint demands its filters.
 */
function paramGroup(name: string, params: Schema[], indent: string): string {
  // Last declaration wins for a repeated name. The document SHOULD not repeat one —
  // OpenAPI forbids duplicate (name, in) pairs — but three list routes declare both a
  // plain `?customer=` and a `?customer[op]=` filter under the same name. Emitting both
  // would produce a duplicate key in a type literal, so the narrower later one stands.
  const mine = [
    ...new Map(params.filter((p) => p["in"] === name).map((p) => [p["name"], p])).values(),
  ];
  if (mine.length === 0) return `${indent}${name}?: never;`;
  const inner = `${indent}    `;
  const body = mine
    .map((p) => {
      const schema = (p["schema"] as Schema | undefined) ?? {};
      // The parameter's own description documents it; the schema's would describe the value.
      const doc = docComment(
        { ...schema, description: p["description"] ?? schema["description"] },
        inner,
      );
      const opt = p["required"] === true ? "" : "?";
      return `${doc}${inner}${key(String(p["name"]))}${opt}: ${typeOf(schema, inner)};`;
    })
    .join("\n");
  const groupOpt = mine.some((p) => p["required"] === true) ? "" : "?";
  return `${indent}${name}${groupOpt}: {\n${body}\n${indent}};`;
}

function contentBlock(content: Schema | undefined, indent: string, opts: Opts = {}): string | null {
  if (!content || typeof content !== "object") return null;
  const entries = Object.entries(content);
  if (entries.length === 0) return null;
  const inner = `${indent}    `;
  const body = entries
    .map(([mime, media]) => {
      const schema = ((media as Schema)["schema"] as Schema | undefined) ?? {};
      return `${inner}${JSON.stringify(mime)}: ${typeOf(schema, inner, opts)};`;
    })
    .join("\n");
  return `{\n${body}\n${indent}}`;
}

function operation(op: Schema, indent: string): string {
  const inner = `${indent}    `;
  const deeper = `${inner}    `;
  const params = (op["parameters"] as Schema[] | undefined) ?? [];

  const paramBlock = PARAM_GROUPS.map(([g]) => paramGroup(g, params, deeper)).join("\n");

  const body = op["requestBody"] as Schema | undefined;
  const bodyContent = body
    ? contentBlock(body["content"] as Schema, `${inner}    `, { inRequestBody: true })
    : null;
  const bodyLine = bodyContent
    ? `${inner}requestBody${body?.["required"] === true ? "" : "?"}: {\n${deeper}content: ${bodyContent};\n${inner}};`
    : `${inner}requestBody?: never;`;

  const responses = (op["responses"] as Record<string, Schema> | undefined) ?? {};
  const respBody = Object.entries(responses)
    .map(([code, r]) => {
      const c = contentBlock(r["content"] as Schema, `${deeper}    `);
      const doc = docComment({ description: r["description"] }, deeper);
      return (
        `${doc}${deeper}${/^\d+$/.test(code) ? code : JSON.stringify(code)}: {\n` +
        `${deeper}    headers: {\n${deeper}        [name: string]: unknown;\n${deeper}    };\n` +
        `${deeper}    ${c ? `content: ${c};` : "content?: never;"}\n` +
        `${deeper}};`
      );
    })
    .join("\n");

  return (
    `{\n${inner}parameters: {\n${paramBlock}\n${inner}};\n` +
    `${bodyLine}\n` +
    `${inner}responses: {\n${respBody}\n${inner}};\n${indent}}`
  );
}

function emitPaths(paths: Record<string, Schema>): string {
  return Object.entries(paths)
    .map(([route, item]) => {
      const shared = (item["parameters"] as Schema[] | undefined) ?? [];
      const sharedBlock = PARAM_GROUPS.map(([g]) => paramGroup(g, shared, "            ")).join(
        "\n",
      );
      const methods = METHODS.map((m) => {
        const op = item[m] as Schema | undefined;
        if (!op) return `        ${m}?: never;`;
        return `${opComment(op, "        ")}        ${m}: ${operation(op, "        ")};`;
      }).join("\n");
      return (
        `    ${JSON.stringify(route)}: {\n` +
        `        parameters: {\n${sharedBlock}\n        };\n` +
        `${methods}\n    };`
      );
    })
    .join("\n");
}

export function emitSchemaDts(doc: {
  paths?: Record<string, Schema>;
  components?: { schemas?: Record<string, Schema> };
}): string {
  const schemas = doc.components?.schemas ?? {};
  const body = Object.entries(schemas)
    .map(
      ([name, s]) => `${docComment(s, "        ")}        ${key(name)}: ${typeOf(s, "        ")};`,
    )
    .join("\n");

  return `/**
 * GENERATED by \`pnpm sdk:generate\` from sdk/openapi.json — do not edit by hand.
 *
 * Emitted by scripts/lib/emit-schema-dts.ts, which needs no TypeScript compiler.
 */

export interface paths {
${emitPaths(doc.paths ?? {})}
}

export type webhooks = Record<string, never>;

export interface components {
    schemas: {
${body}
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}

export type $defs = Record<string, never>;
export type operations = Record<string, never>;
`;
}
