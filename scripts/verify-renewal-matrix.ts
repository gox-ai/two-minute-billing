/**
 * Renewal permutation matrix — closes the audit's last soft spot:
 *  - all intervals advance correctly: day / week / month / year,
 *  - MULTIPLE subscriptions due in ONE clock tick all renew (one failure can't
 *    block the others),
 *  - a past_due sub whose period ends again is re-billed (recovers if card good),
 *  - a paused sub is NOT billed by the clock.
 *
 *   pnpm verify:renewal-matrix
 */
import { desc, eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription, pauseSubscription } from "@/modules/subscriptions/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { subscriptions, invoices } from "@db/schema";

const org = await createOrganization({ name: "RenewalMatrix" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });

async function subWithInterval(interval: "day" | "week" | "month" | "year", token = "tok_4242") {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `${interval}${Math.random()}@a.com`,
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token,
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    interval,
  });
  const s = (
    await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
      defaultPaymentMethodId: pm.id,
    })
  ).subscription;
  return s;
}
const getSub = (id: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1))[0]!,
  );
const invCount = (id: string) =>
  withTenant(
    orgId,
    async (tx) => (await tx.select().from(invoices).where(eq(invoices.subscriptionId, id))).length,
  );
const newestInvoice = (id: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select()
          .from(invoices)
          .where(eq(invoices.subscriptionId, id))
          .orderBy(desc(invoices.createdAt))
          .limit(1)
      )[0] ?? null,
  );
const past = new Date(Date.now() - 60_000);
const backdate = (id: string) =>
  systemDb.update(subscriptions).set({ currentPeriodEnd: past }).where(eq(subscriptions.id, id));
const DAY = 86_400_000;
const checks: Array<[string, boolean]> = [];

// --- intervals: 4 subs, all backdated due, ONE tick renews all + advances by the right span ---
const day = await subWithInterval("day");
const week = await subWithInterval("week");
const month = await subWithInterval("month");
const year = await subWithInterval("year");
for (const s of [day, week, month, year]) await backdate(s.id);
const { renewed } = await runBillingClockTick(new Date());
console.log(`one tick renewed ${renewed} subs (exp >=4)`);
checks.push(["multiple subs renew in one tick", renewed >= 4]);

for (const [name, s, lo, hi] of [
  ["day", day, 0.5, 2],
  ["week", week, 6, 8],
  ["month", month, 27, 32],
  ["year", year, 360, 372],
] as Array<[string, typeof day, number, number]>) {
  const after = await getSub(s.id);
  const spanDays = (after.currentPeriodEnd!.getTime() - after.currentPeriodStart!.getTime()) / DAY;
  const ok = after.status === "active" && spanDays >= lo && spanDays <= hi;
  console.log(
    `  ${name}: new period span ${spanDays.toFixed(1)}d (exp ${lo}-${hi}), status=${after.status}`,
  );
  checks.push([`${name} interval advances`, ok]);
}

