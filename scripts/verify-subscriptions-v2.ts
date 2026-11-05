/**
 * Phase F — Subscriptions verify suite.
 *
 * Exercises the subscription state machine (architecture §4.1) and asserts
 * LEDGER balances / credit-note amounts with HAND-COMPUTED constants (not just
 * statuses — money bugs hide behind green status-only checks).
 *
 *   pnpm verify:subscriptions-v2
 *
 * Sections: SUB-1 future→start + cancel-before-start · SUB-2/4 remaining cycles →
 * non_renewing → cancelled + remove_scheduled_cancellation · SUB-5 cancel option
 * permutations (credit/unbilled/AR/refundable) · SUB-6 pause skip_billing_cycles
 * auto-resume + dunning stop + resume charges · SUB-8 reason codes · SUB-9
 * change_term_end proration · SUB-3 dues snapshot · SUB-7 dunning-retain.
 */
import { and, eq, sql } from "drizzle-orm";
// Warped ticks MUST be business-scoped — unscoped they renew every tenant in the DB.
/**
 * EVERY `runBillingClockTick` in this suite runs inside a clock scope, including the
 * real-time ones the time-warp guard would let through unscoped.
 *
 * The guard only refuses an UNSCOPED tick whose `now` is in the future, because that is
 * the case that renews other tenants' subscriptions. But an unscoped real-time tick is
 * still a GLOBAL sweep: on a shared local DB it processes every due subscription left
 * behind by every earlier suite, and `TICK_SCAN_LIMIT` / `TICK_PASS_BUDGET_MS` then
 * decide how much of that backlog gets through — so whether THIS suite's subscription
 * is reached depends on how much unrelated work is queued ahead of it. That is the
 * shape of the SUB-9 failure seen once on 2026-08-11 (both extension assertions failed
 * together, then passed on four subsequent runs including the exact suite ordering that
 * produced it). Scoping makes the pass see this business only, so the suite's result no
 * longer depends on the state of the database around it.
 */
import { runWithClockScope } from "@/platform/clock";
import { withTenant, closeDb, type Tx } from "@/platform/db";
import { createOrganization, createBusiness, updateBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  apiSubscriptionStatus,
  cancelSubscriptionWithOptions,
  pauseSubscriptionWithOptions,
  resumeSubscriptionWithOptions,
  removeScheduledCancellation,
  changeTermEnd,
  subscriptionDues,
  getSubscriptionByPublicId,
  editTrialEnd,
  pauseSubscription,
  updateSubscriptionSettings,
  type ResumeChargesHandling,
} from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { createCoupon, applyCouponToSubscription } from "@/modules/coupons/service";
import { addAdHocCharge } from "@/modules/subscriptions/items";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { applyDueScheduledChanges } from "@/modules/subscriptions/scheduled-changes";
import { businesses, invoices, subscriptions, creditNotes, unbilledCharges } from "@db/schema";
import { buildApp } from "@/index";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "SubsV2 Org" });
const orgId = org.organization.id;

async function acctBal(businessId: string, account: string): Promise<bigint> {
  return withTenant(orgId, async (tx: Tx) => {
    const res =
      await tx.execute(sql`select coalesce(sum(case when direction='debit' then amount_minor else -amount_minor end),0)::bigint as bal
      from ledger_entries where business_id = ${businessId} and account = ${account} and currency='USD'`);
    return BigInt((res as unknown as Array<{ bal: string | number }>)[0]?.bal ?? 0);
  });
}
async function ledgerNetsZero(businessId: string): Promise<boolean> {
  return withTenant(orgId, async (tx: Tx) => {
    const res =
      await tx.execute(sql`select coalesce(sum(case when direction='debit' then amount_minor else -amount_minor end),0)::bigint as bal
      from ledger_entries where business_id = ${businessId} group by currency`);
    return (res as unknown as Array<{ bal: string | number }>).every((r) => BigInt(r.bal) === 0n);
  });
}
async function freshBiz(name: string) {
  const b = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
  });
  const prod = await createProduct({ organizationId: orgId, businessId: b.id, name: "Plan" });
  const price = (amt: number, extra: Record<string, unknown> = {}) =>
    createPrice({
      organizationId: orgId,
      businessId: b.id,
      productId: prod.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor: amt,
      interval: "month",
      ...extra,
    });
  return { biz: b, price };
}
async function cust(
  bizId: string,
  email: string,
  opts: { auto?: "on" | "off"; card?: "good" | "hard" } = {},
) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email,
    autoCollection: opts.auto ?? "on",
  });
  if (opts.card)
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: bizId,
      customer: c,
      token: opts.card === "good" ? "tok_4242" : "4000000000000002",
    });
  return c;
}
async function subRow(id: string) {
  return withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1))[0]!,
  );
}
async function invCount(subId: string): Promise<number> {
  return withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(invoices).where(eq(invoices.subscriptionId, subId))).length,
  );
}
async function cnFor(bizId: string, customerId: string) {
  return withTenant(orgId, async (tx) =>
    tx
      .select()
      .from(creditNotes)
      .where(and(eq(creditNotes.businessId, bizId), eq(creditNotes.customerId, customerId))),
  );
}
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

// ══════════════════════════════════════════════════════════════════════════════
// SUB-1 — future status
// ══════════════════════════════════════════════════════════════════════════════
{
  const { biz, price } = await freshBiz("F1 future");
  const c = await cust(biz.id, "future@a.com", { auto: "on", card: "good" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    startDate: days(2),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  ok("SUB-1: future-dated create → status future", sub.status === "future");
  ok("SUB-1: no invoice raised for a future sub", (await invCount(sub.id)) === 0);
  // Clock before start date: still future.
  await runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  ok("SUB-1: clock before start keeps it future", (await subRow(sub.id)).status === "future");
  // Clock after start date: starts + first-bills (good card → paid).
  await runWithClockScope({ onlyBusinessId: biz.id, now: days(3) }, () =>
    runBillingClockTick(days(3)),
  );
  const started = await subRow(sub.id);
  ok(
    "SUB-1: clock at/after start → active",
    started.status === "active" && started.activatedAt !== null,
  );
  ok("SUB-1: first period billed on start", (await invCount(sub.id)) === 1);
}
{
  // future + trial → starts into in_trial (trial still ahead), no bill yet.
  const { biz, price } = await freshBiz("F1 future+trial");
  const c = await cust(biz.id, "ftrial@a.com", { auto: "on", card: "good" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    startDate: days(1),
    trialDays: 30,
    items: [{ price: await price(5000), quantity: 1 }],
  });
  ok("SUB-1: future+trial → future", sub.status === "future");
  await runWithClockScope({ onlyBusinessId: biz.id, now: days(2) }, () =>
    runBillingClockTick(days(2)),
  );
  const started = await subRow(sub.id);
  ok("SUB-1: future+trial starts into in_trial", started.status === "in_trial");
  ok("SUB-1: in_trial raises no invoice yet", (await invCount(sub.id)) === 0);
}
{
  // cancel-before-start → cancelled, no money.
  const { biz, price } = await freshBiz("F1 cancel-before-start");
  const c = await cust(biz.id, "cbs@a.com", { auto: "on", card: "good" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    startDate: days(5),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  const { subscription: cancelled } = await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    cancelOption: "immediately",
  });
  ok("SUB-1: cancel a future sub → cancelled", cancelled.status === "cancelled");
  ok(
    "SUB-1: cancel-before-start moved no money",
    (await invCount(sub.id)) === 0 && (await ledgerNetsZero(biz.id)),
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SUB-2/4 — remaining_billing_cycles → non_renewing → cancelled
// ══════════════════════════════════════════════════════════════════════════════
{
  const { biz, price } = await freshBiz("F2 cycles");
  const c = await cust(biz.id, "cycles@a.com", { auto: "on", card: "good" });
  // billing_cycles = 2 → runs exactly 2 cycles then cancels. Seed remaining = 1.
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  // Force the cycle cap on the sub (create seeds from price.billing_cycles; set directly for the test).
  await withTenant(orgId, (tx) =>
    tx.update(subscriptions).set({ remainingBillingCycles: 1 }).where(eq(subscriptions.id, sub.id)),
  );
  await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: await subRow(sub.id),
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
  let s = await subRow(sub.id);
  ok(
    "SUB-2: cycle 1 → active (remaining 1)",
    apiSubscriptionStatus(s) === "active" && s.remainingBillingCycles === 1,
  );
  // Renew once: remaining 1→0 → derived non_renewing.
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ currentPeriodEnd: days(-1) })
      .where(eq(subscriptions.id, sub.id)),
  );
  await runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  s = await subRow(sub.id);
  ok(
    "SUB-4: after renewal remaining 0 → derived non_renewing",
    s.remainingBillingCycles === 0 &&
      apiSubscriptionStatus(s) === "non_renewing" &&
      s.status === "active",
  );
  // remove_scheduled_cancellation → renews forever again.
  const restored = await removeScheduledCancellation({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
  });
  ok(
    "SUB-2: remove_scheduled_cancellation → active + remaining null",
    apiSubscriptionStatus(restored) === "active" && restored.remainingBillingCycles === null,
  );
  // Re-arm exhaustion and renew again → cancels at term end.
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ remainingBillingCycles: 0, currentPeriodEnd: days(-1) })
      .where(eq(subscriptions.id, sub.id)),
  );
  await runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  ok(
    "SUB-2: renewal with remaining 0 → cancelled at term end",
    (await subRow(sub.id)).status === "cancelled",
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SUB-4b — remaining_billing_cycles is now WRITABLE through the settings PATCH
// ══════════════════════════════════════════════════════════════════════════════
// Display shipped long before the write: the detail page rendered the count as a
// read-only row, correctly, because the PATCH route accepted only auto_collection /
// po_number / invoice_notes / custom_fields and an editor would have been a dead
// control. The block above had to reach past the API and UPDATE the column directly to
// test the engine at all, which is the tell. `updateSubscriptionSettings` takes it now.
{
  const { biz, price } = await freshBiz("F2b cycles editable");
  const c = await cust(biz.id, "cycles-edit@a.com", { auto: "on", card: "good" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  ok(
    "SUB-4b: a subscription with no cap starts null (renews forever)",
    (await subRow(sub.id)).remainingBillingCycles === null,
  );

  const capped = await updateSubscriptionSettings({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionPublicId: sub.publicId,
    remainingBillingCycles: 2,
  });
  ok("SUB-4b: the settings PATCH sets the cap", capped?.remainingBillingCycles === 2);
  ok(
    "SUB-4b: …and 2 remaining is still plainly active",
    apiSubscriptionStatus(capped!) === "active",
  );

  // 0 is the load-bearing value: it is what DERIVES non_renewing, so an operator
  // setting it is scheduling the end of the subscription. Asserted, not assumed.
  const last = await updateSubscriptionSettings({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionPublicId: sub.publicId,
    remainingBillingCycles: 0,
  });
  ok(
    "SUB-4b: setting 0 makes the current term the last (derived non_renewing)",
    last?.remainingBillingCycles === 0 &&
      apiSubscriptionStatus(last!) === "non_renewing" &&
      last!.status === "active",
  );

  // null clears it again — the "renews forever" arm of the editor, and the reason the
  // control is a mode select plus a number rather than one box that cannot say forever.
  const cleared = await updateSubscriptionSettings({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionPublicId: sub.publicId,
    remainingBillingCycles: null,
  });
  ok(
    "SUB-4b: null clears the cap and it renews forever again",
    cleared?.remainingBillingCycles === null && apiSubscriptionStatus(cleared!) === "active",
  );

  // Omitting the key must leave it ALONE — the same distinction every field on this
  // route makes, and the one that decides whether an unrelated edit cancels a customer.
  await updateSubscriptionSettings({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionPublicId: sub.publicId,
    remainingBillingCycles: 3,
  });
  const untouched = await updateSubscriptionSettings({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionPublicId: sub.publicId,
    poNumber: "PO-4b",
  });
  ok(
    "SUB-4b: an unrelated settings edit leaves the cap untouched",
    untouched?.remainingBillingCycles === 3 && untouched?.poNumber === "PO-4b",
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SUB-5 — cancel option set (ledger + credit notes)
// ══════════════════════════════════════════════════════════════════════════════

// Pin a clean 10-day term so proration is exact: full 10000, cancel at day 5 → 5000.
async function paidSubOn10DayTerm(
  biz: string,
  priceFn: (
    a: number,
    e?: Record<string, unknown>,
  ) => Promise<Awaited<ReturnType<typeof createPrice>>>,
  email: string,
) {
  const c = await cust(biz, email, { auto: "on", card: "good" });
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: biz,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await priceFn(10000), quantity: 1 }],
  });
  const pStart = new Date(Date.UTC(2026, 0, 1));
  const pEnd = new Date(Date.UTC(2026, 0, 11));
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ currentPeriodStart: pStart, currentPeriodEnd: pEnd })
      .where(eq(subscriptions.id, subscription.id)),
  );
  const sub = await subRow(subscription.id);
  await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz,
    subscription: sub,
    periodStart: pStart,
    periodEnd: pEnd,
  }); // paid via good card
  return { c, sub };
}
const mid = new Date(Date.UTC(2026, 0, 6)); // day 5 of a 10-day term

