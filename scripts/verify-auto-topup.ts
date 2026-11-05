/**
 * Automatic credit top-up (design G5 §3.6), end to end on tmtest:
 *  - concurrent creations make one run, one invoice, one charge; a re-run makes nothing;
 *  - a decline books the attempt, voids the invoice, turns the config off and emits
 *    `credit_auto_topup_failed`; dunning and the stranded sweep never touch a purchase;
 *  - a lost answer (ProviderIndeterminateError) is pending, never failed; a pending payment
 *    grants nothing until it settles;
 *  - the monthly cap reduces a run, then skips it once; runs per day skip once;
 *  - the lead-time rule refuses a low threshold on a notice rail (26 h own, the adapter's lead
 *    on a gateway notice), a schedule is exempt, and the weekly re-check warns once;
 *  - an INR card / UPI mandate run clamps at ₹15,000;
 *  - our own notice charges only after 24 h + margin; a gateway notice only after the stored
 *    `executable_after`;
 *  - a USD run never picks an INR mandate first.
 *
 *   pnpm verify:all:fresh -- --suite auto-topup
 */
import { and, desc, eq } from "drizzle-orm";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createBusiness, createOrganization } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { startTimeTravel } from "@/modules/time-travel/service";
import { runDunningPass, sweepStrandedRetries } from "@/modules/subscriptions/dunning";
import { settlePaymentSucceeded } from "@/modules/payments/settlement";
import { publicId } from "@/platform/ids";
import { grantViews, serializeCreditGrant } from "@/modules/credits/service";
import {
  AutoTopupError,
  createRunFor,
  putAutoTopup,
  recheckAutoTopupThresholds,
  runCreditAutoTopups,
  setBurnReader,
  type AutoTopupInput,
} from "@/modules/usage-controls/auto-topup";
import {
  businesses,
  creditAutoTopupRuns,
  creditAutoTopups,
  creditGrants,
  creditHolds,
  emailMessages,
  events,
  gatewayAccounts,
  invoices,
  paymentMethods,
  payments,
  preDebitNotices,
  timeTravels,
  transactions,
  gatewayRequestLogs,
} from "@db/schema";
import { checker } from "./lib/meter-fixtures";
import "@/modules/emails/outbox";

const { fails, check } = checker();
const H = 3_600_000;
const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);

const org = await createOrganization({ name: "Auto Top-up" });
const orgId = org.organization.id;

/** Run `fn` as business time `t`. */
async function at<T>(bizId: string, t: Date, fn: () => Promise<T>): Promise<T> {
  await systemDb
    .update(timeTravels)
    .set({ simulatedNow: t })
    .where(eq(timeTravels.businessId, bizId));
  return runWithClockScope({ onlyBusinessId: bizId, now: t }, fn);
}
const pass = (bizId: string, t: Date) => at(bizId, t, () => runCreditAutoTopups(t));

/** Gateway calls filed under one span. The log insert is fire-and-forget, so poll briefly. */
async function logsForSpan(spanId: string | null, atLeast = 1) {
  if (!spanId) return [];
  let rows: (typeof gatewayRequestLogs.$inferSelect)[] = [];
  for (let i = 0; i < 40 && rows.length < atLeast; i++) {
    if (i) await new Promise((r) => setTimeout(r, 50));
    rows = await systemDb
      .select()
      .from(gatewayRequestLogs)
      .where(eq(gatewayRequestLogs.spanId, spanId));
  }
  return rows;
}

async function newBusiness(name: string, currency: "USD" | "INR") {
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: currency,
    livemode: "test",
  });
  await startTimeTravel({ orgId, bizId: biz.id, genesisTime: T0 });
  await systemDb
    .update(businesses)
    .set({ creditConfig: { top_up_limits: { [currency]: { min_minor: 300 } } } })
    .where(eq(businesses.id, biz.id));
  const [plain] = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(eq(gatewayAccounts.businessId, biz.id));
  return { biz, plain: plain! };
}

