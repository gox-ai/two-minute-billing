/**
 * Proves the billing clock renews subscriptions: backdate a sub's period end,
 * run a tick, and assert a fresh invoice was generated + the period advanced.
 * Also proves trial → active on the first renewal.
 *
 *   pnpm verify:renewal
 */
import { and, eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { addSubscriptionItem } from "@/modules/subscriptions/items";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { startTimeTravel, travelForward } from "@/modules/time-travel/service";
import { subscriptions, invoices, invoiceLineItems, subscriptionItems, payments } from "@db/schema";

const org = await createOrganization({ name: "Renewal Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "r@a.com",
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_4242",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 5000,
  interval: "month",
});

function countInvoices(subId: string) {
  return withTenant(orgId, async (tx) => {
    const rows = await tx.select().from(invoices).where(eq(invoices.subscriptionId, subId));
    return rows;
  });
}
function getSub(subId: string) {
  return withTenant(orgId, async (tx) => {
    const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1);
    return s!;
  });
}
// Backdate a sub's period end (admin connection) so the clock treats it as due.
function backdate(subId: string, end: Date) {
  return systemDb
    .update(subscriptions)
    .set({ currentPeriodEnd: end })
    .where(eq(subscriptions.id, subId));
}

const past = new Date(Date.now() - 60_000);

// --- Case 1: active monthly sub renews ---
const c1 = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price, quantity: 1 }],
});
// bill-in-advance happens in the route; here invoice it manually for the first period:
const { billSubscriptionPeriod } = await import("@/modules/invoicing/service");
await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: c1.subscription,
  periodStart: c1.subscription.currentPeriodStart!,
  periodEnd: c1.subscription.currentPeriodEnd!,
});
const before1 = (await countInvoices(c1.subscription.id)).length;
await backdate(c1.subscription.id, past);
await runBillingClockTick(new Date());
const after1 = (await countInvoices(c1.subscription.id)).length;
const sub1 = await getSub(c1.subscription.id);
// After renewal the new period end should be ~1 month past the backdated end.
const advanced = sub1.currentPeriodEnd!.getTime() > past.getTime();
console.log(
  `Case 1 (active renew): invoices ${before1} -> ${after1}, status=${sub1.status}, advanced=${advanced}`,
);
// The renewal's payment records which method type paid (0397), not only pay-now captures.
const renewalPays = await withTenant(orgId, (tx) =>
  tx
    .select({ status: payments.status, methodType: payments.methodType })
    .from(payments)
    .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
    .where(eq(invoices.subscriptionId, c1.subscription.id)),
);
const renewalMethodTyped =
  renewalPays.some((p) => p.status === "succeeded") &&
  renewalPays.every((p) => p.methodType === "card");
console.log(
  `Case 1 payments.method_type: ${renewalPays.map((p) => `${p.status}:${p.methodType}`).join(", ")}`,
);

// --- Case 2: trialing sub becomes active on first renewal ---
const c2 = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price, quantity: 1 }],
  trialDays: 14,
});
console.log(`Case 2 start: status=${c2.subscription.status}`);
const before2 = (await countInvoices(c2.subscription.id)).length;
await backdate(c2.subscription.id, past); // trial "ended"
await runBillingClockTick(new Date());
const after2 = (await countInvoices(c2.subscription.id)).length;
const sub2 = await getSub(c2.subscription.id);
console.log(`Case 2 (trial->active): invoices ${before2} -> ${after2}, status=${sub2.status}`);

// A trial converting IS the activation, and it must STAMP activated_at — this path
// emitted subscription_activated but left the column null, so a converted sub read
// `active` with no "Active on" in the timeline (found 2026-08-02). The instant is the
// new TERM START (= the trial end), not when the tick happened to run.
const activatedStamped = sub2.activatedAt != null;
const activatedAtTermStart =
  sub2.activatedAt != null && sub2.activatedAt.getTime() === sub2.currentPeriodStart!.getTime();
console.log(
  `Case 2 activated_at=${sub2.activatedAt?.toISOString() ?? "NULL"} (term start ${sub2.currentPeriodStart!.toISOString()})`,
);

// A LATER renewal of an already-active sub must not move activated_at.
const firstActivation = sub2.activatedAt;
await backdate(c2.subscription.id, past);
await runBillingClockTick(new Date());
const sub2b = await getSub(c2.subscription.id);
const activationStable = sub2b.activatedAt?.getTime() === firstActivation?.getTime();
console.log(`Case 2b (renew again): activated_at unchanged=${activationStable}`);

