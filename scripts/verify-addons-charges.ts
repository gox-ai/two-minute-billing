/**
 * Add-ons + ad-hoc charges (Phase 8):
 *  - add an add-on mid-period → prorated charge billed now,
 *  - remove an item mid-period → credit memo to customer_balance,
 *  - ad-hoc charge invoice_now → its own paid invoice,
 *  - ad-hoc charge deferred → unbilled_charge folded into the next renewal invoice.
 *
 * Plus two 2026-08-03 fixes on the same two functions:
 *  - a ONE-TIME price added MID-TERM is charged in FULL as kind='one_time' (it used
 *    to be time-prorated and labelled "… - Prorated Charges" — a 5000 one-off added
 *    halfway through a monthly term billed ~2500), and the estimate agrees,
 *  - `removeSubscriptionItem` takes the optimistic lock on
 *    `subscriptions.resource_version`, so a concurrent removal loses with a
 *    retryable `ProrationConflictError` (409) instead of crediting off a stale term.
 *
 * And the other half of the first one: REMOVING a `one_time` item credits NOTHING,
 * billed or not. Charging the full fee while crediting a prorated ~half made a
 * mid-term add-then-remove cost the customer the difference.
 *
 *   pnpm verify:addons-charges
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import {
  addSubscriptionItem,
  removeSubscriptionItem,
  addAdHocCharge,
  listUnbilledCharges,
} from "@/modules/subscriptions/items";
import { estimateChange } from "@/modules/subscriptions/estimate";
import { changeSubscription, prorate } from "@/modules/subscriptions/proration";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { customerCreditBalance } from "@/modules/customers/balances";
import {
  subscriptions,
  subscriptionItems,
  invoiceLineItems,
  creditNotes,
  unbilledCharges,
} from "@db/schema";

const org = await createOrganization({ name: "Addons Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
const product = await createProduct({ ...ctx, name: "Pro", kind: "plan" });
const planPrice = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
const addonProduct = await createProduct({ ...ctx, name: "Seats", kind: "addon" });
const seatPrice = await createPrice({
  ...ctx,
  productId: addonProduct.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 500,
  interval: "month",
});

const checks: Array<[string, boolean]> = [];
async function mkSub(email: string) {
  const customer = await createCustomer({ ...ctx, email });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  return { subscription, customerId: customer.id };
}

// 1) Add an add-on mid-period → prorated charge billed now (~full at period start).
{
  const { subscription } = await mkSub("add@a.com");
  const { item, invoice } = await addSubscriptionItem({
    ...ctx,
    subscriptionId: subscription.id,
    price: seatPrice,
    quantity: 2,
    now: new Date(),
    invoiceImmediately: true,
  });
  console.log(
    `add-on: invoice=${invoice ? `${invoice.status} ${Number(invoice.totalMinor)}` : "none"} (exp paid ~1000)`,
  );
  checks.push([
    "add-on billed + paid",
    !!invoice && invoice.status === "paid" && Number(invoice.totalMinor) > 0,
  ]);

  // 2) Remove it → refundable credit note to the customer.
  const { creditNote } = await removeSubscriptionItem({
    ...ctx,
    subscriptionId: subscription.id,
    itemPublicId: item.publicId,
    now: new Date(),
  });
  const bal = await customerCreditBalance(orgId, subscription.customerId, "USD");
  console.log(
    `remove: credit note=${creditNote ? `${creditNote.status} ${Number(creditNote.totalMinor)}` : "none"}, balance=${bal}`,
  );
  checks.push(
    ["remove issues a credit note", !!creditNote && Number(creditNote.totalMinor) > 0],
    ["credit lands on customer_balance", bal > 0n],
  );
}

// 3) Ad-hoc charge invoice_now → its own paid invoice.
{
  const { subscription } = await mkSub("charge@a.com");
  const res = await addAdHocCharge({
    ...ctx,
    subscriptionId: subscription.id,
    description: "One-time setup",
    amountMinor: 2500,
    invoiceNow: true,
    now: new Date(),
  });
  checks.push([
    "invoice_now charge → paid invoice",
    res.object === "invoice" &&
      res.invoice.status === "paid" &&
      Number(res.invoice.totalMinor) === 2500,
  ]);
}

// 4) Deferred ad-hoc charge → folded into the next renewal invoice.
{
  const { subscription } = await mkSub("defer@a.com");
  await addAdHocCharge({
    ...ctx,
    subscriptionId: subscription.id,
    description: "Overage",
    amountMinor: 700,
    invoiceNow: false,
    now: new Date(),
  });
  const pendingBefore = (await listUnbilledCharges(orgId, subscription.id)).filter(
    (c) => c.status === "pending",
  ).length;
  const fresh = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx.select().from(subscriptions).where(eq(subscriptions.id, subscription.id)).limit(1)
      )[0]!,
  );
  // This fixture subscribes with NO trial, so the term exists. Checked once rather than
  // asserted at each use — a trialling subscription genuinely has no term (2026-08-25), and
  // four silent `!`s would hide that if this fixture ever grew a trial.
  const termStart = fresh.currentPeriodStart!;
  const termEnd = fresh.currentPeriodEnd!;
  if (!termStart || !termEnd)
    throw new Error("expected a subscription with a term; got one without (in trial?)");
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription: fresh,
    periodStart: fresh.currentPeriodStart!,
    periodEnd: fresh.currentPeriodEnd!,
  });
  const stillPending = (await listUnbilledCharges(orgId, subscription.id)).filter(
    (c) => c.status === "pending",
  ).length;
  console.log(
    `deferred: pendingBefore=${pendingBefore}, invoice total=${Number(invoice.totalMinor)} (exp 1000+700=1700), stillPending=${stillPending}`,
  );
  checks.push(
    ["charge queued as pending", pendingBefore === 1],
    ["renewal folds in the charge (1000+700)", Number(invoice.totalMinor) === 1700],
    ["folded charge marked billed", stillPending === 0],
  );
}

// 5) Billing-cadence guard, LONGER-cadence direction. A subscription has ONE cycle
// and rates every recurring item against it, so a yearly-priced add-on on a monthly
// subscription would be charged its YEARLY amount every month — a silent 12×
// overcharge. This direction stays refused on both the create and add-item paths even
// after the 2026-08-05 divisor rule (5a below), because the cycle ends before the
// item's period does. The matching cadence must still work.
{
  const yearlySeat = await createPrice({
    ...ctx,
    productId: addonProduct.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 5000,
    interval: "year",
  });
  const customer = await createCustomer({ ...ctx, email: "cadence@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });

  let createRejected = false;
  try {
    await createSubscription({
      ...ctx,
      customerId: customer.id,
      now: new Date(),
      items: [
        { price: planPrice, quantity: 1 },
        { price: yearlySeat, quantity: 1 },
      ],
    });
  } catch (e) {
    createRejected = /billing period/i.test((e as Error).message);
  }

  const { subscription } = await mkSub("cadence-add@a.com");
  let addRejected = false;
  try {
    await addSubscriptionItem({
      ...ctx,
      subscriptionId: subscription.id,
      price: yearlySeat,
      quantity: 1,
      now: new Date(),
      invoiceImmediately: true,
    });
  } catch (e) {
    addRejected = /billing period/i.test((e as Error).message);
  }

  // The guard must not over-reach: a same-cadence add-on still attaches.
  const { item: okItem } = await addSubscriptionItem({
    ...ctx,
    subscriptionId: subscription.id,
    price: seatPrice,
    quantity: 1,
    now: new Date(),
    invoiceImmediately: true,
  });

  checks.push(
    ["create rejects a yearly add-on on a monthly plan", createRejected],
    ["add_item rejects a yearly add-on on a monthly subscription", addRejected],
    ["matching cadence still attaches", !!okItem],
  );
}

// 5a) …and the SHORTER-cadence direction is now FOLDED, not refused (2026-08-05, the
// divisor rule): a monthly add-on added to a YEARLY subscription freezes
// its rate × 12 on the annual cycle. Mirrors the create-path cover in
// `verify:estimates`; this exercises `addSubscriptionItem` / `effectiveAddSnapshotTx`.
{
  const yearlyPlanPrice = await createPrice({
    ...ctx,
    productId: product.id,
    name: "Annual",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 120000,
    interval: "year",
  });
  const customer = await createCustomer({ ...ctx, email: "cadence-fold@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: yearlyPlanPrice, quantity: 1 }],
  });
  const { item } = await addSubscriptionItem({
    ...ctx,
    subscriptionId: subscription.id,
    price: seatPrice,
    quantity: 3,
    now: new Date(),
    invoiceImmediately: true,
  });
  const snap = item.priceSnapshot as {
    amountMinor?: number;
    interval?: string;
    cadenceMultiple?: number;
    catalogInterval?: string;
  };
  console.log(
    `add_item cadence fold: amount=${snap?.amountMinor} (exp 6000) interval=${snap?.interval} (exp year) ×${snap?.cadenceMultiple} (exp 12)`,
  );
  checks.push(
    [
      "add_item folds a monthly add-on onto a yearly cycle (×12)",
      snap?.cadenceMultiple === 12 && snap?.amountMinor === 6000,
    ],
    [
      "folded snapshot bills on the subscription cycle",
      snap?.interval === "year" && snap?.catalogInterval === "month",
    ],
  );
}

// The ESTIMATE prices adds and removes, and agrees with what the booking actually does.
// Before this, `estimateChange` resolved every entry by an EXISTING item id and threw
// otherwise, so it could not express an add or a remove at all: the dashboard rail showed
// nothing and the confirm dialog said "No immediate charge for this change" while
// `DELETE /items/:id` credited unused time. A preview that disagrees with the booking is
// the same class of defect as no preview.
{
  const { subscription } = await mkSub("estimate-add-remove@a.com");

  // ADD: preview first, then actually add, and compare the two.
  const addEst = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    changes: [],
    adds: [{ priceId: seatPrice.publicId, quantity: 2 }],
  });
  const { invoice: addInvoice } = await addSubscriptionItem({
    ...ctx,
    subscriptionId: subscription.id,
    price: seatPrice,
    quantity: 2,
    now: new Date(),
    invoiceImmediately: true,
  });
  const addBooked = addInvoice ? Number(addInvoice.totalMinor) : 0;
  console.log(
    `estimate ADD: preview total=${addEst.total_minor} lines=${addEst.lines.length}; booked=${addBooked}`,
  );
  checks.push(
    ["estimate prices an ADD at all", addEst.lines.length === 1 && addEst.total_minor > 0],
    ["ADD preview == booked amount", addEst.total_minor === addBooked],
  );

  // REMOVE: preview the credit, then remove, and compare. `changes: []` with only a
  // `removes` entry is exactly the shape that used to be inexpressible.
  const items = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, subscription.id)),
  );
  const seatItem = items.find((i) => i.priceId === seatPrice.id)!;
  const remEst = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    changes: [],
    removes: [seatItem.publicId],
  });
  const remPreviewCredit = -remEst.lines
    .filter((l) => l.amount_minor < 0)
    .reduce((s, l) => s + l.amount_minor, 0);
  const { creditNote: remCn } = await removeSubscriptionItem({
    ...ctx,
    subscriptionId: subscription.id,
    itemPublicId: seatItem.publicId,
    now: new Date(),
  });
  const remBooked = remCn ? Number(remCn.totalMinor) : 0;
  console.log(`estimate REMOVE: preview credit=${remPreviewCredit}; booked credit=${remBooked}`);
  checks.push(
    ["estimate prices a REMOVE as a credit line", remEst.lines.some((l) => l.amount_minor < 0)],
    ["REMOVE preview credit == booked credit", remPreviewCredit === remBooked && remBooked > 0],
    // The whole point: a removal is no longer previewed as "nothing happens".
    ["REMOVE preview is not empty", remEst.lines.length > 0],
  );
}

// A ONE-TIME price added MID-TERM is charged in FULL, not time-prorated.
// `addSubscriptionItem` used to prorate unconditionally — its only guard was the
// trial case, never the price TYPE — so a 5000 one-off added halfway through a
// monthly term billed ~2500 and the line claimed to be a prorated charge. Every
// other one-time path in items.ts (activation charges, trigger_charge, ad-hoc
// charges) bills the full amount as kind='one_time'; this was the lone dissenter.
{
  const setupProduct = await createProduct({ ...ctx, name: "Setup", kind: "charge" });
  const setupFee = await createPrice({
    ...ctx,
    productId: setupProduct.id,
    name: "Onboarding setup",
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
  });

  const { subscription } = await mkSub("onetime@a.com");
  const fresh = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx.select().from(subscriptions).where(eq(subscriptions.id, subscription.id)).limit(1)
      )[0]!,
  );
  // This fixture subscribes with NO trial, so the term exists. Checked once rather than
  // asserted at each use — a trialling subscription genuinely has no term (2026-08-25), and
  // silent `!`s would hide that if this fixture ever grew a trial.
  const termStart = fresh.currentPeriodStart!;
  const termEnd = fresh.currentPeriodEnd!;
  if (!termStart || !termEnd)
    throw new Error("expected a subscription with a term; got one without (in trial?)");
  // Halfway through the term — the whole point: a fraction ≠ the full fee.
  const midTerm = new Date((termStart.getTime() + termEnd.getTime()) / 2);
  const halfOfFee = Number(prorate(5000n, midTerm, termStart, termEnd));

  // The PREVIEW must quote the same number the booking charges (they are
  // deliberately shared arithmetic — estimate.ts mirrors this branch).
  const est = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now: midTerm,
    changes: [],
    adds: [{ priceId: setupFee.publicId, quantity: 1 }],
  });

  const { invoice } = await addSubscriptionItem({
    ...ctx,
    subscriptionId: subscription.id,
    price: setupFee,
    quantity: 1,
    now: midTerm,
    invoiceImmediately: true,
  });
  const lines = invoice
    ? await withTenant(orgId, (tx) =>
        tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id)),
      )
    : [];
  const feeLine = lines.find((l) => l.priceId === setupFee.id);
  console.log(
    `one-time mid-term add: invoice total=${invoice ? Number(invoice.totalMinor) : "none"} (full 5000, prorated would be ${halfOfFee}), ` +
      `line kind=${feeLine?.kind ?? "-"} desc="${feeLine?.description ?? "-"}" period=${feeLine?.periodStart ? "set" : "null"}; estimate=${est.total_minor}`,
  );
  checks.push(
    [
      "one-time add bills the FULL catalog amount (5000), not a prorated slice",
      Number(invoice?.totalMinor ?? 0n) === 5000,
    ],
    ["one-time add line amount is the full fee", Number(feeLine?.amountMinor ?? 0n) === 5000],
    ["one-time add line is kind='one_time', not 'proration'", feeLine?.kind === "one_time"],
    [
      'one-time add line is not labelled "Prorated"',
      !!feeLine && !/prorated/i.test(feeLine.description),
    ],
    [
      "one-time add line carries no service period",
      !!feeLine && feeLine.periodStart === null && feeLine.periodEnd === null,
    ],
    ["estimate quotes the FULL one-time fee too (preview == booking)", est.total_minor === 5000],
  );

  // The guard must not over-reach: a RECURRING price added at the same instant is
  // still prorated to the remaining term — and the PREVIEW must agree (the cap
  // helper both branches now share, catalog/pricing.ts `isCycleCapExhausted`, must
  // not treat a recurring snapshot as if it were the one_time full-price case).
  const recEst = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now: midTerm,
    changes: [],
    adds: [{ priceId: seatPrice.publicId, quantity: 1 }],
  });
  const { invoice: recInvoice } = await addSubscriptionItem({
    ...ctx,
    subscriptionId: subscription.id,
    price: seatPrice,
    quantity: 1,
    now: midTerm,
    invoiceImmediately: true,
  });
  const expectRecurring = Number(prorate(500n, midTerm, termStart, termEnd));
  console.log(
    `recurring mid-term add: preview=${recEst.total_minor} invoice total=${recInvoice ? Number(recInvoice.totalMinor) : "none"} (exp prorated ${expectRecurring} of 500)`,
  );
  checks.push(
    [
      "a RECURRING mid-term add is still prorated",
      Number(recInvoice?.totalMinor ?? 0n) === expectRecurring && expectRecurring < 500,
    ],
    [
      "estimate for the RECURRING add previews the same prorated amount (preview == booking)",
      recEst.total_minor === expectRecurring,
    ],
    ["estimate for the RECURRING add is NOT quoted at full price", recEst.total_minor < 500],
  );
}

// CONCURRENCY: `removeSubscriptionItem` now takes the same optimistic lock on
// `subscriptions.resource_version` that `changeSubscription`'s apply phase does
// (Bugs #8). It had none, so two removals of DIFFERENT items — or a removal racing
// `/change` — each priced their prorated credit off the SAME stale term window and
// could double-credit the customer for one span of time.
{
  const { subscription } = await mkSub("concurrent-remove@a.com");
  const { item: itemA } = await addSubscriptionItem({
    ...ctx,
    subscriptionId: subscription.id,
    price: seatPrice,
    quantity: 1,
    now: new Date(),
    invoiceImmediately: true,
  });
  const otherSeat = await createPrice({
    ...ctx,
    productId: addonProduct.id,
    name: "Seats B",
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 300,
    interval: "month",
  });
  const { item: itemB } = await addSubscriptionItem({
    ...ctx,
    subscriptionId: subscription.id,
    price: otherSeat,
    quantity: 1,
    now: new Date(),
    invoiceImmediately: true,
  });

  // Two concurrent removals of DIFFERENT items. Both read the same resource_version,
  // so at most one may write; the loser must fail LOUDLY as a RETRYABLE conflict
  // (ProrationConflictError → 409), never apply a credit priced against the state the
  // winner replaced. Pre-fix the loser failed too, but for the wrong reason and with
  // the wrong status — a plain `ProrationError` from the refundable cap, i.e. a 400
  // "this change cannot be applied", telling an honest client its request was invalid
  // when the correct answer is "retry".
  const settled = await Promise.allSettled([
    removeSubscriptionItem({
      ...ctx,
      subscriptionId: subscription.id,
      itemPublicId: itemA.publicId,
      now: new Date(),
    }),
    removeSubscriptionItem({
      ...ctx,
      subscriptionId: subscription.id,
      itemPublicId: itemB.publicId,
      now: new Date(),
    }),
  ]);
  const rejections = settled
    .filter((r) => r.status === "rejected")
    .map((r) => (r.reason as Error).name);
  const survivors = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, subscription.id)),
  );
  console.log(
    `concurrent removals: rejected=[${rejections.join(",")}] items left=${survivors.length} (plan + ${rejections.length} conflicted)`,
  );
  checks.push(
    // Either the two serialized cleanly (both removed) or a loser conflicted — but a
    // loser must NEVER fail with anything other than the retryable conflict.
    [
      "a losing concurrent removal fails as ProrationConflictError (or not at all)",
      rejections.every((n) => n === "ProrationConflictError"),
    ],
    // Whatever happened, the surviving item set matches the calls that succeeded:
    // a conflicted removal left its item in place, uncredited.
    ["a conflicted removal leaves its item in place", survivors.length === 1 + rejections.length],
  );

  // ── The DETERMINISTIC proof, because `Promise.allSettled` above may simply
  // serialize and prove nothing. A gated writer reproduces the exact interleave the
  // lock exists for:
  //   1. a concurrent transaction UPDATEs the subscription (bumping resource_version)
  //      and is HELD OPEN, keeping the row lock;
  //   2. `removeSubscriptionItem` runs — its READ phase sees the still-committed old
  //      version under READ COMMITTED and prices the credit against it;
  //   3. its apply transaction's first statement, the conditional UPDATE, BLOCKS on
  //      the held row lock;
  //   4. the writer commits → the predicate re-evaluates, matches 0 rows.
  // The removal must abort with a retryable conflict and leave its item in place.
  // Pre-fix there was no conditional UPDATE, so step 3 never happened: the removal
  // deleted the item and credited unused time measured against a term another writer
  // had already moved.
  const { subscription: sub2 } = await mkSub("stale-remove@a.com");
  const { item: raceItem } = await addSubscriptionItem({
    ...ctx,
    subscriptionId: sub2.id,
    price: seatPrice,
    quantity: 1,
    now: new Date(),
    invoiceImmediately: true,
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const blocker = withTenant(orgId, async (tx) => {
    // Bumps resource_version (the bump_row_version trigger) and holds the row lock
    // until this transaction commits. `updatedAt` only — nothing semantic moves.
    await tx
      .update(subscriptions)
      .set({ updatedAt: new Date() })
      .where(eq(subscriptions.id, sub2.id));
    await gate;
  });
  await new Promise((r) => setTimeout(r, 250)); // let the blocker take the row lock
  const removal = removeSubscriptionItem({
    ...ctx,
    subscriptionId: sub2.id,
    itemPublicId: raceItem.publicId,
    now: new Date(),
  })
    .then(() => null)
    .catch((e: unknown) => (e as Error).name);
  await new Promise((r) => setTimeout(r, 500)); // let the removal read, then block on the lock
  release();
  await blocker;
  const staleOutcome = await removal;
  const staleItems = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub2.id)),
  );
  const staleCredit = await customerCreditBalance(orgId, sub2.customerId, "USD");
  console.log(
    `stale removal: outcome=${staleOutcome ?? "SUCCEEDED (no lock)"} items left=${staleItems.length} (exp 2) credit=${staleCredit} (exp 0)`,
  );
  checks.push(
    ["a removal against a concurrently-modified subscription is REFUSED", staleOutcome !== null],
    [
      "it is refused as a retryable ProrationConflictError, not a 400/500",
      staleOutcome === "ProrationConflictError",
    ],
    ["the refused removal left its item in place", staleItems.length === 2],
    ["the refused removal credited nothing", staleCredit === 0n],
  );
}

// REMOVING a ONE-TIME item credits NOTHING — the other half of "a one-time fee is
// charged in FULL". Once the full-charge fix landed, `removeSubscriptionItem` was
// still time-prorating the credit, so a mid-term add-then-remove charged 5000 and
// handed back ~2500: the customer was out the difference on an operation that
// should net to the fee they agreed to pay. An invoiced one-time fee is NOT refunded
// by detaching the item — the operator's route to refunding it is an explicit credit
// note / refund. Two shapes, and the CONTROL that a recurring removal still credits in
// full is the pre-existing block (2) at the top of this file.
{
  const feeProduct = await createProduct({ ...ctx, name: "Setup (removal)", kind: "charge" });
  const oneOffFee = await createPrice({
    ...ctx,
    productId: feeProduct.id,
    name: "Implementation fee",
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
  });
  const countCreditNotes = (customerId: string) =>
    withTenant(
      orgId,
      async (tx) =>
        (await tx.select().from(creditNotes).where(eq(creditNotes.customerId, customerId))).length,
    );

  // (a) BILLED: attached mid-term, charged in full, then removed.
  {
    const { subscription, customerId } = await mkSub("onetime-remove@a.com");
    const fresh = await withTenant(
      orgId,
      async (tx) =>
        (
          await tx
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.id, subscription.id))
            .limit(1)
        )[0]!,
    );
    // Halfway through the term, so a prorated credit (the old behaviour) is visibly
    // HALF the fee — the exact gap the customer used to lose.
    // No trial in this fixture, so the term exists; checked rather than asserted (a
    // trialling subscription has no term since 2026-08-25).
    const tStart = fresh.currentPeriodStart!;
    const tEnd = fresh.currentPeriodEnd!;
    if (!tStart || !tEnd)
      throw new Error("expected a subscription with a term; got one without (in trial?)");
    const midTerm = new Date((tStart.getTime() + tEnd.getTime()) / 2);
    const halfOfFee = Number(prorate(5000n, midTerm, tStart, tEnd));
    const { item, invoice } = await addSubscriptionItem({
      ...ctx,
      subscriptionId: subscription.id,
      price: oneOffFee,
      quantity: 1,
      now: midTerm,
      invoiceImmediately: true,
    });
    const cnBefore = await countCreditNotes(customerId);

    // PREVIEW the removal BEFORE actually removing — must show ZERO credit,
    // matching the booking exactly (2026-08-03 fix, `estimate.ts`'s `removes`
    // branch: a one-time item is credited nothing, billed or not).
    const remEst = await estimateChange({
      ...ctx,
      subscriptionId: subscription.id,
      now: midTerm,
      changes: [],
      removes: [item.publicId],
    });

    const { creditNote } = await removeSubscriptionItem({
      ...ctx,
      subscriptionId: subscription.id,
      itemPublicId: item.publicId,
      now: midTerm,
    });
    const cnAfter = await countCreditNotes(customerId);
    const bal = await customerCreditBalance(orgId, customerId, "USD");
    const left = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(subscriptionItems)
        .where(eq(subscriptionItems.subscriptionId, subscription.id)),
    );
    console.log(
      `one-time remove (billed): preview credit=${remEst.total_minor} lines=${remEst.lines.length}; charged=${invoice ? Number(invoice.totalMinor) : "none"} credit note=${creditNote ? Number(creditNote.totalMinor) : "none"} ` +
        `notes ${cnBefore}→${cnAfter} balance=${bal} (prorated credit would have been ${halfOfFee})`,
    );
    checks.push(
      [
        "one-time fee was charged in FULL before removal (5000)",
        Number(invoice?.totalMinor ?? 0n) === 5000,
      ],
      [
        "removing a BILLED one-time item issues NO credit note",
        creditNote === null && cnAfter === cnBefore,
      ],
      ["…and leaves no credit balance behind (net = the fee paid)", bal === 0n],
      ["…while still removing the item", left.length === 1],
      // Names the regression explicitly: the old code credited ~half the fee.
      ["the removal did not hand back a prorated half of the fee", halfOfFee > 0 && bal === 0n],
      [
        "preview of the removal shows ZERO credit (preview == booking)",
        remEst.lines.length === 0 && remEst.total_minor === 0,
      ],
    );
  }

  // (b) NOT YET BILLED: attached during a trial (charges 0 — the add path defers to
  // the trial-end conversion invoice), then removed before anything billed it. There
  // is no charge to reverse, so this must also credit nothing — and must not throw.
  {
    const customer = await createCustomer({ ...ctx, email: "onetime-remove-trial@a.com" });
    await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
    const { subscription } = await createSubscription({
      ...ctx,
      customerId: customer.id,
      now: new Date(),
      trialDays: 14,
      items: [{ price: planPrice, quantity: 1 }],
    });
    const { item, invoice } = await addSubscriptionItem({
      ...ctx,
      subscriptionId: subscription.id,
      price: oneOffFee,
      quantity: 1,
      now: new Date(),
      invoiceImmediately: true,
    });
    const itemRow = await withTenant(
      orgId,
      async (tx) =>
        (
          await tx
            .select()
            .from(subscriptionItems)
            .where(eq(subscriptionItems.id, item.id))
            .limit(1)
        )[0]!,
    );
    const cnBefore = await countCreditNotes(customer.id);
    let removeError: string | null = null;
    let creditNote: { totalMinor: bigint } | null = null;
    try {
      creditNote = (
        await removeSubscriptionItem({
          ...ctx,
          subscriptionId: subscription.id,
          itemPublicId: item.publicId,
          now: new Date(),
        })
      ).creditNote;
    } catch (e) {
      removeError = (e as Error).message;
    }
    const cnAfter = await countCreditNotes(customer.id);
    const bal = await customerCreditBalance(orgId, customer.id, "USD");
    console.log(
      `one-time remove (unbilled, in trial): charged=${invoice ? Number(invoice.totalMinor) : "none"} cycles_billed=${itemRow.cyclesBilled} ` +
        `error=${removeError ?? "none"} credit note=${creditNote ? Number(creditNote.totalMinor) : "none"} notes ${cnBefore}→${cnAfter} balance=${bal}`,
    );
    checks.push(
      [
        "an in-trial one-time add charges nothing yet (cycles_billed=0)",
        invoice === null && itemRow.cyclesBilled === 0,
      ],
      ["removing an UNBILLED one-time item does not error", removeError === null],
      ["…credits nothing", creditNote === null && cnAfter === cnBefore && bal === 0n],
    );
  }
}

// A TERM RESET must not double-count an ALREADY-BILLED one-time fee, and the
// PREVIEW must equal the booking exactly — the same shared rule
// (`isCycleCapExhausted`, catalog/pricing.ts) `proration.ts`'s reset branch now
// enforces (2026-08-03, see verify-change-atomicity.ts cases H/I) and
// `estimate.ts`'s reset branch mirrors (this fix, same day). Numbers mirror
// case H there: a fee already billed at signup must be neither re-charged nor
// credited by a plan swap.
{
  const planYearly = await createPrice({
    ...ctx,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 11000,
    interval: "year",
  });
  const feeProduct2 = await createProduct({ ...ctx, name: "Setup (reset)", kind: "charge" });
  const resetFee = await createPrice({
    ...ctx,
    productId: feeProduct2.id,
    name: "Onboarding setup (reset)",
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 3000,
  });

  const customer = await createCustomer({ ...ctx, email: "reset-onetime@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [
      { price: planPrice, quantity: 1 },
      { price: resetFee, quantity: 1 },
    ],
  });
  // Direct-service test subs are otherwise UNBILLED (see verify-estimates.ts's
  // case 3) — bill the signup invoice explicitly so the fee is ALREADY BILLED
  // (cycles_billed=1) and a live current-term invoice exists for the reset's
  // credit note to attach to (`issueCurrentTermCredit`), matching case H's setup.
  const fresh0 = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx.select().from(subscriptions).where(eq(subscriptions.id, subscription.id)).limit(1)
      )[0]!,
  );
  await billSubscriptionPeriod({
    ...ctx,
    subscription: fresh0,
    periodStart: fresh0.currentPeriodStart!,
    periodEnd: fresh0.currentPeriodEnd!,
  });
  const itemsBefore = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, subscription.id)),
  );
  const planItem = itemsBefore.find((i) => i.priceId === planPrice.id)!;
  const feeItemBefore = itemsBefore.find((i) => i.priceId === resetFee.id)!;
  console.log(`reset setup: fee cycles_billed=${feeItemBefore.cyclesBilled} (exp 1)`);
  checks.push([
    "reset setup: the one-time fee was billed at signup",
    feeItemBefore.cyclesBilled === 1,
  ]);

  const now = new Date();
  const est = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now,
    changes: [{ itemId: planItem.publicId, newPriceId: planYearly.publicId }],
  });
  const res = await changeSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now,
    changes: [{ itemId: planItem.publicId, newPriceId: planYearly.publicId }],
    invoiceImmediately: true,
  });
  const bookedInvoice = res.prorationInvoice ? Number(res.prorationInvoice.totalMinor) : null;
  const bookedCredit = res.creditNote ? Number(res.creditNote.totalMinor) : null;
  const bookedNet = (bookedInvoice ?? 0) - (bookedCredit ?? 0);
  console.log(
    `term reset w/ billed one-time fee: preview total=${est.total_minor} lines=[${est.lines.map((l) => `${l.description}:${l.amount_minor}`).join(" | ")}]; ` +
      `booked invoice=${bookedInvoice} credit=${bookedCredit} net=${bookedNet} (want invoice 11000, credit 1000, net 10000)`,
  );
  checks.push(
    [
      "reset does not re-charge the already-billed fee (invoice = yearly plan alone, 11000)",
      bookedInvoice === 11000,
    ],
    [
      'reset does not credit the fee\'s "unused time" (credit = monthly plan alone, 1000)',
      bookedCredit === 1000,
    ],
    [
      "preview has no line for the already-billed fee",
      !est.lines.some((l) => l.description.includes(resetFee.publicId)),
    ],
    [
      "preview net EQUALS the booking net, invoice minus credit (preview == booking)",
      est.total_minor === bookedNet,
    ],
  );
  const feeItemAfter = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(subscriptionItems)
        .where(eq(subscriptionItems.subscriptionId, subscription.id)),
    )
  ).find((i) => i.priceId === resetFee.id)!;
  checks.push([
    "the fee still records exactly ONE consumed cycle after the reset",
    feeItemAfter.cyclesBilled === 1,
  ]);
}

// ── An ADD can be DEFERRED (2026-08-19) ─────────────────────────────────────────
// `POST …/items` had no invoicing option and always invoiced, while `/change` honoured
// `invoice_immediately` — so a composition edit applied as three calls could defer its
// changes and charge its adds, and the change form had to refuse the combination
// outright rather than state a total it could not honour.
//
// Both directions are asserted with the option EXPLICIT, plus the business default
// resolving it when omitted, because that shared resolution is what makes the three
// calls land on one answer.
{
  const org = await createOrganization({ name: "Deferred Add Org" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const c = { organizationId: orgId, businessId: biz.id };
  const cust = await createCustomer({ ...c, email: "defer-add@a.com" });
  await vaultPaymentMethod({ ...c, customer: cust, token: "tok_4242" });
  const prod = await createProduct({ ...c, name: "Pro", kind: "plan" });
  const plan = await createPrice({
    ...c,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 2000,
    interval: "month",
  });
  const addonProd = await createProduct({ ...c, name: "Seats", kind: "addon" });
  const seat = await createPrice({
    ...c,
    productId: addonProd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  });
  const { subscription } = await createSubscription({
    ...c,
    customerId: cust.id,
    now: new Date(),
    items: [{ price: plan, quantity: 1 }],
  });

  // Deferred: no invoice, a queued unbilled charge instead.
  const deferred = await addSubscriptionItem({
    ...c,
    subscriptionId: subscription.id,
    price: seat,
    quantity: 1,
    invoiceImmediately: false,
    now: new Date(),
  });
  const queued = await listUnbilledCharges(orgId, subscription.id);
  console.log(
    `deferred add: invoice=${deferred.invoice ? "RAISED" : "none"} queued=${deferred.unbilledCharges?.length ?? 0} total_queued=${queued.length}`,
  );
  checks.push(
    ["a deferred add raises NO invoice", deferred.invoice === null],
    ["…and queues an unbilled charge instead", (deferred.unbilledCharges?.length ?? 0) === 1],
    ["…visible on the subscription’s unbilled charges", queued.length === 1],
    // The item is on the subscription either way — deferring is about where the CHARGE
    // lands, not whether the composition changed.
    [
      "…and the item is still attached",
      (
        await withTenant(orgId, (tx) =>
          tx
            .select()
            .from(subscriptionItems)
            .where(eq(subscriptionItems.subscriptionId, subscription.id)),
        )
      ).some((i) => i.priceId === seat.id),
    ],
  );

  // Explicit true still invoices, on the same subscription.
  const seat2 = await createPrice({
    ...c,
    productId: addonProd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 500,
    interval: "month",
  });
  const immediate = await addSubscriptionItem({
    ...c,
    subscriptionId: subscription.id,
    price: seat2,
    quantity: 1,
    invoiceImmediately: true,
    now: new Date(),
  });
  checks.push(
    ["an explicit immediate add still invoices", !!immediate.invoice],
    ["…and queues nothing", (immediate.unbilledCharges?.length ?? 0) === 0],
  );

  // OMITTED resolves the business default — the property that makes /change and
  // POST …/items agree. The column ships false, so a bare add defers.
  const seat3 = await createPrice({
    ...c,
    productId: addonProd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 700,
    interval: "month",
  });
  const bare = await addSubscriptionItem({
    ...c,
    subscriptionId: subscription.id,
    price: seat3,
    quantity: 1,
    now: new Date(),
  });
  checks.push([
    "an OMITTED option follows the business default (false ⇒ deferred)",
    bare.invoice === null && (bare.unbilledCharges?.length ?? 0) === 1,
  ]);
}

// ── REMOVING A DEFERRED ADD RE-CUTS ITS QUEUED CHARGE ───────────────────────────
// The charge side of a removal (money bug, 2026-08-24). A deferred add queues its
// prorated charge for `[added .. periodEnd]`; remove the item before the renewal and the
// row used to be left behind, so the renewal billed the FULL window — a line for an
// add-on the customer no longer had, over a span running past the day they gave it up.
//
// The rule is a RE-CUT, never a blanket void: time the customer did hold is owed and is
// still billed. So the original row is voided and the slice up to the removal re-queued
// with a shortened window. That the numbers sometimes still landed right before the fix
// was an accident — `issueCurrentTermCredit` fell back to the PLAN's invoice and issued
// a refundable note for the same tail, which cancels only while both halves stay equal.
//
// Asserted on the ROWS rather than the renewal total, because the window is half the
// fix: a renewal recognises the charge over the span the row names.
{
  const org = await createOrganization({ name: "Recut Org" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const c = { organizationId: orgId, businessId: biz.id };
  const cust = await createCustomer({ ...c, email: "recut@a.com" });
  await vaultPaymentMethod({ ...c, customer: cust, token: "tok_4242" });
  const prod = await createProduct({ ...c, name: "Pro", kind: "plan" });
  const plan = await createPrice({
    ...c,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 2000,
    interval: "month",
  });
  const addonProd = await createProduct({ ...c, name: "Seats", kind: "addon" });
  const seat = await createPrice({
    ...c,
    productId: addonProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 6000,
    interval: "month",
  });

  const start = new Date("2026-08-01T00:00:00Z");
  const { subscription } = await createSubscription({
    ...c,
    customerId: cust.id,
    now: start,
    items: [{ price: plan, quantity: 1 }],
  });
  const periodEnd = subscription.currentPeriodEnd!;

  const addedAt = new Date("2026-08-11T00:00:00Z");
  const removedAt = new Date("2026-08-21T00:00:00Z");
  await addSubscriptionItem({
    ...c,
    subscriptionId: subscription.id,
    price: seat,
    quantity: 1,
    invoiceImmediately: false,
    now: addedAt,
  });
  const queuedRow = (await listUnbilledCharges(orgId, subscription.id)).find(
    (u) => u.priceId === seat.id,
  )!;
  const item = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(subscriptionItems)
        .where(eq(subscriptionItems.subscriptionId, subscription.id)),
    )
  ).find((i) => i.priceId === seat.id)!;

  await removeSubscriptionItem({
    ...c,
    subscriptionId: subscription.id,
    itemPublicId: item.publicId,
    now: removedAt,
  });

  const after = await withTenant(orgId, (tx) =>
    tx.select().from(unbilledCharges).where(eq(unbilledCharges.subscriptionId, subscription.id)),
  );
  const forSeat = after.filter((u) => u.priceId === seat.id);
  const original = forSeat.find((u) => u.id === queuedRow.id);
  const survivor = forSeat.find((u) => u.id !== queuedRow.id && u.status === "pending");
  // The customer held it 11-Aug → 21-Aug of an 11-Aug → 1-Sep charge window.
  const expectKept = prorate(
    queuedRow.amountMinor,
    removedAt,
    queuedRow.periodStart!,
    queuedRow.periodEnd!,
  );
  const kept = queuedRow.amountMinor - expectKept;

  console.log(
    `recut: queued=${queuedRow.amountMinor} original=${original?.status} ` +
      `survivor=${survivor?.amountMinor ?? "none"} expected=${kept} ` +
      `window=${survivor?.periodEnd?.toISOString().slice(0, 10) ?? "—"} (was ${queuedRow.periodEnd?.toISOString().slice(0, 10)})`,
  );
  checks.push(
    [
      "a deferred add queues a charge spanning the rest of the term",
      queuedRow.periodEnd?.getTime() === periodEnd.getTime(),
    ],
    ["removing the item VOIDS the original queued charge", original?.status === "voided"],
    ["…and re-queues only the slice the customer actually held", survivor?.amountMinor === kept],
    [
      "…over a window ending at the removal, not the term end",
      survivor?.periodEnd?.getTime() === removedAt.getTime(),
    ],
    [
      "…so nothing pending still covers time past the removal",
      forSeat.every((u) => u.status !== "pending" || (u.periodEnd ?? removedAt) <= removedAt),
    ],
  );
}

let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ ADDONS + CHARGES: PASS" : "❌ ADDONS + CHARGES: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
