import type { FastifyRequest } from "fastify";
import { config } from "@/platform/config";

/**
 * The OAuth issuer and the base of the MCP resource URLs: `MCP_PUBLIC_URL`, else
 * `WEBHOOK_BASE_URL`, else the request's own origin. A connector refuses a server whose metadata
 * names another origin than the URL it was given, so a dedicated MCP host must set the first.
 */
export function issuerFor(req: FastifyRequest): string {
  const base = config.MCP_PUBLIC_URL?.trim() || config.WEBHOOK_BASE_URL?.trim();
  if (base) return base.replace(/\/+$/, "");
  return `${req.protocol}://${req.host}`;
}

/** The dashboard origin, where the member signs in and decides. */
export function dashboardOrigin(): string {
  return (config.DASHBOARD_BASE_URL?.trim() || "http://localhost:4100").replace(/\/+$/, "");
}

/**
 * The issuer split into origin and path. A deployment behind a path prefix (`https://host/api`)
 * keeps its well-known documents at the ORIGIN root with the path appended (RFC 8414 §3,
 * RFC 9728 §3.1): `https://host/.well-known/oauth-protected-resource/api/mcp`.
 */
export function issuerParts(req: FastifyRequest): { origin: string; path: string } {
  const u = new URL(issuerFor(req));
  return { origin: u.origin, path: u.pathname.replace(/\/+$/, "") };
}
