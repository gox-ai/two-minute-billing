/**
 * Phase E — Invoices & Credit Notes verify suite.
 *
 * Exercises the invoice state machine (architecture doc §5.1) transition
 * -for-transition, and asserts LEDGER balances with hand-computed constants (not
 * just statuses — both prior review passes caught bugs status-only tests hid).
 *
 *   pnpm verify:invoices-v2
 *
 * Sections: E1 status vocabulary + posted→due clock · E2 pending + close +
 * auto-close · E3 dunning depth/final-actions/stop-pause · E4 credit notes
 * (adjustment/refundable/allocations/write-off-via-CN/void) · E5 cancellation
 * credit helper · E6 round-off + regenerate.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { publicId } from "@/platform/ids";
import { withTenant, closeDb, type Tx } from "@/platform/db";
import { createOrganization, createBusiness, updateBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, invoiceOutstanding } from "@/modules/invoicing/service";
import {
  voidInvoice,
  regenerateInvoice,
  recordOfflinePayment,
  collectInvoiceNow,
  InvoiceOpsError,
} from "@/modules/invoicing/ops";
import { closeInvoice, runAutoClosePending } from "@/modules/invoicing/pending";
import { runInvoiceDueTransitions } from "@/modules/invoicing/due";
import { stopDunning } from "@/modules/subscriptions/dunning";
import { createFlatTaxRate } from "@/modules/tax/service";
import { recordUsage } from "@/modules/metering/service";
import { invoices, invoiceLineItems, subscriptions as subsTable, payments } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "InvoicesV2 Org" });
const orgId = org.organization.id;

async function acctBal(businessId: string, account: string): Promise<bigint> {
  return withTenant(orgId, async (tx: Tx) => {
    const res = await tx.execute(sql`
      select coalesce(sum(case when direction='debit' then amount_minor else -amount_minor end),0)::bigint as bal
      from ledger_entries where business_id = ${businessId} and account = ${account} and currency='USD'`);
    return BigInt((res as unknown as Array<{ bal: string | number }>)[0]?.bal ?? 0);
  });
}
async function ledgerNetsZero(businessId: string): Promise<boolean> {
  return withTenant(orgId, async (tx: Tx) => {
    const res = await tx.execute(sql`
      select currency, coalesce(sum(case when direction='debit' then amount_minor else -amount_minor end),0)::bigint as bal
      from ledger_entries where business_id = ${businessId} group by currency`);
    return (res as unknown as Array<{ bal: string | number }>).every((r) => BigInt(r.bal) === 0n);
  });
}
async function invRow(id: string) {
  return withTenant(
    orgId,
    async (tx) => (await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1))[0]!,
  );
}
async function lineKinds(invoiceId: string): Promise<Array<typeof invoiceLineItems.$inferSelect>> {
  return withTenant(orgId, (tx) =>
    tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId)),
  );
}

// A no-tax business per scenario group so absolute ledger balances are clean.
async function freshBiz(name: string, currency = "USD") {
  const b = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: currency,
    livemode: "test",
  });
  const prod = await createProduct({ organizationId: orgId, businessId: b.id, name: "Plan" });
  const price = (amt: number, model: "flat" | "usage" = "flat") =>
    createPrice({
      organizationId: orgId,
      businessId: b.id,
      productId: prod.id,
      type: "recurring",
      model,
      currency,
      amountMinor: amt,
      interval: "month",
      ...(model === "usage" ? { usageAggregation: "sum" as const } : {}),
    });
  return { biz: b, price };
}
type Card = "good" | "retriable" | "hard";
const token = (c: Card) =>
  c === "good" ? "tok_4242" : c === "retriable" ? "4000000000009995" : "4000000000000002";
async function customerWith(
  bizId: string,
  email: string,
  opts: { auto?: "on" | "off"; card?: Card; netDays?: number } = {},
) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email,
    autoCollection: opts.auto ?? "on",
    netTermDays: opts.netDays,
  });
  if (opts.card)
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: bizId,
      customer: c,
      token: token(opts.card),
    });
  return c;
}
type Sub = Awaited<ReturnType<typeof createSubscription>>["subscription"];
async function bill(bizId: string, sub: Sub, extra: { createAsPending?: boolean } = {}) {
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: bizId,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
    ...extra,
  });
  return invRow(invoice.id);
}
async function subFor(
  bizId: string,
  customerId: string,
  price: Awaited<ReturnType<typeof createPrice>>,
): Promise<Sub> {
  const s = await createSubscription({
    organizationId: orgId,
    businessId: bizId,
    customerId,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  return s.subscription;
}

// ══════════════════════════════════════════════════════════════════════════════
// E1 — status vocabulary + dunning_status
// ══════════════════════════════════════════════════════════════════════════════

// posted: auto-collect off (send-invoice), no charge attempted.
{
  const { biz, price } = await freshBiz("E1 posted");
  const c = await customerWith(biz.id, "posted@a.com", { auto: "off" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000)));
  // `dunning_status` was `null` here until 2026-08-31. A raised `auto_collection: off`
  // unpaid invoice is `payment_due` + `in_progress` with a `next_retry_at` (see
  // `enrolOfflineInvoiceInDunning`): for a send-invoice bill dunning means REMINDERS,
  // and it starts at once.
  ok(
    "E1: send-invoice → payment_due, enrolled in offline dunning",
    inv.status === "payment_due" && inv.dunningStatus === "in_progress" && inv.attemptCount === 0,
  );
  ok("E1: posted leaves AR open = 5000", (await acctBal(biz.id, "accounts_receivable")) === 5000n);
}

// paid: auto-collect on + good card → charged at generation.
{
  const { biz, price } = await freshBiz("E1 paid");
  const c = await customerWith(biz.id, "paid@a.com", { auto: "on", card: "good" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000)));
  ok("E1: charge ok → paid", inv.status === "paid" && inv.dunningStatus === null);
  ok(
    "E1: paid → cash 5000, AR 0",
    (await acctBal(biz.id, "cash")) === 5000n &&
      (await acctBal(biz.id, "accounts_receivable")) === 0n,
  );
}

// payment_due: retriable decline → dunning opens.
{
  const { biz, price } = await freshBiz("E1 payment_due");
  const c = await customerWith(biz.id, "due@a.com", { auto: "on", card: "retriable" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000)));
  ok(
    "E1: retriable decline → payment_due",
    inv.status === "payment_due" && inv.dunningStatus === "in_progress",
  );
  ok(
    "E1: payment_due keeps AR open + retry scheduled",
    (await acctBal(biz.id, "accounts_receivable")) === 5000n && inv.nextAttemptAt !== null,
  );
}

// not_paid: non-retriable decline → exhausted immediately.
{
  const { biz, price } = await freshBiz("E1 not_paid");
  const c = await customerWith(biz.id, "np@a.com", { auto: "on", card: "hard" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000)));
  ok(
    "E1: non-retriable decline → not_paid",
    inv.status === "not_paid" && inv.dunningStatus === "exhausted",
  );
  ok("E1: not_paid has no scheduled retry", inv.nextAttemptAt === null);
}

// voided: void a posted invoice → ledger reversed to zero.
{
  const { biz, price } = await freshBiz("E1 voided");
  const c = await customerWith(biz.id, "void@a.com", { auto: "off" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000)));
  const v = await voidInvoice(orgId, biz.id, inv.publicId);
  ok("E1: void posted → voided", v.status === "voided");
  ok(
    "E1: void reverses AR to 0",
    (await acctBal(biz.id, "accounts_receivable")) === 0n && (await ledgerNetsZero(biz.id)),
  );
}

// posted → not_paid: offline invoice whose due date passed (clock).
{
  const { biz, price } = await freshBiz("E1 due offline");
  const c = await customerWith(biz.id, "offdue@a.com", { auto: "off", netDays: 30 });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000)));
  ok(
    "E1: offline Net-30 → posted with future due",
    inv.status === "posted" && inv.dueDate !== null,
  );
  // Simulate the due date passing, then run the clock transition.
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ dueDate: new Date(Date.now() - 86_400_000) })
      .where(eq(invoices.id, inv.id)),
  );
  const r = await runInvoiceDueTransitions(new Date());
  const after = await invRow(inv.id);
  // Was `not_paid` + `r.notPaid >= 1`. An offline invoice now OPENS its dunning window
  // at the due date and stays `payment_due` until that window exhausts — `not_paid` is
  // the collection-FAILED status, and this bill has failed nothing.
  // See `runInvoiceDueTransitions`. `dun_offline_invoices` defaults ON, which
  // is why nothing is configured here.
  ok(
    "E1: posted → payment_due + dunning at due date (offline)",
    after.status === "payment_due" &&
      after.dunningStatus === "in_progress" &&
      r.offlineDunningOpened >= 1,
  );
}

// posted → payment_due: a posted auto-collect invoice charged at its due date fails.
// (Auto-collect renewals charge at generation; a POSTED auto-collect invoice arises
// from a send/manual invoice on an auto-collect customer — the clock collects it.)
{
  const { biz } = await freshBiz("E1 due autocollect");
  // This invoice has no subscription behind it, so it is subject to the "Dunning for
  // one-time invoices" toggle. OUR default is OFF (see
  // DunningConfig.dunOneTimeInvoices — deliberate, because the dunning sweep has
  // always skipped subscription-less invoices, so defaulting ON would start
  // voiding/writing off one-offs that businesses expect to be left alone). The posted
  // → payment_due edge therefore only exists for a one-time invoice when the merchant
  // has opted in, so opt in here — the edge itself is what this case is about. The
  // default is asserted separately in the next block.
  await updateBusiness(orgId, biz.publicId, { dunningConfig: { dun_one_time_invoices: true } });
  const c = await customerWith(biz.id, "ondue@a.com", { auto: "on", card: "retriable" });
  const { createManualInvoice } = await import("@/modules/invoicing/ops");
  const { invoice } = await createManualInvoice({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    currency: "USD",
    lines: [{ description: "svc", amountMinor: 5000n, kind: "one_time" }],
    collect: false,
    netDays: 30,
  });
  ok("E1: send invoice on auto-collect customer → posted", invoice.status === "posted");
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ dueDate: new Date(Date.now() - 86_400_000) })
      .where(eq(invoices.id, invoice.id)),
  );
  await runInvoiceDueTransitions(new Date());
  const after = await invRow(invoice.id);
  ok(
    "E1: posted → payment_due at due date (charge fails, one-time dunning ON)",
    after.status === "payment_due" && after.dunningStatus === "in_progress",
  );
}

// The same failure under the DEFAULT config (one-time dunning off): the debt stands
// as not_paid with no dunning armed — never payment_due with a retry that the sweep
// would skip forever.
{
  const { biz } = await freshBiz("E1 due autocollect default");
  const c = await customerWith(biz.id, "ondue-def@a.com", { auto: "on", card: "retriable" });
  const { createManualInvoice } = await import("@/modules/invoicing/ops");
  const { invoice } = await createManualInvoice({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    currency: "USD",
    lines: [{ description: "svc", amountMinor: 5000n, kind: "one_time" }],
    collect: false,
    netDays: 30,
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ dueDate: new Date(Date.now() - 86_400_000) })
      .where(eq(invoices.id, invoice.id)),
  );
  await runInvoiceDueTransitions(new Date());
  const after = await invRow(invoice.id);
  ok(
    "E1: one-time invoice, dunning off by default → not_paid, no retry armed",
    after.status === "not_paid" && after.dunningStatus === null && after.nextAttemptAt === null,
  );
}

// posted → paid: a posted auto-collect invoice charged at its due date succeeds.
{
  const { biz } = await freshBiz("E1 due paid");
  const c = await customerWith(biz.id, "onpaid@a.com", { auto: "on", card: "good" });
  const { createManualInvoice } = await import("@/modules/invoicing/ops");
  const { invoice } = await createManualInvoice({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    currency: "USD",
    lines: [{ description: "svc", amountMinor: 5000n, kind: "one_time" }],
    collect: false,
    netDays: 30,
  });
  ok(
    "E1: posted (not charged yet), cash 0",
    invoice.status === "posted" && (await acctBal(biz.id, "cash")) === 0n,
  );
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ dueDate: new Date(Date.now() - 86_400_000) })
      .where(eq(invoices.id, invoice.id)),
  );
  await runInvoiceDueTransitions(new Date());
  const after = await invRow(invoice.id);
  ok(
    "E1: posted → paid at due date (charge ok)",
    after.status === "paid" && (await acctBal(biz.id, "cash")) === 5000n,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// E1N — NET TERMS on `createInvoiceFromLines` (2026-09-01)
// ══════════════════════════════════════════════════════════════════════════════
//
// `createInvoiceFromLines` is the shared engine behind every invoice that is NOT a
// subscription period: prorations, mid-term item adds, ad-hoc charges, manual bills. It
// consulted no net terms at all — only an explicit `input.dueDate` deferred anything — so
// a Net-30 customer got 30 days on their renewal and ZERO on the proration invoice a
// mid-term change raised, and was chased on it the day it was cut. It now resolves the
// same chain `billSubscriptionPeriod` does (`netTermDaysFrom`, shared so the two cannot
// answer differently; the pure rule is pinned by `test/unit/net-terms.test.ts`).
//
// ⚠️ THIS IS A REAL BEHAVIOUR CHANGE, not a null being defaulted: such an invoice is now
// born `posted` rather than `payment_due`. `posted` means "finalized but not yet due", so
// the whole burden of the change falls on the paths that read it — `due.ts`'s transition
// pass, dunning enrolment and the offline reminder ladder. N7/N8 below assert that
// directly, in both directions: nothing acts on the invoice BEFORE its due date, and the
// due pass moves it correctly WHEN the date arrives. N4 is the other half of the safety
// argument — with no terms anywhere the invoice is still born `payment_due`, so nothing
// can be stranded in `posted` waiting for a due date it never had.
{
  const { biz, price } = await freshBiz("E1N net terms");
  const { createInvoiceFromLines } = await import("@/modules/invoicing/service");
  const day = 86_400_000;
  /** Days between an invoice's due date and its creation, rounded — the chain's answer. */
  const netDaysOf = (inv: { dueDate: Date | null; createdAt: Date }) =>
    inv.dueDate === null
      ? null
      : Math.round((inv.dueDate.getTime() - inv.createdAt.getTime()) / day);
  const adhoc = async (
    customerId: string,
    opts: { subscriptionId?: string; dueDate?: Date } = {},
  ) => {
    const { invoice } = await createInvoiceFromLines({
      organizationId: orgId,
      businessId: biz.id,
      customerId,
      currency: "USD",
      lines: [{ description: "mid-term change", amountMinor: 4000n }],
      ...opts,
    });
    return invRow(invoice.id);
  };

  // N1 — the bug this fixes: a Net-30 customer's proration invoice.
  const net30 = await customerWith(biz.id, "net30@a.com", { auto: "off", netDays: 30 });
  const plan = await price(1000);
  const i1 = await adhoc(net30.id);
  ok("E1N: a Net-30 customer's ad-hoc invoice is due in 30 days", netDaysOf(i1) === 30);
  ok("E1N: …and is therefore born `posted`, not `payment_due`", i1.status === "posted");

  // N2 — the SUBSCRIPTION's terms override the customer's.
  const subNet7 = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: net30.id,
    now: new Date(),
    items: [{ price: plan, quantity: 1 }],
    netTermDays: 7,
  });
  const i2 = await adhoc(net30.id, { subscriptionId: subNet7.subscription.id });
  ok("E1N: the subscription's Net-7 overrides the customer's Net-30", netDaysOf(i2) === 7);

  // N3 — a stored `0` means "no terms at THIS level" and falls through. The pure rule is
  // unit-tested; this asserts the DB loader reads it the same way, which is where a tidy
  // from `||` to `??` would actually do the damage.
  const subNet0 = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: net30.id,
    now: new Date(),
    items: [{ price: plan, quantity: 1 }],
    netTermDays: 0,
  });
  const i3 = await adhoc(net30.id, { subscriptionId: subNet0.subscription.id });
  ok(
    "E1N: a subscription netTermDays of 0 falls THROUGH to the customer's 30 (|| not ??)",
    netDaysOf(i3) === 30,
  );

  // N4 — no terms anywhere: due on the invoice date, and born `payment_due`. This is the
  // regression guard for the change: `due.ts` only ever scans invoices that HAVE a due
  // date, so an invoice born `posted` with none would sit there forever.
  const plain = await customerWith(biz.id, "noterms@a.com", { auto: "off" });
  const i4 = await adhoc(plain.id);
  ok("E1N: with no terms anywhere the invoice is due on its own date", netDaysOf(i4) === 0);
  ok("E1N: …and is born `payment_due`, never stranded at `posted`", i4.status === "payment_due");

  // N5 — the business default is the last link in the chain.
  await updateBusiness(orgId, biz.publicId, { defaultDueDays: 45 });
  const i5 = await adhoc(plain.id);
  ok(
    "E1N: the business default_due_days (45) applies when neither level has terms",
    netDaysOf(i5) === 45,
  );
  await updateBusiness(orgId, biz.publicId, { defaultDueDays: null });

  // N6 — an explicit due date still wins; a caller that has already decided is untouched.
  const i6 = await adhoc(net30.id, { dueDate: new Date(Date.now() + 3 * day) });
  ok("E1N: an explicit dueDate still overrides the whole chain", netDaysOf(i6) === 3);

  // N7 — DOWNSTREAM, before the date: the due pass must not touch it, and nothing may be
  // armed on it. This is the assertion that says the invoice is not being dunned from the
  // day it was raised, which is the behaviour the fix exists to remove.
  ok(
    "E1N: a future-dated `posted` invoice has no retry, no dunning and no attempts",
    i1.nextAttemptAt === null && i1.dunningStatus === null && i1.attemptCount === 0,
  );
  await runInvoiceDueTransitions(new Date());
  const beforeDue = await invRow(i1.id);
  ok(
    "E1N: the due pass leaves it alone while its due date is in the future",
    beforeDue.status === "posted" &&
      beforeDue.dunningStatus === null &&
      beforeDue.nextAttemptAt === null,
  );

  // N8 — DOWNSTREAM, at the date: the same `posted` → `payment_due` + dunning edge an
  // offline Net-D renewal takes. Offline dunning therefore enrols FROM THE DUE DATE, and
  // the reminder ladder is anchored there rather than at issue.
  //
  // Asserted on `i2` — the invoice that CARRIES A SUBSCRIPTION — because that is the case
  // the fix is about (a mid-term change's proration) and because a subscription-less
  // invoice takes the other, equally correct, edge: `dun_one_time_invoices` is off by
  // default, so it goes straight to `not_paid`. Both are checked, and getting this wrong
  // the first time is exactly why: a Net-D `posted` invoice does NOT have one downstream
  // answer, it has the same two the due pass always had.
  const pastDue = async (id: string) => {
    await withTenant(orgId, (tx) =>
      tx
        .update(invoices)
        .set({ dueDate: new Date(Date.now() - day) })
        .where(eq(invoices.id, id)),
    );
    await runInvoiceDueTransitions(new Date());
    return invRow(id);
  };
  const atDue = await pastDue(i2.id);
  ok(
    "E1N: a subscription invoice at its due date → payment_due + dunning in_progress",
    atDue.status === "payment_due" && atDue.dunningStatus === "in_progress",
  );
  ok(
    "E1N: …with the offline reminder armed AFTER the due date, not before it",
    atDue.nextAttemptAt !== null && atDue.nextAttemptAt.getTime() > atDue.dueDate!.getTime(),
  );
  ok(
    "E1N: …and still no charge was attempted (auto-collect off)",
    atDue.attemptCount === 0 && (await acctBal(biz.id, "cash")) === 0n,
  );
  const oneTimeAtDue = await pastDue(i1.id);
  ok(
    "E1N: a Net-D one-time invoice still takes the default edge → not_paid, nothing armed",
    oneTimeAtDue.status === "not_paid" &&
      oneTimeAtDue.dunningStatus === null &&
      oneTimeAtDue.nextAttemptAt === null,
  );
}
// ══════════════════════════════════════════════════════════════════════════════
// E2 — pending invoices + close + auto-close
// ══════════════════════════════════════════════════════════════════════════════

