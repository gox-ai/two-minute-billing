/**
 * verify:palette-coverage — every dashboard page is reachable from ⌘K.
 *
 * The palette offers the two sidebars plus `dashboard/lib/palette-pages.ts`. A page in
 * none of them can only be found by clicking through, which is how the business
 * settings sub-pages (dunning among them) went missing. Static: no DB, no server.
 *
 * Also fails on a registry entry whose route no longer exists, so the list cannot rot
 * the other way.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CREATE_PAGES, PALETTE_PAGES } from "../dashboard/lib/palette-pages";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
// Only the signed-in app. (auth) and (storefront) are public pages nobody navigates to
// from inside the dashboard.
const APP = join(ROOT, "dashboard/app/(dashboard)");
const BIZ = "/businesses/[biz]";

/** Routes deliberately absent from ⌘K. Each needs a reason. */
const EXCLUDED: Record<string, string> = {
  "/two-factor-required": "a gate the app redirects to, never a destination",
  [`${BIZ}/ops`]: "redirect-only: an old link kept from 404ing",
  [`${BIZ}/reports`]: "redirect-only: the Reports group's children are sidebar targets",
  [`${BIZ}/prices/new`]: "redirect-only: to the plans list",
  [`${BIZ}/catalog/products`]: "redirect-only",
  [`${BIZ}/catalog/prices`]: "redirect-only",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name === "page.tsx") out.push(p);
  }
  return out;
}

/** `(dashboard)/businesses/[biz]/settings/(x)/page.tsx` → `/businesses/[biz]/settings`. */
function routeOf(file: string): string {
  const segs = relative(APP, file)
    .split(sep)
    .slice(0, -1)
    .filter((s) => !/^\(.*\)$/.test(s));
  return "/" + segs.join("/");
}

const routes = walk(APP)
  .map(routeOf)
  // Record pages (`[cus]`, `[id]`, …) are reached by entity search, not by name.
  .filter((r) => !r.replace(BIZ, "").includes("["))
  .map((r) => (r === "/" ? "/" : r.replace(/\/$/, "")));

const covered = new Set<string>();

// Business sidebar: `${base}/x` literals, plus `href: base` for Home.
const bizNav = readFileSync(join(ROOT, "dashboard/lib/business-nav.ts"), "utf8");
for (const m of bizNav.matchAll(/`\$\{base\}(\/[^`]*)`/g)) covered.add(BIZ + m[1]);
if (/href:\s*base\b/.test(bizNav)) covered.add(BIZ);

// Org rail: the `navItems` literals in the dashboard layout.
const layout = readFileSync(join(APP, "layout.tsx"), "utf8");
for (const m of layout.matchAll(/href:\s*"(\/[^"]*)"/g)) covered.add(m[1]!);

const registered = new Set<string>();
for (const p of PALETTE_PAGES) {
  const path = p.path.split("#")[0]!;
  registered.add(p.scope === "biz" ? BIZ + path : path);
}
for (const c of CREATE_PAGES) registered.add(`${BIZ}/${c.path}`);
for (const r of registered) covered.add(r);

const missing = routes.filter((r) => !covered.has(r) && !(r in EXCLUDED));
const routeSet = new Set(routes);
const stale = [...registered].filter((r) => !routeSet.has(r));
const staleExcluded = Object.keys(EXCLUDED).filter((r) => !routeSet.has(r));

console.log(
  `${routes.length} page routes · ${covered.size} reachable from ⌘K · ${Object.keys(EXCLUDED).length} excluded`,
);
for (const r of missing) console.log(`FAIL not in ⌘K: ${r}`);
for (const r of stale) console.log(`FAIL registry entry has no page: ${r}`);
for (const r of staleExcluded) console.log(`FAIL exclusion names no page: ${r}`);

if (missing.length + stale.length + staleExcluded.length > 0) {
  console.error(
    "\nAdd the page to dashboard/lib/palette-pages.ts (label = the page's own header), " +
      "or to EXCLUDED here with a reason.",
  );
  process.exit(1);
}
console.log("\npalette coverage: ok");
