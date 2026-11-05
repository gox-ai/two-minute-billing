/**
 * TRIAL CHANGE — a subscription in trial has been billed
 * NOTHING, so there is no charged term to prorate against. Changing its
 * composition mid-trial must move no money at all:
 *
 *  - `/change` (plan swap, quantity, custom price) → no proration invoice,
 *    no credit note, no payment,
 *  - `/items` add → no prorated charge; `/items` remove → no credit note,
 *  - the ESTIMATE must say the same thing: nothing due now, and the full
 *    post-change composition billed at TRIAL END (`due_at_trial_end`),
 *  - a term-reset change (plan swap / frequency change) may re-cadence but must
 *    NOT re-anchor the trial window — the trial end is a promise to the customer,
 *  - when the trial converts, ONE invoice bills the FULL new composition.
 *
 * Plus a regression guard: an ACTIVE subscription still prorates immediately.
 *
 * § F is a different invariant on the same state: **a trialing subscription's MRR is
 * 0 in ALL FIVE layers** — the stored column, the API field, the list cell's input,
 * the SQL `mrr` FILTER and the SQL `mrr` SORT — and becomes the real rate the moment
 * the trial converts. It is stored rather than adjusted at the boundary because the
 * filter and the sort run in SQL against `subscriptions.mrr`: a display-only fix left
 * `mrr[gt]=0` returning rows the screen showed as 0.00. The conversion half is the
 * load-bearing one — miss it and every converted subscription reports 0 MRR forever.
 *
 *   pnpm verify:trial-change
 */
import { eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription, listSubscriptionsPage } from "@/modules/subscriptions/service";
import { serializeSubscription } from "@/modules/subscriptions/serialize";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { addSubscriptionItem, removeSubscriptionItem } from "@/modules/subscriptions/items";
import { estimateChange } from "@/modules/subscriptions/estimate";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { startTimeTravel, travelForward } from "@/modules/time-travel/service";
import { subscriptions, subscriptionItems, invoices, creditNotes, payments } from "@db/schema";

const org = await createOrganization({ name: "Trial Change Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };

// per_unit everywhere so a quantity change actually re-rates.
const planProduct = await createProduct({ ...ctx, name: "Platform", kind: "plan" });
const planPrice = await createPrice({
  ...ctx,
  productId: planProduct.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 12900,
  interval: "month",
});
const planPriceYearly = await createPrice({
  ...ctx,
  productId: planProduct.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 129000,
  interval: "year",
});
const addonProduct = await createProduct({ ...ctx, name: "Additional connector", kind: "addon" });
const addonPrice = await createPrice({
  ...ctx,
  productId: addonProduct.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 47500,
  interval: "month",
});

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => checks.push([name, ok]);

let n = 0;
async function scenario(
  trialDays: number,
  items: Array<{ price: typeof planPrice; quantity: number }>,
) {
  const customer = await createCustomer({ ...ctx, email: `trial${n++}@a.com` });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription, items: created } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items,
    ...(trialDays > 0 ? { trialDays } : { trialDays: 0 }),
  });
  return { customer, subscription, items: created };
}

/** Everything money-shaped this customer has, so "no money moved" is provable. */
const moneyFor = (customerId: string) =>
  withTenant(orgId, async (tx) => ({
    invoices: await tx.select().from(invoices).where(eq(invoices.customerId, customerId)),
    creditNotes: (await tx.select().from(creditNotes).where(eq(creditNotes.customerId, customerId)))
      .length,
    payments: (await tx.select().from(payments).where(eq(payments.customerId, customerId))).length,
  }));

const subRow = (id: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1))[0]!,
  );
const itemRows = (id: string) =>
  withTenant(orgId, async (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, id)),
  );

