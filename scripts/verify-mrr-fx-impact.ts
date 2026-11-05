/**
 * `mrr_fx_impact` — the rate-driven part of a converted MRR change.
 *
 * A USD business with a USD and an INR subscription, and a rate history that moves inside
 * each window. Asserts FX equals the hand-computed drift, that the Business Home waterfall
 * (opening + flows + FX = closing) reconciles to the minor unit, that a movement no flow
 * measures is never labelled FX, and that a single-currency answer carries none.
 *
 *   pnpm verify:mrr-fx-impact
 */
import { eq } from "drizzle-orm";
import { closeDb, systemDb } from "@/platform/db";
import { createOrganization, createBusiness, updateBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { bulkFillMetricDays } from "@/modules/metrics/daily/bulk-fill";
import { resolveAnalytics, resolveScope } from "@/modules/metrics/daily/public-query";
import { MeasureRefused } from "@/modules/metrics/daily/query";
import { businesses, exchangeRateHistory, mrrMovements, subscriptions } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "FX Impact Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "FX Impact Biz",
  defaultCurrency: "USD",
  timezone: "UTC",
  livemode: "test",
});
await updateBusiness(orgId, biz.publicId, { exchangeRates: { INR: 94 } });
await systemDb
  .update(businesses)
  .set({ exchangeRateSources: { INR: { source: "auto" } } })
  .where(eq(businesses.id, biz.id));

// INR per USD: 75 through Feb, 80 from 15 Mar, 85 from 10 Apr, 90 from 20 Apr.
const RATES: Array<[string, string]> = [
  ["2022-02-01T00:00:00Z", "75"],
  ["2022-03-15T00:00:00Z", "80"],
  ["2022-04-10T00:00:00Z", "85"],
  ["2022-04-20T00:00:00Z", "90"],
];
await systemDb.insert(exchangeRateHistory).values(
  RATES.map(([at, rate]) => ({
    organizationId: orgId,
    businessId: biz.id,
    currency: "INR",
    baseCurrency: "USD",
    rate,
    effectiveFrom: new Date(at),
  })),
);

const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plan" });
const price = (currency: string, amountMinor: number) =>
  createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency,
    amountMinor,
    interval: "month",
  });
const PARKED = new Date(Date.now() + 365 * 86_400_000);
async function subscribe(currency: string, amountMinor: number, at: string) {
  const p = await price(currency, amountMinor);
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `fx-impact-${currency}-${amountMinor}-${Date.now()}@example.test`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(at),
    items: [{ price: p, quantity: 1 }],
  });
  // Park the term so a live worker never renews a subscription dated years back.
  await systemDb
    .update(subscriptions)
    .set({ currentPeriodEnd: PARKED })
    .where(eq(subscriptions.id, subscription.id));
  return { id: subscription.id, customerId: c.id, currency };
}
type Sub = Awaited<ReturnType<typeof subscribe>>;
async function move(s: Sub, reason: string, prev: number, next: number, at: string) {
  await systemDb.insert(mrrMovements).values({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: s.id,
    customerId: s.customerId,
    reason,
    planProductId: product.id,
    previousPlanProductId: product.id,
    currency: s.currency,
    previousMrrMinor: BigInt(prev),
    newMrrMinor: BigInt(next),
    deltaMinor: BigInt(next - prev),
    occurredAt: new Date(at),
  });
}

const A = await subscribe("USD", 5_000, "2022-01-10T10:00:00Z");
const B = await subscribe("INR", 900_000, "2022-01-10T10:00:00Z");
const E = await subscribe("INR", 200_000, "2022-01-10T10:00:00Z");

// April: every movement kind, across the two rate changes.
await move(B, "expansion", 900_000, 1_000_000, "2022-04-05T12:00:00Z"); // at 80
await move(A, "expansion", 5_000, 6_000, "2022-04-12T12:00:00Z");
const C = await subscribe("INR", 300_000, "2022-04-15T10:00:00Z"); // at 85
const D = await subscribe("USD", 2_000, "2022-04-16T10:00:00Z");
await move(B, "contraction", 1_000_000, 950_000, "2022-04-21T12:00:00Z"); // at 90
await move(C, "churn", 300_000, 0, "2022-04-22T12:00:00Z");
await move(C, "reactivation", 0, 300_000, "2022-04-25T12:00:00Z");
await move(D, "pause", 2_000, 0, "2022-04-27T12:00:00Z");
await move(E, "pause", 200_000, 0, "2022-04-12T12:00:00Z"); // at 85
// May, rate flat at 90: a pause and a resume. `resume` has no flow measure of its own.
await move(B, "pause", 950_000, 0, "2022-05-05T12:00:00Z");
await move(B, "resume", 0, 950_000, "2022-05-20T12:00:00Z");