// A pending draft posts NO ledger; close finalizes recurring + accreted usage.
{
  const { biz, price } = await freshBiz("E2 pending close");
  const c = await customerWith(biz.id, "pending@a.com", { auto: "on", card: "good" });
  const flat = await price(1000);
  const metered = await price(5, "usage");
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [
      { price: flat, quantity: 1 },
      { price: metered, quantity: 1 },
    ],
  });
  const usageItem = sub.items.find((i) => i.priceId === metered.id)!;
  // Pending draft: recurring only, no ledger.
  const draft = await bill(biz.id, sub.subscription, { createAsPending: true } as never);
  ok("E2: pending draft created", draft.status === "pending");
  ok(
    "E2: pending draft posts NO ledger (AR 0, revenue 0)",
    (await acctBal(biz.id, "accounts_receivable")) === 0n &&
      (await acctBal(biz.id, "revenue")) === 0n,
  );
  ok(
    "E2: draft has the recurring line only (no usage yet)",
    (await lineKinds(draft.id))
      .filter((l) => l.kind !== "tax")
      .every((l) => l.kind === "recurring"),
  );
  // Usage accretes during the period.
  for (const q of [40, 35, 25])
    await recordUsage({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionItemId: usageItem.id,
      quantity: q,
      timestamp: new Date(),
    });
  // Close → finalize recurring (1000) + usage (100 × 5 = 500) = 1500, charged (good card).
  const closed = await closeInvoice(orgId, biz.id, draft.publicId);
  const cInv = await invRow(draft.id);
  ok(
    "E2: close keeps the same invoice id",
    cInv.id === draft.id && closed.invoice.publicId === draft.publicId,
  );
  ok(
    "E2: close → paid + total 1500 (recurring + usage)",
    cInv.status === "paid" && cInv.totalMinor === 1500n,
  );
  ok(
    "E2: close bills the usage line (100 units)",
    (await lineKinds(draft.id)).some(
      (l) => l.kind === "usage" && l.quantity === 100 && l.amountMinor === 500n,
    ),
  );
  ok(
    "E2: close posts the ledger (cash 1500, AR 0)",
    (await acctBal(biz.id, "cash")) === 1500n &&
      (await acctBal(biz.id, "accounts_receivable")) === 0n,
  );
  ok("E2: close ledger nets to zero", await ledgerNetsZero(biz.id));
}