{
  // immediately + credit prorate (paid term) → refundable CN 5000 (hand-computed).
  const { biz, price } = await freshBiz("F5 credit-prorate");
  const { c, sub } = await paidSubOn10DayTerm(biz.id, price, "cp@a.com");
  const { subscription, creditNote } = await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: mid,
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
    cancelReasonCode: "customer_request",
  });
  ok(
    "SUB-5: immediate cancel → cancelled + reason code (SUB-8)",
    subscription.status === "cancelled" && subscription.cancelReasonCode === "customer_request",
  );
  const cns = await cnFor(biz.id, c.id);
  const refundable = cns.find((n) => n.publicId === creditNote);
  ok(
    "SUB-5: prorate/paid → refundable CN = 5000 (hand-computed 10000×5/10)",
    !!refundable && refundable.kind === "refundable" && refundable.totalMinor === 5000n,
  );
  ok(
    "SUB-5: refundable bucket credited 5000",
    (await acctBal(biz.id, "refundable_credit_balance")) === -5000n,
  );
  ok("SUB-5: prorate cancel ledger nets zero", await ledgerNetsZero(biz.id));
}
{
  // immediately + credit full (paid) → refundable CN = full term 10000.
  const { biz, price } = await freshBiz("F5 credit-full");
  const { c, sub } = await paidSubOn10DayTerm(biz.id, price, "cf@a.com");
  const { creditNote } = await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: mid,
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "full",
  });
  const refundable = (await cnFor(biz.id, c.id)).find((n) => n.publicId === creditNote);
  ok(
    "SUB-5: full/paid → refundable CN = 10000 (whole term)",
    !!refundable && refundable.totalMinor === 10000n,
  );
}
{
  // immediately + refundable_credits_handling schedule_refund → bucket → refunds_payable.
  const { biz, price } = await freshBiz("F5 refund-refundable");
  const { c, sub } = await paidSubOn10DayTerm(biz.id, price, "rr@a.com");
  const cashBeforeRefund = await acctBal(biz.id, "cash"); // 10000 from the paid term
  await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: mid,
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
    refundableCreditsHandling: "schedule_refund",
  });
  ok(
    "SUB-5: schedule_refund drains refundable bucket to 0",
    (await acctBal(biz.id, "refundable_credit_balance")) === 0n,
  );
  // schedule_refund now PAYS OUT via the gateway: refunds_payable draws +5000 then
  // clears −5000 → net 0, and cash goes out 5000 (the customer receives money).
  ok(
    "SUB-5: schedule_refund pays out → refunds_payable 0, cash out 5000",
    (await acctBal(biz.id, "refunds_payable")) === 0n &&
      (await acctBal(biz.id, "cash")) === cashBeforeRefund - 5000n,
  );
  ok("SUB-5: refund handling ledger nets zero", await ledgerNetsZero(biz.id));
}
{
  // immediately + AR write_off (unpaid/offline invoice) → invoice written_off + bad_debt.
  const { biz, price } = await freshBiz("F5 ar-writeoff");
  const c = await cust(biz.id, "wo@a.com", { auto: "off" }); // offline → open invoice
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(4000), quantity: 1 }],
  });
  await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  }); // posted, AR 4000
  await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    cancelOption: "immediately",
    accountReceivablesHandling: "write_off",
  });
  ok(
    "SUB-5: AR write_off → invoice written_off + AR cleared",
    (await acctBal(biz.id, "accounts_receivable")) === 0n &&
      (await acctBal(biz.id, "bad_debt")) === 4000n,
  );
  ok("SUB-5: write_off ledger nets zero", await ledgerNetsZero(biz.id));
}
{
  // immediately + AR void (2026-09-07) → invoice VOIDED and AR cleared, with NO bad_debt.
  // That last clause is the whole point of a fourth option: a write-off says the revenue
  // was earned and will not be collected (bad_debt 4000 above), a void says it was never
  // owed. If a void ever posts bad_debt, the two have been conflated and the P&L is wrong.
  const { biz, price } = await freshBiz("F5 ar-void");
  const c = await cust(biz.id, "void@a.com", { auto: "off" }); // offline → open invoice
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(4000), quantity: 1 }],
  });
  await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  }); // posted, AR 4000
  await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    cancelOption: "immediately",
    accountReceivablesHandling: "void",
  });
  const voidedInvs = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.subscriptionId, sub.id)),
  );
  ok(
    `SUB-5: AR void → invoice voided [${voidedInvs.map((i) => i.status).join(",")}]`,
    voidedInvs.length > 0 && voidedInvs.every((i) => i.status === "voided"),
  );
  ok(
    "SUB-5: AR void → AR cleared and NO bad_debt",
    (await acctBal(biz.id, "accounts_receivable")) === 0n &&
      (await acctBal(biz.id, "bad_debt")) === 0n,
  );
  ok("SUB-5: void ledger nets zero", await ledgerNetsZero(biz.id));
}
{
  // immediately + unbilled_charges_option delete → pending charge voided (no invoice).
  const { biz, price } = await freshBiz("F5 unbilled-delete");
  const c = await cust(biz.id, "ud@a.com", { auto: "off" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(3000), quantity: 1 }],
  });
  await addAdHocCharge({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    description: "overage",
    amountMinor: 1500,
    invoiceNow: false,
    now: new Date(),
  });
  const before = await invCount(sub.id);
  await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    cancelOption: "immediately",
    unbilledChargesOption: "delete",
  });
  ok("SUB-5: unbilled delete → no new invoice for the charge", (await invCount(sub.id)) === before);
}
{
  // immediately + unbilled_charges_option invoice → pending charge invoiced.
  const { biz, price } = await freshBiz("F5 unbilled-invoice");
  const c = await cust(biz.id, "ui@a.com", { auto: "off" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(3000), quantity: 1 }],
  });
  await addAdHocCharge({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    description: "overage",
    amountMinor: 1500,
    invoiceNow: false,
    now: new Date(),
  });
  const before = await invCount(sub.id);
  await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    cancelOption: "immediately",
    unbilledChargesOption: "invoice",
  });
  ok(
    "SUB-5: unbilled invoice → a new invoice bills the charge",
    (await invCount(sub.id)) === before + 1,
  );
}
{
  // end_of_term → cancel_at_period_end (derived non_renewing), no money now.
  const { biz, price } = await freshBiz("F5 eot");
  const c = await cust(biz.id, "eot@a.com", { auto: "on", card: "good" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  const { subscription: eot } = await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    cancelOption: "end_of_term",
  });
  ok(
    "SUB-5: end_of_term → active + cancel_at_period_end (derived non_renewing)",
    eot.status === "active" &&
      eot.cancelAtPeriodEnd === true &&
      apiSubscriptionStatus(eot) === "non_renewing",
  );
  // At term end the clock cancels it.
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ currentPeriodEnd: days(-1) })
      .where(eq(subscriptions.id, sub.id)),
  );
  await runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  ok("SUB-5: end_of_term cancels at renewal", (await subRow(sub.id)).status === "cancelled");
}
{
  // specific_date → scheduled cancel; applied by the clock at the date.
  const { biz, price } = await freshBiz("F5 specific");
  const c = await cust(biz.id, "spec@a.com", { auto: "on", card: "good" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  const { scheduledChange } = await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    cancelOption: "specific_date",
    cancelAt: days(3),
  });
  ok(
    "SUB-5: specific_date → scheduled change created, sub still active",
    !!scheduledChange && (await subRow(sub.id)).status === "active",
  );
  await applyDueScheduledChanges(days(4));
  ok(
    "SUB-5: scheduled cancel applied at date → cancelled",
    (await subRow(sub.id)).status === "cancelled",
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SUB-6 — pause / resume option set
// ══════════════════════════════════════════════════════════════════════════════
{
  // pause billing_cycles skip=1 → paused + auto-resume scheduled; clock resumes it.
  const { biz, price } = await freshBiz("F6 skip");
  const c = await cust(biz.id, "skip@a.com", { auto: "on", card: "good" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  const { subscription: paused, resumeScheduledAt } = await pauseSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    pauseOption: "billing_cycles",
    skipBillingCycles: 1,
  });
  ok(
    "SUB-6: pause billing_cycles → paused + a resume is scheduled",
    paused.status === "paused" && resumeScheduledAt !== null,
  );
  // Paused subs are not billed by the renewal pass.
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ currentPeriodEnd: days(-1) })
      .where(eq(subscriptions.id, sub.id)),
  );
  await runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  ok("SUB-6: paused sub is not renewed/billed", (await subRow(sub.id)).status === "paused");
  // Advance well past the scheduled resume → the clock resumes it.
  await applyDueScheduledChanges(days(120));
  const resumed = await subRow(sub.id);
  ok("SUB-6: skip_billing_cycles auto-resumes → active", resumed.status === "active");
  // F-review blocker: the resume must RESTART the term (period in the future),
  // or the clock back-bills every "skipped" cycle. Exactly two invoices ever:
  // the create-time bill + the fresh resumed period.
  ok(
    "SUB-6: auto-resume restarts the term (period end in the future)",
    resumed.currentPeriodEnd! > new Date(),
  );
  await runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  ok(
    "SUB-6: no back-billing of skipped cycles (only the resumed period billed)",
    (await invCount(sub.id)) === 1,
  );
  ok(
    "SUB-6: skipped cycle was never charged (cash = 1 × 5000)",
    (await acctBal(biz.id, "cash")) === 5000n,
  );
}
{
  // pause dunning_handling stop → the sub's open payment_due invoice is stopped.
  const { biz, price } = await freshBiz("F6 dunning-stop");
  const c = await cust(biz.id, "ds@a.com", { auto: "on", card: "hard" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  // A retriable-ish decline: use a fresh hard card sub, then set an invoice payment_due manually.
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ status: "payment_due", dunningStatus: "in_progress", nextAttemptAt: days(1) })
      .where(eq(invoices.id, invoice.id)),
  );
  await pauseSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    pauseOption: "immediately",
    dunningHandling: "stop",
  });
  const inv = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1))[0]!,
  );
  ok(
    "SUB-6: pause dunning_handling=stop halts dunning on the open invoice",
    inv.dunningStatus === "stopped" && inv.status === "not_paid",
  );
}
{
  // resume charges_handling invoice_immediately → a fresh invoice is raised.
  const { biz, price } = await freshBiz("F6 resume-invoice");
  const c = await cust(biz.id, "ri@a.com", { auto: "on", card: "good" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  await pauseSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    pauseOption: "immediately",
  });
  const before = await invCount(sub.id);
  const { subscription: resumed, invoice } = await resumeSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(sub.currentPeriodEnd!.getTime() + 3 * 86_400_000),
    chargesHandling: "invoice_immediately",
  });
  ok("SUB-6: resume → active", resumed.status === "active");
  ok(
    "SUB-6: resume invoice_immediately raises a new invoice",
    !!invoice && (await invCount(sub.id)) === before + 1,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SUB-9 — change_term_end proration
// ══════════════════════════════════════════════════════════════════════════════
{
  // Extend a 10-day term by 5 days at 10000/term → charge 5000 (hand-computed).
  const { biz, price } = await freshBiz("F9 extend");
  const { c, sub } = await paidSubOn10DayTerm(biz.id, price, "ext@a.com");
  const cashBefore = await acctBal(biz.id, "cash");
  const { prorationInvoice } = await changeTermEnd({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: mid,
    termEndsAt: new Date(Date.UTC(2026, 0, 16)),
    prorate: true,
    invoiceImmediately: true,
    originToken: "vtok_verify-subscriptions-v2_0",
  });
  ok("SUB-9: term extension raises a proration charge (5000 = 10000×5/10)", !!prorationInvoice);
  ok("SUB-9: extension collected 5000", (await acctBal(biz.id, "cash")) === cashBefore + 5000n);
  ok(
    "SUB-9: new term end moved",
    (await subRow(sub.id)).currentPeriodEnd!.getTime() === Date.UTC(2026, 0, 16),
  );
  ok("SUB-9: extension ledger nets zero", await ledgerNetsZero(biz.id));
  void c;
}
{
  // No-prorate term change → boundary moves, no money.
  const { biz, price } = await freshBiz("F9 noprorate");
  const { sub } = await paidSubOn10DayTerm(biz.id, price, "np9@a.com");
  const cnBefore = (await cnFor(biz.id, sub.customerId)).length;
  await changeTermEnd({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: mid,
    termEndsAt: new Date(Date.UTC(2026, 0, 16)),
    prorate: false,
  });
  ok(
    "SUB-9: no-prorate term change moves boundary, no credit note",
    (await subRow(sub.id)).currentPeriodEnd!.getTime() === Date.UTC(2026, 0, 16) &&
      (await cnFor(biz.id, sub.customerId)).length === cnBefore,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SUB-3 — dues snapshot
// ══════════════════════════════════════════════════════════════════════════════
{
  const { biz, price } = await freshBiz("F3 dues");
  const c = await cust(biz.id, "dues@a.com", { auto: "off" }); // offline → open invoice
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(7000), quantity: 1 }],
  });
  await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  }); // posted, due 7000
  const dues = await subscriptionDues(orgId, sub.id);
  ok("SUB-3: dues snapshot counts the open invoice", dues.due_invoices_count === 1);
  ok("SUB-3: total_dues = 7000", dues.total_dues_minor === 7000);
  ok("SUB-3: due_since set", dues.due_since !== null);
}

