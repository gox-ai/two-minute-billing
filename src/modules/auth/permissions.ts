/**
 * The permission catalogue: every API route and dashboard control resolves to one key here.
 *
 * Code, not data. A key's `legacy` is the fixed level that held it before custom roles; a fixed
 * role holds exactly `{K : legacyAllows(role, K.legacy)}`, so on deploy no fixed role gains or
 * loses a route (`verify:permission-coverage` checks this against the route snapshot).
 *
 * `mode` follows the HTTP method: GET routes take read keys, writes take write keys, except
 * the read-scope POSTs (estimates, preview). A key map's `read` holds only read-mode keys.
 */

export type FixedRole = "owner" | "admin" | "manager" | "ops" | "developer";
export type LegacyLevel = "any" | "ops" | "manager" | "developer" | "admin";
export type PermissionMode = "read" | "write";

export interface PermissionDef {
  key: string;
  resource: string;
  mode: PermissionMode;
  legacy: LegacyLevel;
  area: string;
  label: string;
  /** A signed-in member only. An API key never holds it. */
  operatorOnly?: boolean;
}

type Def = Omit<PermissionDef, "key" | "resource">;
const d = (
  mode: PermissionMode,
  legacy: LegacyLevel,
  area: string,
  label: string,
  operatorOnly?: boolean,
): Def => ({
  mode,
  legacy,
  area,
  label,
  ...(operatorOnly ? { operatorOnly } : {}),
});