// --- Case 3: a ONE-TIME item is billed ONCE, never re-billed by a renewal ---
// 🔴 Money bug (2026-08-03): `planSubscriptionPeriodInvoice` rates every non-metered
// item from its snapshot EVERY period, and the only brake was an item-level
// `billing_cycles` cap that nothing sets — so a one-off setup fee attached as a
// subscription item recurred forever. Driven by Time Travel (the real pipeline
// at a simulated instant), not by backdating, because the point is what the RENEWAL
// invoice contains.
const DAY = 86_400_000;
const G = new Date("2027-03-01T00:00:00.000Z");
const biz3 = await createBusiness({
  organizationId: orgId,
  name: "OneTime biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const cust3 = await createCustomer({
  organizationId: orgId,
  businessId: biz3.id,
  email: "ot@a.com",
  autoCollection: "on",
  address: { country: "US" },
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz3.id,
  customer: cust3,
  token: "tok_4242",
});
const plan3 = await createProduct({
  organizationId: orgId,
  businessId: biz3.id,
  name: "Plan OT",
  id: "ot-plan",
  kind: "plan",
});
const planPrice3 = await createPrice({
  organizationId: orgId,
  businessId: biz3.id,
  productId: plan3.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 5000,
  interval: "month",
});
const setup3 = await createProduct({
  organizationId: orgId,
  businessId: biz3.id,
  name: "Onboarding setup",
  id: "ot-setup",
  kind: "charge",
});
const setupPrice3 = await createPrice({
  organizationId: orgId,
  businessId: biz3.id,
  productId: setup3.id,
  type: "one_time",
  model: "flat",
  currency: "USD",
  amountMinor: 3000,
});

await startTimeTravel({ orgId, bizId: biz3.id, genesisTime: G });
const c3 = await createSubscription({
  organizationId: orgId,
  businessId: biz3.id,
  customerId: cust3.id,
  now: G,
  items: [{ price: planPrice3, quantity: 1 }],
});
// First period invoice (the route does this in production; Case 1 does the same).
await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz3.id,
  subscription: c3.subscription,
  periodStart: c3.subscription.currentPeriodStart!,
  periodEnd: c3.subscription.currentPeriodEnd!,
});

// Mid-term: attach the one-time fee. It must be charged in FULL (3000, not a
// prorated ~2500) on its own invoice — the fix that landed earlier today.
await travelForward({ orgId, bizId: biz3.id, toTime: new Date(G.getTime() + 5 * DAY) });
const added = await addSubscriptionItem({
  organizationId: orgId,
  businessId: biz3.id,
  subscriptionId: c3.subscription.id,
  price: setupPrice3,
  quantity: 1,
  now: new Date(G.getTime() + 5 * DAY),
  invoiceImmediately: true,
});
const oneTimeChargedFull = Number(added.invoice?.subtotalMinor ?? -1) === 3000;
console.log(
  `Case 3 attach: one-time invoice subtotal=${Number(added.invoice?.subtotalMinor ?? -1)} (expect the FULL 3000 — a prorated slice of the remaining term would be less)`,
);

const linesOf = (invoiceId: string) =>
  withTenant(orgId, (tx) =>
    tx
      .select({
        description: invoiceLineItems.description,
        kind: invoiceLineItems.kind,
        amountMinor: invoiceLineItems.amountMinor,
        priceId: invoiceLineItems.priceId,
      })
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoiceId)),
  );
const invoiceIdsFor = async (subId: string) =>
  new Set((await countInvoices(subId)).map((i) => i.id));

// Renew: travel past the first term end (G+31d for a March monthly term).
const idsBeforeRenewal = await invoiceIdsFor(c3.subscription.id);
await travelForward({ orgId, bizId: biz3.id, toTime: new Date(G.getTime() + 35 * DAY) });
const renewalInvoices = (await countInvoices(c3.subscription.id)).filter(
  (i) => !idsBeforeRenewal.has(i.id),
);
const renewalLines = (await Promise.all(renewalInvoices.map((i) => linesOf(i.id)))).flat();
const chargeLines = renewalLines.filter(
  (l) => l.kind === "recurring" || l.kind === "one_time" || l.kind === "proration",
);
const renewalHasPlan = chargeLines.some(
  (l) => l.priceId === planPrice3.id && Number(l.amountMinor) === 5000,
);
const renewalHasOneTime = chargeLines.some((l) => l.priceId === setupPrice3.id);
// The item is NOT detached — it stays part of the subscription, it just stops rating.
const itemStillAttached = await withTenant(orgId, async (tx) => {
  const rows = await tx
    .select()
    .from(subscriptionItems)
    .where(
      and(
        eq(subscriptionItems.subscriptionId, c3.subscription.id),
        eq(subscriptionItems.priceId, setupPrice3.id),
      ),
    );
  return rows.length === 1;
});
console.log(
  `Case 3 renewal: ${renewalInvoices.length} new invoice(s), charge lines=[${chargeLines.map((l) => `${l.kind}:${Number(l.amountMinor)}:${l.description}`).join(" | ")}]`,
);
console.log(
  `Case 3 renewal: recurring plan line present=${renewalHasPlan}, one-time line present=${renewalHasOneTime} (must be false), item still attached=${itemStillAttached}`,
);

