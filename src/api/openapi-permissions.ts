/**
 * Stamp each documented operation with the permission its route declares (`x-permission`) and
 * the 403 a caller without it receives. Read from the boot registry, so the docs cannot drift
 * from what the server enforces.
 */
import { permissionDef } from "@/modules/auth/permissions";
import type { RoutePermission } from "./permission-registry";

type Doc = { paths?: Record<string, Record<string, Record<string, unknown>>> };

const FORBIDDEN = {
  description:
    "The caller does not have the permission (`code: missing_permission` for a member, `key_missing_permission` for an API key).",
};

export function withPermissions<T extends Doc>(
  doc: T,
  registry: ReadonlyMap<string, RoutePermission>,
): T {
  const paths: NonNullable<Doc["paths"]> = {};
  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    const url = path.replace(/\{([A-Za-z_]+)\}/g, ":$1");
    const out: Record<string, Record<string, unknown>> = {};
    for (const [method, op] of Object.entries(ops)) {
      const decl = registry.get(`${method.toUpperCase()} ${url}`);
      if (!decl || typeof op !== "object" || op === null) {
        out[method] = op;
        continue;
      }
      if (decl.key === null) {
        out[method] = { ...op, "x-permission": null };
        continue;
      }
      const def = permissionDef(decl.key)!;
      const responses = (op.responses ?? {}) as Record<string, unknown>;
      out[method] = {
        ...op,
        "x-permission": {
          key: def.key,
          resource: def.resource,
          mode: def.mode,
          members_only: !!def.operatorOnly,
        },
        responses: { ...responses, ...(responses["403"] ? {} : { "403": FORBIDDEN }) },
      };
    }
    paths[path] = out;
  }
  return { ...doc, paths };
}