const DEFS = {
  // ── Customers ──
  "customers:view": d("read", "any", "Customers", "View customers, contacts and portal sessions"),
  "customers:manage": d("write", "ops", "Customers", "Create, edit and delete customers"),
  "payment_methods:view": d("read", "any", "Customers", "View payment methods"),
  "payment_methods:manage": d(
    "write",
    "ops",
    "Customers",
    "Add, change and remove payment methods",
  ),
  "credits:view": d(
    "read",
    "any",
    "Customers",
    "View promotional credits, excess payments and wallets",
  ),
  "credits:manage": d(
    "write",
    "ops",
    "Customers",
    "Give credits, record excess payments and top up wallets",
  ),
  "credit_holds:manage": d(
    "write",
    "ops",
    "Customers",
    "Hold, capture and release credit for a call in progress",
  ),
  // ── Subscriptions ──
  "subscriptions:view": d("read", "any", "Subscriptions", "View subscriptions"),
  "subscriptions:count": d("write", "any", "Subscriptions", "Count subscriptions with a filter"),
  "subscriptions:estimate": d(
    "read",
    "ops",
    "Subscriptions",
    "Get subscription and cancellation estimates",
  ),
  "subscriptions:manage": d(
    "write",
    "ops",
    "Subscriptions",
    "Create and change subscriptions, items, charges and schedules",
  ),
  // `ops`, not `any`, since 2026-11-03: a developer may not cancel or pause a subscription.
  "subscriptions:lifecycle": d(
    "write",
    "ops",
    "Subscriptions",
    "Cancel, pause, resume and change subscription terms",
  ),
  "usage:view": d("read", "any", "Subscriptions", "View usage, current usage and unbilled charges"),
  "usage:manage": d(
    "write",
    "ops",
    "Subscriptions",
    "Record and delete usage, and invoice unbilled charges",
  ),
  "usage_events:view": d("read", "any", "Usage", "View usage events"),
  "usage_events:manage": d("write", "ops", "Usage", "Send and void usage events"),
  "usage_controls:view": d(
    "read",
    "any",
    "Usage",
    "View spend limits, usage alerts, automatic top-ups and credit runway",
  ),
  "usage_controls:manage": d(
    "write",
    "manager",
    "Usage",
    "Set spend limits, usage alerts, automatic top-ups and usage invoice thresholds",
  ),
  // ── Invoices ──
  "invoices:view": d("read", "any", "Invoices", "View invoices and payment retries"),
  "invoices:manage": d(
    "write",
    "ops",
    "Invoices",
    "Create, edit, close and regenerate invoices, and control dunning",
  ),
  // `ops`, not `any`, since 2026-11-03: a developer may not charge a customer.
  "invoices:collect": d("write", "ops", "Invoices", "Collect or retry payment of an invoice"),
  "invoices:void": d("write", "manager", "Invoices", "Void and write off invoices"),
  "invoices:estimate": d("write", "any", "Invoices", "Estimate an invoice for unbilled charges"),
  "credit_notes:view": d("read", "any", "Invoices", "View credit notes"),
  "credit_notes:manage": d(
    "write",
    "manager",
    "Invoices",
    "Create, refund and void credit notes, and apply credits",
  ),
  // ── Payments ──
  "payments:view": d(
    "read",
    "any",
    "Payments",
    "View transactions, payment intents, receipts, payment requests, links and disputes",
  ),
  "payments:collect": d(
    "write",
    "ops",
    "Payments",
    "Collect payments, and manage payment intents, requests and links",
  ),
  "payments:refund": d(
    "write",
    "manager",
    "Payments",
    "Refund payments, void payment intents, cancel pending debits and record disputes",
  ),
  "checkout_sessions:view": d("read", "ops", "Payments", "View checkout sessions"),
  "checkout_sessions:manage": d("write", "ops", "Payments", "Create and revoke checkout sessions"),
  // ── Catalogue ──
  "catalog:view": d("read", "any", "Catalogue", "View products, prices, plans and features"),
  "catalog:manage": d(
    "write",
    "manager",
    "Catalogue",
    "Create, edit and delete products, prices, plans and features",
  ),
  "meters:manage": d("write", "manager", "Catalogue", "Create, change and archive meters"),
  "model_prices:view": d("read", "any", "Catalogue", "View the model price list and your cost"),
  "model_prices:manage": d("write", "manager", "Catalogue", "Set and end your cost for AI models"),
  "catalog:copy": d("write", "any", "Catalogue", "Copy products or coupons from another business"),
  "coupons:view": d("read", "any", "Catalogue", "View coupons, coupon sets and codes"),
  "coupons:manage": d(
    "write",
    "manager",
    "Catalogue",
    "Create, edit and delete coupons and coupon codes",
  ),
  "taxes:view": d("read", "any", "Catalogue", "View tax profiles and regions"),
  "taxes:manage": d("write", "manager", "Catalogue", "Change tax profiles and regions"),
  // ── Communications ──
  "emails:view": d("read", "any", "Communications", "View emails, templates and email settings"),
  "emails:preview": d("read", "ops", "Communications", "Preview email templates"),
  "emails:manage": d(
    "write",
    "ops",
    "Communications",
    "Send emails, and change templates and email settings",
  ),
  "comments:view": d("read", "any", "Communications", "View comments"),
  "comments:manage": d("write", "ops", "Communications", "Add, edit and delete comments"),
  // ── Reports ──
  "reports:view": d("read", "any", "Reports", "View reports, metrics and analytics"),
  "reports:query": d("write", "any", "Reports", "Run analytics queries"),
  "reports:export": d("read", "any", "Reports", "Export raw data"),
  "usage_margin:view": d("read", "manager", "Reports", "View usage cost and margin"),
  "views:view": d(
    "read",
    "any",
    "Reports",
    "View saved list views, report dashboards and segments",
  ),
  "views:manage": d(
    "write",
    "any",
    "Reports",
    "Change saved list views, report dashboards and segments",
  ),
  "audit_logs:view": d("read", "any", "Reports", "View the audit log"),
  "events:view": d("read", "any", "Reports", "View events"),
  // ── Settings ──
  "settings:view": d("read", "any", "Settings", "View businesses and business settings"),
  "settings:manage": d(
    "write",
    "admin",
    "Settings",
    "Change the organization and business settings",
  ),
  "businesses:create": d("write", "manager", "Settings", "Create businesses"),
  "test_mode:manage": d("write", "manager", "Settings", "Turn on test mode for a business"),
  "dunning_policies:view": d("read", "any", "Settings", "View dunning policies"),
  "dunning_policies:manage": d(
    "write",
    "admin",
    "Settings",
    "Create, change and archive dunning policies",
  ),
  "gateways:view": d("read", "any", "Settings", "View payment gateways and their logs"),
  "gateways:manage": d("write", "admin", "Settings", "Connect, change and remove payment gateways"),
  "integrations:view": d("read", "any", "Settings", "View integrations"),
  "integrations:manage": d("write", "admin", "Settings", "Connect, change and remove integrations"),
  "integrations:sync": d("write", "manager", "Settings", "Start an integration sync"),
  "transfers:view": d("read", "admin", "Settings", "View the list of business transfers"),
  "transfers:status": d("read", "any", "Settings", "View one business transfer"),
  "transfers:manage": d("write", "admin", "Settings", "Preview and run business transfers"),
  "transfers:live_override": d(
    "write",
    "admin",
    "Settings",
    "Override the live-mode check of a transfer",
    true,
  ),
  "test_tools:view": d("read", "any", "Settings", "View time travel"),
  "test_tools:manage": d(
    "write",
    "admin",
    "Settings",
    "Use time travel, and create or delete sample and test data",
  ),
  "test_clock:advance": d("write", "ops", "Settings", "Advance the test clock"),
  // ── Developers ──
  "api_keys:view": d("read", "any", "Developers", "View API keys"),
  "api_keys:manage": d(
    "write",
    "developer",
    "Developers",
    "Create, change, rotate and revoke API keys",
  ),
  "webhooks:view": d("read", "any", "Developers", "View webhook endpoints and deliveries"),
  "webhooks:manage": d(
    "write",
    "developer",
    "Developers",
    "Create, change and test webhook endpoints",
  ),
  "api_logs:view": d("read", "developer", "Developers", "View API request logs"),
  // ── Team (a signed-in member only) ──
  "members:view": d("read", "admin", "Team", "View team members", true),
  "members:manage": d("write", "admin", "Team", "Invite, change and remove team members", true),
  "roles:view": d("read", "admin", "Team", "View roles", true),
  "roles:manage": d("write", "admin", "Team", "Create, change and delete roles", true),
  "security:view": d("read", "admin", "Team", "View the organization security settings", true),
  "security:manage": d("write", "admin", "Team", "Change the organization security settings", true),
} as const satisfies Record<string, Def>;

