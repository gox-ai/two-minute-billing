/**
 * The boot gate: every route behind `authenticate` declares one catalogue permission, or an
 * exemption with a reason. A route without one cannot ship — the server refuses to start.
 *
 * Registered as an `onRoute` hook before any route, so it sees each route as it is added.
 * The registry it fills is the runtime truth `verify:permission-coverage` and the OpenAPI
 * `x-permission` read.
 */
import type { RouteOptions } from "fastify";
import { authenticate, requestKind } from "@/platform/auth";
import { permissionDef } from "@/modules/auth/permissions";
import { EXEMPT_TAG, MEMBER_TAG, PERMISSION_TAG } from "./helpers";

export interface RoutePermission {
  method: string;
  url: string;
  /** Catalogue key, or null for an exempt route. */
  key: string | null;
  exempt?: string;
  /** A session-only `/auth/*` route (`requireMemberPermission`). */
  member?: boolean;
}

const registry = new Map<string, RoutePermission>();

/** Every declared route, `METHOD url` → declaration. */
export function routePermissions(): ReadonlyMap<string, RoutePermission> {
  return registry;
}

type Tagged = Record<symbol, string | boolean | undefined>;

export function declareRoutePermission(r: RouteOptions): void {
  const handlers = (
    r.preHandler == null ? [] : Array.isArray(r.preHandler) ? r.preHandler : [r.preHandler]
  ) as unknown[];
  const authAt = handlers.indexOf(authenticate);
  const tagged = handlers
    .map((h, i) => ({ i, t: h as Tagged }))
    .filter(({ t }) => t[PERMISSION_TAG] !== undefined || t[EXEMPT_TAG] !== undefined);
  const methods = (Array.isArray(r.method) ? r.method : [r.method]).filter((m) => m !== "HEAD");
  const where = `${methods.join(",")} ${r.url}`;
  if (tagged.length === 0) {
    if (authAt >= 0) {
      throw new Error(
        `Route ${where} has no permission. Add requirePerm("<resource:action>") after authenticate, or noMemberPermission("<reason>").`,
      );
    }
    return;
  }
  if (tagged.length > 1) throw new Error(`Route ${where} declares more than one permission.`);
  const { i, t } = tagged[0]!;
  const member = t[MEMBER_TAG] === true;
  if (!member && (authAt < 0 || i < authAt)) {
    throw new Error(`Route ${where}: the permission check must come after authenticate.`);
  }
  const exempt = t[EXEMPT_TAG] as string | undefined;
  const key = (t[PERMISSION_TAG] as string | undefined) ?? null;
  if (key !== null) {
    const def = permissionDef(key);
    if (!def) throw new Error(`Route ${where} names an unknown permission: ${key}`);
    for (const m of methods) {
      if (def.mode !== requestKind(m, r.url)) {
        throw new Error(
          `Route ${where} takes a ${requestKind(m, r.url)} permission, and ${key} is ${def.mode}.`,
        );
      }
    }
  }
  for (const m of methods) {
    registry.set(`${m} ${r.url}`, {
      method: m,
      url: r.url,
      key,
      ...(exempt ? { exempt } : {}),
      ...(member ? { member } : {}),
    });
  }
}