// close on a send-invoice customer → posted (offline), no charge.
{
  const { biz, price } = await freshBiz("E2 close offline");
  const c = await customerWith(biz.id, "pendoff@a.com", { auto: "off" });
  const sub = await subFor(biz.id, c.id, await price(2000));
  const draft = await bill(biz.id, sub, { createAsPending: true } as never);
  const closed = await closeInvoice(orgId, biz.id, draft.publicId);
  ok("E2: close offline → payment_due (awaiting payment)", closed.invoice.status === "payment_due");
  ok(
    "E2: closed offline posts AR = 2000",
    (await acctBal(biz.id, "accounts_receivable")) === 2000n,
  );
  // Closing an already-closed invoice is rejected.
  let rejected = false;
  try {
    await closeInvoice(orgId, biz.id, draft.publicId);
  } catch {
    rejected = true;
  }
  ok("E2: re-closing a non-pending invoice is rejected", rejected);
}

// Auto-close job closes pending invoices past the business window.
{
  const { biz, price } = await freshBiz("E2 autoclose");
  await updateBusiness(orgId, biz.publicId, { autoClosePendingAfterDays: 5 });
  const c = await customerWith(biz.id, "autoclose@a.com", { auto: "off" });
  const sub = await subFor(biz.id, c.id, await price(3000));
  const draft = await bill(biz.id, sub, { createAsPending: true } as never);
  // Backdate the period end so the 5-day window has elapsed.
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ periodEnd: new Date(Date.now() - 10 * 86_400_000) })
      .where(eq(invoices.id, draft.id)),
  );
  const r = await runAutoClosePending(new Date());
  const after = await invRow(draft.id);
  ok("E2: auto-close finalizes the pending invoice", r.closed >= 1 && after.status !== "pending");
}

// ══════════════════════════════════════════════════════════════════════════════
// E3 — structured dunning config + final actions (SUB-7) + stop/pause
// ══════════════════════════════════════════════════════════════════════════════

// Drive an invoice to dunning exhaustion, then assert the configured final action.
async function exhaust(
  bizPublicId: string,
  bizId: string,
  finalAction: { invoice: "not_paid" | "void" | "write_off"; subscription: "cancel" | "retain" },
  price: Awaited<ReturnType<typeof createPrice>>,
  email: string,
) {
  // One retry so exhaustion is quick: initial fail (attempt 1) → 1 retry → exhausted.
  await updateBusiness(orgId, bizPublicId, {
    dunningConfig: { retries: [{ after_days: 1 }], final_action: finalAction },
  });
  const c = await customerWith(bizId, email, { auto: "on", card: "retriable" });
  const sub = await subFor(bizId, c.id, price);
  const inv = await bill(bizId, sub); // retriable decline → payment_due
  // Fast-forward the scheduled retry into the past and run dunning until it settles.
  for (let i = 0; i < 4; i++) {
    const cur = await invRow(inv.id);
    if (cur.status !== "payment_due") break;
    await withTenant(orgId, (tx) =>
      tx
        .update(invoices)
        .set({ nextAttemptAt: new Date(Date.now() - 3600_000) })
        .where(eq(invoices.id, inv.id)),
    );
    await (await import("@/modules/subscriptions/dunning")).runDunningPass(new Date());
  }
  const finalInv = await invRow(inv.id);
  return { inv: finalInv, subId: sub.id };
}
async function subStatus(subId: string): Promise<string> {
  const { subscriptions } = await import("@db/schema");
  return (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1),
    )
  )[0]!.status;
}