let cn = 0;
async function customerWith(bizId: string, token: string, acctId?: string) {
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: `atu-${++cn}-${Date.now()}@example.com`,
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: bizId,
    customer,
    token,
    ...(acctId ? { gatewayAccountId: acctId } : {}),
  });
  return { customer, pm };
}
/** A UPI mandate on the instrument (an India e-mandate rail). */
const asUpiMandate = (pmId: string, accountId?: string) =>
  withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({
        type: "upi",
        mandateRail: "upi",
        mandateReference: "UMN-TEST-0001",
        mandateStatus: "confirmed",
        ...(accountId ? { gatewayAccountId: accountId } : {}),
      })
      .where(eq(paymentMethods.id, pmId)),
  );

const fixedCfg = (o: Partial<AutoTopupInput> = {}): AutoTopupInput => ({
  trigger: "threshold",
  thresholdMinor: 1_000n,
  method: "fixed",
  amountMinor: 500n,
  monthlyCapMinor: 1_000_000n,
  maxRunsPerDay: 10,
  grant: { tax_treatment: "taxed_at_purchase" },
  ...o,
});
async function save(bizId: string, cus: string, cfg: AutoTopupInput, t = T0) {
  return at(bizId, t, () =>
    putAutoTopup({ organizationId: orgId, businessId: bizId, customerPublicId: cus, config: cfg }),
  );
}
async function refusal(bizId: string, cus: string, cfg: AutoTopupInput): Promise<string> {
  try {
    await save(bizId, cus, cfg);
    return "";
  } catch (e) {
    return e instanceof AutoTopupError ? e.message : `threw ${(e as Error).message}`;
  }
}
const runsOf = (configId: string) =>
  systemDb
    .select()
    .from(creditAutoTopupRuns)
    .where(eq(creditAutoTopupRuns.configId, configId))
    .orderBy(creditAutoTopupRuns.createdAt, creditAutoTopupRuns.id);
const configRow = async (id: string) =>
  (await systemDb.select().from(creditAutoTopups).where(eq(creditAutoTopups.id, id)))[0]!;
const invoiceRow = async (id: string) =>
  (await systemDb.select().from(invoices).where(eq(invoices.id, id)))[0]!;
const paymentsOf = (invoiceId: string) =>
  systemDb.select().from(payments).where(eq(payments.invoiceId, invoiceId));
const grantOf = async (invoiceId: string) =>
  (await systemDb.select().from(creditGrants).where(eq(creditGrants.invoiceId, invoiceId)))[0];
const eventsOf = (type: string, resourceId: string) =>
  systemDb
    .select()
    .from(events)
    .where(and(eq(events.type, type as never), eq(events.resourceId, resourceId)));
/** Spend the balance: an open hold lowers it (PR 2's live balance). */
async function hold(bizId: string, customerId: string, currency: string, amount: bigint) {
  await systemDb.insert(creditHolds).values({
    organizationId: orgId,
    businessId: bizId,
    publicId: publicId("chd"),
    customerId,
    currency,
    amountMinor: amount,
    status: "held",
    expiresAt: new Date(T0.getTime() + 30 * 24 * H),
  });
}

