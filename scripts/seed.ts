/**
 * Seed a fresh, browsable dataset: one org ("Demo Org", login admin@example.com) with three
 * test businesses whose 10–14 months of history were produced by the real billing engine.
 *
 *   pnpm seed                # load the captured snapshot (seconds), history ending today
 *   pnpm seed --small        # the smaller snapshot (fewer months and customers)
 *   pnpm seed --live         # run the engine generator instead (minutes) — see seed/live.ts
 *   pnpm seed --write-env    # also write the org key into dashboard/.env.local (scripts only)
 *   pnpm seed --admin-email you@example.com   # a second copy next to an existing one
 *   pnpm seed:capture        # regenerate the snapshot in a throwaway database
 *   pnpm seed --fixture <dir>                 # load a snapshot from elsewhere
 *
 * Needs the geo rows (`pnpm geo:seed`). Signup refuses an email that already exists, so a
 * second load into the same database needs `--admin-email`.
 */
import "./seed/quiet";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { withTenant, closeDb, systemDb } from "@/platform/db";
import { organizations, users } from "@db/schema";
import { loadGeoReference } from "@/platform/geo";
import { signup } from "@/modules/auth/service";
import { runLive, type SeededBusiness } from "./seed/live";
import { loadSnapshot } from "./seed/load";
import { readManifest } from "./seed/snapshot";

// Geo reference data is an in-process cache loaded at boot; a script gets no boot, and
// India GST needs it (`GeoNotLoadedError` otherwise).
await loadGeoReference();

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const opt = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const writeEnv = flag("--write-env");
const small = flag("--small");
const reportJson = opt("--report-json"); // seed:capture reads the live run's summary from here
const LOGIN = {
  email: opt("--admin-email") ?? "admin@example.com",
  password: "Sparrow-Lantern-9134",
  name: "Admin",
};
const started = Date.now();
const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir =
  opt("--fixture") ?? join(here, "..", "db", "seed-data", "demo", small ? "small" : "full");

// A second load into the same database would collide on the login, not on data: say so up front.
const [taken] = await systemDb
  .select({ id: users.id })
  .from(users)
  .where(eq(users.email, LOGIN.email))
  .limit(1);
if (taken) {
  console.error(
    `✖ ${LOGIN.email} already exists in this database. Load another copy with --admin-email <other>, ` +
      "or start from an empty one (`pnpm db:reset`).",
  );
  await closeDb();
  process.exit(1);
}

let secret: string;
let orgPublicId: string;
let seeded: SeededBusiness[];
let mode = "snapshot";

const manifest = flag("--live") ? null : readManifest(fixtureDir);
const loaded = manifest ? await loadSnapshot({ dir: fixtureDir, manifest, login: LOGIN }) : null;
if (loaded?.ok) {
  ({ secret, orgPublicId, businesses: seeded } = loaded);
  const t = loaded.timings;
  console.log(
    `✅ loaded snapshot captured ${manifest!.capturedAt.slice(0, 10)} (${manifest!.migration?.tag ?? "baseline"}), ` +
      `${loaded.rows} rows, shifted +${loaded.shiftDays.org} days — ` +
      Object.entries(t)
        .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`)
        .join(" · "),
  );
} else {
  if (!flag("--live")) {
    console.log(
      loaded
        ? `⚠ snapshot not loaded — ${loaded.reason}\n  Falling back to the live engine generator (minutes). Run \`pnpm seed:capture\` to refresh the snapshot.`
        : `⚠ no snapshot at ${fixtureDir} — running the live engine generator (minutes). \`pnpm seed:capture\` creates one.`,
    );
  }
  mode = "live";
  const s = await signup({ ...LOGIN, organizationName: "Demo Org" });
  secret = s.dashboardKeySecret;
  orgPublicId = s.user.organizationPublicId;
  const orgId = s.user.organizationId;
  console.log(`✅ org + login user created: ${LOGIN.email} / ${LOGIN.password}`);
  // The local estate's one org is the platform operator: `/v1/ops/*` is gated on
  // `is_platform` (0196) and 403s without it.
  await withTenant(orgId, (tx) =>
    tx.update(organizations).set({ isPlatform: true }).where(eq(organizations.id, orgId)),
  );
  const { buildApp } = await import("@/index");
  const app = await buildApp({ logger: false });
  seeded = await runLive({ app, secret, orgId, small });
  await app.close();
  if (reportJson) {
    writeFileSync(
      reportJson,
      JSON.stringify({
        finishedAt: new Date().toISOString(),
        businesses: Object.fromEntries(seeded.map((b) => [b.name.split(" ")[0]!.toLowerCase(), b])),
      }),
    );
  }
}

if (writeEnv) {
  const envPath = join(here, "..", "dashboard", ".env.local");
  const line = `TMBILLING_API_KEY=${secret}`;
  if (existsSync(envPath)) {
    const updated = readFileSync(envPath, "utf8").replace(/^TMBILLING_API_KEY=.*$/m, line);
    writeFileSync(envPath, updated.includes(line) ? updated : updated + `\n${line}\n`);
  } else {
    writeFileSync(envPath, `TMBILLING_API_URL=http://localhost:4000\n${line}\n`);
  }
  console.log(`✅ wrote key into dashboard/.env.local (for scripts; the dashboard ignores it)`);
}

const fmt = (o: Record<string, number>) =>
  Object.entries(o)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
console.log("");
console.log(
  `✅ Seeded org ${orgPublicId} (${mode}) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
for (const s of seeded) {
  console.log(
    `\n   ${s.name} (${s.publicId}) — ${s.summary.customers} customers · MRR today ${s.summary.mrr}`,
  );
  console.log(`     subscriptions: ${fmt(s.summary.subs)}`);
  console.log(`     invoices:      ${fmt(s.summary.invoices)}`);
  console.log(`     payments:      ${s.summary.payments} succeeded`);
  for (const line of s.showcase) console.log(`     · ${line}`);
}
console.log("");
// The dashboard signs in with a session (0198); scripts and integrations need a key, and
// it is shown exactly once.
console.log("   ORG API KEY (for scripts/integrations, NOT the dashboard) — shown once:", secret);
if (!writeEnv) console.log("   → export TMBILLING_API_KEY=… to drive the API from a script");
console.log("");
console.log(
  "   Dashboard: http://localhost:4100/login  ·  login:",
  LOGIN.email,
  "/",
  LOGIN.password,
);

await closeDb();
process.exit(0);
