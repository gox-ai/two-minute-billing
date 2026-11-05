/**
 * Every route declares a permission, and no fixed role gains or loses a route.
 *
 * Reads the boot registry (src/api/permission-registry.ts) of the REAL app and checks:
 *  1. every `authenticate` route is declared (the boot gate throws otherwise; checked again here);
 *  2. every declared route is in scripts/fixtures/route-permissions.json, and its key's legacy
 *     level equals the level the route had before custom roles; new routes name their key;
 *  3. for each fixed role × route: allowed now ⇔ allowed before (the proof, computed);
 *  4. POST routes with read-mode keys = READ_SCOPE_POSTS;
 *  5. the served OpenAPI `x-permission` of every documented operation = the registry;
 *  6. the dashboard's generated catalogue is current.
 *
 *   pnpm verify:permission-coverage
 */
import { readFileSync } from "node:fs";
import { buildApp } from "@/index";
import { closeDb } from "@/platform/db";
import { authenticate, READ_SCOPE_POSTS } from "@/platform/auth";
import { routePermissions } from "@/api/permission-registry";
import {
  FIXED_ROLES,
  fixedRolePermissions,
  legacyAllows,
  permissionDef,
  type LegacyLevel,
} from "@/modules/auth/permissions";
import {
  DASHBOARD_CATALOGUE_PATH,
  renderDashboardCatalogue,
} from "./generate-dashboard-permissions";

const checks: Array<[string, boolean, string[]]> = [];
const ok = (n: string, bad: string[]) => checks.push([n, bad.length === 0, bad]);

const authed: string[] = [];
const app = await buildApp({
  logger: false,
  onRoute: (r) => {
    const ph =
      r.preHandler == null ? [] : Array.isArray(r.preHandler) ? r.preHandler : [r.preHandler];
    if (!ph.includes(authenticate as never)) return;
    for (const m of Array.isArray(r.method) ? r.method : [r.method])
      if (m !== "HEAD") authed.push(`${m} ${r.url}`);
  },
});
const registry = routePermissions();

// 1
ok(
  `every authenticate route declares a permission (${authed.length} routes)`,
  authed.filter((k) => !registry.has(k)),
);

// 2
type Snapshot = string | { key?: string; exempt?: boolean };
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/route-permissions.json", import.meta.url), "utf8"),
).routes as Record<string, Snapshot>;
const missing: string[] = [];
const drift: string[] = [];
for (const [k, d] of registry) {
  const snap = fixture[k];
  if (snap === undefined) {
    missing.push(`${k} (${d.key ?? "exempt"}) — add it to the fixture in review`);
    continue;
  }
  if (typeof snap === "string") {
    const legacy = d.key ? permissionDef(d.key)!.legacy : "any";
    if (legacy !== snap) drift.push(`${k}: was ${snap}, ${d.key ?? "exempt"} is ${legacy}`);
  } else if (snap.exempt ? d.key !== null : snap.key !== d.key) {
    drift.push(`${k}: fixture ${snap.key ?? "exempt"}, route ${d.key ?? "exempt"}`);
  }
}
ok("every declared route is in the snapshot", missing);
ok("every route keeps its legacy level (or its reviewed key)", drift);
ok(
  "no snapshot entry is stale",
  Object.keys(fixture).filter((k) => !registry.has(k)),
);

// 3 — the proof, route by route
const proof: string[] = [];
let pairs = 0;
for (const [k, snap] of Object.entries(fixture)) {
  if (typeof snap !== "string") continue;
  const d = registry.get(k);
  if (!d) continue;
  for (const role of FIXED_ROLES) {
    pairs++;
    const before = legacyAllows(role, snap as LegacyLevel);
    const now = d.key === null || fixedRolePermissions(role).has(d.key);
    if (before !== now) proof.push(`${role} ${k}: before ${before}, now ${now}`);
  }
}
ok(`no fixed role gains or loses a route (${pairs} role × route pairs)`, proof);

// 4
const readPosts = [...registry.values()]
  .filter((d) => d.method === "POST" && d.key && permissionDef(d.key)!.mode === "read")
  .map((d) => d.url)
  .sort();
ok("read-mode POST routes = READ_SCOPE_POSTS", [
  ...readPosts.filter((u) => !READ_SCOPE_POSTS.has(u)).map((u) => `extra ${u}`),
  ...[...READ_SCOPE_POSTS].filter((u) => !readPosts.includes(u)).map((u) => `missing ${u}`),
]);

// 5
const spec = JSON.parse((await app.inject({ method: "GET", url: "/openapi.json" })).body) as {
  paths: Record<string, Record<string, { "x-permission"?: { key: string } | null }>>;
};
const docDrift: string[] = [];
let documented = 0;
for (const [path, ops] of Object.entries(spec.paths)) {
  if (!path.startsWith("/v1/")) continue;
  const url = path.replace(/\{([A-Za-z_]+)\}/g, ":$1");
  for (const [method, op] of Object.entries(ops)) {
    const d = registry.get(`${method.toUpperCase()} ${url}`);
    if (!d) continue;
    documented++;
    const doc = op["x-permission"];
    if (doc === undefined || (doc?.key ?? null) !== d.key)
      docDrift.push(`${method.toUpperCase()} ${path}: docs ${doc?.key ?? doc}, route ${d.key}`);
  }
}
ok(`OpenAPI x-permission matches the registry (${documented} operations)`, docDrift);

// 6
ok(
  "dashboard/lib/permissions.generated.ts is current (pnpm permissions:generate)",
  readFileSync(DASHBOARD_CATALOGUE_PATH, "utf8") === renderDashboardCatalogue() ? [] : ["stale"],
);

await app.close();
let pass = true;
for (const [n, c, bad] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  for (const b of bad.slice(0, 15)) console.log(`      ↳ ${b}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ PERMISSION-COVERAGE: PASS" : "❌ PERMISSION-COVERAGE: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