// ── 1. Concurrent creations make one run; a re-run makes nothing ─────────────────────
console.log("1. one run under concurrency, idempotent re-run");
const usd = await newBusiness("ATU USD", "USD");
{
  const c = await customerWith(usd.biz.id, "4242424242424242");
  const { config } = await save(usd.biz.id, c.customer.publicId, fixedCfg({ currency: "USD" }));
  const outcomes = await at(usd.biz.id, T0, () =>
    Promise.all(Array.from({ length: 20 }, () => createRunFor(config, T0))),
  );
  const runs = await runsOf(config.id);
  const invs = await systemDb
    .select()
    .from(invoices)
    .where(and(eq(invoices.customerId, c.customer.id), eq(invoices.purpose, "credit_purchase")));
  check(
    "20 parallel creations make one run and one purchase invoice",
    runs.length === 1 && invs.length === 1 && outcomes.filter((o) => o === "created").length === 1,
    { runs: runs.length, invs: invs.length, outcomes },
  );
  check(
    "fixed lands strictly above the threshold: 3 × 500 from a zero balance",
    runs[0]?.amountMinor === 1_500n,
    runs[0]?.amountMinor,
  );
  check(
    "the purchase invoice: origin atu:<run>, purpose credit_purchase, a pending paid grant",
    invs[0]?.originToken === `atu:${runs[0]?.publicId}` &&
      (await grantOf(invs[0]!.id))?.status === "pending" &&
      (await grantOf(invs[0]!.id))?.source === "auto_top_up",
    invs[0],
  );
  await pass(usd.biz.id, T0);
  await pass(usd.biz.id, T0);
  const after = await runsOf(config.id);
  check(
    "the pass charges once; the grant is active only after payment; a re-run adds nothing",
    after.length === 1 &&
      after[0]!.status === "succeeded" &&
      (await paymentsOf(invs[0]!.id)).length === 1 &&
      (await grantOf(invs[0]!.id))?.status === "active" &&
      (await invoiceRow(invs[0]!.id)).status === "paid",
    after.map((r) => r.status),
  );
  check(
    "credit_auto_topup_succeeded once",
    (await eventsOf("credit_auto_topup_succeeded", config.publicId)).length === 1,
  );
  const g = (await grantOf(invs[0]!.id))!;
  const [view] = await withTenant(orgId, (tx) => grantViews(tx, [g]));
  check(
    "the grant links to its run: source_ref = the run, auto_top_up_run = atur_…",
    g.sourceRef === after[0]!.id &&
      serializeCreditGrant(view!).auto_top_up_run === after[0]!.publicId,
    { ref: g.sourceRef, api: serializeCreditGrant(view!).auto_top_up_run },
  );
}

// ── 2. A decline: attempt booked, invoice voided, config off, never dunned ────────────
console.log("2. decline");
{
  const c = await customerWith(usd.biz.id, "4000000000009995");
  const { config } = await save(usd.biz.id, c.customer.publicId, fixedCfg({ currency: "USD" }));
  await systemDb
    .update(businesses)
    .set({ emailConfig: { enabled: true, types: {} } })
    .where(eq(businesses.id, usd.biz.id));
  await pass(usd.biz.id, T0);
  await systemDb.update(businesses).set({ emailConfig: null }).where(eq(businesses.id, usd.biz.id));
  const [run] = await runsOf(config.id);
  const pays = await paymentsOf(run!.invoiceId!);
  const txns = await systemDb
    .select()
    .from(transactions)
    .where(eq(transactions.invoiceId, run!.invoiceId!));
  const ev = await eventsOf("credit_auto_topup_failed", config.publicId);
  const cfgAfter = await configRow(config.id);
  const failedTxn = txns.find((t) => t.status === "failed");
  const topupLogs = await logsForSpan(failedTxn?.spanId ?? null);
  check(
    "span: the top-up's transaction has its own span, and its gateway call carries it",
    !!failedTxn?.spanId && topupLogs.length >= 1,
    { span: failedTxn?.spanId, logs: topupLogs.length },
  );
  check(
    "the decline books one failed payment and one failed transaction (never stranded)",
    pays.length === 1 && pays[0]!.status === "failed" && txns.some((t) => t.status === "failed"),
    { pays: pays.map((p) => p.status), txns: txns.map((t) => t.status) },
  );
  check(
    "run failed with the code; invoice voided; config disabled (payment_declined)",
    run!.status === "failed" &&
      run!.declineCode === "insufficient_funds" &&
      (await invoiceRow(run!.invoiceId!)).status === "voided" &&
      cfgAfter.status === "disabled" &&
      cfgAfter.disabledReason === "payment_declined",
    { run: run!.status, code: run!.declineCode, cfg: cfgAfter.status },
  );
  check(
    "credit_auto_topup_failed carries the decline code; the pending grant is voided",
    ev.length === 1 &&
      (ev[0]!.data as Record<string, unknown>).decline_code === "insufficient_funds" &&
      (await grantOf(run!.invoiceId!))?.status === "voided",
    ev[0]?.data,
  );
  const mails = await systemDb
    .select({ type: emailMessages.type })
    .from(emailMessages)
    .where(eq(emailMessages.customerId, c.customer.id));
  check(
    "the customer gets only credit_auto_topup_failed: no invoice_issued, no payment_failed",
    mails.length === 1 && mails[0]!.type === "credit_auto_topup_failed",
    mails.map((m) => m.type),
  );
  await pass(usd.biz.id, T0);
  check("a disabled config makes no new run", (await runsOf(config.id)).length === 1);
}
{
  // A purchase invoice in the shape the stranded sweep re-arms is left alone.
  const c = await customerWith(usd.biz.id, "4242424242424242");
  const { config } = await save(usd.biz.id, c.customer.publicId, fixedCfg({ currency: "USD" }));
  await at(usd.biz.id, T0, () => createRunFor(config, T0));
  const [run] = await runsOf(config.id);
  await systemDb
    .update(invoices)
    .set({ dunningStatus: "in_progress", nextAttemptAt: null, status: "payment_due" })
    .where(eq(invoices.id, run!.invoiceId!));
  await at(usd.biz.id, T0, async () => {
    await sweepStrandedRetries(T0);
    await runDunningPass(T0);
  });
  const inv = await invoiceRow(run!.invoiceId!);
  check(
    "sweepStrandedRetries and dunning never re-arm or charge a purchase invoice",
    inv.nextAttemptAt == null && (await paymentsOf(inv.id)).length === 0,
    { next: inv.nextAttemptAt, attempts: inv.attemptCount },
  );
}