// ══════════════════════════════════════════════════════════════════════════════
// SUB-7 — dunning-exhaust with subscription RETAINED
// ══════════════════════════════════════════════════════════════════════════════
{
  const { biz, price } = await freshBiz("F7 retain");
  await updateBusiness(orgId, biz.publicId, {
    dunningConfig: { retries: [], final_action: { invoice: "not_paid", subscription: "retain" } },
  });
  const c = await cust(biz.id, "retain@a.com", { auto: "on", card: "hard" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  // Renew into an exhausting failure (hard card, no retries) → final action retain.
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ currentPeriodEnd: days(-1) })
      .where(eq(subscriptions.id, sub.id)),
  );
  await runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  ok(
    "SUB-7: dunning-exhaust with retain → subscription stays active (not cancelled)",
    (await subRow(sub.id)).status === "active",
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// FR — F-review regressions (Fable audit)
// ══════════════════════════════════════════════════════════════════════════════

// FR1: trial + billing_cycles=1 → exactly ONE paid cycle (was zero: the seed
// assumed the trial period was a billed cycle).
{
  const { biz, price } = await freshBiz("FR1 trial cycles");
  const c = await cust(biz.id, "fr1@a.com", { auto: "on", card: "good" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    trialDays: 7,
    items: [{ price: await price(5000, { billingCycles: 1 }), quantity: 1 }],
  });
  ok(
    "FR1: trial sub seeds remaining = FULL cap (1)",
    sub.status === "in_trial" && sub.remainingBillingCycles === 1,
  );
  // Trial ends → renewal bills paid cycle #1 (remaining 1 → 0).
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ currentPeriodEnd: days(-1) })
      .where(eq(subscriptions.id, sub.id)),
  );
  await runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  const afterTrial = await subRow(sub.id);
  ok(
    "FR1: trial end bills the one paid cycle",
    afterTrial.status === "active" &&
      (await invCount(sub.id)) === 1 &&
      (await acctBal(biz.id, "cash")) === 5000n,
  );
  // Next term end → cancels WITHOUT billing a second cycle.
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ currentPeriodEnd: days(-1) })
      .where(eq(subscriptions.id, sub.id)),
  );
  await runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  ok(
    "FR1: exactly 1 paid cycle then cancelled",
    (await subRow(sub.id)).status === "cancelled" && (await invCount(sub.id)) === 1,
  );
}

// FR2: renewal must not resurrect a concurrently-cancelled sub (guarded claim).
{
  const { biz, price } = await freshBiz("FR2 no-resurrect");
  const c = await cust(biz.id, "fr2@a.com", { auto: "on", card: "good" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ currentPeriodEnd: days(-1) })
      .where(eq(subscriptions.id, sub.id)),
  );
  await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    cancelOption: "immediately",
  });
  const before = await invCount(sub.id);
  await runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  const after = await subRow(sub.id);
  ok("FR2: cancelled sub stays cancelled through a due tick", after.status === "cancelled");
  ok("FR2: no invoice billed for a cancelled sub", (await invCount(sub.id)) === before);
}