// ─────────────────────────────────────────────────────────────────────────────
// A) THE FLOW: in-trial sub → raise the add-on quantity → nothing billed →
//    trial converts → ONE invoice for the FULL new composition.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { customer, subscription, items } = await scenario(14, [
    { price: planPrice, quantity: 1 },
    { price: addonPrice, quantity: 1 },
  ]);
  const addonItem = items.find((i) => i.priceId === addonPrice.id)!;
  const before = await moneyFor(customer.id);
  check("A0 sub starts in_trial", subscription.status === "in_trial");
  check("A0 trial raises no invoice", before.invoices.length === 0);

  const now = new Date();
  const est = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now,
    changes: [{ itemId: addonItem.publicId, newQuantity: 4 }],
  });
  // Full post-change composition: plan 12900 + addon 47500×4 = 202900.
  const fullComposition = 12900 + 47500 * 4;
  console.log(
    `A estimate: immediate=${est.immediate_charge} total=${est.total_minor} due_now=${est.amount_due_minor} due_at_trial_end=${est.due_at_trial_end}`,
  );
  check("A1 estimate charges nothing immediately", est.immediate_charge === false);
  check("A1 estimate amount_due_minor = 0 now", est.amount_due_minor === 0);
  // Against `trialEnd`, not `currentPeriodEnd`. Until 2026-08-25 a trial mirrored its end
  // onto the term columns, so the two were the same instant and this read either one; now a
  // trialling subscription has no term at all, and the field named `due_at_trial_end` is
  // checked against the trial end it is named after.
  check(
    "A1 estimate is flagged due at trial end",
    est.due_at_trial_end === subscription.trialEnd!.toISOString(),
  );
  check("A1 estimate total = full new composition", est.total_minor === fullComposition);
  check(
    "A1 estimate has no negative (credit) line",
    est.lines.every((l) => l.amount_minor >= 0),
  );

  const res = await changeSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now,
    changes: [{ itemId: addonItem.publicId, newQuantity: 4 }],
    invoiceImmediately: true,
  });
  const after = await moneyFor(customer.id);
  console.log(
    `A change: invoice=${res.prorationInvoice?.publicId ?? "none"} cn=${res.creditNote?.publicId ?? "none"} pay=${res.payment?.publicId ?? "none"}; invoices=${after.invoices.length} cns=${after.creditNotes} pays=${after.payments}`,
  );
  check("A2 change returns no proration invoice", res.prorationInvoice === null);
  check("A2 change returns no credit note", res.creditNote === null);
  check("A2 change returns no payment", res.payment === null);
  check("A2 no invoice was written", after.invoices.length === 0);
  check("A2 no credit note was written", after.creditNotes === 0);
  check("A2 no payment was taken", after.payments === 0);

  const rows = await itemRows(subscription.id);
  check(
    "A3 the item change WAS applied (qty 4)",
    rows.find((r) => r.priceId === addonPrice.id)?.quantity === 4,
  );
  const midTrial = await subRow(subscription.id);
  check(
    "A3 still in_trial with the same trial end",
    midTrial.status === "in_trial" &&
      midTrial.trialEnd!.getTime() === subscription.trialEnd!.getTime(),
  );
  // `/change` recomputes the cached mrr; in trial that recompute must still land on 0,
  // not on the new composition (§F for the full five-layer proof).
  check("A3 cached mrr stays 0 through an in-trial change", midTrial.mrr === 0n);

  // Trial end arrives → the clock converts + bills.
  const at = new Date(Date.now() - 60_000);
  await systemDb
    .update(subscriptions)
    .set({ trialEnd: at })
    .where(eq(subscriptions.id, subscription.id));
  await runWithClockScope({ onlyBusinessId: biz.id, now: new Date() }, () =>
    runBillingClockTick(new Date()),
  );
  const converted = await subRow(subscription.id);
  const billed = await moneyFor(customer.id);
  const inv = billed.invoices[0];
  console.log(
    `A trial end: status=${converted.status}; invoices=${billed.invoices.length} total=${inv ? Number(inv.totalMinor) : "n/a"} (expected ${fullComposition})`,
  );
  check("A4 trial converted to active", converted.status === "active");
  // The conversion restates MRR from the POST-change composition, not the signup one.
  check(
    "A4 conversion restated mrr to the changed composition",
    converted.mrr === BigInt(fullComposition),
  );
  check("A4 exactly ONE invoice at trial end", billed.invoices.length === 1);
  check(
    "A4 that invoice bills the FULL new composition",
    !!inv && Number(inv.totalMinor) === fullComposition,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B) in-trial ADD item → no prorated charge.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { customer, subscription } = await scenario(14, [{ price: planPrice, quantity: 1 }]);
  const r = await addSubscriptionItem({
    ...ctx,
    subscriptionId: subscription.id,
    price: addonPrice,
    quantity: 2,
    now: new Date(),
    invoiceImmediately: true,
  });
  const after = await moneyFor(customer.id);
  console.log(
    `B add item: invoice=${r.invoice?.publicId ?? "none"} pay=${r.payment?.publicId ?? "none"}; invoices=${after.invoices.length}`,
  );
  check("B1 add during trial raises no invoice", r.invoice === null && after.invoices.length === 0);
  check("B1 add during trial takes no payment", r.payment === null && after.payments === 0);
  check(
    "B2 the item was still added",
    (await itemRows(subscription.id)).some((i) => i.priceId === addonPrice.id),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// C) in-trial REMOVE item → no credit note.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { customer, subscription, items } = await scenario(14, [
    { price: planPrice, quantity: 1 },
    { price: addonPrice, quantity: 1 },
  ]);
  const addonItem = items.find((i) => i.priceId === addonPrice.id)!;
  const r = await removeSubscriptionItem({
    ...ctx,
    subscriptionId: subscription.id,
    itemPublicId: addonItem.publicId,
    now: new Date(),
  });
  const after = await moneyFor(customer.id);
  console.log(`C remove item: cn=${r.creditNote?.publicId ?? "none"}; cns=${after.creditNotes}`);
  check(
    "C1 remove during trial issues no credit note",
    r.creditNote === null && after.creditNotes === 0,
  );
  check(
    "C2 the item was still removed",
    !(await itemRows(subscription.id)).some((i) => i.priceId === addonPrice.id),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// D) in-trial PLAN SWAP with a frequency change (the term-reset path) → no money,
//    trial window untouched, cadence re-aligned for the post-trial term.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { customer, subscription, items } = await scenario(14, [{ price: planPrice, quantity: 1 }]);
  const planItem = items[0]!;
  const trialEndBefore = subscription.trialEnd!;
  const now = new Date();
  const est = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now,
    changes: [{ itemId: planItem.publicId, newPriceId: planPriceYearly.publicId }],
  });
  const res = await changeSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now,
    changes: [{ itemId: planItem.publicId, newPriceId: planPriceYearly.publicId }],
    invoiceImmediately: true,
  });
  const after = await moneyFor(customer.id);
  const row = await subRow(subscription.id);
  console.log(
    `D swap: est.total=${est.total_minor} est.due_at_trial_end=${est.due_at_trial_end}; invoice=${res.prorationInvoice?.publicId ?? "none"} cn=${res.creditNote?.publicId ?? "none"}; trial_end=${row.trialEnd!.toISOString()} unit=${row.billingPeriodUnit}`,
  );
  check(
    "D1 term-reset swap in trial moves no money",
    res.prorationInvoice === null && res.creditNote === null && res.payment === null,
  );
  check(
    "D1 nothing written",
    after.invoices.length === 0 && after.creditNotes === 0 && after.payments === 0,
  );
  check(
    "D2 trial end is NOT re-anchored",
    row.trialEnd!.getTime() === trialEndBefore.getTime() && row.currentPeriodEnd === null,
  );
  check("D2 still in_trial", row.status === "in_trial");
  check("D3 cadence re-aligned to the new plan", row.billingPeriodUnit === "year");
  check(
    "D4 estimate matches: nothing now, yearly plan at trial end",
    est.immediate_charge === false && est.amount_due_minor === 0 && est.total_minor === 129000,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// E) REGRESSION GUARD: an ACTIVE subscription still prorates immediately.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { customer, subscription, items } = await scenario(0, [{ price: planPrice, quantity: 1 }]);
  check("E0 sub is active (no trial)", subscription.status === "active");
  const now = new Date();
  const est = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now,
    changes: [{ itemId: items[0]!.publicId, newQuantity: 3 }],
  });
  const res = await changeSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now,
    changes: [{ itemId: items[0]!.publicId, newQuantity: 3 }],
    invoiceImmediately: true,
  });
  const after = await moneyFor(customer.id);
  console.log(
    `E active: est.total=${est.total_minor} immediate=${est.immediate_charge} due_at_trial_end=${est.due_at_trial_end}; invoice total=${res.prorationInvoice ? Number(res.prorationInvoice.totalMinor) : "none"}`,
  );
  check(
    "E1 active change still charges immediately",
    est.immediate_charge === true && est.total_minor > 0,
  );
  check("E1 active estimate is NOT flagged trial-end", est.due_at_trial_end == null);
  check(
    "E2 active change still raises a proration invoice",
    res.prorationInvoice !== null && after.invoices.length === 1,
  );
  check(
    "E3 estimate == applied booking",
    !!res.prorationInvoice && est.total_minor === Number(res.prorationInvoice.totalMinor),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// F) TRIAL MRR IS 0 IN ALL FIVE LAYERS — stored column, API field, the number the
//    list cell renders, the SQL `mrr` FILTER and the SQL `mrr` SORT — and the
//    trial→active conversion restates it to the real rate.
// ─────────────────────────────────────────────────────────────────────────────
{
  const fullMonthly = 12900 + 47500 * 2; // plan + 2 × add-on = 107900
  const { subscription: trialing } = await scenario(14, [
    { price: planPrice, quantity: 1 },
    { price: addonPrice, quantity: 2 },
  ]);
  // A cheaper ACTIVE neighbour: under the bug the trialing sub (107900) outranked it
  // on a DESC MRR sort even though the screen showed the trial as 0.00.
  const { subscription: activeNeighbour } = await scenario(0, [{ price: planPrice, quantity: 1 }]);

  const stored = await subRow(trialing.id);
  const api = serializeSubscription(stored, biz);
  const page = (filters?: Array<{ field: string; op: string; value: string }>, sort?: boolean) =>
    listSubscriptionsPage(orgId, biz.id, {
      limit: 100,
      ...(filters ? { filters } : {}),
      ...(sort ? { sortField: "mrr", sortDesc: true } : {}),
    });
  const gt0 = await page([{ field: "mrr", op: "gt", value: "0" }]);
  const is0 = await page([{ field: "mrr", op: "is", value: "0" }]);
  const sorted = await page(undefined, true);
  const rank = (id: string) => sorted.data.findIndex((r) => r.subscription.id === id);

  console.log(
    `F trialing: stored=${stored.mrr} api=${api.mrr} (created at ${fullMonthly}); mrr[gt]=0 hit=${gt0.data.some((r) => r.subscription.id === trialing.id)} mrr[is]=0 hit=${is0.data.some((r) => r.subscription.id === trialing.id)}; sort DESC rank trial=${rank(trialing.id)} active(12900)=${rank(activeNeighbour.id)}`,
  );
  check("F1 stored column is 0 while in_trial", stored.status === "in_trial" && stored.mrr === 0n);
  check("F2 API reports mrr 0", api.mrr === 0);
  // The list cell (`mrrOf`, subscriptions-table.tsx) trusts this field verbatim for a
  // live row, so a 0 here is the `0.00` on screen — and NOT the blank a null would give.
  check(
    "F3 the list cell renders 0.00 (live row, mrr present and 0)",
    api.status === "in_trial" && api.mrr === 0,
  );
  check(
    "F4 the SQL mrr[gt]=0 filter EXCLUDES it",
    !gt0.data.some((r) => r.subscription.id === trialing.id),
  );
  check(
    "F4 the SQL mrr[is]=0 filter INCLUDES it",
    is0.data.some((r) => r.subscription.id === trialing.id),
  );
  check(
    "F4 the same filter still returns the active neighbour",
    gt0.data.some((r) => r.subscription.id === activeNeighbour.id),
  );
  check(
    "F5 MRR sort DESC does not rank the trial by a hidden number",
    rank(trialing.id) > rank(activeNeighbour.id),
  );

  // Conversion: trial end arrives, the clock converts + bills (§A's idiom).
  const at = new Date(Date.now() - 60_000);
  await systemDb
    .update(subscriptions)
    .set({ trialEnd: at })
    .where(eq(subscriptions.id, trialing.id));
  await runWithClockScope({ onlyBusinessId: biz.id, now: new Date() }, () =>
    runBillingClockTick(new Date()),
  );
  const converted = await subRow(trialing.id);
  const convertedApi = serializeSubscription(converted, biz);
  const gt0After = await page([{ field: "mrr", op: "gt", value: "0" }]);
  console.log(
    `F conversion: status=${converted.status} stored=${converted.mrr} api=${convertedApi.mrr} (expect ${fullMonthly}); mrr[gt]=0 hit=${gt0After.data.some((r) => r.subscription.id === trialing.id)}`,
  );
  check("F6 the trial converted to active", converted.status === "active");
  check("F6 the conversion restated mrr to the REAL rate", converted.mrr === BigInt(fullMonthly));
  check("F6 the API reports the real rate after conversion", convertedApi.mrr === fullMonthly);
  check(
    "F6 mrr[gt]=0 now INCLUDES the converted sub",
    gt0After.data.some((r) => r.subscription.id === trialing.id),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// G) THE CONVERSION, DRIVEN BY THE TIME TRAVEL. §F moves `trial_end` into the past
//    and ticks; this one changes nothing but the clock — the trial expires because
//    time passed, through the same pipeline production runs. It is the half that
//    matters most: if the recompute is missed here, every converted subscription
//    reports 0 MRR forever, which is worse than the bug the zero closes.
// ─────────────────────────────────────────────────────────────────────────────
{
  const DAY = 86_400_000;
  const G = new Date("2027-05-01T00:00:00.000Z");
  const bizTm = await createBusiness({
    organizationId: orgId,
    name: "Trial MRR TM biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const tmCtx = { organizationId: orgId, businessId: bizTm.id };
  const cust = await createCustomer({
    ...tmCtx,
    email: "trialmrr-tm@a.com",
    autoCollection: "on",
    address: { country: "US" },
  });
  await vaultPaymentMethod({ ...tmCtx, customer: cust, token: "tok_4242" });
  const prod = await createProduct({ ...tmCtx, name: "TM Plan", id: "tm-mrr-plan", kind: "plan" });
  const price = await createPrice({
    ...tmCtx,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });

  await startTimeTravel({ orgId, bizId: bizTm.id, genesisTime: G });
  const { subscription } = await createSubscription({
    ...tmCtx,
    customerId: cust.id,
    now: G,
    items: [{ price, quantity: 1 }],
    trialDays: 14,
  });
  const row = (id: string) =>
    withTenant(
      orgId,
      async (tx) =>
        (await tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1))[0]!,
    );

  const inTrial = await row(subscription.id);
  check("G1 starts in_trial with mrr 0", inTrial.status === "in_trial" && inTrial.mrr === 0n);

  // Mid-trial: time moves, nothing converts, MRR stays 0.
  await travelForward({ orgId, bizId: bizTm.id, toTime: new Date(G.getTime() + 7 * DAY) });
  const midTrial = await row(subscription.id);
  check(
    "G2 still in_trial + mrr 0 a week in",
    midTrial.status === "in_trial" && midTrial.mrr === 0n,
  );

  // Past trial end: the clock converts it, and MRR must become the real rate.
  await travelForward({ orgId, bizId: bizTm.id, toTime: new Date(G.getTime() + 20 * DAY) });
  const converted = await row(subscription.id);
  console.log(
    `G time travel: status=${converted.status} mrr=${converted.mrr} (expect 5000) activated_at=${converted.activatedAt?.toISOString() ?? "null"}`,
  );
  check("G3 the trial converted by the clock alone", converted.status === "active");
  check("G3 the conversion restated mrr to 5000", converted.mrr === 5000n);
  check(
    "G3 mrr[gt]=0 finds the converted sub",
    (
      await listSubscriptionsPage(orgId, bizTm.id, {
        limit: 100,
        filters: [{ field: "mrr", op: "gt", value: "0" }],
      })
    ).data.some((r) => r.subscription.id === subscription.id),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// H) in-trial ONE-TIME item — the preview must mirror the shared cycle-cap rule
//    (`isCycleCapExhausted`/`itemCycleCap`, catalog/pricing.ts) that the invoicing
//    planner enforces at trial-end conversion: an EXPLICIT `billing_cycles`, else
//    an IMPLICIT cap of 1 for a `one_time` snapshot. `estimateChange`'s in-trial
//    branch used to re-derive this cap itself (`billingCycles != null && ...`)
//    without the implicit one_time half — inert today only because an in-trial
//    item's `cycles_billed` is always 0, but a duplicated rule is how a preview
//    quietly stops matching the booking the moment that stops being true. Now
//    both read the one shared helper. Proves preview == booking end to end: the
//    one-time fee previews at FULL price (cycles_billed=0 < cap 1), and the
//    trial-end conversion invoice charges exactly what was previewed.
// ─────────────────────────────────────────────────────────────────────────────
{
  const setupProduct = await createProduct({ ...ctx, name: "Setup (trial)", kind: "charge" });
  const setupFee = await createPrice({
    ...ctx,
    productId: setupProduct.id,
    name: "Onboarding setup",
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 9900,
  });
  const { customer, subscription } = await scenario(14, [{ price: planPrice, quantity: 1 }]);
  const { item, invoice: addInvoice } = await addSubscriptionItem({
    ...ctx,
    subscriptionId: subscription.id,
    price: setupFee,
    quantity: 1,
    now: new Date(),
    invoiceImmediately: true,
  });
  check("H0 in-trial one-time add charges nothing yet", addInvoice === null);

  const est = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    changes: [],
  });
  const fullComposition = 12900 + 9900; // plan + the one-time fee, both at full price
  console.log(
    `H estimate: total=${est.total_minor} immediate=${est.immediate_charge} due_at_trial_end=${est.due_at_trial_end} (expect ${fullComposition})`,
  );
  check("H1 estimate includes the one-time fee at full price", est.total_minor === fullComposition);
  check(
    "H1 estimate charges nothing now",
    est.immediate_charge === false && est.amount_due_minor === 0,
  );

  // Trial end arrives → the clock converts + bills (§A's idiom).
  const at = new Date(Date.now() - 60_000);
  await systemDb
    .update(subscriptions)
    .set({ trialEnd: at })
    .where(eq(subscriptions.id, subscription.id));
  await runWithClockScope({ onlyBusinessId: biz.id, now: new Date() }, () =>
    runBillingClockTick(new Date()),
  );
  const billed = await moneyFor(customer.id);
  const inv = billed.invoices[0];
  const itemRow = (await itemRows(subscription.id)).find((i) => i.id === item.id)!;
  console.log(
    `H conversion: invoices=${billed.invoices.length} total=${inv ? Number(inv.totalMinor) : "n/a"} cycles_billed=${itemRow.cyclesBilled} (expect ${fullComposition}, cycles_billed=1)`,
  );
  check("H2 exactly one invoice at trial end", billed.invoices.length === 1);
  check(
    "H2 trial-end invoice EQUALS the preview (preview == booking)",
    !!inv && Number(inv.totalMinor) === est.total_minor,
  );
  check(
    "H3 the one-time item is marked billed (cycle consumed, cap now exhausted)",
    itemRow.cyclesBilled === 1,
  );
}

let pass = true;
console.log("");
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ TRIAL CHANGE: PASS" : "❌ TRIAL CHANGE: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