const days: string[] = [];
for (
  let d = new Date("2022-02-27T00:00:00Z");
  d <= new Date("2022-05-31T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1)
)
  days.push(d.toISOString().slice(0, 10));
await bulkFillMetricDays({
  organizationId: orgId,
  businessId: biz.id,
  grain: "day",
  days,
  write: true,
  timezone: "UTC",
});

const scope = await resolveScope(orgId, {
  id: biz.id,
  publicId: biz.publicId,
  name: "FX Impact Biz",
  timezone: "UTC",
});
const NOW = new Date("2022-06-15T00:00:00Z");
const ask = (measure: string, start: string, end: string, extra: Record<string, string> = {}) =>
  resolveAnalytics(scope, { measure, grain: "month", start, end, ...extra }, NOW);
const usd = (inr: number, rate: number) => Math.round(inr / rate);

/** The Business Home card's own arithmetic, from the same answers it asks for. */
async function waterfall(start: string, end: string, extra: Record<string, string> = {}) {
  const mrr = await ask("mrr", start, end, { compare: "previous", ...extra });
  // A single-currency ask refuses a flow with nothing in that currency: that flow is 0.
  const flow = async (id: string) =>
    (
      await ask(id, start, end, extra).catch((e) => {
        if (e instanceof MeasureRefused) return null;
        throw e;
      })
    )?.total ?? 0;
  const fx = await ask("mrr_fx_impact", start, end, extra);
  const parts = {
    opening: mrr.compare?.previous_total ?? null,
    closing: mrr.total,
    new: await flow("mrr_new"),
    expansion: await flow("mrr_expansion"),
    reactivation: await flow("mrr_reactivation"),
    contraction: await flow("mrr_contraction"),
    churn: await flow("mrr_churn"),
    paused: await flow("mrr_paused"),
    fx: fx.total,
    fxBasis: fx.currency_basis,
    fxCurrency: fx.currency,
  };
  const drawn =
    (parts.opening ?? NaN) +
    parts.new +
    parts.expansion +
    parts.reactivation -
    parts.contraction -
    parts.churn -
    parts.paused +
    (parts.fx ?? NaN);
  return { ...parts, drawn };
}

// ── March: no movement at all, only the rate (75 → 80) ─────────────────────────────────
{
  const w = await waterfall("2022-03-01", "2022-03-31");
  console.log("march:", JSON.stringify(w));
  const opening = 5_000 + usd(1_100_000, 75);
  const closing = 5_000 + usd(1_100_000, 80);
  ok("march: opening is 28 Feb's book at 28 Feb's rate", w.opening === opening);
  ok("march: closing is 31 Mar's book at 31 Mar's rate", w.closing === closing);
  ok(
    `march: with nothing moving, FX is exactly the rate drift (${closing - opening})`,
    w.fx === closing - opening,
  );
  ok(
    "march: the answer is converted into USD",
    w.fxBasis === "converted" && w.fxCurrency === "USD",
  );
  ok("march: opening + FX = closing", w.drawn === w.closing);
}

// ── April: every movement kind, and two rate changes ──────────────────────────────────
{
  const w = await waterfall("2022-04-01", "2022-04-30");
  console.log("april:", JSON.stringify(w));
  const opening = 5_000 + usd(1_100_000, 80);
  const closing = 6_000 + usd(1_250_000, 90);
  const flows =
    usd(300_000, 85) +
    2_000 +
    (usd(100_000, 80) + 1_000) +
    usd(300_000, 90) -
    usd(50_000, 90) -
    usd(300_000, 90) -
    (2_000 + usd(200_000, 85));
  ok(
    "april: each flow converts at its own day's rate",
    w.new === usd(300_000, 85) + 2_000 && w.expansion === usd(100_000, 80) + 1_000,
  );
  ok(
    `april: FX = closing − opening − flows (${closing - opening - flows})`,
    w.fx === closing - opening - flows,
  );
  ok("april: FX is a loss when INR weakens (80 → 90)", (w.fx ?? 0) < 0);
  ok(
    "april: an INR-only flow is stated in the book's currency, converted (churn at 90)",
    w.churn === usd(300_000, 90) && w.contraction === usd(50_000, 90),
  );
  ok(
    "april: the waterfall reconciles to the minor unit — opening + new + expansion + reactivation − contraction − churn − paused + FX = closing",
    w.drawn === w.closing,
  );
  // A flow: the day series adds up to the month.
  const byDay = await resolveAnalytics(
    scope,
    { measure: "mrr_fx_impact", grain: "day", start: "2022-04-01", end: "2022-04-30" },
    NOW,
  );
  const sum = byDay.series.reduce((s, p) => s + (p.value ?? 0), 0);
  ok("april: the day series sums to the month's FX", sum === w.fx && byDay.total === w.fx);
  const on = (d: string) => byDay.series.find((p) => p.t === d)?.value;
  ok("april: a movement on a day the rate held adds no FX (5 Apr)", on("2022-04-05") === 0);
  ok(
    "april: the day the rate moved carries the book's drift (10 Apr, 80 → 85)",
    on("2022-04-10") === usd(1_200_000, 85) - usd(1_200_000, 80),
  );
}

// ── May: rate flat, a pause then a resume that no flow measures ──────────────────────────
{
  const w = await waterfall("2022-05-01", "2022-05-31");
  console.log("may:", JSON.stringify(w));
  ok("may: a flat rate carries no FX, even past a movement no flow measures", w.fx === 0);
  ok(
    "may: the unmeasured resume stays a gap of exactly its converted amount, not FX",
    (w.closing ?? 0) - w.drawn === usd(950_000, 90),
  );
}

// ── One currency: no FX by definition ─────────────────────────────────────────────────
{
  for (const ccy of ["INR", "USD"]) {
    const w = await waterfall("2022-04-01", "2022-04-30", { currency: ccy });
    console.log(`${ccy}:`, JSON.stringify(w));
    ok(
      `${ccy} only: FX is 0 and the answer is per currency`,
      w.fx === 0 && w.fxBasis === "per_currency",
    );
    ok(`${ccy} only: the native waterfall reconciles without it`, w.drawn === w.closing);
  }
}

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(
  failed === 0 ? `\nPASS — ${checks.length} checks` : `\nFAIL — ${failed}/${checks.length} failed`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
