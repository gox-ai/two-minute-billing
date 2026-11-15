/**
 * Calls an existing /v1 route in-process with the caller's own credential.
 *
 * Tools never query the database: going through the route keeps authentication, the
 * permission check, RLS, the test/live partition, rate limits and the request log exactly
 * as they are for any other API call.
 */
import type { FastifyInstance } from "fastify";
import { INNER_CALL_HEADER, innerCallHeaderValue } from "@/platform/inner-call";

export type QueryValue = string | number | boolean;

export interface RouteRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Absolute path, e.g. `/v1/businesses/biz_…/invoices`. */
  path: string;
  query?: Record<string, QueryValue | undefined>;
  body?: unknown;
  /** Extra headers, e.g. `idempotency-key` for a write the member confirmed. */
  headers?: Record<string, string>;
}

/** Sent with an action the member confirmed in the assistant: the audit trail says "via Billy". */
export const VIA_ASSISTANT_HEADER = "x-tmb-via";

export interface RouteResult {
  status: number;
  body: unknown;
}

/**
 * The headers that carry the caller's credential and name the client: `authorization` for an
 * MCP client's key or token, `cookie` for a dashboard member's session.
 */
export type CallerHeaders = Record<string, string> & { "user-agent": string };

export async function callRoute(
  app: FastifyInstance,
  caller: CallerHeaders,
  req: RouteRequest,
): Promise<RouteResult> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) qs.set(k, String(v));
  const url = qs.size ? `${req.path}?${qs.toString()}` : req.path;
  const res = await app.inject({
    method: req.method,
    url,
    headers: {
      ...req.headers,
      ...caller,
      accept: "application/json",
      [INNER_CALL_HEADER]: innerCallHeaderValue(),
    },
    ...(req.body !== undefined ? { payload: req.body as object } : {}),
  });
  const type = String(res.headers["content-type"] ?? "");
  if (!type.includes("application/json")) {
    return { status: res.statusCode >= 400 ? res.statusCode : 415, body: null };
  }
  return { status: res.statusCode, body: res.json() };
}

/** The route's own error message, when it sent one. */
export function routeErrorMessage(r: RouteResult): string | null {
  const err = (r.body as { error?: { message?: unknown } } | null)?.error;
  return typeof err?.message === "string" ? err.message : null;
}
