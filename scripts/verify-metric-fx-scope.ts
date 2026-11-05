/**
 * WHOSE CURRENCY A SEMANTIC-LAYER ANSWER IS STATED IN.
 *
 * `metric_daily` holds money per currency and never sums across them, so every multi-currency
 * money measure needs a reporting currency and a rate for each one present. `resolveScope`
 * chooses that pair — and it used to read the ORGANIZATION's for both scopes.
 *
 * That is wrong for a single business, which bills in its own currency and quotes its own
 * rates against it. Measured on the golden fixture (a EUR rate set on the BUSINESS, the
 * organization with no base currency at all), the resolver REFUSED every multi-currency money
 * measure the business could answer perfectly well.
 *
 * The rule this gate holds in place:
 *   1. a SINGLE BUSINESS answers in its own default currency, at its own rates;
 *   2. an ORGANIZATION answers in the organization's — the only pair that spans the account;
 *   3. the business wins even when the organization has a base currency of its own;
 *   4. a business with no default falls back to the organization's pair, whole;
 *   5. CURRENCY AND RATES TRAVEL TOGETHER — a rate quoted against one base applied to another
 *      is a wrong number, not a missing one, so the two are never taken from different rows;
 *   6. what the payload publishes (`currency`, `rates`, `missing_rates`, `currency_basis`) is
 *      the pair that was actually used, so a converted figure can be re-derived;
 *   7. a single-currency measure is untouched by any of it.
 *
 *   pnpm verify:metric-fx-scope
 */
import { eq } from "drizzle-orm";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { writeMetricDay } from "@/modules/metrics/daily/write";
import { resolveAnalytics, resolveScope } from "@/modules/metrics/daily/public-query";
import { MeasureRefused } from "@/modules/metrics/daily/query";
import { businesses, organizations } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const NOW = new Date("2026-09-15T12:00:00.000Z");

const org = await createOrganization({ name: "FX Scope Org" });
const orgId = org.organization.id;
/** A brand new organization must start with NO base currency, or property 1 is untestable. */
const [orgRow] = await withTenant(orgId, (tx) =>
  tx
    .select({ baseCurrency: organizations.baseCurrency })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1),
);
ok("seed: the organization has never chosen a base currency", orgRow?.baseCurrency == null);

const biz = await createBusiness({
  organizationId: orgId,
  name: "FX Scope Biz",
  defaultCurrency: "EUR",
  livemode: "test",
  timezone: "UTC",
});
const bizId = biz.id;
/** Quoted against the BUSINESS's default: 1 EUR = 1.1 USD. */
await systemDb
  .update(businesses)
  .set({ exchangeRates: { USD: 1.1 } })
  .where(eq(businesses.id, bizId));

/** A second business, EUR with no rates of its own. (A business with NO default currency cannot exist since 0499.) */
const bare = await createBusiness({
  organizationId: orgId,
  name: "FX Scope Bare Biz",
  defaultCurrency: "EUR",
  livemode: "test",
  timezone: "UTC",
});
await systemDb.update(businesses).set({ exchangeRates: null }).where(eq(businesses.id, bare.id));

/**
 * Two currencies in the store, so a money measure has something to refuse over.
 *
 * A summed measure is stored at DAY grain and folded up at read time, so that is where both
 * of these live and the reader is left to do what it does in production. The count is held in
 * two currencies too — a count is currency-agnostic because of its UNIT, not because it has
 * only one currency on file.
 */
const PERIOD = "2026-09-30";
for (const b of [bizId, bare.id]) {
  await writeMetricDay({
    organizationId: orgId,
    businessId: b,
    grain: "day",
    periodEnd: "2026-09-10",
    rows: [
      { measure: "payments_captured", dim: "", dimValue: "", currency: "EUR", value: 10_000n },
      { measure: "payments_captured", dim: "", dimValue: "", currency: "USD", value: 22_000n },
      { measure: "trials_started", dim: "", dimValue: "", currency: "EUR", value: 3n },
      { measure: "trials_started", dim: "", dimValue: "", currency: "USD", value: 4n },
    ],
  });
}

const scopeOf = async (b: { id: string; publicId: string; name: string } | null) =>
  resolveScope(
    orgId,
    b ? { id: b.id, publicId: b.publicId, name: b.name, timezone: "UTC" } : null,
    "test",
  );

const ask = (scope: Awaited<ReturnType<typeof scopeOf>>, measure: string) =>
  resolveAnalytics(scope, { measure, grain: "month", start: "2026-09-01", end: PERIOD }, NOW);

/**
 * The answer, or null with the refusal printed. A gate about whether a question CAN be
 * answered must record a refusal as a failed check, not crash on it — a mutation that puts
 * the refusal back would otherwise kill the run instead of failing it.
 */
