/**
 * Marks a request this process made to itself (`fastify.inject` from the MCP tools).
 *
 * The secret is random per process and never leaves it, so an outside request cannot carry
 * it. `authenticate` uses it to let an OAuth access token — whose audience is /mcp only —
 * reach the /v1 routes a tool calls on the token holder's behalf, and nothing else.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

export const INNER_CALL_HEADER = "x-tmb-inner-call";
const SECRET = randomBytes(32).toString("hex");

export function innerCallHeaderValue(): string {
  return SECRET;
}

export function isInnerCall(headers: Record<string, unknown>): boolean {
  const v = headers[INNER_CALL_HEADER];
  if (typeof v !== "string" || v.length !== SECRET.length) return false;
  return timingSafeEqual(Buffer.from(v), Buffer.from(SECRET));
}