// A SECOND renewal must not resurrect it either (the cap is durable, not one-shot).
const idsBeforeRenewal2 = await invoiceIdsFor(c3.subscription.id);
await travelForward({ orgId, bizId: biz3.id, toTime: new Date(G.getTime() + 66 * DAY) });
const renewal2Lines = (
  await Promise.all(
    (await countInvoices(c3.subscription.id))
      .filter((i) => !idsBeforeRenewal2.has(i.id))
      .map((i) => linesOf(i.id)),
  )
).flat();
const renewal2HasOneTime = renewal2Lines.some((l) => l.priceId === setupPrice3.id);
const renewal2HasPlan = renewal2Lines.some(
  (l) => l.priceId === planPrice3.id && Number(l.amountMinor) === 5000,
);
console.log(
  `Case 3 renewal #2: one-time line present=${renewal2HasOneTime} (must be false), plan line present=${renewal2HasPlan}`,
);

const case3 =
  oneTimeChargedFull &&
  renewalInvoices.length === 1 &&
  renewalHasPlan &&
  !renewalHasOneTime &&
  itemStillAttached &&
  renewal2HasPlan &&
  !renewal2HasOneTime;
console.log(`Case 3 (one-time item not re-billed): ${case3 ? "PASS" : "FAIL"}`);

// --- Case 4: the two paths that MUST still bill a one-time item, in full ---
// The implicit one-cycle cap is derived from `cycles_billed`, so it can only skip a
// fee that has ALREADY been billed. These are the two paths where the FIRST bill is
// the period invoice itself, and skipping there would lose the money outright:
//   (a) a one-time price attached at CREATE → the first period invoice bills it;
//   (b) a one-time price attached DURING A TRIAL → `addSubscriptionItem` deliberately
//       defers (charges 0 now) and the trial-end conversion invoice bills it in full.
const G4 = new Date("2027-06-01T00:00:00.000Z");
const biz4 = await createBusiness({
  organizationId: orgId,
  name: "OneTime biz 2",
  defaultCurrency: "USD",
  livemode: "test",
});
const cust4 = await createCustomer({
  organizationId: orgId,
  businessId: biz4.id,
  email: "ot2@a.com",
  autoCollection: "on",
  address: { country: "US" },
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz4.id,
  customer: cust4,
  token: "tok_4242",
});
const plan4 = await createProduct({
  organizationId: orgId,
  businessId: biz4.id,
  name: "Plan OT2",
  id: "ot2-plan",
  kind: "plan",
});
const planPrice4 = await createPrice({
  organizationId: orgId,
  businessId: biz4.id,
  productId: plan4.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 5000,
  interval: "month",
});
const setup4product = await createProduct({
  organizationId: orgId,
  businessId: biz4.id,
  name: "Onboarding setup 2",
  id: "ot2-setup",
  kind: "charge",
});
const setupPrice4 = await createPrice({
  organizationId: orgId,
  businessId: biz4.id,
  productId: setup4product.id,
  type: "one_time",
  model: "flat",
  currency: "USD",
  amountMinor: 3000,
});
await startTimeTravel({ orgId, bizId: biz4.id, genesisTime: G4 });

// (a) attached at CREATE
const cD = await createSubscription({
  organizationId: orgId,
  businessId: biz4.id,
  customerId: cust4.id,
  now: G4,
  items: [
    { price: planPrice4, quantity: 1 },
    { price: setupPrice4, quantity: 1 },
  ],
});
const { invoice: firstD } = await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz4.id,
  subscription: cD.subscription,
  periodStart: cD.subscription.currentPeriodStart!,
  periodEnd: cD.subscription.currentPeriodEnd!,
});
const firstDLines = await linesOf(firstD.id);
const firstDBillsOneTime = firstDLines.some(
  (l) => l.priceId === setupPrice4.id && Number(l.amountMinor) === 3000 && l.kind === "one_time",
);
const firstDBillsPlan = firstDLines.some(
  (l) => l.priceId === planPrice4.id && Number(l.amountMinor) === 5000,
);
console.log(
  `Case 4a create-time attach: first invoice total=${Number(firstD.totalMinor)} lines=[${firstDLines.map((l) => `${l.kind}:${Number(l.amountMinor)}`).join(" | ")}] (one-time billed=${firstDBillsOneTime})`,
);

