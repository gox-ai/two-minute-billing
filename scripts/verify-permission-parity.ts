/**
 * The dashboard and the engine must agree about who may do what (audit H1).
 *
 * A route stricter than the dashboard action that calls it is a button that always fails.
 * For every `'use server'` action that calls `requirePermission(<key>, "<level>")` and then
 * writes to a `/v1/...` or `/auth/...` path, the route serving that path must be satisfied by:
 *  - the action's LEVEL, for fixed roles (the level covers the route key's legacy level);
 *  - the action's KEY(S), for custom roles (the route's key is one of them).
 *
 * Routes come from the boot registry of the real app, so loop-registered routes count too.
 * The gate fails below a pair-count floor (it passed while checking nothing once: its regex
 * wanted single quotes after the code moved to double quotes), and it mutation-tests itself:
 * a weakened level and a wrong key must both be caught.
 *
 *   pnpm verify:permission-parity
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "@/index";
import { closeDb } from "@/platform/db";
import { routePermissions } from "@/api/permission-registry";
import { legacyAllows, permissionDef, type LegacyLevel } from "@/modules/auth/permissions";

const ROOT = new URL("../", import.meta.url).pathname;
/** Pairs compared on 2026-10-25, the first honest run. Lower only on purpose. */
const PAIR_FLOOR = 104;

/** Does page level `have` satisfy `need` for every fixed role that has `have`? */
const ROLES = ["owner", "admin", "manager", "ops", "developer"] as const;
function covers(have: string, need: LegacyLevel): boolean {
  return ROLES.every((r) => !legacyAllows(r, have as LegacyLevel) || legacyAllows(r, need));
}

const shape = (p: string) =>
  p
    .replace(/\$\{[^}]+\}/g, ":x")
    .replace(/:\w+/g, ":x")
    .replace(/\/$/, "")
    .split("?")[0]!;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

// ── 1. routes, from the running app ──────────────────────────────────────────
const app = await buildApp({ logger: false });
const routes = new Map<string, string>();
for (const d of routePermissions().values())
  if (d.key) routes.set(`${d.method} ${shape(d.url)}`, d.key);
await app.close();

// ── 2. every dashboard action that guards itself and then writes ─────────────
interface Pair {
  action: string;
  level: string;
  keys: string[];
  route: string;
  routeKey: string;
}
const METHOD: Record<string, string> = {
  apiPost: "POST",
  apiPatch: "PATCH",
  apiPut: "PUT",
  apiDelete: "DELETE",
};
const pairs: Pair[] = [];
for (const f of walk(join(ROOT, "dashboard/app"))) {
  const src = readFileSync(f, "utf8");
  if (!/^\s*["']use server["']/m.test(src.slice(0, 400))) continue;
  const fns = [...src.matchAll(/^export async function (\w+)/gm)];
  for (let i = 0; i < fns.length; i++) {
    const body = src.slice(fns[i]!.index!, i + 1 < fns.length ? fns[i + 1]!.index! : src.length);
    const guard = /requirePermission\(([\s\S]*?),\s*["'](\w+)["']\s*\)/.exec(body);
    if (!guard) continue;
    const keys = [...guard[1]!.matchAll(/["']([a-z_]+:[a-z_]+)["']/g)].map((m) => m[1]!);
    for (const w of body.matchAll(
      /(apiPost|apiPatch|apiPut|apiDelete|apiWrite|memberWrite)\(\s*[`'"]([^`'"]+)[`'"]([^)]*)/g,
    )) {
      const method = METHOD[w[1]!] ?? /["'](POST|PUT|PATCH|DELETE)["']/.exec(w[3]!)?.[1] ?? "POST";
      const route = `${method} ${shape(w[2]!)}`;
      const routeKey = routes.get(route);
      if (routeKey) pairs.push({ action: fns[i]![1]!, level: guard[2]!, keys, route, routeKey });
    }
  }
}

function offenders(list: Pair[]): string[] {
  const out: string[] = [];
  for (const p of list) {
    const legacy = permissionDef(p.routeKey)!.legacy;
    if (!covers(p.level, legacy))
      out.push(`${p.action} (${p.level}) → ${p.route} needs ${legacy} (${p.routeKey})`);
    if (!p.keys.includes(p.routeKey))
      out.push(`${p.action} [${p.keys.join(", ")}] → ${p.route} needs ${p.routeKey}`);
  }
  return out;
}

const found = offenders(pairs);

// ── 3. the gate tests itself ──────────────────────────────────────────────────
const strict = pairs.find((p) => permissionDef(p.routeKey)!.legacy !== "any");
const weakLevel = strict
  ? offenders([{ ...strict, level: strict.routeKey.startsWith("api_keys") ? "ops" : "developer" }])
  : [];
const wrongKey = pairs[0] ? offenders([{ ...pairs[0], keys: ["events:view"] }]) : [];
const selfTest = !!strict && weakLevel.length > 0 && wrongKey.length > 0;

console.log(`  annotated routes      ${routes.size}`);
console.log(`  action→route pairs    ${pairs.length} (floor ${PAIR_FLOOR})`);
console.log(`  dead controls         ${found.length} (budget 0)`);
for (const o of found) console.log(`     ↳ ${o}`);
console.log(
  `  mutation self-test    ${selfTest ? "caught a weakened level and a wrong key" : "FAILED"}`,
);
if (found.length > 0) {
  console.log("");
  console.log("  The dashboard offers this action to a role the engine then refuses, so the");
  console.log("  button always fails. Make the action's level and key agree with the route.");
}
console.log("");
const pass = found.length === 0 && pairs.length >= PAIR_FLOOR && selfTest;
console.log(pass ? "✅ PERMISSION PARITY: PASS" : "❌ PERMISSION PARITY: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