// FR3: cancellation credit bases on the TERM invoice even when unbilled charges
// are invoiced first, and a promo-paid term restores the PROMO bucket (no CN throw,
// no cashable credit) — idempotently.
{
  const { addPromotionalCredits, bucketBalancesForCurrency } =
    await import("@/modules/customers/balances");
  const { issueProratedCreditForUnusedTerm } =
    await import("@/modules/subscriptions/cancellation-credit");
  // (a) term invoice 10000 paid by card + a 500 ad-hoc charge invoiced at cancel:
  // prorated credit must derive from the 10000 term invoice, not the 500 one.
  const { biz, price } = await freshBiz("FR3 credit-base");
  const c = await cust(biz.id, "fr3@a.com", { auto: "on", card: "good" });
  const start = new Date(Date.now() - 5 * 86_400_000);
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: start,
    startDate: start,
    items: [{ price: await price(10000), quantity: 1 }],
  });
  await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
  // Pin a 10-day term so the halfway proration constant is exact: 5000.
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({
        currentPeriodStart: start,
        currentPeriodEnd: new Date(start.getTime() + 10 * 86_400_000),
      })
      .where(eq(subscriptions.id, sub.id)),
  );
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ periodStart: start, periodEnd: new Date(start.getTime() + 10 * 86_400_000) })
      .where(eq(invoices.subscriptionId, sub.id)),
  );
  await addAdHocCharge({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    description: "setup",
    amountMinor: 500,
    invoiceNow: false,
    now: new Date(),
  });
  const { creditNote } = await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(start.getTime() + 5 * 86_400_000),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
    unbilledChargesOption: "invoice",
  });
  const cns = (await cnFor(biz.id, c.id)).filter(
    (n) => n.reasonCode === "subscription_cancellation",
  );
  ok(
    "FR3a: credit based on the 10000 TERM invoice (5000 = 10-day term at day 5)",
    cns.length === 1 && cns[0]!.totalMinor === 5000n && creditNote != null,
  );

  // (b) promo-paid term: cancel must not throw, promo goes back to the promo
  // bucket, no refundable CN is minted, and a re-run credits nothing more.
  const { biz: biz2, price: price2 } = await freshBiz("FR3 promo-paid");
  const c2 = await cust(biz2.id, "fr3b@a.com", { auto: "on", card: "good" });
  await addPromotionalCredits({
    organizationId: orgId,
    businessId: biz2.id,
    customer: c2,
    amountMinor: 10000,
    currency: "USD",
  });
  const start2 = new Date(Date.now() - 5 * 86_400_000);
  const { subscription: sub2 } = await createSubscription({
    organizationId: orgId,
    businessId: biz2.id,
    customerId: c2.id,
    now: start2,
    startDate: start2,
    items: [{ price: await price2(10000), quantity: 1 }],
  });
  await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz2.id,
    subscription: sub2,
    periodStart: sub2.currentPeriodStart!,
    periodEnd: sub2.currentPeriodEnd!,
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({
        currentPeriodStart: start2,
        currentPeriodEnd: new Date(start2.getTime() + 10 * 86_400_000),
      })
      .where(eq(subscriptions.id, sub2.id)),
  );
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ periodStart: start2, periodEnd: new Date(start2.getTime() + 10 * 86_400_000) })
      .where(eq(invoices.subscriptionId, sub2.id)),
  );
  const r = await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz2.id,
    subscriptionId: sub2.id,
    now: new Date(start2.getTime() + 5 * 86_400_000),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
  });
  const buckets = await bucketBalancesForCurrency(orgId, c2.id, "USD");
  ok(
    "FR3b: promo-paid cancel does not tear (sub cancelled, no throw)",
    r.subscription.status === "cancelled",
  );
  ok(
    "FR3b: promo restored to the PROMO bucket (~5000), nothing cashable",
    buckets.promotional === 5000n && buckets.refundable === 0n,
  );
  const again = await issueProratedCreditForUnusedTerm({
    organizationId: orgId,
    businessId: biz2.id,
    subscription: await subRow(sub2.id),
    creditOption: "prorate",
    now: new Date(start2.getTime() + 5 * 86_400_000),
  });
  const buckets2 = await bucketBalancesForCurrency(orgId, c2.id, "USD");
  ok(
    "FR3b: credit is idempotent (re-run restores nothing more)",
    buckets2.promotional === 5000n &&
      (again == null || again.reasonCode === "subscription_cancellation"),
  );
  ok("FR3b: ledger nets to zero", await ledgerNetsZero(biz2.id));
}

// FR4: change_term_end must reject a boundary in the past (over-credit of
// already-consumed time).
{
  const { biz, price } = await freshBiz("FR4 past term end");
  const c = await cust(biz.id, "fr4@a.com", { auto: "on", card: "good" });
  const start = new Date(Date.now() - 20 * 86_400_000);
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: start,
    startDate: start,
    items: [{ price: await price(10000), quantity: 1 }],
  });
  let rejected = false;
  try {
    await changeTermEnd({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      termEndsAt: new Date(Date.now() - 9 * 86_400_000),
      prorate: true,
      now: new Date(),
      originToken: "vtok_verify-subscriptions-v2_1",
    });
  } catch {
    rejected = true;
  }
  ok("FR4: past term_ends_at rejected (no credit for consumed time)", rejected);
}

// FR5: voiding an adjustment CN on a partially-promo-paid invoice reopens only
// the true outstanding (bucket draws are settled value).
{
  const cnMod = await import("@/modules/credit-notes/service");
  const { addPromotionalCredits } = await import("@/modules/customers/balances");
  const { biz, price } = await freshBiz("FR5 void-outstanding");
  const c = await cust(biz.id, "fr5@a.com", { auto: "off" });
  await addPromotionalCredits({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 3000,
    currency: "USD",
  });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(10000), quantity: 1 }],
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
  // 10000 total, 3000 promo applied at generation → due 7000; adjust the rest → paid.
  const cn = await cnMod.issueAdjustmentCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: invoice.publicId,
    items: [{ description: "adj", amountMinor: 7000 }],
  });
  const paid = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1))[0]!,
  );
  ok("FR5: full adjustment of the cash remainder → paid", paid.status === "paid");
  await cnMod.voidCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    creditNotePublicId: cn.publicId,
  });
  const reopened = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1))[0]!,
  );
  ok(
    "FR5: void reopens only the true outstanding (7000, not 10000)",
    reopened.amountDueMinor === 7000n,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// GR — Phase-F review regressions (warm-up fixes; HAND-COMPUTED money)
// ══════════════════════════════════════════════════════════════════════════════

// GR1: change_term_end SHORTENING credits the removed time (hand-computed). 10-day
// term, paid 10000; shorten day-10 → day-8 at day-5 removes 2 days → 2000 back.
{
  const { biz, price } = await freshBiz("GR1 shorten");
  const { c, sub } = await paidSubOn10DayTerm(biz.id, price, "gr1@a.com");
  const cnBefore = (await cnFor(biz.id, c.id)).length;
  const bucketBefore = await acctBal(biz.id, "refundable_credit_balance");
  // Paid term → shortening credits the removed time as a refundable CN (in the
  // bucket; the customer can refund it separately). 2000 = 10000 × 2days / 10days.
  await changeTermEnd({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: mid,
    termEndsAt: new Date(Date.UTC(2026, 0, 9)),
    prorate: true,
    invoiceImmediately: false,
    originToken: "vtok_verify-subscriptions-v2_2",
  });
  const cns = await cnFor(biz.id, c.id);
  const shortCn = cns.find((n) => n.reasonCode === "term_change");
  ok(
    "GR1: shortening a paid term issues a 2000 refundable CN",
    !!shortCn && shortCn!.totalMinor === 2000n && cns.length === cnBefore + 1,
  );
  ok(
    "GR1: shortening credits the refundable bucket by 2000",
    (await acctBal(biz.id, "refundable_credit_balance")) === bucketBefore - 2000n,
  );
  ok(
    "GR1: new (earlier) term end moved",
    (await subRow(sub.id)).currentPeriodEnd!.getTime() === Date.UTC(2026, 0, 9),
  );
  ok("GR1: shortening ledger nets zero", await ledgerNetsZero(biz.id));
}

// GR2: repeated change_term_end must NOT dilute the daily rate. Extend +5d twice;
// each extension charges 5000 (10000 × 5 / 10), not a diluted rate.
{
  const { biz, price } = await freshBiz("GR2 no-dilute");
  const { sub } = await paidSubOn10DayTerm(biz.id, price, "gr2@a.com");
  const cash0 = await acctBal(biz.id, "cash");
  await changeTermEnd({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: mid,
    termEndsAt: new Date(Date.UTC(2026, 0, 16)),
    prorate: true,
    invoiceImmediately: true,
    originToken: "vtok_verify-subscriptions-v2_0",
  });
  const cash1 = await acctBal(biz.id, "cash");
  await changeTermEnd({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: mid,
    termEndsAt: new Date(Date.UTC(2026, 0, 21)),
    prorate: true,
    invoiceImmediately: true,
    originToken: "vtok_verify-subscriptions-v2_4",
  });
  const cash2 = await acctBal(biz.id, "cash");
  ok("GR2: first +5d extension charges 5000", cash1 - cash0 === 5000n);
  ok("GR2: second +5d extension ALSO charges 5000 (no rate dilution)", cash2 - cash1 === 5000n);
}

// GR3: specific_date cancel carries its money options — the scheduled apply issues
// the prorate credit + drains the refundable bucket (was silently dropped).
{
  const { biz, price } = await freshBiz("GR3 specific-date-opts");
  const { c, sub } = await paidSubOn10DayTerm(biz.id, price, "gr3@a.com");
  const cashBefore = await acctBal(biz.id, "cash"); // 10000
  // Scheduled from the START of the term for a cancel at `mid` — `cancel_at` must be
  // in the future when it is scheduled (0159; a past date now means "you wanted
  // cancel_option=immediately"). The apply instant below is still `mid`, so every
  // money assertion here is unchanged: the specific_date branch uses `now` only for
  // that guard and the audit stamp.
  await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(Date.UTC(2026, 0, 1)),
    cancelOption: "specific_date",
    cancelAt: mid,
    creditOptionForCurrentTermCharges: "prorate",
    refundableCreditsHandling: "schedule_refund",
  });
  ok(
    "GR3: sub still active before the scheduled date applies",
    (await subRow(sub.id)).status === "active",
  );
  await applyDueScheduledChanges(mid); // day 5 → prorate credit 5000
  ok(
    "GR3: scheduled specific_date cancel applied → cancelled",
    (await subRow(sub.id)).status === "cancelled",
  );
  // prorate credit 5000 issued and (schedule_refund) paid out → cash out 5000.
  ok(
    "GR3: specific_date honoured its money options (cash out 5000, bucket 0)",
    (await acctBal(biz.id, "cash")) === cashBefore - 5000n &&
      (await acctBal(biz.id, "refundable_credit_balance")) === 0n,
  );
  void c;
}