export type PermissionKey = keyof typeof DEFS;

export const PERMISSIONS: readonly PermissionDef[] = Object.entries(DEFS).map(([key, def]) => ({
  key,
  resource: key.slice(0, key.indexOf(":")),
  ...def,
}));

const BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p]));

export function permissionDef(key: string): PermissionDef | undefined {
  return BY_KEY.get(key);
}

export function isPermissionKey(key: string): key is PermissionKey {
  return BY_KEY.has(key);
}

/** Resources an API key map may name: those with at least one key a key can hold. */
export const KEY_RESOURCES: readonly string[] = [
  ...new Set(PERMISSIONS.filter((p) => !p.operatorOnly).map((p) => p.resource)),
];

// ── Fixed roles ─────────────────────────────────────────────────────────────

export const FIXED_ROLES: readonly FixedRole[] = ["owner", "admin", "manager", "ops", "developer"];

/** Which legacy levels each fixed role held. Identical to the old four-level matrix plus `any`. */
const LEGACY: Record<FixedRole, readonly LegacyLevel[]> = {
  owner: ["any", "ops", "manager", "developer", "admin"],
  admin: ["any", "ops", "manager", "developer", "admin"],
  manager: ["any", "ops", "manager"],
  ops: ["any", "ops"],
  developer: ["any", "developer"],
};

export function legacyAllows(role: string, level: LegacyLevel): boolean {
  return (
    (LEGACY as Record<string, readonly LegacyLevel[] | undefined>)[role]?.includes(level) ?? false
  );
}