// A) invoice=not_paid + subscription=cancel (the historical default).
{
  const { biz, price } = await freshBiz("E3 not_paid+cancel");
  const r = await exhaust(
    biz.publicId,
    biz.id,
    { invoice: "not_paid", subscription: "cancel" },
    await price(5000),
    "e3a@a.com",
  );
  ok(
    "E3: exhausted → invoice not_paid",
    r.inv.status === "not_paid" && r.inv.dunningStatus === "exhausted",
  );
  ok("E3: not_paid keeps AR open (5000)", (await acctBal(biz.id, "accounts_receivable")) === 5000n);
  ok("E3: final_action.subscription=cancel → canceled", (await subStatus(r.subId)) === "cancelled");
}

// B) invoice=void + subscription=retain (SUB-7 headline: subscription SURVIVES).
{
  const { biz, price } = await freshBiz("E3 void+retain");
  const r = await exhaust(
    biz.publicId,
    biz.id,
    { invoice: "void", subscription: "retain" },
    await price(5000),
    "e3b@a.com",
  );
  ok(
    "E3: final_action.invoice=void → voided (ledger reversed)",
    r.inv.status === "voided" && (await acctBal(biz.id, "accounts_receivable")) === 0n,
  );
  ok("E3: void ledger nets to zero", await ledgerNetsZero(biz.id));
  ok(
    "E3 (SUB-7): final_action.subscription=retain → subscription NOT cancelled",
    (await subStatus(r.subId)) !== "cancelled",
  );
}

// C) invoice=write_off + subscription=cancel → bad-debt booked, AR cleared.
{
  const { biz, price } = await freshBiz("E3 writeoff+cancel");
  const r = await exhaust(
    biz.publicId,
    biz.id,
    { invoice: "write_off", subscription: "cancel" },
    await price(5000),
    "e3c@a.com",
  );
  ok(
    "E3: final_action.invoice=write_off → bad_debt 5000, AR 0",
    (await acctBal(biz.id, "bad_debt")) === 5000n &&
      (await acctBal(biz.id, "accounts_receivable")) === 0n,
  );
  ok("E3: write-off ledger nets to zero", await ledgerNetsZero(biz.id));
  ok("E3: write_off+cancel → subscription canceled", (await subStatus(r.subId)) === "cancelled");
}

// D) stop_dunning + pause_dunning manual ops.
{
  const { biz, price } = await freshBiz("E3 stop/pause");
  const { stopDunning, pauseDunning } = await import("@/modules/subscriptions/dunning");
  // stop_dunning: payment_due → not_paid (stopped), no more retries.
  const c1 = await customerWith(biz.id, "e3stop@a.com", { auto: "on", card: "retriable" });
  const inv1 = await bill(biz.id, await subFor(biz.id, c1.id, await price(5000)));
  const stopped = await stopDunning(orgId, biz.id, inv1.publicId);
  ok(
    "E3: stop_dunning → not_paid + dunning_status stopped + no retry",
    stopped.status === "not_paid" &&
      stopped.dunningStatus === "stopped" &&
      stopped.nextAttemptAt === null,
  );
  // pause_dunning: stays payment_due, retry pushed to `until`.
  const c2 = await customerWith(biz.id, "e3pause@a.com", { auto: "on", card: "retriable" });
  const inv2 = await bill(biz.id, await subFor(biz.id, c2.id, await price(5000)));
  const until = new Date(Date.now() + 30 * 86_400_000);
  const paused = await pauseDunning(orgId, biz.id, inv2.publicId, until);
  ok(
    "E3: pause_dunning keeps payment_due + reschedules retry",
    paused.status === "payment_due" &&
      Math.abs((paused.nextAttemptAt?.getTime() ?? 0) - until.getTime()) < 1000,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// E4 — adjustment / refundable credit notes, allocations, write-off via CN, void
// ══════════════════════════════════════════════════════════════════════════════
const cnMod = await import("@/modules/credit-notes/service");
const refundsMod = await import("@/modules/refunds/service");
const { recordExcessPayment, addPromotionalCredits, bucketBalancesForCurrency } =
  await import("@/modules/customers/balances");

// CN-1: adjustment CN reduces an unpaid invoice; fully-adjusting → paid.
{
  const { biz, price } = await freshBiz("E4 adjustment");
  const c = await customerWith(biz.id, "adj@a.com", { auto: "off" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000)));
  const cn = await cnMod.issueAdjustmentCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: inv.publicId,
    items: [{ description: "goodwill", amountMinor: 2000 }],
  });
  const after = await invRow(inv.id);
  ok(
    "E4: adjustment CN → kind adjustment, status adjusted",
    cn.kind === "adjustment" && cn.status === "adjusted",
  );
  ok(
    "E4: adjustment reduces amount_due (5000→3000)",
    after.amountDueMinor === 3000n && after.status === "payment_due",
  );
  ok(
    "E4: adjustment ledger dr credit_adjustments / cr AR (AR 3000)",
    (await acctBal(biz.id, "accounts_receivable")) === 3000n &&
      (await acctBal(biz.id, "credit_adjustments")) === 2000n,
  );
  // Fully-adjusting the remainder → paid.
  await cnMod.issueAdjustmentCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: inv.publicId,
    items: [{ description: "rest", amountMinor: 3000 }],
  });
  const paid = await invRow(inv.id);
  ok(
    "E4: fully-adjusting CN zeroes invoice → paid",
    paid.status === "paid" && (paid.amountDueMinor ?? 0n) === 0n,
  );
  ok("E4: adjustment ledger nets to zero", await ledgerNetsZero(biz.id));
}

// INV-4: write-off routes through an adjustment CN (bad_debt) → paid + written_off.
{
  const { biz, price } = await freshBiz("E4 writeoff-via-CN");
  const c = await customerWith(biz.id, "wo@a.com", { auto: "off" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(6000)));
  const { writeOffInvoice } = await import("@/modules/invoicing/ops");
  const wo = await writeOffInvoice(orgId, biz.id, inv.publicId);
  ok("E4: write-off → invoice paid + written_off", wo.status === "paid" && wo.writtenOff === true);
  ok(
    "E4: write-off books bad_debt 6000 + clears AR (same as the old path)",
    (await acctBal(biz.id, "bad_debt")) === 6000n &&
      (await acctBal(biz.id, "accounts_receivable")) === 0n,
  );
  const cns = await cnMod.listCreditNotesByBusiness(orgId, biz.id, {
    invoicePublicId: inv.publicId,
  });
  ok(
    "E4: write-off created an adjustment CN reason=write_off",
    cns.length === 1 &&
      cns[0]!.note.kind === "adjustment" &&
      cns[0]!.note.reasonCode === "write_off",
  );
  ok("E4: write-off ledger nets to zero", await ledgerNetsZero(biz.id));
}

// CN-2: refundable CN credits the bucket; refund op draws it back to cash.
{
  const { biz, price } = await freshBiz("E4 refundable");
  const c = await customerWith(biz.id, "ref@a.com", { auto: "on", card: "good" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000))); // paid
  const cn = await cnMod.issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: inv.publicId,
    items: [{ description: "partial refundable", amountMinor: 3000 }],
  });
  ok(
    "E4: refundable CN → refund_due + credits the bucket (3000)",
    cn.kind === "refundable" &&
      cn.status === "refund_due" &&
      (await bucketBalancesForCurrency(orgId, c.id, "USD")).refundable === 3000n,
  );
  ok("E4: refundable CN available = total (3000)", Number(cnMod.creditNoteAvailable(cn)) === 3000);
  const cashBefore = await acctBal(biz.id, "cash");
  const payableBefore = await acctBal(biz.id, "refunds_payable");
  const refunded = await cnMod.refundCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    creditNotePublicId: cn.publicId,
    amountMinor: 1000,
  });
  ok(
    "E4: partial refund → refunded 1000, available 2000, still refund_due",
    refunded.refundedMinor === 1000n &&
      Number(cnMod.creditNoteAvailable(refunded)) === 2000 &&
      refunded.status === "refund_due",
  );
  // The refund draws the bucket into refunds_payable, then a gateway refund clears
  // it → cash out 1000 (customer paid); refunds_payable nets back to where it was.
  ok(
    "E4: refund → cash out 1000, refunds_payable net 0, bucket 2000",
    (await acctBal(biz.id, "cash")) === cashBefore - 1000n &&
      (await acctBal(biz.id, "refunds_payable")) === payableBefore &&
      (await bucketBalancesForCurrency(orgId, c.id, "USD")).refundable === 2000n,
  );
  const full = await cnMod.refundCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    creditNotePublicId: cn.publicId,
  });
  ok(
    "E4: refunding the rest → status refunded, available 0",
    full.status === "refunded" && Number(cnMod.creditNoteAvailable(full)) === 0,
  );
  ok("E4: refundable ledger nets to zero", await ledgerNetsZero(biz.id));
}