// ── 3. A lost answer is pending; a pending payment grants nothing until it settles ─────
console.log("3. indeterminate and pending");
{
  const c = await customerWith(usd.biz.id, "4000000000000127");
  const { config } = await save(usd.biz.id, c.customer.publicId, fixedCfg({ currency: "USD" }));
  await pass(usd.biz.id, T0);
  const [run] = await runsOf(config.id);
  const pays = await paymentsOf(run!.invoiceId!);
  const txns = await systemDb
    .select()
    .from(transactions)
    .where(eq(transactions.invoiceId, run!.invoiceId!));
  check(
    "ProviderIndeterminateError: run pending, payment pending, a timeout transaction, config on",
    run!.status === "pending" &&
      pays.length === 1 &&
      pays[0]!.status === "pending" &&
      txns.some((t) => t.status === "timeout") &&
      (await configRow(config.id)).status === "active",
    { run: run!.status, pays: pays.map((p) => p.status), txns: txns.map((t) => t.status) },
  );
  await pass(usd.biz.id, T0);
  check(
    "a pending run blocks new runs and is never charged again",
    (await runsOf(config.id)).length === 1 && (await paymentsOf(run!.invoiceId!)).length === 1,
  );
}
{
  const c = await customerWith(usd.biz.id, "4000000000000101");
  const { config } = await save(usd.biz.id, c.customer.publicId, fixedCfg({ currency: "USD" }));
  await pass(usd.biz.id, T0);
  const [run] = await runsOf(config.id);
  check(
    "async pending: the run is pending and the grant is not active",
    run!.status === "pending" && (await grantOf(run!.invoiceId!))?.status === "pending",
    run!.status,
  );
  const [pay] = await paymentsOf(run!.invoiceId!);
  await at(usd.biz.id, T0, () =>
    withTenant(orgId, (tx) =>
      settlePaymentSucceeded(tx, {
        organizationId: orgId,
        businessId: usd.biz.id,
        paymentId: pay!.id,
      }),
    ),
  );
  await pass(usd.biz.id, T0);
  const [after] = await runsOf(config.id);
  check(
    "once the payment settles, the grant is active and the run succeeded",
    after!.status === "succeeded" && (await grantOf(run!.invoiceId!))?.status === "active",
    after!.status,
  );
}