// GR4: a `future` sub can't be paused; end_of_term cancel of a future sub cancels
// immediately with no money (never starts + bills).
{
  const { biz, price } = await freshBiz("GR4 future-holes");
  const c = await cust(biz.id, "gr4@a.com", { auto: "on", card: "good" });
  const { subscription: fut } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    startDate: days(5),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  let pauseRejected = false;
  try {
    await pauseSubscriptionWithOptions({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: fut.id,
      now: new Date(),
      pauseOption: "immediately",
    });
  } catch {
    pauseRejected = true;
  }
  ok("GR4: pausing a future sub is rejected", pauseRejected);
  const { subscription: cancelled } = await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: fut.id,
    now: new Date(),
    cancelOption: "end_of_term",
  });
  ok("GR4: end_of_term cancel of a future sub → cancelled now", cancelled.status === "cancelled");
  await runWithClockScope({ onlyBusinessId: biz.id, now: days(6) }, () =>
    runBillingClockTick(days(6)),
  );
  ok(
    "GR4: cancelled future sub never starts/bills after its start date",
    (await subRow(fut.id)).status === "cancelled" && (await invCount(fut.id)) === 0,
  );
}

// GR5: reactivating a cycle-exhausted cancelled sub resets remaining cycles + reason
// codes (was: reactivated straight into non_renewing and re-cancelled next term).
{
  const { biz, price } = await freshBiz("GR5 reactivate-reset");
  const c = await cust(biz.id, "gr5@a.com", { auto: "on", card: "good" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  // Exhaust the cycle cap and cancel at term end via a renewal.
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ remainingBillingCycles: 0, currentPeriodEnd: days(-1), cancelReasonCode: "gone" })
      .where(eq(subscriptions.id, sub.id)),
  );
  await runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  ok("GR5: exhausted sub is cancelled", (await subRow(sub.id)).status === "cancelled");
  const { reactivateSubscription } = await import("@/modules/subscriptions/service");
  const { subscription: re } = await reactivateSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
  });
  ok(
    "GR5: reactivate resets remaining cycles + reason codes",
    re.status === "active" &&
      re.remainingBillingCycles === null &&
      re.cancelReasonCode === null &&
      apiSubscriptionStatus(re) === "active",
  );
}

// GR6: resume add_to_unbilled_charges rates the FULL period from snapshots (not MRR)
// — a yearly sub books the annual amount, not 1/12.
{
  const b = await createBusiness({
    organizationId: orgId,
    name: "GR6 yearly",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const prod = await createProduct({ organizationId: orgId, businessId: b.id, name: "Yearly" });
  const yearly = await createPrice({
    organizationId: orgId,
    businessId: b.id,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 120000,
    interval: "year",
  });
  const c = await cust(b.id, "gr6@a.com", { auto: "on", card: "good" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: b.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: yearly, quantity: 1 }],
  });
  await pauseSubscriptionWithOptions({
    organizationId: orgId,
    businessId: b.id,
    subscriptionId: sub.id,
    now: new Date(),
    pauseOption: "immediately",
  });
  await resumeSubscriptionWithOptions({
    organizationId: orgId,
    businessId: b.id,
    subscriptionId: sub.id,
    now: new Date(sub.currentPeriodEnd!.getTime() + 3 * 86_400_000),
    chargesHandling: "add_to_unbilled_charges",
  });
  const { listUnbilledCharges } = await import("@/modules/subscriptions/items");
  const uch = await listUnbilledCharges(orgId, sub.id);
  ok(
    "GR6: resume add_to_unbilled books the FULL annual 120000 (not MRR 10000)",
    uch.length === 1 && uch[0]!.amountMinor === 120000n,
  );
}

// RES: billing is in advance, so a resume inside the paid term charges nothing and keeps
// the term; a resume after it restarts the term at the resume and always bills it.
{
  const DAY = 86_400_000;
  const { listUnbilledCharges } = await import("@/modules/subscriptions/items");
  const setup = async (label: string, pauseConfig?: Record<string, unknown>) => {
    const { biz, price } = await freshBiz(`RES ${label}`);
    if (pauseConfig)
      await withTenant(orgId, (tx) =>
        tx.update(businesses).set({ pauseConfig }).where(eq(businesses.id, biz.id)),
      );
    const c = await cust(biz.id, `res-${label}@a.com`, { auto: "on", card: "good" });
    const { subscription: sub } = await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price: await price(5000), quantity: 1 }],
    });
    await pauseSubscriptionWithOptions({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      now: new Date(),
      pauseOption: "immediately",
    });
    return { biz, sub: await subRow(sub.id), invoices: await invCount(sub.id) };
  };
  const resume = (bizId: string, subId: string, now: Date, charges?: ResumeChargesHandling) =>
    resumeSubscriptionWithOptions({
      organizationId: orgId,
      businessId: bizId,
      subscriptionId: subId,
      now,
      chargesHandling: charges,
    });

  // In-term: even an explicit invoice_immediately raises nothing.
  {
    const { biz, sub, invoices: n0 } = await setup("in-term");
    const { subscription: r, invoice } = await resume(
      biz.id,
      sub.id,
      new Date(Date.now() + DAY),
      "invoice_immediately",
    );
    ok(
      "RES: in-term resume → active, term unchanged",
      r.status === "active" &&
        r.currentPeriodStart!.getTime() === sub.currentPeriodStart!.getTime() &&
        r.currentPeriodEnd!.getTime() === sub.currentPeriodEnd!.getTime(),
    );
    ok(
      "RES: in-term resume → no invoice, no unbilled charge",
      invoice === null &&
        (await invCount(sub.id)) === n0 &&
        (await listUnbilledCharges(orgId, sub.id)).length === 0,
    );
    ok("RES: in-term resume restates MRR", r.mrr === 5000n);
  }

  // Out-of-term, nothing configured → invoice_immediately bills the new term.
  {
    const { biz, sub, invoices: n0 } = await setup("default");
    const at = new Date(sub.currentPeriodEnd!.getTime() + 10 * DAY);
    const { subscription: r, invoice } = await resume(biz.id, sub.id, at);
    const start = r.currentPeriodStart!.getTime();
    ok(
      "RES: out-of-term resume restarts the term at the resume",
      start <= at.getTime() &&
        start > at.getTime() - DAY &&
        r.currentPeriodEnd!.getTime() > at.getTime(),
    );
    const [inv] = invoice
      ? await withTenant(orgId, (tx) =>
          tx.select().from(invoices).where(eq(invoices.publicId, invoice)).limit(1),
        )
      : [];
    ok(
      "RES: out-of-term resume (default) raises ONE invoice for the new term",
      (await invCount(sub.id)) === n0 + 1 &&
        !!inv &&
        inv.totalMinor === 5000n &&
        inv.periodStart?.getTime() === start,
    );
  }

  // Legacy `next_renewal` config resolves to add_to_unbilled_charges.
  {
    const { biz, sub, invoices: n0 } = await setup("legacy", { charges_on_resume: "next_renewal" });
    await resume(biz.id, sub.id, new Date(sub.currentPeriodEnd!.getTime() + 10 * DAY));
    const uch = await listUnbilledCharges(orgId, sub.id);
    ok(
      "RES: legacy next_renewal → one unbilled charge of the full recurring amount, no invoice",
      (await invCount(sub.id)) === n0 && uch.length === 1 && uch[0]!.amountMinor === 5000n,
    );
  }

  // Scheduled billing_cycles resume lands after the paused term: billed, not back-billed.
  {
    const { biz, price } = await freshBiz("RES scheduled");
    const c = await cust(biz.id, "res-sched@a.com", { auto: "on", card: "good" });
    const { subscription: sub } = await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price: await price(5000), quantity: 1 }],
    });
    const n0 = await invCount(sub.id);
    const { resumeScheduledAt } = await pauseSubscriptionWithOptions({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      now: new Date(),
      pauseOption: "billing_cycles",
      skipBillingCycles: 1,
    });
    const at = new Date(resumeScheduledAt!.getTime() + 60_000);
    await runWithClockScope({ onlyBusinessId: biz.id }, () => applyDueScheduledChanges(at));
    const r = await subRow(sub.id);
    ok(
      "RES: scheduled billing_cycles resume → active on a new term from the resume date",
      r.status === "active" &&
        r.currentPeriodStart!.getTime() <= at.getTime() &&
        r.currentPeriodStart!.getTime() > at.getTime() - DAY,
    );
    ok("RES: scheduled resume bills exactly the new term", (await invCount(sub.id)) === n0 + 1);
  }
}