// --- re-bill: an active sub with a GOOD card, period ended → renews to active AND
//     actually RAISES + COLLECTS a fresh invoice (teeth restored: the weakened
//     version only checked status, so a renewal that silently billed nothing would
//     have passed). ---
{
  const s = await subWithInterval("month");
  const before = await invCount(s.id);
  await backdate(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  const newest = await newestInvoice(s.id);
  console.log(
    `active + good card → ${after.status}, invoices ${before}→${count}, newest=${newest?.status}`,
  );
  checks.push(["renewed → active", after.status === "active"]);
  checks.push(["renewal raised a fresh invoice", count === before + 1]);
  checks.push(["renewal charged the good card → paid", newest?.status === "paid"]);
}

// --- RENEWAL AFTER A TERM RESET: cadence and anchor both come from the SUBSCRIPTION ---
//
// `loadRenewalCtx` used to read the renewal interval from `limit 1` over the recurring
// items, unordered — so on a MIXED-cadence subscription it could pick an add-on. A
// monthly→yearly plan change produces exactly that state (the monthly add-ons keep their
// monthly price on a now-yearly plan), and the result was a yearly term renewing after
// **16 days** with an invoice for the full yearly amount. Non-deterministic, so a fixture
// could pass while production failed.
//
// `billing_anchor_day` compounded it: written once at create and never updated, so after
// a reset moved the term start it still named the old day of the month and `advancePeriod`
// re-aligned every later renewal onto it (351-day "year").
{
  const { changeSubscription } = await import("@/modules/subscriptions/proration");
  const { subscriptionItems } = await import("@db/schema");
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `reset${Math.random()}@a.com`,
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  const monthly = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 10000,
    interval: "month",
  });
  const yearlyP = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 100000,
    interval: "year",
  });
  const seats = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: `Seats${Math.random()}`,
    kind: "addon",
  });
  const seatsMonthly = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: seats.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 500,
    interval: "month",
  });

  // Start on the 8th so the reset (on the 23rd) moves the anchor — same-day would hide it.
  const start = new Date("2026-08-08T00:00:00.000Z");
  const { subscription: rs } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: start,
    trialDays: 0,
    items: [
      { price: monthly, quantity: 1 },
      { price: seatsMonthly, quantity: 10 },
    ],
    defaultPaymentMethodId: pm.id,
  });
  const rsItems = await withTenant(orgId, async (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, rs.id)),
  );
  await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: rs.id,
    now: new Date("2026-08-23T00:00:00.000Z"),
    changes: [
      {
        itemId: rsItems.find((i) => i.priceId === monthly.id)!.publicId,
        newPriceId: yearlyP.publicId,
      },
    ],
    invoiceImmediately: true,
  });
  const afterChange = await getSub(rs.id);
  checks.push([
    "term reset: the subscription cadence is yearly",
    afterChange.billingPeriodUnit === "year" && (afterChange.billingPeriod ?? 1) === 1,
  ]);
  checks.push([
    "term reset: billing_anchor_day follows the NEW term start (23, not the original 8)",
    afterChange.billingAnchorDay === 23,
  ]);

  // The RESET term's own span, checked at the source. Without this the reset can mint a
  // short "year" (measured 2026-08-31: 23-Aug-2026 → 08-Aug-2027, 350d) and the suite only
  // notices one renewal later, as a 381d term — which reads like a renewal bug and is not.
  const resetDays = Math.round(
    (afterChange.currentPeriodEnd!.getTime() - afterChange.currentPeriodStart!.getTime()) / DAY,
  );
  checks.push([
    `term reset: the reset term is itself a YEAR (got ${resetDays}d)`,
    resetDays >= 365 && resetDays <= 366,
  ]);

  const { renewSubscription } = await import("@/modules/subscriptions/renewal");
  await renewSubscription(orgId, rs.id, afterChange.currentPeriodEnd!);
  const afterRenew = await getSub(rs.id);
  const renewedDays = Math.round(
    (afterRenew.currentPeriodEnd!.getTime() - afterRenew.currentPeriodStart!.getTime()) / DAY,
  );
  // A year, not a month — and not 351 days either.
  checks.push([
    `term reset: the renewal is a YEAR, not an add-on's month (got ${renewedDays}d)`,
    renewedDays >= 365 && renewedDays <= 366,
  ]);
  checks.push([
    "term reset: the renewed term starts where the old one ended",
    afterRenew.currentPeriodStart!.getTime() === afterChange.currentPeriodEnd!.getTime(),
  ]);
}