// ── 4. Monthly cap and runs per day ───────────────────────────────────────────────
console.log("4. monthly cap, runs per day");
{
  const c = await customerWith(usd.biz.id, "4242424242424242");
  const { config } = await save(
    usd.biz.id,
    c.customer.publicId,
    fixedCfg({ currency: "USD", monthlyCapMinor: 2_000n }),
  );
  await pass(usd.biz.id, T0);
  await hold(usd.biz.id, c.customer.id, "USD", 1_500n);
  await pass(usd.biz.id, T0);
  const runs = await runsOf(config.id);
  check(
    "the monthly cap reduces the second run to what is left (1,500 then 500)",
    runs.length === 2 && runs[0]!.amountMinor === 1_500n && runs[1]!.amountMinor === 500n,
    runs.map((r) => `${r.amountMinor}:${r.status}`),
  );
  await hold(usd.biz.id, c.customer.id, "USD", 500n);
  await pass(usd.biz.id, T0);
  await pass(usd.biz.id, T0);
  const skipped = await eventsOf("credit_auto_topup_skipped", config.publicId);
  check(
    "then it skips: no third run, credit_auto_topup_skipped (monthly_cap) once",
    (await runsOf(config.id)).length === 2 &&
      skipped.length === 1 &&
      (skipped[0]!.data as Record<string, unknown>).reason === "monthly_cap",
    skipped.map((e) => e.data),
  );
}
{
  const c = await customerWith(usd.biz.id, "4242424242424242");
  const { config } = await save(
    usd.biz.id,
    c.customer.publicId,
    fixedCfg({ currency: "USD", maxRunsPerDay: 2 }),
  );
  for (let i = 0; i < 3; i++) {
    await pass(usd.biz.id, T0);
    await hold(usd.biz.id, c.customer.id, "USD", 1_500n);
  }
  await pass(usd.biz.id, T0);
  const skipped = await eventsOf("credit_auto_topup_skipped", config.publicId);
  check(
    "max_runs_per_day 2: two runs, then credit_auto_topup_skipped (daily_limit) once",
    (await runsOf(config.id)).length === 2 &&
      skipped.length === 1 &&
      (skipped[0]!.data as Record<string, unknown>).reason === "daily_limit",
    { runs: (await runsOf(config.id)).length, skipped: skipped.map((e) => e.data) },
  );
}

// ── 5. INR: the lead-time rule, the ₹15,000 clamp, our notice, a gateway notice ─────────
console.log("5. notice rails");
const inr = await newBusiness("ATU INR", "INR");
const noticeAcct = async (lead: string) => {
  const a = await createGatewayAccount({
    organizationId: orgId,
    businessId: inr.biz.id,
    gatewayKey: "tmtest",
    label: `Notice ${lead}`,
    credentials: { pre_debit_lead_hours: lead },
  });
  return (await systemDb.select().from(gatewayAccounts).where(eq(gatewayAccounts.id, a.id)))[0]!;
};
const inrCfg = (o: Partial<AutoTopupInput> = {}) =>
  fixedCfg({ currency: "INR", thresholdMinor: 30_000n, amountMinor: 50_000n, ...o });