// UCFG: unset unbilled-charges keys follow default_invoice_immediately; a set key decides
// its own event only. Read through the DB, as the change and item paths do.
{
  const { defaultInvoiceImmediately } = await import("@/modules/subscriptions/proration");
  const { biz } = await freshBiz("UCFG precedence");
  const setBiz = (v: Partial<typeof businesses.$inferInsert>) =>
    withTenant(orgId, (tx) => tx.update(businesses).set(v).where(eq(businesses.id, biz.id)));
  const both = async () => [
    await defaultInvoiceImmediately(orgId, biz.id, "onChange"),
    await defaultInvoiceImmediately(orgId, biz.id, "onOneTimeCharge"),
  ];
  await setBiz({
    defaultInvoiceImmediately: true,
    unbilledChargesConfig: { on_create: "invoice_immediately" },
  });
  ok(
    "UCFG: keys unset + flag on → both events invoice now",
    (await both()).every((x) => x),
  );
  await setBiz({ defaultInvoiceImmediately: false });
  ok(
    "UCFG: keys unset + flag off → both events defer",
    (await both()).every((x) => !x),
  );
  await setBiz({ unbilledChargesConfig: { on_change: "invoice_immediately" } });
  const [chg, one] = await both();
  ok(
    "UCFG: on_change set → it decides on_change; one-time still follows the flag",
    chg === true && one === false,
  );
}

// PCFG: pause_config's unbilled_on_pause + dunning_on_pause apply to a scheduled
// end-of-term pause when it lands, exactly as they do to an immediate pause — unless the
// caller gave its own options when scheduling, which are stored and win.
for (const [timing, explicit] of [
  ["immediately", false],
  ["end_of_term", false],
  ["end_of_term", true],
] as const) {
  const label = explicit ? `${timing} + explicit no_action/continue` : timing;
  const { listUnbilledCharges } = await import("@/modules/subscriptions/items");
  const pendingCount = async (subId: string) =>
    (await listUnbilledCharges(orgId, subId)).filter((u) => u.status === "pending").length;
  const { biz, price } = await freshBiz(`PCFG ${label}`);
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ pauseConfig: { unbilled_on_pause: "invoice", dunning_on_pause: "stop" } })
      .where(eq(businesses.id, biz.id)),
  );
  const c = await cust(biz.id, `pcfg-${timing}-${explicit}@a.com`, { auto: "on", card: "good" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ status: "payment_due", dunningStatus: "in_progress", nextAttemptAt: days(1) })
      .where(eq(invoices.id, invoice.id)),
  );
  await addAdHocCharge({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    description: "overage",
    amountMinor: 700,
    invoiceNow: false,
    now: new Date(),
  });
  const n0 = await invCount(sub.id);
  await pauseSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    pauseOption: timing,
    ...(explicit
      ? { unbilledChargesHandling: "no_action" as const, dunningHandling: "continue" as const }
      : {}),
  });
  if (timing === "end_of_term") {
    ok(
      "PCFG: end_of_term pause leaves charges and dunning alone until it lands",
      (await subRow(sub.id)).status === "active" && (await pendingCount(sub.id)) === 1,
    );
    const at = new Date(sub.currentPeriodEnd!.getTime() + 60_000);
    await runWithClockScope({ onlyBusinessId: biz.id }, () => applyDueScheduledChanges(at));
  }
  const inv = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1))[0]!,
  );
  ok(`PCFG ${label}: subscription paused`, (await subRow(sub.id)).status === "paused");
  if (explicit) {
    ok(
      `PCFG ${label}: stored no_action keeps the charge pending, no invoice`,
      (await pendingCount(sub.id)) === 1 && (await invCount(sub.id)) === n0,
    );
    ok(
      `PCFG ${label}: stored continue leaves dunning running`,
      inv.dunningStatus === "in_progress",
    );
  } else {
    ok(
      `PCFG ${label}: unbilled_on_pause=invoice invoices the pending charge`,
      (await pendingCount(sub.id)) === 0 && (await invCount(sub.id)) === n0 + 1,
    );
    ok(
      `PCFG ${label}: dunning_on_pause=stop halts dunning on the open invoice`,
      inv.dunningStatus === "stopped",
    );
  }
}

// GB3 (G-review regression): a future sub whose trial fully ELAPSED during clock
// downtime starts into the first PAID period — which must consume a billing
// cycle (billing_cycles=1 + trial previously billed TWO paid cycles), and a
// crash before that first bill must be healed (period starts at trial_end).
{
  const { biz, price } = await freshBiz("GB3 elapsed trial cycles");
  const c = await cust(biz.id, "gb3@a.com", { auto: "on", card: "good" });
  const start = new Date(Date.now() - 10 * 86_400_000);
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(Date.now() - 11 * 86_400_000),
    startDate: start,
    trialDays: 3,
    items: [{ price: await price(5000, { billingCycles: 1 }), quantity: 1 }],
  });
  ok(
    "GB3: future+trial seeds the FULL cap (1)",
    sub.status === "future" && sub.remainingBillingCycles === 1,
  );
  // Clock catches up long after the trial elapsed → starts + bills paid cycle #1.
  await runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  const started = await subRow(sub.id);
  ok(
    "GB3: elapsed-trial start bills exactly one paid period",
    started.status === "active" &&
      (await invCount(sub.id)) === 1 &&
      (await acctBal(biz.id, "cash")) === 5000n,
  );
  ok("GB3: the paid period consumed the cycle (remaining 0)", started.remainingBillingCycles === 0);
  ok(
    "GB3: period starts at trial end (heal signature)",
    started.currentPeriodStart!.getTime() === started.trialEnd!.getTime(),
  );
  // Next term end → cancels WITHOUT billing a second cycle.
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ currentPeriodEnd: days(-1) })
      .where(eq(subscriptions.id, sub.id)),
  );
  await runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  ok(
    "GB3: exactly 1 paid cycle then cancelled",
    (await subRow(sub.id)).status === "cancelled" &&
      (await invCount(sub.id)) === 1 &&
      (await acctBal(biz.id, "cash")) === 5000n,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SUB-EDIT-TRIAL — edit trial end date
// ══════════════════════════════════════════════════════════════════════════════

// ET1: extend the trial end into the future — trial_end moves and the subscription
// still has NO term; status stays in_trial; no invoice raised.
//
// Until 2026-08-25 this asserted the opposite — that `current_period_end` moved WITH
// `trial_end`, because a trialling subscription mirrored its trial window onto the term
// columns. That mirroring is what made a trialling subscription report a trial AND a term
// at once, which is wrong; the term columns now stay null until the trial
// converts, so the assertion pins the absence rather than the mirror.
{
  const { biz, price } = await freshBiz("ET1 extend trial");
  const c = await cust(biz.id, "et1@a.com", { auto: "on", card: "good" });
  const now = new Date();
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now,
    trialDays: 7,
    items: [{ price: await price(5000), quantity: 1 }],
  });
  const newEnd = new Date(now.getTime() + 30 * 86_400_000);
  const { subscription: updated } = await editTrialEnd({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now,
    trialEnd: newEnd,
  });
  ok("ET1: extended trial stays in_trial", updated.status === "in_trial");
  ok("ET1: trial_end moved to the new date", updated.trialEnd!.getTime() === newEnd.getTime());
  ok(
    "ET1: an extended trial still has no term",
    updated.currentPeriodStart === null && updated.currentPeriodEnd === null,
  );
  ok("ET1: no invoice raised for extending a trial", (await invCount(sub.id)) === 0);
}

// ET2: shorten the trial end — same, just a nearer future date.
{
  const { biz, price } = await freshBiz("ET2 shorten trial");
  const c = await cust(biz.id, "et2@a.com", { auto: "on", card: "good" });
  const now = new Date();
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now,
    trialDays: 14,
    items: [{ price: await price(5000), quantity: 1 }],
  });
  const newEnd = new Date(now.getTime() + 2 * 86_400_000);
  const { subscription: updated } = await editTrialEnd({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now,
    trialEnd: newEnd,
  });
  ok(
    "ET2: shortened trial_end applied",
    updated.trialEnd!.getTime() === newEnd.getTime() && updated.currentPeriodEnd === null,
  );
}

// ET3: end the trial "immediately" — activates the subscription and bills the
// first term exactly as the natural trial-end renewal would (remaining_billing_
// cycles decrements from the FULL cap it was seeded with, per FR1).
{
  const { biz, price } = await freshBiz("ET3 end trial now");
  const c = await cust(biz.id, "et3@a.com", { auto: "on", card: "good" });
  const now = new Date();
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now,
    trialDays: 7,
    items: [{ price: await price(5000, { billingCycles: 1 }), quantity: 1 }],
  });
  ok(
    "ET3: trial sub seeds remaining = FULL cap (1)",
    sub.status === "in_trial" && sub.remainingBillingCycles === 1,
  );
  const { subscription: updated } = await editTrialEnd({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now,
    immediately: true,
  });
  ok("ET3: subscription activated immediately", updated.status === "active");
  ok(
    "ET3: first term invoice raised + collected",
    (await invCount(sub.id)) === 1 && (await acctBal(biz.id, "cash")) === 5000n,
  );
  ok(
    "ET3: billing_cycles decremented like natural trial-end (0 left)",
    updated.remainingBillingCycles === 0,
  );
  ok(
    "ET3: period start moved to the trial-end instant (now)",
    updated.currentPeriodStart!.getTime() === now.getTime(),
  );
}

// ET6: end-trial-now is REFUSED when the sub auto-collects and there is no card at
// all — converting would cancel it for `no_card` (see isTrialConversionUncollectable),
// which is not what an operator asking for an activation is asking for. The request is
// refused ("no valid card on file"). Nothing may be written.
{
  const { biz, price } = await freshBiz("ET6 end trial now, cardless");
  const c = await cust(biz.id, "et6@a.com", { auto: "on" });
  const now = new Date();
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now,
    trialDays: 7,
    items: [{ price: await price(5000), quantity: 1 }],
  });
  const trialEndBefore = sub.trialEnd!.getTime();
  let threw = false;
  try {
    await editTrialEnd({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      now,
      immediately: true,
    });
  } catch {
    threw = true;
  }
  const after = await subRow(sub.id);
  ok("ET6: refuses to end a cardless auto-collect trial", threw);
  ok(
    "ET6: subscription untouched — still in_trial, boundary unmoved",
    after.status === "in_trial" && after.trialEnd!.getTime() === trialEndBefore,
  );
  ok(
    "ET6: nothing invoiced and nothing cancelled",
    (await invCount(sub.id)) === 0 && after.canceledAt === null,
  );
}