// Auto-allocation: a refundable CN's credit drawn at the NEXT invoice → allocated.
{
  const { biz, price } = await freshBiz("E4 auto-alloc");
  // Refundable CNs now require a PAID invoice (review fix) — seed the bucket from a
  // paid invoice, then a later invoice draws it down (auto-allocation under test).
  const c = await customerWith(biz.id, "alloc@a.com", { auto: "on", card: "good" });
  const inv1 = await bill(biz.id, await subFor(biz.id, c.id, await price(5000))); // paid
  const cn = await cnMod.issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: inv1.publicId,
    items: [{ description: "credit", amountMinor: 3000 }],
  });
  // A new invoice draws the refundable bucket at generation → CN gets allocated.
  const inv2 = await bill(biz.id, await subFor(biz.id, c.id, await price(2000)));
  const reloaded = (await cnMod.listCreditNotesByBusiness(orgId, biz.id)).find(
    (v) => v.note.publicId === cn.publicId,
  )!.note;
  ok(
    "E4: refundable CN auto-allocated to the drawing invoice (2000)",
    reloaded.allocatedMinor === 2000n && Number(cnMod.creditNoteAvailable(reloaded)) === 1000,
  );
  ok(
    "E4: invariant total = allocated + refunded + available",
    reloaded.totalMinor ===
      reloaded.allocatedMinor + reloaded.refundedMinor + cnMod.creditNoteAvailable(reloaded),
  );
  ok(
    "E4: 2000-credit invoice fully covered by refundable → paid",
    (await invRow(inv2.id)).status === "paid",
  );
}

// CN-3: void a refundable CN reverses the bucket credit; forbidden once spent.
{
  const { biz, price } = await freshBiz("E4 void");
  const c = await customerWith(biz.id, "void-cn@a.com", { auto: "on", card: "good" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000)));
  const cn = await cnMod.issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: inv.publicId,
    items: [{ description: "x", amountMinor: 2000 }],
  });
  const voided = await cnMod.voidCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    creditNotePublicId: cn.publicId,
  });
  ok(
    "E4: void refundable CN → voided + bucket reversed to 0",
    voided.status === "voided" &&
      (await bucketBalancesForCurrency(orgId, c.id, "USD")).refundable === 0n,
  );
  ok("E4: void ledger nets to zero", await ledgerNetsZero(biz.id));
  // A refunded CN can't be voided.
  const cn2 = await cnMod.issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: inv.publicId,
    items: [{ description: "y", amountMinor: 1000 }],
  });
  await cnMod.refundCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    creditNotePublicId: cn2.publicId,
  });
  let blocked = false;
  try {
    await cnMod.voidCreditNote({
      organizationId: orgId,
      businessId: biz.id,
      creditNotePublicId: cn2.publicId,
    });
  } catch {
    blocked = true;
  }
  ok("E4: voiding a refunded CN is rejected", blocked);
}

// CN-2 refund-CN flow: refunding a credit-consuming invoice RESTORES the credit.
{
  const { biz, price } = await freshBiz("E4 refund restores credit");
  const c = await customerWith(biz.id, "restore@a.com", { auto: "on", card: "good" });
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 2000,
    currency: "USD",
  });
  // $50 invoice: $20 excess credit consumed + $30 card. Then refund the whole thing.
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000)));
  ok(
    "E4: invoice consumed 2000 excess + 3000 card, paid",
    inv.status === "paid" && inv.excessPaymentsAppliedMinor === 2000n,
  );
  const r = await cnMod.refundInvoiceViaCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: inv.publicId,
  });
  ok("E4 (CN-2): card portion refunded (3000)", r.cardRefundedMinor === 3000);
  // Excess goes back to the EXCESS bucket — never as a cashable refundable CN.
  ok(
    "E4 (CN-2): credit portion restored to its own bucket (2000 excess, no CN)",
    r.creditRestoredMinor === 2000 && r.creditNote === null,
  );
  ok(
    "E4 (CN-2): restored credit is spendable again (excess bucket 2000)",
    (await bucketBalancesForCurrency(orgId, c.id, "USD")).excess === 2000n,
  );
  ok("E4 (CN-2): refund-restore ledger nets to zero", await ledgerNetsZero(biz.id));
  // Idempotent: re-running the refund flow restores nothing more, refunds nothing more.
  const r2 = await cnMod.refundInvoiceViaCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: inv.publicId,
  });
  ok(
    "E4 (CN-2): re-run is a no-op (0 card, bucket still 2000)",
    r2.cardRefundedMinor === 0 &&
      (await bucketBalancesForCurrency(orgId, c.id, "USD")).excess === 2000n,
  );
}

// Allocation-invariant FUZZ: random refunds never violate total = alloc+refund+avail.
{
  const { biz, price } = await freshBiz("E4 fuzz");
  const c = await customerWith(biz.id, "fuzz@a.com", { auto: "on", card: "good" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(10000)));
  const cn = await cnMod.issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: inv.publicId,
    items: [{ description: "fuzz", amountMinor: 9000 }],
  });
  let invariantHeld = true;
  // Deterministic pseudo-random partial refunds (no Math.random — reproducible).
  const amounts = [1300, 700, 2500, 400, 1600, 3000, 5000];
  for (let i = 0; i < amounts.length; i++) {
    const cur = (await cnMod.listCreditNotesByBusiness(orgId, biz.id)).find(
      (v) => v.note.publicId === cn.publicId,
    )!.note;
    const avail = Number(cnMod.creditNoteAvailable(cur));
    if (avail <= 0) break;
    const amt = Math.min(amounts[i]!, avail);
    const after = await cnMod.refundCreditNote({
      organizationId: orgId,
      businessId: biz.id,
      creditNotePublicId: cn.publicId,
      amountMinor: amt,
    });
    if (
      after.totalMinor !==
      after.allocatedMinor + after.refundedMinor + cnMod.creditNoteAvailable(after)
    )
      invariantHeld = false;
    if (cnMod.creditNoteAvailable(after) < 0n) invariantHeld = false;
  }
  const final = (await cnMod.listCreditNotesByBusiness(orgId, biz.id)).find(
    (v) => v.note.publicId === cn.publicId,
  )!.note;
  ok("E4: fuzz — invariant held across random partial refunds", invariantHeld);
  // INDEPENDENT recheck (not the CN's own columns): allocated from the
  // allocations table, refunded from the ledger's credit_note_refund entries.
  const indep = await withTenant(orgId, async (tx: Tx) => {
    const alloc = await tx.execute(sql`
      select coalesce(sum(a.amount_minor),0)::bigint as v from credit_note_allocations a
      join credit_notes n on n.id = a.credit_note_id where n.public_id = ${cn.publicId}`);
    const refd = await tx.execute(sql`
      select coalesce(sum(amount_minor),0)::bigint as v from ledger_entries
      where source_type = 'credit_note_refund' and source_id = ${cn.publicId} and direction = 'debit'`);
    return {
      alloc: BigInt((alloc as unknown as Array<{ v: string | number }>)[0]?.v ?? 0),
      refd: BigInt((refd as unknown as Array<{ v: string | number }>)[0]?.v ?? 0),
    };
  });
  ok(
    "E4: fuzz — CN columns match allocations table + refund ledger independently",
    indep.alloc === final.allocatedMinor &&
      indep.refd === final.refundedMinor &&
      final.totalMinor === indep.alloc + indep.refd + cnMod.creditNoteAvailable(final),
  );
  ok(
    "E4: fuzz — fully refunded (available 0, status refunded)",
    Number(cnMod.creditNoteAvailable(final)) === 0 && final.status === "refunded",
  );
  ok(
    "E4: fuzz — over-refund past available is rejected",
    await (async () => {
      try {
        await cnMod.refundCreditNote({
          organizationId: orgId,
          businessId: biz.id,
          creditNotePublicId: cn.publicId,
          amountMinor: 1,
        });
        return false;
      } catch {
        return true;
      }
    })(),
  );
  ok("E4: fuzz ledger nets to zero", await ledgerNetsZero(biz.id));
}

// ══════════════════════════════════════════════════════════════════════════════
// E5 — cancellation credit helper (feeds Phase F)
// ══════════════════════════════════════════════════════════════════════════════
const { issueProratedCreditForUnusedTerm } =
  await import("@/modules/subscriptions/cancellation-credit");
const { subscriptions } = await import("@db/schema");
// Pin a known 10-day term; cancel at day 5 → 50% unused.
const pStart = new Date(Date.UTC(2026, 0, 1)),
  pEnd = new Date(Date.UTC(2026, 0, 11)),
  mid = new Date(Date.UTC(2026, 0, 6));
async function pinPeriod(subId: string) {
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ currentPeriodStart: pStart, currentPeriodEnd: pEnd })
      .where(eq(subscriptions.id, subId)),
  );
  // Keep the term invoice consistent with the pinned period — the credit helper
  // (correctly) selects the invoice whose period_start matches the sub's.
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ periodStart: pStart, periodEnd: pEnd })
      .where(eq(invoices.subscriptionId, subId)),
  );
  return (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1),
    )
  )[0]!;
}