// 24,000 a day over 48 h of usage.
setBurnReader(async () => ({ burnMinorPerDay: 24_000n, usageHours: 48 }));
{
  const c = await customerWith(inr.biz.id, "4242424242424242", inr.plain.publicId);
  await asUpiMandate(c.pm.id, inr.plain.id);
  const low = await refusal(inr.biz.id, c.customer.publicId, inrCfg({ thresholdMinor: 10_000n }));
  check(
    "own notice (26 h): a threshold below 26 h of burn is refused with the lead and the amount",
    low.includes("up to 26 hours") && low.includes("₹260.00"),
    low,
  );
  check(
    "a threshold that covers the lead saves",
    (await refusal(inr.biz.id, c.customer.publicId, inrCfg({ thresholdMinor: 26_000n }))) === "",
  );
  check(
    "a schedule config is exempt",
    (await refusal(
      inr.biz.id,
      c.customer.publicId,
      inrCfg({ trigger: "schedule", thresholdMinor: null, schedule: { every: "month", day: 1 } }),
    )) === "",
  );
  const p72 = await noticeAcct("72");
  await asUpiMandate(c.pm.id, p72.id);
  const low72 = await refusal(inr.biz.id, c.customer.publicId, inrCfg({ thresholdMinor: 30_000n }));
  check(
    "a gateway notice uses the adapter's lead (72 h): 30,000 < 72,000 is refused",
    low72.includes("up to 72 hours") && low72.includes("₹720.00"),
    low72,
  );
}
{
  // Weekly re-check: burn grows past the cover; warn once a week, never change the config.
  const c = await customerWith(inr.biz.id, "4242424242424242", inr.plain.publicId);
  await asUpiMandate(c.pm.id, inr.plain.id);
  const { config } = await save(
    inr.biz.id,
    c.customer.publicId,
    inrCfg({ thresholdMinor: 30_000n }),
  );
  setBurnReader(async () => ({ burnMinorPerDay: 48_000n, usageHours: 48 }));
  await at(inr.biz.id, T0, () => recheckAutoTopupThresholds(T0));
  await at(inr.biz.id, T0, () => recheckAutoTopupThresholds(new Date(T0.getTime() + H)));
  const low = await eventsOf("credit_auto_topup_threshold_low", config.publicId);
  const row = await configRow(config.id);
  check(
    "credit_auto_topup_threshold_low once a week, with the required threshold; config unchanged",
    low.length === 1 &&
      (low[0]!.data as { credit_auto_topup?: { required_minor?: number } }).credit_auto_topup
        ?.required_minor === 52_000 &&
      row.thresholdMinor === 30_000n &&
      row.status === "active",
    low.map((e) => e.data),
  );
  setBurnReader(async () => null);
}
{
  const c = await customerWith(inr.biz.id, "4242424242424242", inr.plain.publicId);
  await asUpiMandate(c.pm.id, inr.plain.id);
  const big = await refusal(inr.biz.id, c.customer.publicId, inrCfg({ amountMinor: 2_000_000n }));
  check(
    "a fixed amount above ₹15,000 on a UPI mandate is refused at save",
    big.includes("₹15,000"),
    big,
  );
  const { config } = await save(
    inr.biz.id,
    c.customer.publicId,
    inrCfg({ thresholdMinor: 1_000_000n, amountMinor: 1_000_000n, monthlyCapMinor: 10_000_000n }),
  );
  await at(inr.biz.id, T0, () => createRunFor(config, T0));
  const [run] = await runsOf(config.id);
  check(
    "a UPI mandate run (2 × ₹10,000) is clamped to ₹15,000",
    run?.amountMinor === 1_500_000n,
    run?.amountMinor,
  );
}
{
  // Our own notice: a mandate on a gateway with no notice API.
  const c = await customerWith(inr.biz.id, "4242424242424242", inr.plain.publicId);
  await asUpiMandate(c.pm.id, inr.plain.id);
  const { config } = await save(inr.biz.id, c.customer.publicId, inrCfg());
  await pass(inr.biz.id, T0);
  const [run] = await runsOf(config.id);
  const sched = await eventsOf("credit_auto_topup_scheduled", config.publicId);
  check(
    "own notice: notice_sent, credit_auto_topup_scheduled (ours) with the mandate, nothing charged",
    run!.status === "notice_sent" &&
      run!.chargeAfter?.getTime() === T0.getTime() + 24 * H + 10 * 60_000 &&
      sched.length === 1 &&
      (sched[0]!.data as Record<string, unknown>).notice_by === "ours" &&
      (sched[0]!.data as Record<string, unknown>).mandate_reference === "UMN-TEST-0001" &&
      (await paymentsOf(run!.invoiceId!)).length === 0,
    { run: run!.status, at: run!.chargeAfter },
  );
  await pass(inr.biz.id, new Date(T0.getTime() + 23 * H));
  check("23 h later: still not charged", (await paymentsOf(run!.invoiceId!)).length === 0);
  await pass(inr.biz.id, new Date(T0.getTime() + 24 * H + 11 * 60_000));
  const [after] = await runsOf(config.id);
  check(
    "after 24 h + margin: charged once, succeeded",
    after!.status === "succeeded" && (await paymentsOf(run!.invoiceId!)).length === 1,
    after!.status,
  );
}
{
  // A gateway notice: gated on the STORED executable_after.
  const n24 = await noticeAcct("24");
  const c = await customerWith(inr.biz.id, "4242424242424242");
  await asUpiMandate(c.pm.id, n24.id);
  const { config } = await save(inr.biz.id, c.customer.publicId, inrCfg());
  await pass(inr.biz.id, T0);
  const [run] = await runsOf(config.id);
  const [notice] = await systemDb
    .select()
    .from(preDebitNotices)
    .where(eq(preDebitNotices.paymentMethodId, c.pm.id))
    .orderBy(desc(preDebitNotices.createdAt));
  check(
    "gateway notice: credit_topup purpose, run notice_sent, nothing charged",
    notice?.purpose === "credit_topup" &&
      run!.status === "notice_sent" &&
      run!.noticeId === notice?.id &&
      (await paymentsOf(run!.invoiceId!)).length === 0,
    { purpose: notice?.purpose, run: run!.status },
  );
  // The gateway pushed the debit later than our derived lead: the stored value rules.
  await systemDb
    .update(preDebitNotices)
    .set({ executableAfter: new Date(T0.getTime() + 30 * H) })
    .where(eq(preDebitNotices.id, notice!.id));
  await pass(inr.biz.id, new Date(T0.getTime() + 26 * H));
  check(
    "26 h later, before the stored executable_after (30 h): not charged",
    (await paymentsOf(run!.invoiceId!)).length === 0,
  );
  await pass(inr.biz.id, new Date(T0.getTime() + 31 * H));
  const [after] = await runsOf(config.id);
  check(
    "after executable_after: charged once with the notice, succeeded",
    after!.status === "succeeded" && (await paymentsOf(run!.invoiceId!)).length === 1,
    after!.status,
  );
}

