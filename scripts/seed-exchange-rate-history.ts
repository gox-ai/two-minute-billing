/**
 * Seed `exchange_rate_history` from the rates every business holds RIGHT NOW — the
 * cutover step for 0264.
 *
 * `businesses.exchange_rates` is overwritten in place, so the values standing today are
 * the only ones that exist: there is no earlier rate to recover, and inventing one would
 * be worse than having none. This records today's as each business's first observation
 * and stops there.
 *
 * ⚠️ IT RESTATES NOTHING, BY CONSTRUCTION. A reader asked for the rate at an instant with
 * no earlier observation answers with the CURRENT rate — the rate every converted figure
 * already uses. So after this runs, every bucket on every screen converts exactly as it
 * did before, and the FX line reads zero. FX becomes a real number only as the rates move
 * from here.
 *
 * Idempotent: a business that already has an observation is skipped, so a re-run after a
 * real rate change cannot backdate that change away.
 *
 * Cross-organization (the base `db` handle, as `platform/db.ts` documents for admin
 * operations that span orgs), writing through `withTenant` per business so RLS holds.
 *
 *   pnpm fx:seed-history              # dry run, every business
 *   pnpm fx:seed-history --write
 *   pnpm fx:seed-history --biz biz_… --write
 */
import { eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { businesses, organizations, exchangeRateHistory } from "@db/schema";
import { recordExchangeRateObservations } from "@/platform/fx/history";

const arg = (flag: string): string | null => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
};
const WRITE = process.argv.includes("--write");
const BIZ = arg("--biz");
const ORG = arg("--org");

const rows = await systemDb
  .select({
    id: businesses.id,
    publicId: businesses.publicId,
    name: businesses.name,
    organizationId: businesses.organizationId,
    orgPublicId: organizations.publicId,
    defaultCurrency: businesses.defaultCurrency,
    exchangeRates: businesses.exchangeRates,
  })
  .from(businesses)
  .innerJoin(organizations, eq(organizations.id, businesses.organizationId));

const targets = rows.filter((r) => {
  if (BIZ) return r.publicId === BIZ;
  if (ORG) return r.orgPublicId === ORG;
  return true;
});

let seeded = 0;
let skipped = 0;
for (const biz of targets) {
  const rates = (biz.exchangeRates ?? {}) as Record<string, unknown>;
  const codes = Object.keys(rates).filter(
    (c) => c.toUpperCase() !== biz.defaultCurrency?.toUpperCase(),
  );
  if (!biz.defaultCurrency) {
    console.log(`  – ${biz.publicId} ${biz.name}: no default currency, nothing to quote against`);
    skipped++;
    continue;
  }
  if (codes.length === 0) {
    console.log(`  – ${biz.publicId} ${biz.name}: no rates held`);
    skipped++;
    continue;
  }
  const existing = await withTenant(biz.organizationId, (tx) =>
    tx
      .select({ id: exchangeRateHistory.id })
      .from(exchangeRateHistory)
      .where(eq(exchangeRateHistory.businessId, biz.id))
      .limit(1),
  );
  if (existing.length > 0) {
    console.log(`  – ${biz.publicId} ${biz.name}: already has history`);
    skipped++;
    continue;
  }
  const shown = codes.map((c) => `${c}=${String(rates[c])}`).join(" ");
  if (!WRITE) {
    console.log(`  · ${biz.publicId} ${biz.name}: would seed base=${biz.defaultCurrency} ${shown}`);
    seeded++;
    continue;
  }
  const n = await withTenant(biz.organizationId, (tx) =>
    recordExchangeRateObservations(tx, {
      organizationId: biz.organizationId,
      businessId: biz.id,
    }),
  );
  console.log(
    `  ✓ ${biz.publicId} ${biz.name}: ${n} observation(s) — base=${biz.defaultCurrency} ${shown}`,
  );
  seeded++;
}

console.log(
  `\n${WRITE ? "seeded" : "would seed"} ${seeded} business(es); skipped ${skipped}` +
    (WRITE ? "" : "  — pass --write to apply"),
);
await closeDb();
