/**
 * Roles and grants on the dashboard side: what a fixed role holds, and what the signed-in
 * member may hand out. The engine enforces every rule here; this only decides what to offer.
 * A plain module (no "use client"), so server pages and client components both import it.
 */
import { PERMISSIONS, type PermissionDef } from "@/lib/permissions.generated";

export const FIXED_ROLES = ["owner", "admin", "manager", "ops", "developer"] as const;
export type FixedRoleName = (typeof FIXED_ROLES)[number];

const LEGACY: Record<FixedRoleName, readonly string[]> = {
  owner: ["any", "ops", "manager", "developer", "admin"],
  admin: ["any", "ops", "manager", "developer", "admin"],
  manager: ["any", "ops", "manager"],
  ops: ["any", "ops"],
  developer: ["any", "developer"],
};

/** The keys a fixed role holds. Same rule as the engine (`legacyAllows`). */
export function fixedRoleKeys(role: FixedRoleName): string[] {
  return PERMISSIONS.filter((p) => LEGACY[role].includes(p.legacy)).map((p) => p.key);
}

/** May an actor holding `actor` give a role with `keys`? */
export function canGrant(actor: readonly string[], keys: readonly string[]): boolean {
  return keys.every((k) => actor.includes(k));
}

export interface CustomRole {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  version: number;
  member_count: number;
}

/** Areas in catalogue order, each with its resources and their keys. */
export function permissionAreas(): Array<{
  area: string;
  resources: Array<{ resource: string; keys: PermissionDef[] }>;
}> {
  const areas: Array<{
    area: string;
    resources: Array<{ resource: string; keys: PermissionDef[] }>;
  }> = [];
  for (const p of PERMISSIONS) {
    let a = areas.find((x) => x.area === p.area);
    if (!a) areas.push((a = { area: p.area, resources: [] }));
    let r = a.resources.find((x) => x.resource === p.resource);
    if (!r) a.resources.push((r = { resource: p.resource, keys: [] }));
    r.keys.push(p);
  }
  return areas;
}

/** "payment_methods" → "Payment methods". */
export function resourceLabel(resource: string): string {
  const s = resource.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export type KeyAccess = "none" | "read" | "write";

/** What the member may put on an API key, by the engine's "grant only what you hold" rule. */
export interface KeyGrantOptions {
  full: boolean;
  readOnly: boolean;
  resources: Record<string, { read: boolean; write: boolean }>;
}

export function keyGrantOptions(actor: readonly string[]): KeyGrantOptions {
  const keyable = PERMISSIONS.filter((p) => !p.operatorOnly);
  const resources: KeyGrantOptions["resources"] = {};
  for (const p of keyable) {
    const r = (resources[p.resource] ??= { read: true, write: true });
    if (!actor.includes(p.key)) {
      r.write = false;
      if (p.mode === "read") r.read = false;
    }
  }
  return {
    full: keyable.every((p) => actor.includes(p.key)),
    readOnly: keyable.filter((p) => p.mode === "read").every((p) => actor.includes(p.key)),
    resources,
  };
}

/** One line for the keys list: "Read and write", "Read only", or the custom map. */
export function keyAccessSummary(k: {
  scope?: string;
  permissions?: Record<string, "read" | "write"> | null;
}): string {
  if (!k.permissions) return k.scope === "read" ? "Read only" : "Read and write";
  const entries = Object.entries(k.permissions);
  return `Custom: ${entries.map(([r, a]) => `${resourceLabel(r)} (${a === "write" ? "write" : "read"})`).join(", ")}`;
}

/** A role a member may be given: fixed (`owner`…) or custom (`role_…`). */
export interface RoleOption {
  value: string;
  label: string;
  /** The signed-in member holds every key of this role, so may give it. */
  grantable: boolean;
  keys: string[];
  custom?: boolean;
}