export function isFixedRole(role: string): role is FixedRole {
  return (FIXED_ROLES as readonly string[]).includes(role);
}

/** Frozen per fixed role at load. */
const FIXED_SETS: Record<FixedRole, ReadonlySet<string>> = Object.fromEntries(
  FIXED_ROLES.map((r) => [
    r,
    new Set(PERMISSIONS.filter((p) => legacyAllows(r, p.legacy)).map((p) => p.key)),
  ]),
) as unknown as Record<FixedRole, ReadonlySet<string>>;

export function fixedRolePermissions(role: FixedRole): ReadonlySet<string> {
  return FIXED_SETS[role];
}

const EMPTY: ReadonlySet<string> = new Set();
const customMemo = new Map<string, ReadonlySet<string>>();

/**
 * A member's effective keys. Fixed role → its frozen set. Custom role → its stored keys that
 * still exist, memoised by (role id, version); an edit bumps the version, so no stale window.
 */
export function effectivePermissions(
  role: string,
  custom?: { id: string; version: number; permissions: readonly string[] } | null,
): ReadonlySet<string> {
  if (isFixedRole(role)) return FIXED_SETS[role];
  if (role !== "custom" || !custom) return EMPTY;
  const memoKey = `${custom.id}:${custom.version}`;
  let set = customMemo.get(memoKey);
  if (!set) {
    set = new Set(custom.permissions.filter((k) => BY_KEY.has(k)));
    if (customMemo.size >= 1000) customMemo.delete(customMemo.keys().next().value!);
    customMemo.set(memoKey, set);
  }
  return set;
}

// ── API keys ────────────────────────────────────────────────────────────────

export type KeyAccess = "read" | "write";
export type KeyPermissionMap = Record<string, KeyAccess>;

/**
 * Does an API key hold `key`? NULL map = by scope, as before custom roles: `write` holds every
 * key a key can hold; `read` every read-mode one.
 */
export function apiKeyHolds(
  def: PermissionDef,
  scope: "read" | "write" | null,
  map: KeyPermissionMap | null,
): boolean {
  if (def.operatorOnly) return false;
  if (!map) return scope === "write" || (scope === "read" && def.mode === "read");
  const access = map[def.resource];
  return access === "write" || (access === "read" && def.mode === "read");
}

/** Every key a key with this grant would hold. */
export function apiKeyGrant(scope: "read" | "write", map: KeyPermissionMap | null): string[] {
  return PERMISSIONS.filter((p) => apiKeyHolds(p, scope, map)).map((p) => p.key);
}

/** The scope a map implies: `write` if any resource is write. Keeps the method wall correct. */
export function scopeForMap(map: KeyPermissionMap): "read" | "write" {
  return Object.values(map).includes("write") ? "write" : "read";
}

/** Unknown resources or access values in a requested map, as a message. Null when valid. */
export function keyMapError(map: Record<string, unknown>): string | null {
  const entries = Object.entries(map);
  if (entries.length === 0) return "permissions must name at least one resource";
  for (const [resource, access] of entries) {
    if (!KEY_RESOURCES.includes(resource)) return `Unknown resource in permissions: ${resource}`;
    if (access !== "read" && access !== "write")
      return `permissions.${resource} must be "read" or "write"`;
  }
  return null;
}

/** Keys the actor lacks for this grant. Empty = the actor may grant it. */
export function missingForGrant(
  actor: ReadonlySet<string>,
  scope: "read" | "write",
  map: KeyPermissionMap | null,
): string[] {
  return apiKeyGrant(scope, map).filter((k) => !actor.has(k));
}

// ── Custom role names ───────────────────────────────────────────────────────

const RESERVED_NAMES = new Set([
  "owner",
  "admin",
  "administrator",
  "manager",
  "ops",
  "operations",
  "developer",
  "custom",
]);

/** NFKC, drop invisible code points, collapse spaces, trim, lower-case. */
export function roleNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isReservedRoleName(name: string): boolean {
  return RESERVED_NAMES.has(roleNameKey(name));
}