// prorate on a PAID term → refundable CN for the unused half.
{
  const { biz, price } = await freshBiz("E5 prorate paid");
  const c = await customerWith(biz.id, "e5p@a.com", { auto: "on", card: "good" });
  const sub = await subFor(biz.id, c.id, await price(10000));
  await bill(biz.id, sub);
  const cn = await issueProratedCreditForUnusedTerm({
    organizationId: orgId,
    businessId: biz.id,
    subscription: await pinPeriod(sub.id),
    creditOption: "prorate",
    now: mid,
  });
  ok(
    "E5: prorate/paid → refundable CN for ~50% (5000)",
    cn?.kind === "refundable" &&
      cn.totalMinor === 5000n &&
      cn.reasonCode === "subscription_cancellation",
  );
  ok(
    "E5: refundable bucket credited 5000",
    (await bucketBalancesForCurrency(orgId, c.id, "USD")).refundable === 5000n,
  );
}

// full on a PAID term → refundable CN for the whole term.
{
  const { biz, price } = await freshBiz("E5 full paid");
  const c = await customerWith(biz.id, "e5f@a.com", { auto: "on", card: "good" });
  const sub = await subFor(biz.id, c.id, await price(10000));
  await bill(biz.id, sub);
  const cn = await issueProratedCreditForUnusedTerm({
    organizationId: orgId,
    businessId: biz.id,
    subscription: await pinPeriod(sub.id),
    creditOption: "full",
    now: mid,
  });
  ok("E5: full/paid → refundable CN for the whole term (10000)", cn?.totalMinor === 10000n);
}

// prorate on an UNPAID term → adjustment CN reduces the amount due.
{
  const { biz, price } = await freshBiz("E5 prorate unpaid");
  const c = await customerWith(biz.id, "e5u@a.com", { auto: "off" });
  const sub = await subFor(biz.id, c.id, await price(10000));
  const inv = await bill(biz.id, sub); // posted (unpaid)
  const cn = await issueProratedCreditForUnusedTerm({
    organizationId: orgId,
    businessId: biz.id,
    subscription: await pinPeriod(sub.id),
    creditOption: "prorate",
    now: mid,
  });
  ok(
    "E5: prorate/unpaid → adjustment CN (5000)",
    cn?.kind === "adjustment" && cn.totalMinor === 5000n,
  );
  ok(
    "E5: adjustment reduced amount_due (10000→5000)",
    (await invRow(inv.id)).amountDueMinor === 5000n,
  );
}

// none → no credit note.
{
  const { biz, price } = await freshBiz("E5 none");
  const c = await customerWith(biz.id, "e5n@a.com", { auto: "on", card: "good" });
  const sub = await subFor(biz.id, c.id, await price(10000));
  await bill(biz.id, sub);
  const cn = await issueProratedCreditForUnusedTerm({
    organizationId: orgId,
    businessId: biz.id,
    subscription: await pinPeriod(sub.id),
    creditOption: "none",
    now: mid,
  });
  ok("E5: creditOption none → no credit note", cn === null);
}

// ══════════════════════════════════════════════════════════════════════════════
// E6 — round-off (INV-5) + regenerate voided invoice (INV-6)
// ══════════════════════════════════════════════════════════════════════════════

// Round DOWN: nearest_unit rounds 10.49 → 10.00 (rounding line −49).
{
  const { biz, price } = await freshBiz("E6 round down");
  await updateBusiness(orgId, biz.publicId, { invoiceRounding: "nearest_unit" });
  const c = await customerWith(biz.id, "e6d@a.com", { auto: "off" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(1049)));
  const lines = await lineKinds(inv.id);
  ok("E6: round-down → total 1000 (from 1049)", inv.totalMinor === 1000n);
  ok(
    "E6: rounding line −49 present",
    lines.some((l) => l.kind === "rounding" && l.amountMinor === -49n),
  );
  ok(
    "E6: AR = rounded total 1000; ledger balances",
    (await acctBal(biz.id, "accounts_receivable")) === 1000n && (await ledgerNetsZero(biz.id)),
  );
}

// Round UP: 10.80 → 11.00 (rounding line +20).
{
  const { biz, price } = await freshBiz("E6 round up");
  await updateBusiness(orgId, biz.publicId, { invoiceRounding: "nearest_unit" });
  const c = await customerWith(biz.id, "e6u@a.com", { auto: "off" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(1080)));
  ok("E6: round-up → total 1100 (from 1080)", inv.totalMinor === 1100n);
  ok(
    "E6: rounding line +20 present",
    (await lineKinds(inv.id)).some((l) => l.kind === "rounding" && l.amountMinor === 20n),
  );
  ok(
    "E6: round-up ledger balances (rounding account)",
    (await acctBal(biz.id, "accounts_receivable")) === 1100n && (await ledgerNetsZero(biz.id)),
  );
}

// The unit is one MAJOR unit of the currency: JPY has none smaller, KWD has 1000 minor.
{
  const { biz, price } = await freshBiz("E6 round JPY", "JPY");
  await updateBusiness(orgId, biz.publicId, { invoiceRounding: "nearest_unit" });
  const c = await customerWith(biz.id, "e6j@a.com", { auto: "off" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(1049)));
  ok(`E6: JPY total untouched (1049 → ${inv.totalMinor})`, inv.totalMinor === 1049n);
  ok("E6: JPY has no rounding line", !(await lineKinds(inv.id)).some((l) => l.kind === "rounding"));
}
{
  const { biz, price } = await freshBiz("E6 round KWD", "KWD");
  await updateBusiness(orgId, biz.publicId, { invoiceRounding: "nearest_unit" });
  const c = await customerWith(biz.id, "e6k@a.com", { auto: "off" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(10499)));
  ok(`E6: KWD rounds to 1000 minor (10499 → ${inv.totalMinor})`, inv.totalMinor === 10000n);
  ok(
    "E6: KWD rounding line −499; ledger balances",
    (await lineKinds(inv.id)).some((l) => l.kind === "rounding" && l.amountMinor === -499n) &&
      (await ledgerNetsZero(biz.id)),
  );
}

// Regenerate a voided invoice → a brand-new invoice for the same period.
{
  const { biz, price } = await freshBiz("E6 regenerate");
  const { voidInvoice, regenerateInvoice } = await import("@/modules/invoicing/ops");
  const c = await customerWith(biz.id, "e6r@a.com", { auto: "off" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000)));
  await voidInvoice(orgId, biz.id, inv.publicId);
  const { invoice: regen } = await regenerateInvoice(orgId, biz.id, inv.publicId);
  ok(
    "E6: regenerate → new invoice id, same period",
    regen.id !== inv.id &&
      regen.publicId !== inv.publicId &&
      regen.periodStart?.getTime() === inv.periodStart?.getTime(),
  );
  ok(
    "E6: regenerated invoice is live (payment_due, AR 5000)",
    regen.status === "payment_due" && (await invRow(regen.id)).totalMinor === 5000n,
  );
  // Regenerate rejected for a non-voided invoice.
  let rejected = false;
  try {
    await regenerateInvoice(orgId, biz.id, regen.publicId);
  } catch {
    rejected = true;
  }
  ok("E6: regenerate rejected for a non-voided invoice", rejected);
}

// ══════════════════════════════════════════════════════════════════════════════
// R — E-review regressions (Fable audit): races + bucket-faithful refunds
// ══════════════════════════════════════════════════════════════════════════════

// R1: concurrent refunds of ONE credit note can't double-cash (customer-locked
// re-read: the loser sees available 0 and is rejected).
{
  const { biz, price } = await freshBiz("R1 cn refund race");
  const c = await customerWith(biz.id, "r1@a.com", { auto: "on", card: "good" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000))); // paid → cash 5000
  const cn = await cnMod.issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: inv.publicId,
    items: [{ description: "race", amountMinor: 5000 }],
  });
  const results = await Promise.allSettled([
    cnMod.refundCreditNote({
      organizationId: orgId,
      businessId: biz.id,
      creditNotePublicId: cn.publicId,
    }),
    cnMod.refundCreditNote({
      organizationId: orgId,
      businessId: biz.id,
      creditNotePublicId: cn.publicId,
    }),
  ]);
  const wins = results.filter((r) => r.status === "fulfilled").length;
  const after = (await cnMod.listCreditNotesByBusiness(orgId, biz.id)).find(
    (v) => v.note.publicId === cn.publicId,
  )!.note;
  ok("R1: exactly one concurrent CN refund succeeds", wins === 1);
  ok(
    "R1: refunded exactly once (5000, bucket 0)",
    after.refundedMinor === 5000n &&
      (await bucketBalancesForCurrency(orgId, c.id, "USD")).refundable === 0n,
  );
  // Exactly one refund pays out via the gateway: cash 5000 in − 5000 out = 0, and
  // refunds_payable nets to 0. The race can't double-pay (would be −5000 cash).
  ok(
    "R1: single refund pays out once (cash 0, refunds_payable 0)",
    (await acctBal(biz.id, "cash")) === 0n && (await acctBal(biz.id, "refunds_payable")) === 0n,
  );
  ok("R1: ledger nets to zero", await ledgerNetsZero(biz.id));
}