async function tryAsk(scope: Awaited<ReturnType<typeof scopeOf>>, measure: string) {
  try {
    return await ask(scope, measure);
  } catch (e) {
    console.log(`  ↳ refused ${measure}:`, e instanceof MeasureRefused ? e.message : String(e));
    return null;
  }
}

/** Whether a question REFUSES, and in which words. */
async function refusal(scope: Awaited<ReturnType<typeof scopeOf>>, measure: string) {
  try {
    await ask(scope, measure);
    return null;
  } catch (e) {
    return e instanceof MeasureRefused ? e.message : `threw ${String(e)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. A SINGLE BUSINESS answers in its own currency, at its own rates.
// ─────────────────────────────────────────────────────────────────────────────
{
  const scope = await scopeOf(biz);
  ok(
    "business scope: the reporting pair is the BUSINESS's, and says so",
    scope.baseCurrency === "EUR" &&
      scope.baseCurrencySource === "business" &&
      scope.exchangeRates?.USD === 1.1,
  );

  const r = await tryAsk(scope, "payments_captured");
  // 10,000 EUR + 22,000 USD at 1 EUR = 1.1 USD → 10,000 + 20,000 = 30,000 EUR.
  ok(
    "business scope: a multi-currency money measure is ANSWERED, converted into the business's currency",
    r?.currency === "EUR" && r.currency_basis === "converted" && r.total === 30_000,
  );
  ok(
    "business scope: the payload publishes the rates it used, so the figure can be re-derived",
    r?.rates?.USD === 1.1 && (r.missing_rates ?? []).length === 0,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE ORGANIZATION keeps the organization's — and with none set, still refuses.
// ─────────────────────────────────────────────────────────────────────────────
{
  const scope = await scopeOf(null);
  ok(
    "organization scope: the pair is the organization's, which here is none at all",
    scope.baseCurrency === null && scope.baseCurrencySource === "none",
  );
  const why = await refusal(scope, "payments_captured");
  ok(
    "organization scope: with no base currency the account-wide question refuses, naming the options",
    why != null && why.includes("EUR") && why.includes("USD") && why.includes("organization"),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 & 5. The business wins over an organization that HAS a base — and the rates come
//        from the same row as the currency, never from the other one.
// ─────────────────────────────────────────────────────────────────────────────
await systemDb
  .update(organizations)
  // Deliberately a different base AND a rate that would give a different total, so a mixed
  // pair shows up as a number rather than as an absence.
  .set({ baseCurrency: "USD", exchangeRates: { EUR: 0.5 } })
  .where(eq(organizations.id, orgId));
{
  const scope = await scopeOf(biz);
  ok(
    "precedence: the business's own default wins over an organization base currency",
    scope.baseCurrency === "EUR" && scope.baseCurrencySource === "business",
  );
  ok(
    "precedence: and its rates come with it — the organization's EUR rate is nowhere in the answer",
    scope.exchangeRates?.USD === 1.1 && scope.exchangeRates?.EUR === undefined,
  );
  const r = await tryAsk(scope, "payments_captured");
  ok(
    "precedence: the converted total is the business's arithmetic, not the organization's",
    r?.currency === "EUR" && r.total === 30_000,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. The organization-wide answer now converts too — the part that was already right.
// ─────────────────────────────────────────────────────────────────────────────
{
  const scope = await scopeOf(null);
  const r = await tryAsk(scope, "payments_captured");
  // Both businesses, both currencies: 44,000 USD + 20,000 EUR at 0.5 → 44,000 + 40,000.
  ok(
    "organization scope: unchanged — the account-wide answer is the organization's pair",
    scope.baseCurrencySource === "organization" && r?.currency === "USD" && r.total === 84_000,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. None of this touches a measure that has no currency to choose between.
// ─────────────────────────────────────────────────────────────────────────────
{
  const bizScope = await scopeOf(biz);
  const orgScope = await scopeOf(null);
  const a = await tryAsk(bizScope, "trials_started");
  const b = await tryAsk(orgScope, "trials_started");
  ok(
    "a count is currency-agnostic under either scope, and names no currency at all",
    a?.currency === null &&
      a.currency_basis === "across_currencies" &&
      b?.currency === null &&
      a.total === 7 &&
      b.total === 14,
  );
}

for (const [name, passed] of checks) console.log(`  ${passed ? "✓" : "✗"} ${name}`);
const failed = checks.filter(([, c]) => !c);
console.log("");
const verdict = failed.length === 0;
console.log(
  verdict
    ? `✅ METRIC-FX-SCOPE: PASS (${checks.length}/${checks.length})`
    : `❌ METRIC-FX-SCOPE: FAIL (${failed.length}/${checks.length} failed)`,
);
await closeDb();
process.exit(verdict ? 0 : 1);