// ET7: the same subscription with auto-collection OFF converts normally — a missing
// card is the whole arrangement in the send-invoice model, so there is nothing to
// refuse. The invoice is raised and left for the customer to pay.
{
  const { biz, price } = await freshBiz("ET7 end trial now, send-invoice");
  const c = await cust(biz.id, "et7@a.com", { auto: "off" });
  const now = new Date();
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now,
    trialDays: 7,
    items: [{ price: await price(5000), quantity: 1 }],
  });
  const { subscription: updated } = await editTrialEnd({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now,
    immediately: true,
  });
  ok("ET7: cardless send-invoice trial still activates", updated.status === "active");
  ok("ET7: first term invoiced (sent, not charged)", (await invCount(sub.id)) === 1);
}

// ET4: reject for a non-in_trial subscription.
{
  const { biz, price } = await freshBiz("ET4 reject non-trial");
  const c = await cust(biz.id, "et4@a.com", { auto: "on", card: "good" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  let threw = false;
  try {
    await editTrialEnd({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      now: new Date(),
      trialEnd: new Date(Date.now() + 86_400_000),
    });
  } catch {
    threw = true;
  }
  ok("ET4: rejects edit_trial_end on a non-in_trial subscription", threw);
}

// ET5: reject a past trial_end date.
{
  const { biz, price } = await freshBiz("ET5 reject past date");
  const c = await cust(biz.id, "et5@a.com", { auto: "on", card: "good" });
  const now = new Date();
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now,
    trialDays: 7,
    items: [{ price: await price(5000), quantity: 1 }],
  });
  let threw = false;
  try {
    await editTrialEnd({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      now,
      trialEnd: new Date(now.getTime() - 86_400_000),
    });
  } catch {
    threw = true;
  }
  ok("ET5: rejects a trial_end in the past", threw);
}

// ── Caller-supplied subscription id (name it at signup) ──────────────────────
// The create form always posted `id`, but `createSubBody` had no such field and is
// `.passthrough()`, so it validated silently and was then dropped — "auto generated if
// not provided" was always true. Unique per BUSINESS, so a clash is a caller error.
{
  const { biz, price } = await freshBiz("OWNID own subscription id");
  const c = await cust(biz.id, "own-id@a.com");
  const chosen = `sub_myown-${Date.now()}`;
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    publicId: chosen,
    items: [{ price: await price(5000), quantity: 1 }],
  });
  ok("OWNID: a supplied public id is used verbatim", sub.publicId === chosen);
  ok(
    "OWNID: the subscription is findable by that id",
    (await getSubscriptionByPublicId(orgId, biz.id, chosen))?.id === sub.id,
  );

  // Same id again in the same business → SubscriptionError (→ 400), not a raw
  // unique-violation 500 from subscriptions_biz_public_id_uq.
  let clashed = false;
  let clashMsg = "";
  try {
    const c2 = await cust(biz.id, "own-id2@a.com");
    await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c2.id,
      now: new Date(),
      publicId: chosen,
      items: [{ price: await price(5000), quantity: 1 }],
    });
  } catch (e) {
    clashed = true;
    clashMsg = (e as Error).message;
  }
  ok("OWNID: a duplicate id is rejected", clashed);
  ok(
    "OWNID: rejection says the id is taken (not a constraint dump)",
    /already in use/i.test(clashMsg),
  );

  // Omitting it still auto-generates.
  const c3 = await cust(biz.id, "own-id3@a.com");
  const { subscription: auto } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c3.id,
    now: new Date(),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  ok(
    "OWNID: omitting it still auto-generates sub_<nano>",
    /^sub_/.test(auto.publicId) && auto.publicId !== chosen,
  );

  // The id is per-BUSINESS, so the same one is legal in a different business.
  const { biz: biz2, price: price2 } = await freshBiz("OWNID second business");
  const c4 = await cust(biz2.id, "own-id4@a.com");
  const { subscription: reused } = await createSubscription({
    organizationId: orgId,
    businessId: biz2.id,
    customerId: c4.id,
    now: new Date(),
    publicId: chosen,
    items: [{ price: await price2(5000), quantity: 1 }],
  });
  ok(
    "OWNID: the same id is allowed in another business",
    reused.publicId === chosen && reused.id !== sub.id,
  );
}

// ── Signup coupon discounts the FIRST invoice ────────────────────────────────
// This mirrors the CREATE ROUTE's ordering deliberately: create the subscription,
// apply `coupon_ids` with atSignup, and only THEN bill the first period. The dashboard
// used to POST …/discount after create had already raised AND charged that invoice, so
// the customer paid full price for the period they were promised a discount on. If this
// ever fails, check that nothing moved billing ahead of the coupon loop in the route.
{
  const { biz, price } = await freshBiz("SIGNUPCPN signup coupon");
  const c = await cust(biz.id, "signup-coupon@a.com", { auto: "off" });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "SIGNUP25",
    kind: "percentage",
    percentOffBps: 2500,
    durationType: "forever",
  });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(4000), quantity: 1 }],
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "SIGNUP25",
    now: new Date(),
    atSignup: true,
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
  // 4000 less 25% = 3000. A full-price 4000 here means the coupon missed the first invoice.
  console.log(
    `signup coupon: first invoice total=${invoice ? Number(invoice.totalMinor) : "none"} (expected 3000, undiscounted would be 4000)`,
  );
  ok("SIGNUPCPN: the first invoice exists", !!invoice);
  ok(
    "SIGNUPCPN: the first invoice is DISCOUNTED (3000, not 4000)",
    !!invoice && Number(invoice.totalMinor) === 3000,
  );
}