// R2: concurrent closes of ONE pending invoice finalize exactly once (atomic
// status='pending' claim inside the finalize transaction).
{
  const { biz, price } = await freshBiz("R2 close race");
  const c = await customerWith(biz.id, "r2@a.com", { auto: "off" });
  const sub = await subFor(biz.id, c.id, await price(3000));
  const draft = await bill(biz.id, sub, { createAsPending: true } as never);
  const results = await Promise.allSettled([
    closeInvoice(orgId, biz.id, draft.publicId),
    closeInvoice(orgId, biz.id, draft.publicId),
  ]);
  const wins = results.filter((r) => r.status === "fulfilled").length;
  ok("R2: exactly one concurrent close succeeds", wins === 1);
  ok(
    "R2: ledger posted once (AR 3000, revenue −3000 side nets zero)",
    (await acctBal(biz.id, "accounts_receivable")) === 3000n && (await ledgerNetsZero(biz.id)),
  );
  const after = await invRow(draft.id);
  ok("R2: invoice finalized once → payment_due", after.status === "payment_due");
}

// R3: refunding a promo-consuming invoice restores PROMOTIONAL credit to its own
// bucket — it must never come back as cashable refundable credit.
{
  const { biz, price } = await freshBiz("R3 promo not cashable");
  const c = await customerWith(biz.id, "r3@a.com", { auto: "on", card: "good" });
  await addPromotionalCredits({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 2000,
    currency: "USD",
  });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000)));
  ok(
    "R3: invoice consumed 2000 promo + 3000 card",
    inv.status === "paid" && inv.promotionalCreditsAppliedMinor === 2000n,
  );
  const r = await cnMod.refundInvoiceViaCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: inv.publicId,
  });
  const buckets = await bucketBalancesForCurrency(orgId, c.id, "USD");
  ok(
    "R3: card refunded 3000; NO refundable CN issued for promo",
    r.cardRefundedMinor === 3000 && r.creditNote === null,
  );
  ok(
    "R3: promo back in the promo bucket (2000), refundable stays 0",
    buckets.promotional === 2000n && buckets.refundable === 0n,
  );
  ok("R3: ledger nets to zero", await ledgerNetsZero(biz.id));
}

// R6: TWO GATEWAY PAYMENTS ON ONE INVOICE — refunding both returns the promotional
// grant ONCE. Regression for the defect handed over 2026-08-28: the cash refund's
// promotional slice divided by `pay.amountMinor` (this payment) while the numerator was
// the INVOICE's total promo, so a full refund of EACH leg returned the whole grant and
// minted spendable promotional credit from nothing.
//
// The absence of this fixture is what let it through — every other fixture in the repo
// settles an invoice with exactly one payment, and at one payment the wrong denominator
// and the right one are the same number.
//
// The second leg is inserted directly because no API raises a partial GATEWAY payment
// (`/pay` records an offline one, which `refundPayment` refuses for want of a provider
// charge). The STATE is reachable though: a late capture smaller than the outstanding
// amount books a succeeded gateway payment and leaves the invoice open (`settlement.ts`),
// so the next payment settles the rest.
{
  const { biz, price } = await freshBiz("R4 promo across two payments");
  const c = await customerWith(biz.id, "r4@a.com", { auto: "on", card: "good" });
  await addPromotionalCredits({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    amountMinor: 2000,
    currency: "USD",
  });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(10000)));
  ok(
    "R6: invoice consumed 2000 promo + 8000 card",
    inv.promotionalCreditsAppliedMinor === 2000n && inv.status === "paid",
  );

  // Split the single 8000 settlement into two 4000 gateway legs.
  const [leg1] = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, inv.id)),
  );
  await withTenant(orgId, (tx) =>
    tx.update(payments).set({ amountMinor: 4000n }).where(eq(payments.id, leg1!.id)),
  );
  const [leg2] = await withTenant(orgId, (tx) =>
    tx
      .insert(payments)
      .values({
        organizationId: orgId,
        businessId: biz.id,
        customerId: c.id,
        invoiceId: inv.id,
        publicId: publicId("pay"),
        status: "succeeded",
        amountMinor: 4000n,
        currency: "USD",
        paymentMethodId: leg1!.paymentMethodId,
        providerKey: leg1!.providerKey,
        providerChargeId: `${leg1!.providerChargeId}_leg2`,
      })
      .returning(),
  );

  await refundsMod.refundPayment({
    organizationId: orgId,
    businessId: biz.id,
    paymentPublicId: leg1!.publicId,
    amountMinor: 4000,
  });
  const mid = await bucketBalancesForCurrency(orgId, c.id, "USD");
  // Half the cash unwound → half the grant. Under the old denominator this was the FULL
  // 2000, and a customer who refunded only one leg walked away 1000 up.
  ok(
    "R6: refunding ONE leg returns its share (1000), not the whole grant",
    mid.promotional === 1000n,
  );

  await refundsMod.refundPayment({
    organizationId: orgId,
    businessId: biz.id,
    paymentPublicId: leg2!.publicId,
    amountMinor: 4000,
  });
  const end = await bucketBalancesForCurrency(orgId, c.id, "USD");
  ok(
    "R6: both legs refunded returns the grant exactly once (2000, not 4000)",
    end.promotional === 2000n,
  );
  ok(
    "R6: the invoice never gives back more promo than it took",
    end.promotional <= (inv.promotionalCreditsAppliedMinor ?? 0n),
  );
  ok("R6: ledger nets to zero", await ledgerNetsZero(biz.id));
}

// R4: transition INTO pending mode must not drop the just-ended period's usage —
// the first pending draft claims the trailing arrears window and bills it at close.
{
  const { runBillingClockTick } = await import("@/modules/subscriptions/renewal");
  const { biz, price } = await freshBiz("R4 pending usage transition");
  const c = await customerWith(biz.id, "r4@a.com", { auto: "off" });
  const flat = await price(1000);
  const metered = await price(5, "usage");
  const past = new Date(Date.now() - 35 * 86_400_000); // sub period already over
  const s = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: past,
    items: [
      { price: flat, quantity: 1 },
      { price: metered, quantity: 1 },
    ],
  });
  const usageItem = s.items.find((i) => i.priceId === metered.id)!;
  await bill(biz.id, s.subscription); // P0 invoice, old regime (no usage window claimed)
  // Usage lands during P0…
  await recordUsage({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionItemId: usageItem.id,
    quantity: 10,
    timestamp: new Date(past.getTime() + 86_400_000),
  });
  // …then the business flips on pending invoices and the clock renews into P1.
  await updateBusiness(orgId, biz.publicId, { createPendingInvoices: true });
  await runBillingClockTick(new Date());
  const draft = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select()
          .from(invoices)
          .where(
            and(eq(invoices.subscriptionId, s.subscription.id), eq(invoices.status, "pending")),
          )
          .limit(1)
      )[0],
  );
  ok("R4: renewal created a pending draft", !!draft);
  if (draft) {
    const win = (draft.metadata as { usage_window?: { start?: string } } | null)?.usage_window;
    ok(
      "R4: draft claims the trailing arrears window (P0 start)",
      !!win?.start &&
        new Date(win.start).getTime() === s.subscription.currentPeriodStart!.getTime(),
    );
    const closed = await closeInvoice(orgId, biz.id, draft.publicId);
    const usageLine = (await lineKinds(draft.id)).find((l) => l.kind === "usage");
    ok(
      "R4: close bills P0 usage (10 × 5 = 50)",
      !!usageLine && usageLine.quantity === 10 && usageLine.amountMinor === 50n,
    );
    ok("R4: closed total = recurring 1000 + usage 50", closed.invoice.totalMinor === 1050n);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// W — Phase E review backlog regressions (warm-up)
// ══════════════════════════════════════════════════════════════════════════════

// W-CN-cap: refundable CN is rejected on an unpaid (posted) invoice — you can't
// refund money that was never collected (review fix).
{
  const { biz, price } = await freshBiz("W refundable-cap");
  const c = await customerWith(biz.id, "wcap@a.com", { auto: "off" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000))); // posted, unpaid
  let rejected = false;
  try {
    await cnMod.issueRefundableCreditNote({
      organizationId: orgId,
      businessId: biz.id,
      invoicePublicId: inv.publicId,
      items: [{ description: "x", amountMinor: 1000 }],
    });
  } catch (e) {
    rejected = e instanceof cnMod.CreditNoteError;
  }
  ok("W: refundable CN rejected on an unpaid invoice", rejected);
}