// (b) attached DURING A TRIAL
const cE = await createSubscription({
  organizationId: orgId,
  businessId: biz4.id,
  customerId: cust4.id,
  now: G4,
  trialDays: 10,
  items: [{ price: planPrice4, quantity: 1 }],
});
await travelForward({ orgId, bizId: biz4.id, toTime: new Date(G4.getTime() + 3 * DAY) });
const addedInTrial = await addSubscriptionItem({
  organizationId: orgId,
  businessId: biz4.id,
  subscriptionId: cE.subscription.id,
  price: setupPrice4,
  quantity: 1,
  now: new Date(G4.getTime() + 3 * DAY),
  invoiceImmediately: true,
});
const trialAddDeferred = addedInTrial.invoice === null;
// Trial ends at G4+10 → the conversion invoice bills the first paid period.
const idsBeforeConversion = await invoiceIdsFor(cE.subscription.id);
await travelForward({ orgId, bizId: biz4.id, toTime: new Date(G4.getTime() + 12 * DAY) });
const conversionLines = (
  await Promise.all(
    (await countInvoices(cE.subscription.id))
      .filter((i) => !idsBeforeConversion.has(i.id))
      .map((i) => linesOf(i.id)),
  )
).flat();
const conversionBillsOneTimeFull = conversionLines.some(
  (l) => l.priceId === setupPrice4.id && Number(l.amountMinor) === 3000,
);
const conversionBillsPlan = conversionLines.some(
  (l) => l.priceId === planPrice4.id && Number(l.amountMinor) === 5000,
);
console.log(
  `Case 4b trial add: charged now=${trialAddDeferred ? "nothing (deferred)" : "SOMETHING"}; conversion lines=[${conversionLines.map((l) => `${l.kind}:${Number(l.amountMinor)}`).join(" | ")}] (one-time billed in full=${conversionBillsOneTimeFull})`,
);

// Both must then STOP: renew each once more and assert no one-time line.
const idsBeforeD2 = await invoiceIdsFor(cD.subscription.id);
const idsBeforeE2 = await invoiceIdsFor(cE.subscription.id);
await travelForward({ orgId, bizId: biz4.id, toTime: new Date(G4.getTime() + 45 * DAY) });
const dRenewalLines = (
  await Promise.all(
    (await countInvoices(cD.subscription.id))
      .filter((i) => !idsBeforeD2.has(i.id))
      .map((i) => linesOf(i.id)),
  )
).flat();
const eRenewalLines = (
  await Promise.all(
    (await countInvoices(cE.subscription.id))
      .filter((i) => !idsBeforeE2.has(i.id))
      .map((i) => linesOf(i.id)),
  )
).flat();
const dRenewalClean =
  dRenewalLines.some((l) => l.priceId === planPrice4.id) &&
  !dRenewalLines.some((l) => l.priceId === setupPrice4.id);
const eRenewalClean =
  eRenewalLines.some((l) => l.priceId === planPrice4.id) &&
  !eRenewalLines.some((l) => l.priceId === setupPrice4.id);
console.log(
  `Case 4 renewals: create-attached sub clean=${dRenewalClean} [${dRenewalLines.map((l) => `${l.kind}:${Number(l.amountMinor)}`).join(" | ")}], trial-attached sub clean=${eRenewalClean} [${eRenewalLines.map((l) => `${l.kind}:${Number(l.amountMinor)}`).join(" | ")}]`,
);

const case4 =
  firstDBillsOneTime &&
  firstDBillsPlan &&
  Number(firstD.totalMinor) === 8000 &&
  trialAddDeferred &&
  conversionBillsOneTimeFull &&
  conversionBillsPlan &&
  dRenewalClean &&
  eRenewalClean;
console.log(
  `Case 4 (one-time still billed once, in full, on create + trial-end): ${case4 ? "PASS" : "FAIL"}`,
);

const pass =
  after1 === before1 + 1 &&
  sub1.status === "active" &&
  advanced &&
  renewalMethodTyped &&
  c2.subscription.status === "in_trial" &&
  after2 === before2 + 1 &&
  sub2.status === "active" &&
  activatedStamped &&
  activatedAtTermStart &&
  activationStable &&
  case3 &&
  case4;

console.log("");
console.log(pass ? "✅ RENEWAL: PASS" : "❌ RENEWAL: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