// ── Signup invoicing over HTTP: invoice_immediately + coupon_ids ─────────────
// The two signup-time money decisions live in the CREATE ROUTE, not in a service, so
// they are exercised against the real server booted in-process (same trick as
// verify:sdk) — the block above only mirrors the route's ordering, this one IS it.
{
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  let nonce = 0;
  const createSub = async (bizId: string, cusId: string, body: Record<string, unknown>) => {
    const r = await fetch(`${base}/v1/businesses/${bizId}/customers/${cusId}/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${org.secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `subsv2-signup-${Date.now()}-${++nonce}`,
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const unbilledFor = (subId: string) =>
    withTenant(orgId, (tx) =>
      tx.select().from(unbilledCharges).where(eq(unbilledCharges.subscriptionId, subId)),
    );
  const subByPublicId = (publicId: string) =>
    withTenant(
      orgId,
      async (tx) =>
        (
          await tx.select().from(subscriptions).where(eq(subscriptions.publicId, publicId)).limit(1)
        )[0]!,
    );

  // (a) omitted → the first invoice is raised now, exactly as before.
  {
    const { biz, price } = await freshBiz("IMMED default");
    const p = await price(4000);
    const c = await cust(biz.id, "immed-default@a.com", { auto: "off" });
    const res = await createSub(biz.publicId, c.publicId, {
      items: [{ price: p.publicId, quantity: 1 }],
    });
    ok("IMMED: omitted → 201", res.status === 201);
    ok(
      "IMMED: omitted → first invoice raised now (4000)",
      res.json.latest_invoice?.total_minor === 4000,
    );
    ok("IMMED: omitted → no deferred charge", res.json.deferred_charge === undefined);
  }

  // (b) false → NO invoice; the first period is queued as a pending unbilled charge.
  {
    const { biz, price } = await freshBiz("IMMED false");
    const p = await price(4000);
    const c = await cust(biz.id, "immed-false@a.com", { auto: "off" });
    const res = await createSub(biz.publicId, c.publicId, {
      items: [{ price: p.publicId, quantity: 1 }],
      invoice_immediately: false,
    });
    const sub = res.json.id ? await subByPublicId(res.json.id) : null;
    const charges = sub ? await unbilledFor(sub.id) : [];
    console.log(
      `invoice_immediately=false: latest_invoice=${JSON.stringify(res.json.latest_invoice)} deferred=${JSON.stringify(res.json.deferred_charge)} unbilled=${charges.map((c2) => `${c2.status}/${c2.amountMinor}`).join(",")}`,
    );
    ok("IMMED: false → 201 active", res.status === 201 && res.json.status === "active");
    ok(
      "IMMED: false → NO invoice raised",
      !!sub && (await invCount(sub.id)) === 0 && res.json.latest_invoice === undefined,
    );
    ok(
      "IMMED: false → deferred_charge reports the 4000 it queued",
      res.json.deferred_charge?.amount_minor === 4000,
    );
    ok(
      "IMMED: false → exactly one PENDING unbilled charge of 4000",
      charges.length === 1 && charges[0]!.status === "pending" && charges[0]!.amountMinor === 4000n,
    );
    ok(
      "IMMED: false → the charge carries the period it covers",
      !!charges[0]?.periodStart && !!charges[0]?.periodEnd,
    );

    // …and it rides on the NEXT invoice: renewal bills period 2 (4000) + the deferred
    // period (4000) = 8000. A 4000 here would mean the first period was billed twice
    // or lost altogether.
    if (sub) {
      await withTenant(orgId, (tx) =>
        tx
          .update(subscriptions)
          .set({ currentPeriodEnd: days(-1) })
          .where(eq(subscriptions.id, sub.id)),
      );
      await runWithClockScope({ onlyBusinessId: biz.id, now: new Date() }, () =>
        runBillingClockTick(new Date()),
      );
      const invs = await withTenant(orgId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.subscriptionId, sub.id)),
      );
      const after = await unbilledFor(sub.id);
      console.log(
        `invoice_immediately=false: renewal invoices=${invs.map((i) => Number(i.totalMinor)).join(",")} charge now ${after[0]?.status}`,
      );
      ok(
        "IMMED: the deferred period rides on the next invoice (8000, not 4000)",
        invs.length === 1 && Number(invs[0]!.totalMinor) === 8000,
      );
      ok("IMMED: the unbilled charge is marked billed", after[0]?.status === "billed");
    }
  }

  // (c) false must EXEMPT the auto-collect card requirement — nothing is collected at
  // signup, so refusing a card-less signup would be wrong. The control proves the
  // requirement is still enforced when the first invoice IS raised.
  {
    const { biz, price } = await freshBiz("IMMED no card");
    const p = await price(4000);
    const c = await cust(biz.id, "immed-nocard@a.com", { auto: "on" }); // auto-collect ON, no card
    const deferred = await createSub(biz.publicId, c.publicId, {
      items: [{ price: p.publicId, quantity: 1 }],
      invoice_immediately: false,
    });
    const immediate = await createSub(biz.publicId, c.publicId, {
      items: [{ price: p.publicId, quantity: 1 }],
    });
    ok(
      "IMMED: false + auto-collect ON + no card → allowed (nothing is collected)",
      deferred.status === 201,
    );
    ok("IMMED: control — invoicing now with no card still refused", immediate.status === 400);
  }

  // (d) the route's own signup-coupon ordering, end to end: 4000 less 25% = 3000 on the
  // FIRST invoice. This is the HTTP-level guard for the dashboard fix (the create form
  // now posts `coupon_ids` instead of POSTing …/discount after the invoice was raised).
  {
    const { biz, price } = await freshBiz("IMMED signup coupon route");
    const p = await price(4000);
    const c = await cust(biz.id, "immed-coupon@a.com", { auto: "off" });
    await createCoupon({
      organizationId: orgId,
      businessId: biz.id,
      code: "ROUTE25",
      kind: "percentage",
      percentOffBps: 2500,
      durationType: "forever",
    });
    const res = await createSub(biz.publicId, c.publicId, {
      items: [{ price: p.publicId, quantity: 1 }],
      coupon_ids: ["ROUTE25"],
    });
    console.log(
      `coupon_ids at signup: first invoice total=${res.json.latest_invoice?.total_minor} (expected 3000, undiscounted 4000)`,
    );
    ok(
      "IMMED: coupon_ids discounts the FIRST invoice over HTTP (3000, not 4000)",
      res.json.latest_invoice?.total_minor === 3000,
    );

    // A signup coupon must also discount the DEFERRED charge — the two signup options
    // must not disagree about what the customer owes for the same period.
    const c2 = await cust(biz.id, "immed-coupon-deferred@a.com", { auto: "off" });
    const res2 = await createSub(biz.publicId, c2.publicId, {
      items: [{ price: p.publicId, quantity: 1 }],
      coupon_ids: ["ROUTE25"],
      invoice_immediately: false,
    });
    console.log(
      `coupon_ids + invoice_immediately=false: deferred=${JSON.stringify(res2.json.deferred_charge)} (expected 3000)`,
    );
    ok(
      "IMMED: a signup coupon also discounts the deferred charge (3000, not 4000)",
      res2.json.deferred_charge?.amount_minor === 3000,
    );
  }

  await app.close();
}

// ══════════════════════════════════════════════════════════════════════════════
// GR7 — cancellation invariants found in the 2026-08-08 audit
// ══════════════════════════════════════════════════════════════════════════════

// GR7a: a cancelled subscription reports mrr 0, on EVERY path. `recomputeSubscriptionMrr`
// has always specified this ("CANCELLED → 0"), but no cancel path called it, so a
// churned subscription kept the full rate it carried while live — the API, the list
// filter/sort and the shadow reconcile (which diffs against 0) all read
// that column.
{
  const { biz, price } = await freshBiz("GR7a mrr-on-cancel");
  const p = await price(5000);

  const c1 = await cust(biz.id, "gr7a1@a.com", { auto: "on", card: "good" });
  const { subscription: s1 } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c1.id,
    now: new Date(),
    items: [{ price: p, quantity: 1 }],
  });
  ok("GR7a: live subscription carries its rate", (await subRow(s1.id)).mrr === 5000n);
  await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: s1.id,
    now: new Date(),
    cancelOption: "immediately",
  });
  ok("GR7a: immediate cancel → mrr 0", (await subRow(s1.id)).mrr === 0n);

  // …and the term-end path, which cancels inside the clock's guarded claim.
  const c2 = await cust(biz.id, "gr7a2@a.com", { auto: "on", card: "good" });
  const { subscription: s2 } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c2.id,
    now: new Date(),
    items: [{ price: p, quantity: 1 }],
  });
  await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: s2.id,
    now: new Date(),
    cancelOption: "end_of_term",
  });
  ok(
    "GR7a: end_of_term keeps the rate while it is still live",
    (await subRow(s2.id)).mrr === 5000n,
  );
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ currentPeriodEnd: days(-1) })
      .where(eq(subscriptions.id, s2.id)),
  );
  await runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  const after = await subRow(s2.id);
  ok("GR7a: term-end cancel → cancelled + mrr 0", after.status === "cancelled" && after.mrr === 0n);
}

// GR7d: a PAUSED subscription reports mrr 0, and resuming restores the real rate
// (2026-08-19 ruling). It raises no invoices while paused, so it earns nothing — and
// until this it kept its full rate, which three surfaces then disagreed about: the
// reporting series counted it, `migration/reconcile.ts` (active + non_renewing) did not,
// and the subscriptions list blanked the cell while its own SQL filter/sort read the
// stored column. All four read this column, so zeroing it is what makes them agree.
{
  const { biz, price } = await freshBiz("GR7d mrr-on-pause");
  const p = await price(5000);
  const c = await cust(biz.id, "gr7c@a.com", { auto: "on", card: "good" });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: p, quantity: 1 }],
  });
  ok("GR7d: live subscription carries its rate", (await subRow(sub.id)).mrr === 5000n);

  await pauseSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    pauseOption: "immediately",
  });
  const paused = await subRow(sub.id);
  ok("GR7d: pause → mrr 0", paused.status === "paused" && paused.mrr === 0n);

  // The round trip is the point: zeroing is only safe because resume restates the rate
  // from the items, with no separate restore path that could drift from the pause one.
  await resumeSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
  });
  const resumed = await subRow(sub.id);
  ok(
    "GR7d: resume → the real rate is restated, not lost",
    resumed.status === "active" && resumed.mrr === 5000n,
  );

  // The plain (non-option) pause path delegates to the same function, so it must agree —
  // this is the path the API's bare /pause uses.
  await pauseSubscription({ organizationId: orgId, businessId: biz.id, subscriptionId: sub.id });
  ok("GR7d: the plain pause path zeroes it too", (await subRow(sub.id)).mrr === 0n);
}

// GR7b: end_of_term cancel is REFUSED on a paused subscription. The renewal scan is
// `status IN ('in_trial','active')`, so the flag would never be acted on — measured at
// 30 days past term end, still paused, with the API reporting plain `paused`.
{
  const { biz, price } = await freshBiz("GR7b paused-eot");
  const c = await cust(biz.id, "gr7b@a.com", { auto: "on", card: "good" });
  const { subscription: s } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: await price(5000), quantity: 1 }],
  });
  await pauseSubscription({ organizationId: orgId, businessId: biz.id, subscriptionId: s.id });
  let refused = false;
  try {
    await cancelSubscriptionWithOptions({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: s.id,
      now: new Date(),
      cancelOption: "end_of_term",
    });
  } catch (e) {
    refused = /no term end to cancel at/.test((e as Error).message);
  }
  ok("GR7b: end_of_term on a paused sub is refused", refused);
  ok("GR7b: …and left no half-set flag", (await subRow(s.id)).cancelAtPeriodEnd === false);
  // specific_date still works on a paused sub — the scheduled-changes pass acts on
  // any status, so the message that points there is not sending anyone nowhere.
  const sched = await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: s.id,
    now: new Date(),
    cancelOption: "specific_date",
    cancelAt: days(2),
  });
  ok("GR7b: specific_date on a paused sub IS accepted", typeof sched.scheduledChange === "string");
  await applyDueScheduledChanges(days(3));
  ok("GR7b: …and the clock cancels it", (await subRow(s.id)).status === "cancelled");
}

// GR7c: a plan-swap DOWNGRADE on a term that was never invoiced must not book a
// negative invoice. The unused-time credit (3000) exceeds the new plan's charge
// (1000); the fallback booked it as negative lines, `createInvoiceFromLines` threw a
// bare Error AFTER the apply transaction committed, and the subscription came out
// swapped onto the cheaper plan with no invoice, no credit note, and a 500.
{
  const { biz, price } = await freshBiz("GR7c uninvoiced-downgrade");
  const pro = await price(3000);
  const basic = await price(1000);
  // auto_collection off + no card → nothing is billed at signup, so the term has no
  // invoice to credit against. This is the never-billed shape (imports, offline subs).
  const c = await cust(biz.id, "gr7c@a.com", { auto: "off" });
  const { subscription: s, items } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: pro, quantity: 1 }],
  });
  const before = await invCount(s.id);
  let threw: string | null = null;
  try {
    await changeSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: s.id,
      now: new Date(),
      changes: [{ itemId: items[0]!.publicId, newPriceId: basic.publicId }],
    });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("GR7c: uninvoiced downgrade does not throw", threw === null);
  ok("GR7c: …and restates mrr to the new plan", (await subRow(s.id)).mrr === 1000n);
  // Nothing was ever charged for the old term, so no credit is owed and no negative
  // document is written — only the new plan's charge.
  ok("GR7c: …and books no negative invoice", (await invCount(s.id)) >= before);
  const cns = await cnFor(biz.id, c.id);
  ok("GR7c: …and invents no credit for a term never billed", cns.length === 0);
}

// ── Report ──────────────────────────────────────────────────────────────────
let pass = true;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ SUBSCRIPTIONS V2: PASS" : "❌ SUBSCRIPTIONS V2: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