// W-tax-split: fully adjusting a TAXED invoice reverses the tax liability share,
// not just AR (review fix) — leaves tax_payable at 0, not stranded.
{
  const b = await createBusiness({
    organizationId: orgId,
    name: "W tax-split",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: b.id,
    name: "VAT",
    country: "GB",
    rateBps: 2000,
  });
  const prod = await createProduct({ organizationId: orgId, businessId: b.id, name: "Plan" });
  const pr = await createPrice({
    organizationId: orgId,
    businessId: b.id,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const c = await createCustomer({
    organizationId: orgId,
    businessId: b.id,
    email: "wtax@a.com",
    autoCollection: "off",
    address: { line1: "1 St", city: "London", postalCode: "EC1", country: "GB" },
  });
  const inv = await bill(b.id, await subFor(b.id, c.id, pr)); // subtotal 5000 + 20% tax 1000 = 6000
  ok(
    "W: taxed invoice total 6000, tax_payable liability 1000",
    inv.totalMinor === 6000n && (await acctBal(b.id, "tax_payable")) === -1000n,
  );
  await cnMod.issueAdjustmentCreditNote({
    organizationId: orgId,
    businessId: b.id,
    invoicePublicId: inv.publicId,
    items: [{ description: "full adj", amountMinor: 6000 }],
    reasonCode: "other",
  });
  ok(
    "W: adjustment splits tax → tax_payable 0, credit_adjustments 5000 (net), AR 0",
    (await acctBal(b.id, "tax_payable")) === 0n &&
      (await acctBal(b.id, "credit_adjustments")) === 5000n &&
      (await acctBal(b.id, "accounts_receivable")) === 0n,
  );
  ok("W: tax-split adjustment ledger nets to zero", await ledgerNetsZero(b.id));
  ok("W: fully-adjusted invoice → paid", (await invRow(inv.id)).status === "paid");
}

// W-void-guard: voiding a partial adjustment CN reopens ONLY the still-outstanding
// portion (net of cash paid), never resurrecting collected cash (review fix).
{
  const { biz, price } = await freshBiz("W void-guard");
  const c = await customerWith(biz.id, "wvoid@a.com", { auto: "off" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000))); // posted, AR 5000
  const cn = await cnMod.issueAdjustmentCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: inv.publicId,
    items: [{ description: "partial adj", amountMinor: 2000 }],
    reasonCode: "other",
  });
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: inv.publicId,
  }); // pays remaining 3000 → paid
  ok("W: partial adj + cash → paid", (await invRow(inv.id)).status === "paid");
  await cnMod.voidCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    creditNotePublicId: cn.publicId,
  });
  const after = await invRow(inv.id);
  // ASSERTED THROUGH `invoiceOutstanding`, the function every collection path goes through —
  // not off the raw column. `amount_due_minor` is the ISSUE-TIME collectible, net of CREDITS
  // only; cash is subtracted when the invoice is served. Reading the raw column here made this
  // test PIN A BUG: the void wrote a cash-net 2000 into it, so the column read 2000 and this
  // assertion passed, while what anyone actually saw was `2000 − 3000` clamped to **0**. The
  // void reopened a debt nobody could be shown or charged for, and 60 invoices then tripped
  // `invoice_not_overpaid` because 3000 of cash sat against a "2000" invoice. The stored column
  // is now 5000 (nothing credits it — the note is voided) and the outstanding is the 2000 this
  // test always meant.
  const outstanding = await withTenant(orgId, (tx) => invoiceOutstanding(tx, after));
  ok(
    "W: void adj reopens only the 2000 the CN covered (not 5000)",
    after.status === "posted" &&
      after.amountDueMinor === 5000n &&
      outstanding.remainingMinor === 2000n,
  );
}

// W-regen-dup: regenerate refuses to run twice for one period (no N live invoices).
{
  const { biz, price } = await freshBiz("W regen-dup");
  const c = await customerWith(biz.id, "wregen@a.com", { auto: "off" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000)));
  const v = await voidInvoice(orgId, biz.id, inv.publicId);
  await regenerateInvoice(orgId, biz.id, v.publicId); // ok → one live invoice
  let refused = false;
  try {
    await regenerateInvoice(orgId, biz.id, v.publicId);
  } catch (e) {
    refused = e instanceof InvoiceOpsError;
  }
  ok("W: regenerate refused when a live invoice already covers the period", refused);
}

// W-due-final-action: a non-retriable decline at the DUE-DATE clock pass applies
// the dunning final action (invoice not_paid + sub canceled), not strand past_due
// forever (review fix — renewal/retry applied it; the due path previously didn't).
{
  const { biz, price } = await freshBiz("W due final-action");
  const c = await customerWith(biz.id, "wduefa@a.com", { auto: "on", card: "hard" });
  const sub = await subFor(biz.id, c.id, await price(5000));
  const inv = await bill(biz.id, sub); // hard card charged at generation → not_paid
  // Reset to a POSTED subscription invoice with a past due date (a Net-D bill the
  // clock will collect at term) + active sub, to exercise the due-date pass.
  await withTenant(orgId, async (tx) => {
    await tx
      .update(invoices)
      .set({
        status: "posted",
        dunningStatus: null,
        attemptCount: 0,
        nextAttemptAt: null,
        amountDueMinor: 5000n,
        paidAt: null,
        dueDate: new Date(Date.now() - 86_400_000),
      })
      .where(eq(invoices.id, inv.id));
    await tx
      .update(subsTable)
      .set({ status: "active", canceledAt: null, cancelReason: null })
      .where(eq(subsTable.id, sub.id));
  });
  await runInvoiceDueTransitions(new Date());
  const after = await invRow(inv.id);
  const subAfter = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(subsTable)
      .where(eq(subsTable.id, sub.id))
      .limit(1)
      .then((r) => r[0]!),
  );
  ok(
    "W: due-path non-retriable decline → invoice not_paid + subscription canceled",
    after.status === "not_paid" &&
      subAfter.status === "cancelled" &&
      subAfter.cancelReason === "not_paid",
  );
}

// W-stop-rearm: a failed manual collect must NOT re-arm a stop_dunning'd invoice.
{
  const { biz, price } = await freshBiz("W stop-rearm");
  const c = await customerWith(biz.id, "wstop@a.com", { auto: "on", card: "retriable" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000))); // payment_due
  await stopDunning(orgId, biz.id, inv.publicId); // → not_paid / stopped
  await collectInvoiceNow(orgId, biz.id, inv.publicId); // retriable card fails again
  const after = await invRow(inv.id);
  ok(
    "W: stopped invoice stays not_paid/stopped after a failed collect (no re-arm)",
    after.status === "not_paid" &&
      after.dunningStatus === "stopped" &&
      after.nextAttemptAt === null,
  );
}

// W-offline-rearm: a failed manual collect on an auto-collect-OFF invoice settles
// to not_paid with no automatic dunning schedule.
{
  const { biz, price } = await freshBiz("W offline-rearm");
  const c = await customerWith(biz.id, "woff@a.com", { auto: "off", card: "retriable" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000))); // payment_due, in offline dunning
  await collectInvoiceNow(orgId, biz.id, inv.publicId); // operator collect → retriable fail
  const after = await invRow(inv.id);
  // Was `not_paid` / dunning null / next null. A charge that auto-collection rules out
  // must leave NO trace on the invoice: `planFailureRearm` answers `send_invoice`, which
  // writes nothing at all, so the invoice keeps the state it was raised in. The old
  // expectation was the bug: such an invoice must read `payment_due` with no attempts,
  // and ours reported `not_paid` with `attempt_count: 1`.
  ok(
    "W: failed collect on an offline invoice changes nothing about it",
    after.status === "payment_due" &&
      after.dunningStatus === "in_progress" &&
      after.nextAttemptAt?.getTime() === inv.nextAttemptAt?.getTime() &&
      after.attemptCount === 0,
  );
}

// R5 (H-review blocker regression): concurrent voids of ONE invoice reverse the
// ledger exactly once (atomic voided claim — the loser rolls back entirely).
{
  const { biz, price } = await freshBiz("R5 void race");
  const c = await customerWith(biz.id, "r5@a.com", { auto: "off" });
  const inv = await bill(biz.id, await subFor(biz.id, c.id, await price(5000)));
  const results = await Promise.allSettled([
    voidInvoice(orgId, biz.id, inv.publicId),
    voidInvoice(orgId, biz.id, inv.publicId),
  ]);
  const wins = results.filter((r) => r.status === "fulfilled").length;
  ok("R5: exactly one concurrent void succeeds", wins === 1);
  ok(
    "R5: AR reversed exactly once (0, not −5000)",
    (await acctBal(biz.id, "accounts_receivable")) === 0n,
  );
  ok("R5: ledger nets to zero", await ledgerNetsZero(biz.id));
  ok("R5: invoice voided", (await invRow(inv.id)).status === "voided");
}

// ── Report ──────────────────────────────────────────────────────────────────
let pass = true;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ INVOICES V2: PASS" : "❌ INVOICES V2: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