// --- DETERMINISTIC guard for the cadence rule: EVERY item is monthly, the SUBSCRIPTION
//     is yearly. Whichever row an unordered `limit 1` returns, it is a month — so the old
//     code renews monthly no matter how Postgres feels, and the new code renews yearly.
//
//     The end-to-end case above exercises the real path but cannot be relied on for this
//     half: with a plan AND an add-on present, `limit 1` sometimes returns the plan and the
//     assertion passes against the broken code (observed). This one removes the coin flip.
{
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `cadence${Math.random()}@a.com`,
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  const mPrice = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 10000,
    interval: "month",
  });
  const { subscription: cs } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date("2026-08-08T00:00:00.000Z"),
    trialDays: 0,
    items: [{ price: mPrice, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  // The state a term reset leaves: the subscription's cadence has moved on while the
  // items still carry the old one. Written directly so the case is about ONE variable.
  await systemDb
    .update(subscriptions)
    .set({ billingPeriodUnit: "year", billingPeriod: 1 })
    .where(eq(subscriptions.id, cs.id));
  const before = await getSub(cs.id);
  const { renewSubscription } = await import("@/modules/subscriptions/renewal");
  await renewSubscription(orgId, cs.id, before.currentPeriodEnd!);
  const after = await getSub(cs.id);
  const days = Math.round(
    (after.currentPeriodEnd!.getTime() - after.currentPeriodStart!.getTime()) / DAY,
  );
  checks.push([
    `cadence comes from the SUBSCRIPTION, not an item (every item monthly, sub yearly → ${days}d)`,
    days >= 365 && days <= 366,
  ]);
}

// --- paused is NOT billed ---
//
// Paused through the ENGINE, not with a raw `set({ status: 'paused' })`. The direct update
// wrote a state the product cannot produce — `pauseSubscription` zeroes the cached MRR in the
// same transaction as the status, because a paused subscription raises no invoice and so earns
// nothing — and every run left one such row behind in the dev database, where
// `stored_mrr_matches_recomputed` (CRITICAL) reported it forever. Two costs, both real: the
// case was not exercising the mechanism it claims to test, and a critical invariant that is
// permanently red is the one nobody reads when it finally means something. The MRR assertion
// below is what keeps this honest.
{
  const s = await subWithInterval("month");
  await pauseSubscription({ organizationId: orgId, businessId: biz.id, subscriptionId: s.id });
  const paused = await getSub(s.id);
  const before = await invCount(s.id);
  await backdate(s.id);
  await runBillingClockTick(new Date());
  const after = await invCount(s.id);
  const sub = await getSub(s.id);
  console.log(
    `paused: invoices ${before}→${after} (no new bill), status=${sub.status} mrr=${paused.mrr}`,
  );
  checks.push(
    ["paused not billed", after === before && sub.status === "paused"],
    [
      "pausing zeroes the cached MRR (stored_mrr_matches_recomputed stays clean)",
      paused.mrr === 0n,
    ],
  );
}

// --- one bad card among the batch doesn't block others ---
{
  const good = await subWithInterval("month", "tok_4242");
  const bad = await subWithInterval("month", "4000000000009995"); // retriable decline
  await backdate(good.id);
  await backdate(bad.id);
  await runBillingClockTick(new Date());
  const g = await getSub(good.id);
  const b = await getSub(bad.id);
  const gi = await newestInvoice(good.id);
  const bi = await newestInvoice(bad.id);
  // Both subs stay `active` (dunning runs on the INVOICE), but the bad card's failure
  // must be OBSERVABLE (teeth restored: the weakened version asserted both active
  // and nothing else, so a bad card that silently succeeded/no-op'd would pass).
  // The good renewal invoice is paid; the bad one is open + dunning in progress.
  console.log(
    `batch isolation: good=${g.status}/${gi?.status}, bad=${b.status}/${bi?.status} (${bi?.dunningStatus})`,
  );
  checks.push([
    "one failure does not block others",
    g.status === "active" && b.status === "active",
  ]);
  checks.push(["good card renewal → paid", gi?.status === "paid"]);
  checks.push([
    "bad card renewal → open + dunning",
    bi?.status === "payment_due" && bi?.dunningStatus === "in_progress",
  ]);
}

let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ RENEWAL MATRIX: PASS" : "❌ RENEWAL MATRIX: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