// ── A USD top-up never picks an INR mandate first ───────────────────────────────────
console.log("a USD top-up skips an INR mandate");
{
  const usd2 = await newBusiness("ATU USD mandate", "USD");
  // The primary method is an INR UPI mandate; a card that can take USD is the backup.
  const c = await customerWith(usd2.biz.id, "4242424242424242");
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({
        type: "upi",
        mandateRail: "upi",
        mandateReference: "UMN-TEST-0002",
        mandateStatus: "confirmed",
        mandateCurrency: "INR",
      })
      .where(eq(paymentMethods.id, c.pm.id)),
  );
  const card = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: usd2.biz.id,
    customer: c.customer,
    token: "4242424242424242",
  });
  const { config } = await save(usd2.biz.id, c.customer.publicId, fixedCfg({ currency: "USD" }));
  await pass(usd2.biz.id, T0);
  const [run] = await runsOf(config.id);
  const pays = run?.invoiceId ? await paymentsOf(run.invoiceId) : [];
  check(
    "a USD top-up charges the card at once: no notice for the INR mandate, which is never charged",
    run?.status === "succeeded" &&
      pays.length === 1 &&
      pays[0]!.paymentMethodId === card.id &&
      !pays.some((p) => p.paymentMethodId === c.pm.id),
    { run: run?.status, pays: pays.map((p) => p.paymentMethodId === card.id) },
  );
}

await closeDb();
if (fails.length) {
  console.log(`\n❌ AUTO-TOPUP: FAIL (${fails.length})`);
  process.exit(1);
}
console.log("\n✅ AUTO-TOPUP: PASS");
process.exit(0);
