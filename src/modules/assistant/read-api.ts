/**
 * `read_api` as the in-app model gets it: the same guarded catalogue read, with the shapes models
 * write mended first (a full `/v1/businesses/<id>/…` path, a `?query` in the path, filters
 * nested under `filters`) and an unknown path answered with the real paths near it.
 * MCP keeps the catalogue's tool unchanged.
 */
import { z } from "zod";
import { ToolError, type ToolDef } from "@/modules/assistant-tools/catalog";
import type { QueryValue } from "@/modules/assistant-tools/route-call";
import { openapiDocument } from "@/api/openapi";

const PREFIX = "/v1/businesses/{biz}/";

/** Every GET path of a business, relative, with {placeholders}. */
let readable: string[] | null = null;
function readablePaths(): string[] {
  readable ??= Object.entries(
    (openapiDocument as unknown as { paths: Record<string, Record<string, unknown>> }).paths,
  )
    .filter(([p, ops]) => ops.get && p.startsWith(PREFIX))
    .map(([p]) => p.slice(PREFIX.length));
  return readable;
}

const matches = (template: string, path: string) => {
  const t = template.split("/");
  const p = path.split("/");
  return t.length === p.length && t.every((s, i) => s.startsWith("{") || s === p[i]);
};

/** The path relative to the business, and any query the model put in it. */
export function normalizeReadArgs(args: Record<string, unknown>): {
  path: string;
  query: Record<string, QueryValue> | undefined;
} {
  let path = String(args.path ?? "").trim();
  const query: Record<string, QueryValue> = {};
  const q = path.indexOf("?");
  if (q >= 0) {
    for (const [k, v] of new URLSearchParams(path.slice(q + 1))) query[k] = v;
    path = path.slice(0, q);
  }
  path = path
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^\/*(v1\/)?businesses\/[^/]+\/?/, "")
    .replace(/^\/+|\/+$/g, "");
  for (const [k, v] of Object.entries((args.query as Record<string, unknown>) ?? {})) {
    if (k === "filters" && v && typeof v === "object") {
      for (const [fk, fv] of Object.entries(v as Record<string, unknown>))
        if (["string", "number", "boolean"].includes(typeof fv)) query[fk] = fv as QueryValue;
    } else if (Array.isArray(v)) query[k] = v.join(",");
    else if (["string", "number", "boolean"].includes(typeof v)) query[k] = v as QueryValue;
  }
  return { path, query: Object.keys(query).length ? query : undefined };
}

/** Readable paths near one that is not: same first segment, else the collections. */
export function nearPaths(path: string): string[] {
  const all = readablePaths();
  const head = path.split("/")[0];
  const same = all.filter((p) => p.split("/")[0] === head);
  return (same.length ? same : all.filter((p) => !p.includes("/"))).slice(0, 25);
}

export function assistantReadApi(base: ToolDef): ToolDef {
  return {
    ...base,
    description:
      "GET a read endpoint of this business that the other tools do not cover. path is the part after /v1/businesses/{business}/, with no query string: put filters, limit and starting_after in query. " +
      "Collections: credit_notes, coupons, prices, products, payment_intents, transactions, disputes, retries, events, emails, payment_requests, unbilled_charges, usages, meters, credit_units, dunning_policies, tax_profiles, audit_logs. " +
      "One record: credit_notes/cn_…, payment_intents/pi_…; a customer's own: customers/cus_…/promotional_credits, …/wallet, …/payment_methods. " +
      "Payments in depth: payment_intents with query customer (cus_…) lists one customer's intents; payment_intents/pi_…/attempts; gateway_requests with span_id[is] (an attempt's span_id) lists the calls that attempt made; gateway_webhooks with payment_intent[is] (pi_…) or payment_attempt[is] (pia_…) lists what the gateway sent about it. " +
      "If a path is not readable, the error lists the readable paths near it. Documents (pdf, html), bulk exports and connection settings are not available here.",
    input: {
      path: z
        .string()
        .min(1)
        .max(300)
        .describe("e.g. credit_notes or customers/cus_123/wallet. No /v1 prefix, no ?query."),
      query: z
        .record(z.string().max(80), z.union([z.string().max(500), z.number(), z.boolean()]))
        .optional()
        .describe('Query parameters, e.g. {"limit": 10, "status[is]": "open"}.'),
    },
    run: async (ctx, args) => {
      const { path, query } = normalizeReadArgs(args);
      if (!path)
        throw new ToolError(
          "We could not read that path. Give the part after /v1/businesses/{business}/, such as credit_notes.",
        );
      try {
        return await base.run(ctx, { path, query });
      } catch (e) {
        if (!(e instanceof ToolError) || e.status !== 404) throw e;
        if (readablePaths().some((t) => matches(t, path))) throw e;
        throw new ToolError(
          `We could not read ${path}: it is not a read endpoint. Readable paths near it: ${nearPaths(path).join(", ")}.`,
          404,
        );
      }
    },
  };
}
