/**
 * Gateway-sent pre-debit notices (`capabilities.preDebitNotice`), end to end on tmtest
 * (`pre_debit_*` credentials): the collection gate defers a debit until its notice period
 * ends, the reminders pass sends the notice ahead of the renewal and skips our own email,
 * a late gateway answer arrives by signed webhook, a paid wallet top-up waits on its own
 * notice without touching the invoice's, and tmtest refuses any covered debit
 * that does not name a valid notice, which proves the engine passes it.
 *
 * Each scenario has its own time-travelled business, and every pass runs inside
 * `runWithClockScope({ onlyBusinessId })`, so the dev worker cannot race the suite.
 *
 *   pnpm verify:pre-debit-notices
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { renewSubscription } from "@/modules/subscriptions/renewal";
import { runRemindersPass } from "@/modules/subscriptions/reminders";
import { runDunningPass } from "@/modules/subscriptions/dunning";
import { runInvoiceDueTransitions } from "@/modules/invoicing/due";
import { addPromotionalCredits } from "@/modules/customers/balances";
import { collectInvoiceNow, InvoiceOpsError } from "@/modules/invoicing/ops";
import {
  commitSubscriptionPeriodInvoice,
  createInvoiceFromLines,
  planSubscriptionPeriodInvoice,
} from "@/modules/invoicing/service";
import { chargeBeforeSubscriptionInvoice } from "@/modules/invoicing/collection";
import {
  applyGatewayNoticeUpdate,
  PAYMENT_PURPOSE_KEY,
  preDebitGate,
  sendGatewayNotice,
  type PreDebitPurpose,
} from "@/modules/invoicing/pre-debit";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { publicId as newPublicId } from "@/platform/ids";
import { createGatewayAccount, updateGatewayAccount } from "@/modules/gateway/service";
import { recheckPausedMandates } from "@/modules/payment-methods/paused-mandates";
import { ingestGatewayWebhook } from "@/modules/gateway/inbound";
import { startTimeTravel } from "@/modules/time-travel/service";
import { topUpWallet, WalletError } from "@/modules/wallet/service";
import { resolveAdapter } from "@/providers/registry";
import { TmtestProvider } from "@/providers/tmtest";
import { advanceTmtest } from "@/providers/tmtest/webhooks";
import { signTmtest } from "@/providers/tmtest/signing";
import {
  events,
  gatewayAccounts,
  invoices,
  paymentMethods,
  payments,
  preDebitNotices,
  providerEvents,
  subscriptions,
  timeTravels,
  tmtestCharges,
  walletTopups,
} from "@db/schema";

const checks: Array<[string, boolean, string?]> = [];
const ok = (name: string, cond: boolean, detail?: unknown) => {
  checks.push([name, cond, detail === undefined ? undefined : String(detail)]);
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail !== undefined ? ` — ${detail}` : ""}`);
};

const M = 60_000;
const H = 60 * M;
const LEAD = 24;
/** `LEAD_MARGIN_MS` in the gate: a deferred debit waits this long past the lead. */
const MARGIN = 10 * M;
const T0 = new Date();
const AMOUNT = 50_000n;
const GOOD = "4242424242424242";
const INSUFFICIENT = "4000000000009995";

const org = await createOrganization({ name: "Pre-debit notices" });
const orgId = org.organization.id;

type Pm = typeof paymentMethods.$inferSelect;
type Acct = typeof gatewayAccounts.$inferSelect;

/** Run `fn` as business time `t`: the time-travel row and the clock scope agree. */
async function at<T>(bizId: string, t: Date, fn: () => Promise<T>): Promise<T> {
  await systemDb
    .update(timeTravels)
    .set({ simulatedNow: t })
    .where(eq(timeTravels.businessId, bizId));
  return runWithClockScope({ onlyBusinessId: bizId, now: t }, fn);
}

/** The two passes that collect a due invoice: `posted` (due pass) and `payment_due` (dunning). */
async function collectPasses(bizId: string, t: Date) {
  await at(bizId, t, async () => {
    await runInvoiceDueTransitions(t);
    await runDunningPass(t);
  });
}

async function accountRow(id: string): Promise<Acct> {
  const [a] = await systemDb.select().from(gatewayAccounts).where(eq(gatewayAccounts.id, id));
  return a!;
}

async function noticeAccount(bizId: string, credentials: Record<string, string>): Promise<Acct> {
  const a = await createGatewayAccount({
    organizationId: orgId,
    businessId: bizId,
    gatewayKey: "tmtest",
    label: `Notice ${Object.values(credentials).join(" ")}`,
    credentials,
  });
  return accountRow(a.id);
}

async function setPm(pmId: string, set: Partial<typeof paymentMethods.$inferInsert>) {
  await withTenant(orgId, (tx) =>
    tx.update(paymentMethods).set(set).where(eq(paymentMethods.id, pmId)),
  );
}

/** A UPI mandate instrument vaulted through `acct`. */
async function mandatePm(
  bizId: string,
  customer: Awaited<ReturnType<typeof createCustomer>>,
  acct: Acct,
  token = GOOD,
): Promise<Pm> {
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: bizId,
    customer,
    token,
    gatewayAccountId: acct.publicId,
  });
  await setPm(pm.id, {
    type: "upi",
    mandateRail: "upi",
    mandateReference: "UMN-TEST-0001",
    mandateStatus: "confirmed",
  });
  return (await pmRow(pm.id))!;
}

async function pmRow(id: string): Promise<Pm | undefined> {
  const [r] = await withTenant(orgId, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.id, id)),
  );
  return r;
}

/** Point an instrument at a different test card, keeping its row. */
async function swapCard(bizId: string, pm: Pm, token: string) {
  const ref = await new TmtestProvider(bizId).vaultPaymentMethod({
    customer: { providerKey: "tmtest", providerCustomerId: pm.providerCustomerId },
    token,
  });
  await setPm(pm.id, { providerPaymentMethodId: ref.providerPaymentMethodId });
}

/**
 * A time-travelled test business with a plain tmtest account and a notice account,
 * one customer, and a monthly INR subscription on a UPI mandate. The first invoice is
 * paid through the plain account; the instrument then moves to the notice account
 * unless `keepPlain`.
 */
async function scenario(
  name: string,
  creds: Record<string, string>,
  opts: { keepPlain?: boolean } = {},
) {
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "INR",
    livemode: "test",
  });
  await startTimeTravel({ orgId, bizId: biz.id, genesisTime: T0 });
  const [plain] = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(eq(gatewayAccounts.businessId, biz.id));
  const notice = await noticeAccount(biz.id, creds);
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "INR",
    amountMinor: Number(AMOUNT),
    interval: "month",
  });
  const addSub = async (label: string, acct: Acct = notice) => {
    const customer = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: `${name}-${label}@example.com`,
    });
    const pm = await mandatePm(biz.id, customer, plain!);
    const created = await at(biz.id, T0, () =>
      createSubscription({
        organizationId: orgId,
        businessId: biz.id,
        customerId: customer.id,
        now: T0,
        items: [{ price, quantity: 1 }],
        defaultPaymentMethodId: pm.id,
      }),
    );
    if (acct.id !== plain!.id) await setPm(pm.id, { gatewayAccountId: acct.id });
    return {
      customer,
      pm: (await pmRow(pm.id))!,
      sub: created.subscription,
      E: created.subscription.currentPeriodEnd!,
    };
  };
  const first = await addSub("main", opts.keepPlain ? plain! : notice);
  return { biz, plain: plain!, notice, price, addSub, ...first };
}

async function latestInvoice(subId: string) {
  const [r] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, subId))
      .orderBy(desc(invoices.createdAt))
      .limit(1),
  );
  return r!;
}
async function invoiceRow(id: string) {
  const [r] = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, id)),
  );
  return r!;
}
async function paymentsFor(invoiceId: string) {
  return withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, invoiceId)).orderBy(payments.createdAt),
  );
}
async function noticesFor(pmId: string) {
  return withTenant(orgId, (tx) =>
    tx
      .select()
      .from(preDebitNotices)
      .where(eq(preDebitNotices.paymentMethodId, pmId))
      .orderBy(preDebitNotices.createdAt),
  );
}
async function gatewayNotice(ref: string | null) {
  if (!ref) return null;
  const [r] = await systemDb.select().from(tmtestCharges).where(eq(tmtestCharges.chargeId, ref));
  return r
    ? { ...r, state: (r.checkoutParams ?? {}) as { debits?: number; lastChargeKey?: string } }
    : null;
}
async function eventCount(bizId: string, type: string) {
  const [r] = await withTenant(orgId, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(events)
      .where(and(eq(events.businessId, bizId), eq(events.type, type))),
  );
  return r!.n;
}
const same = (a: Date | null | undefined, b: Date) => !!a && a.getTime() === b.getTime();
const attemptKey = (invPublicId: string, n: number, pm: Pm) =>
  `inv_${invPublicId}_attempt_${n}_${pm.publicId}`;

// ── Capability: credentials switch it on; an account without them is unchanged ─────────
{
  const s = await scenario("cap", { pre_debit_lead_hours: "24" }, { keepPlain: true });
  const cap = resolveAdapter(s.notice).capabilities.preDebitNotice;
  ok(
    "capability: pre_debit_lead_hours declares preDebitNotice on card+upi, exact amount, 4 debits",
    JSON.stringify(cap) ===
      JSON.stringify({
        methods: ["card", "upi"],
        minLeadHours: 24,
        maxDebitsPerNotice: 4,
        exactAmount: true,
      }),
    JSON.stringify(cap),
  );
  const plainAdapter = resolveAdapter(s.plain);
  ok(
    "capability: an account without the credentials declares nothing and has no notify method",
    !plainAdapter.capabilities.preDebitNotice &&
      !plainAdapter.notifyUpcomingDebit &&
      !plainAdapter.capabilities.gatewayNotifiesPayer,
  );
  const gate = await at(s.biz.id, T0, () =>
    preDebitGate({
      organizationId: orgId,
      businessId: s.biz.id,
      adapter: plainAdapter,
      account: s.plain,
      pm: s.pm,
      amountMinor: AMOUNT,
      currency: "INR",
      contact: null,
      purpose: "invoice",
    }),
  );
  ok(
    "(j) gate: a gateway without the capability answers not_required",
    gate.kind === "not_required",
  );
}

// ── (a) Renewal with no notice: deferred, nothing booked; collected after the lead ──────
{
  const s = await scenario("a-defer", { pre_debit_lead_hours: "24" });
  const failedBefore = await eventCount(s.biz.id, "payment_failed");
  await at(s.biz.id, s.E, () => renewSubscription(orgId, s.sub.id, s.E));
  const inv = await latestInvoice(s.sub.id);
  const [n] = await noticesFor(s.pm.id);
  ok(
    "(a) renewal raised the invoice and left it due, dunning not started",
    inv.status === "payment_due" && inv.dunningStatus == null,
    `${inv.status} ${inv.dunningStatus}`,
  );
  ok("(a) no payments row: a deferral books nothing", (await paymentsFor(inv.id)).length === 0);
  ok(
    "(a) attempt_count unchanged: no dunning slot spent",
    inv.attemptCount === 0,
    inv.attemptCount,
  );
  ok(
    "(a) no payment_failed event, so no failure email",
    (await eventCount(s.biz.id, "payment_failed")) === failedBefore,
  );
  ok(
    "(a) one notice sent through the gateway, for the invoice amount",
    n?.status === "sent" && n.amountMinor === inv.totalMinor && n.invoiceId === inv.id,
    `${n?.status} ${n?.amountMinor}`,
  );
  ok(
    "(a) executable_after = sent + minLeadHours (business time)",
    same(n?.executableAfter, new Date(s.E.getTime() + LEAD * H)),
    n?.executableAfter?.toISOString(),
  );
  const until = new Date(s.E.getTime() + LEAD * H + MARGIN);
  ok("(a) next_attempt_at = the notice's executable time + margin", same(inv.nextAttemptAt, until));

  await collectPasses(s.biz.id, new Date(s.E.getTime() + 23 * H));
  ok(
    "(a) before the notice period ends the clock does not charge",
    (await paymentsFor(inv.id)).length === 0,
  );
  await collectPasses(s.biz.id, new Date(until.getTime() + M));
  const paid = await invoiceRow(inv.id);
  const pays = await paymentsFor(inv.id);
  ok(
    "(a) after it, the dunning pass collects",
    paid.status === "paid" && pays.length === 1 && pays[0]!.status === "succeeded",
    `${paid.status} ${pays.map((p) => p.status)}`,
  );
  const [used] = await noticesFor(s.pm.id);
  ok("(a) the debit is counted on the notice", used?.debitsUsed === 1, used?.debitsUsed);
  const g = await gatewayNotice(n?.notificationRef ?? null);
  ok(
    "(a) tmtest saw the notice ref on that charge",
    g?.state.debits === 1 && g.state.lastChargeKey === attemptKey(inv.publicId, 1, s.pm),
    JSON.stringify(g?.state),
  );
}

// ── (b) Reminders send the gateway notice ahead; our email only where we owe it ─────────
{
  const s = await scenario("b-remind", { pre_debit_lead_hours: "24" });
  const plainSub = await s.addSub("plain", s.plain);
  const notifies = await noticeAccount(s.biz.id, { gateway_notifies_payer: "upi" });
  const selfSub = await s.addSub("self", notifies);
  const tick = (t: Date) => at(s.biz.id, t, () => runRemindersPass(t));
  const emails = async (subPublicId: string) => {
    const rows = await withTenant(orgId, (tx) =>
      tx
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.type, "subscription_pre_debit_notification"),
            eq(events.resourceId, subPublicId),
          ),
        ),
    );
    return rows.length;
  };

  const r1 = await tick(new Date(s.E.getTime() - 30 * H));
  ok(
    "(b) at T-30h: the plain mandate gets our email; no gateway notice yet (lead 24h + 2h)",
    r1.preDebit === 1 && r1.gatewayPreDebit === 0,
    JSON.stringify(r1),
  );
  const r2 = await tick(new Date(s.E.getTime() - 25 * H));
  const [n] = await noticesFor(s.pm.id);
  ok("(b) at T-25h: the gateway notice goes out", r2.gatewayPreDebit === 1, JSON.stringify(r2));
  ok(
    "(b) the notice names the renewal date and the estimated amount",
    same(n?.debitAt, s.E) && n?.amountMinor === AMOUNT && n.status === "sent",
    `${n?.debitAt?.toISOString()} ${n?.amountMinor} ${n?.status}`,
  );
  ok(
    "(b) its executable time is before the renewal",
    same(n?.executableAfter, new Date(s.E.getTime() - H)),
  );
  const r3 = await tick(new Date(s.E.getTime() - 24 * H));
  ok(
    "(b) a later tick sends no second notice",
    r3.gatewayPreDebit === 0 && (await noticesFor(s.pm.id)).length === 1,
  );
  ok("(b) our email is NOT sent on the notice rail", (await emails(s.sub.publicId)) === 0);
  ok(
    "(b) nor where the gateway notifies the payer itself",
    (await emails(selfSub.sub.publicId)) === 0 && (await noticesFor(selfSub.pm.id)).length === 0,
  );
  ok(
    "(b) the plain mandate rail gets exactly one email",
    (await emails(plainSub.sub.publicId)) === 1,
  );

  await at(s.biz.id, s.E, () => renewSubscription(orgId, s.sub.id, s.E));
  const inv = await latestInvoice(s.sub.id);
  const pays = await paymentsFor(inv.id);
  ok(
    "(b) the renewal collects at once under the proactive notice",
    inv.status === "paid" && pays.length === 1 && pays[0]!.status === "succeeded",
    `${inv.status} ${inv.nextAttemptAt?.toISOString()}`,
  );
  const g = await gatewayNotice(n?.notificationRef ?? null);
  ok(
    "(b) tmtest saw the proactive notice on the renewal charge",
    g?.state.debits === 1 && g.state.lastChargeKey === attemptKey(inv.publicId, 1, s.pm),
    JSON.stringify(g?.state),
  );

  // (j) The plain mandate and the gateway-notifies rail renew exactly as before.
  for (const [label, x] of [
    ["plain", plainSub],
    ["gateway-notifies", selfSub],
  ] as const) {
    await at(s.biz.id, x.E, () => renewSubscription(orgId, x.sub.id, x.E));
    const i = await latestInvoice(x.sub.id);
    ok(
      `(j) ${label}: renewal collects at once, no notice row`,
      i.status === "paid" && (await noticesFor(x.pm.id)).length === 0,
      i.status,
    );
  }
}

// ── (t) Exact-amount rail + scheduled downgrade: the notice states the expected amount ──
// The collection gate re-notifies an exact-amount rail when the amount differs, so the
// proactive notice uses the post-change amount, and the renewal is not deferred.
{
  const { scheduleChange, applyDueScheduledChanges } =
    await import("@/modules/subscriptions/scheduled-changes");
  const { subscriptionItems } = await import("@db/schema");
  const s = await scenario("t-downgrade", { pre_debit_lead_hours: "24" });
  const lite = await createPrice({
    organizationId: orgId,
    businessId: s.biz.id,
    productId: s.price.productId,
    type: "recurring",
    model: "flat",
    currency: "INR",
    amountMinor: Number(AMOUNT / 2n),
    interval: "month",
  });
  const [item] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, s.sub.id)),
  );
  await scheduleChange({
    organizationId: orgId,
    businessId: s.biz.id,
    subscriptionId: s.sub.id,
    type: "change",
    effectiveAt: s.E,
    changes: [{ itemId: item!.publicId, newPriceId: lite.publicId }],
  });
  const t = new Date(s.E.getTime() - 25 * H);
  await at(s.biz.id, t, () => runRemindersPass(t));
  const [n] = await noticesFor(s.pm.id);
  ok(
    "(t) exact-amount rail: the proactive notice states the post-change amount",
    n?.amountMinor === AMOUNT / 2n,
    `${n?.amountMinor}`,
  );
  await at(s.biz.id, s.E, () => applyDueScheduledChanges(s.E));
  await at(s.biz.id, s.E, () => renewSubscription(orgId, s.sub.id, s.E));
  const inv = await latestInvoice(s.sub.id);
  ok(
    "(t) the renewal collects at once under that notice, not deferred",
    inv.status === "paid" && Number(inv.totalMinor) === Number(AMOUNT / 2n),
    `${inv.status} ${inv.totalMinor} ${inv.nextAttemptAt?.toISOString()}`,
  );
}

// ── (c) The amount due changes after the proactive notice: replaced, debit deferred ─────
{
  const s = await scenario("c-amount", { pre_debit_lead_hours: "24" });
  const t = new Date(s.E.getTime() - 25 * H);
  await at(s.biz.id, t, () => runRemindersPass(t));
  // Credit granted after the notice: the renewal now debits less than was notified.
  await addPromotionalCredits({
    organizationId: orgId,
    businessId: s.biz.id,
    customer: s.customer,
    amountMinor: 10_000,
    currency: "INR",
  });
  await at(s.biz.id, s.E, () => renewSubscription(orgId, s.sub.id, s.E));
  const inv = await latestInvoice(s.sub.id);
  const [old, fresh] = await noticesFor(s.pm.id);
  const due = AMOUNT - 10_000n;
  ok(
    "(c) the renewal is the full price, the credit lowers what is due",
    inv.totalMinor === AMOUNT,
    inv.totalMinor,
  );
  ok("(c) the old notice is superseded", old?.status === "superseded", old?.status);
  ok(
    "(c) a new notice is sent for the amount now due",
    fresh?.status === "sent" && fresh.amountMinor === due,
    `${fresh?.status} ${fresh?.amountMinor}`,
  );
  ok(
    "(c) the debit is deferred to the new notice, nothing booked",
    (await paymentsFor(inv.id)).length === 0 &&
      same(inv.nextAttemptAt, new Date(s.E.getTime() + LEAD * H + MARGIN)),
    inv.nextAttemptAt?.toISOString(),
  );
}

// ── (d) The gateway refuses the notice: a retriable failure on the ordinary dunning path ─
{
  const s = await scenario("d-refused", { pre_debit_lead_hours: "24", pre_debit_fault: "fail" });
  const failedBefore = await eventCount(s.biz.id, "payment_failed");
  await at(s.biz.id, s.E, () => renewSubscription(orgId, s.sub.id, s.E));
  const inv = await latestInvoice(s.sub.id);
  const pays = await paymentsFor(inv.id);
  ok(
    "(d) a failed payment with code pre_debit_notice_failed",
    pays.length === 1 &&
      pays[0]!.status === "failed" &&
      pays[0]!.failureCode === "pre_debit_notice_failed",
    pays.map((p) => `${p.status}/${p.failureCode}`).join(","),
  );
  ok(
    "(d) retriable: the invoice is in dunning with a next attempt, one slot spent",
    inv.status === "payment_due" &&
      inv.attemptCount === 1 &&
      !!inv.nextAttemptAt &&
      inv.nextAttemptAt > s.E,
    `${inv.status} ${inv.attemptCount} ${inv.nextAttemptAt?.toISOString()}`,
  );
  ok(
    "(d) the payer is told (payment_failed event)",
    (await eventCount(s.biz.id, "payment_failed")) === failedBefore + 1,
  );
  const [n] = await noticesFor(s.pm.id);
  ok(
    "(d) the notice row records the refusal",
    n?.status === "failed" && !!n.failureCode,
    n?.status,
  );
  ok(
    "(d) no charge reached tmtest for the refused debit",
    (
      await systemDb
        .select()
        .from(tmtestCharges)
        .where(and(eq(tmtestCharges.businessId, s.biz.id), eq(tmtestCharges.kind, "charge")))
    ).every((c) => c.amountMinor !== inv.totalMinor || c.createdAt < s.E),
  );
}

// ── (d2) The gateway refuses the notice because the mandate is gone: final, not retried ──
{
  const s = await scenario("d2-dead", { pre_debit_lead_hours: "24", pre_debit_fault: "dead" });
  await at(s.biz.id, s.E, () => renewSubscription(orgId, s.sub.id, s.E));
  const inv = await latestInvoice(s.sub.id);
  const pays = await paymentsFor(inv.id);
  ok(
    "(d2) a notice refused as a dead mandate is booked with the gateway's class",
    pays.length === 1 && pays[0]!.status === "failed" && pays[0]!.failureCode === "mandate_expired",
    pays.map((p) => `${p.status}/${p.failureCode}`).join(","),
  );
  const pm = await pmRow(s.pm.id);
  ok(
    "(d2) the payment method is taken out of collection (update-payment-method path)",
    pm?.status === "invalid",
    `${pm?.status} ${pm?.mandateStatus}`,
  );
  const sent = (await noticesFor(s.pm.id)).length;
  await collectPasses(s.biz.id, new Date(s.E.getTime() + 3 * 24 * H));
  ok(
    "(d2) no further notice is sent to the dead mandate",
    (await noticesFor(s.pm.id)).length === sent,
    `${sent} → ${(await noticesFor(s.pm.id)).length}`,
  );
}

// ── (d3) The reminders pass's notice is refused as dead: the renewal sends no second one ─
{
  const s = await scenario("d3-dead-early", {
    pre_debit_lead_hours: "24",
    pre_debit_fault: "dead",
  });
  const t = new Date(s.E.getTime() - 25 * H);
  await at(s.biz.id, t, () => runRemindersPass(t));
  const early = (await noticesFor(s.pm.id)).length;
  await at(s.biz.id, s.E, () => renewSubscription(orgId, s.sub.id, s.E));
  const inv = await latestInvoice(s.sub.id);
  const pays = await paymentsFor(inv.id);
  ok(
    "(d3) the renewal reuses the refused notice's verdict: no second notice, a dead-mandate decline",
    early === 1 &&
      (await noticesFor(s.pm.id)).length === 1 &&
      pays.length === 1 &&
      pays[0]!.failureCode === "mandate_expired" &&
      (await pmRow(s.pm.id))?.status === "invalid",
    `${early} → ${(await noticesFor(s.pm.id)).length} ${pays.map((p) => p.failureCode).join(",")}`,
  );
}

// ── (d4) Refused in "dead" words, but the mandate is only PAUSED: parked, then revived ───
{
  const s = await scenario("d4-paused", { pre_debit_lead_hours: "24", pre_debit_fault: "paused" });
  await at(s.biz.id, s.E, () => renewSubscription(orgId, s.sub.id, s.E));
  const inv = await latestInvoice(s.sub.id);
  const pays = await paymentsFor(inv.id);
  const pm = await pmRow(s.pm.id);
  ok(
    "(d4) a paused mandate is parked: retriable, the instrument paused (not dead)",
    pays.length === 1 &&
      pays[0]!.failureCode === "mandate_paused" &&
      pm?.mandateStatus === "paused",
    `${pays.map((p) => p.failureCode).join(",")} ${pm?.status}/${pm?.mandateStatus}`,
  );
  // The payer resumes it at the bank; the paused-mandate sweep reads it again.
  const before = (await noticesFor(s.pm.id)).length;
  await updateGatewayAccount({
    organizationId: orgId,
    businessId: s.biz.id,
    gwaPublicId: s.notice.publicId,
    credentials: { pre_debit_lead_hours: "24" },
  });
  await at(s.biz.id, new Date(s.E.getTime() + H), () => recheckPausedMandates());
  const revived = await pmRow(s.pm.id);
  await collectPasses(s.biz.id, new Date(s.E.getTime() + 2 * 24 * H));
  const after = await noticesFor(s.pm.id);
  ok(
    "(d4) once resumed the verdict clears: a new notice is sent to the same instrument",
    revived?.status === "valid" &&
      revived.mandateStatus === "confirmed" &&
      after.length === before + 1 &&
      after.at(-1)!.status === "sent",
    `${revived?.status}/${revived?.mandateStatus} notices ${before} → ${after.map((n) => n.status).join(",")}`,
  );
}

// ── (d5) An open notice cycle at the gateway (PayU UPI E9254): wait, book nothing; parks ─
{
  const s = await scenario("d5-cycle", {
    pre_debit_lead_hours: "24",
    pre_debit_fault: "cycle_open",
  });
  await at(s.biz.id, s.E, () => renewSubscription(orgId, s.sub.id, s.E));
  const inv = await latestInvoice(s.sub.id);
  const first = await paymentsFor(inv.id);
  const n1 = await noticesFor(s.pm.id);
  ok(
    "(d5) a notice refused as an open cycle books no attempt: the debit waits",
    first.length === 0 && n1.at(-1)?.failureCode === "pre_debit_cycle_open",
    `payments ${first.length} notices ${n1.map((n) => n.failureCode).join(",")}`,
  );
  for (let i = 1; i <= 10; i++) await collectPasses(s.biz.id, new Date(s.E.getTime() + i * 7 * H));
  const later = await paymentsFor(inv.id);
  const pm = await pmRow(s.pm.id);
  ok(
    "(d5) still refused after 8 notices: one attempt, parked as ours (gateway_request_rejected); the instrument stays valid",
    later.length === 1 &&
      later[0]!.failureCode === "gateway_request_rejected" &&
      pm?.status === "valid",
    `${later.map((p) => p.failureCode).join(",")} pm ${pm?.status} notices ${(await noticesFor(s.pm.id)).length}`,
  );
}

// ── (e) Declines use up the notice: the next retry sends a new one and waits ────────────
{
  const s = await scenario("e-exhaust", { pre_debit_lead_hours: "24", pre_debit_max_debits: "2" });
  await swapCard(s.biz.id, s.pm, INSUFFICIENT);
  await at(s.biz.id, s.E, () => renewSubscription(orgId, s.sub.id, s.E));
  let inv = await latestInvoice(s.sub.id);
  const t1 = new Date(inv.nextAttemptAt!.getTime() + M);
  await collectPasses(s.biz.id, t1);
  inv = await invoiceRow(inv.id);
  ok(
    "(e) debit 1 under the notice declines into dunning",
    inv.status === "payment_due" && inv.attemptCount === 1,
    `${inv.status} ${inv.attemptCount}`,
  );
  const t2 = inv.nextAttemptAt!;
  await collectPasses(s.biz.id, t2);
  inv = await invoiceRow(inv.id);
  const [n1] = await noticesFor(s.pm.id);
  ok(
    "(e) debit 2 declines and exhausts the notice (max 2)",
    inv.attemptCount === 2 && n1?.debitsUsed === 2 && n1.status === "exhausted",
    `${inv.attemptCount} ${n1?.debitsUsed} ${n1?.status}`,
  );
  const t3 = inv.nextAttemptAt!;
  await collectPasses(s.biz.id, t3);
  inv = await invoiceRow(inv.id);
  const ns = await noticesFor(s.pm.id);
  ok(
    "(e) the next retry sends a new notice instead of a third debit",
    ns.length === 2 && ns[1]!.status === "sent",
    ns.map((n) => n.status).join(","),
  );
  ok(
    "(e) …and defers: no third payment, no slot spent",
    (await paymentsFor(inv.id)).length === 2 &&
      inv.attemptCount === 2 &&
      same(inv.nextAttemptAt, new Date(t3.getTime() + LEAD * H + MARGIN)),
    `${inv.attemptCount} ${inv.nextAttemptAt?.toISOString()}`,
  );
  const g = await gatewayNotice(n1?.notificationRef ?? null);
  ok(
    "(e) tmtest counted exactly 2 debits on the first notice",
    g?.state.debits === 2,
    g?.state.debits,
  );
}

// ── (f) Async answer: pending → signed webhook → sent → collected ───────────────────────
{
  const s = await scenario("f-async", { pre_debit_lead_hours: "24", pre_debit_mode: "async" });
  await at(s.biz.id, s.E, () => renewSubscription(orgId, s.sub.id, s.E));
  let inv = await latestInvoice(s.sub.id);
  let [n] = await noticesFor(s.pm.id);
  ok("(f) the notice is pending until the gateway answers", n?.status === "pending", n?.status);
  ok(
    "(f) the debit waits the recheck interval (1h), nothing booked",
    same(inv.nextAttemptAt, new Date(s.E.getTime() + H)) &&
      (await paymentsFor(inv.id)).length === 0,
    inv.nextAttemptAt?.toISOString(),
  );
  const t1 = new Date(s.E.getTime() + 5 * M);
  const delivered = await at(s.biz.id, t1, () => advanceTmtest(orgId, t1));
  [n] = await noticesFor(s.pm.id);
  ok("(f) tmtest delivered its signed webhook", delivered.delivered >= 1, delivered.delivered);
  ok(
    "(f) the webhook marks the notice sent, executable after created_at + lead",
    n?.status === "sent" && same(n.executableAfter, new Date(s.E.getTime() + LEAD * H)),
    `${n?.status} ${n?.executableAfter?.toISOString()}`,
  );
  const [pe] = await systemDb
    .select()
    .from(providerEvents)
    .where(
      and(
        eq(providerEvents.businessId, s.biz.id),
        eq(providerEvents.type, "pre_debit_notice.updated"),
      ),
    );
  ok("(f) the delivery is logged as processed", pe?.outcome === "processed", pe?.outcome);
  const again = await applyGatewayNoticeUpdate({
    providerKey: "tmtest",
    businessId: s.biz.id,
    gatewayAccountId: null,
    update: { notificationRef: n!.notificationRef!, status: "sent" },
  });
  const unknown = await applyGatewayNoticeUpdate({
    providerKey: "tmtest",
    businessId: s.biz.id,
    gatewayAccountId: null,
    update: { notificationRef: "tmpdn_unknown", status: "failed" },
  });
  ok("(f) a repeated update is ignored (idempotent)", again === "ignored");
  ok("(f) an unknown ref is ignored", unknown === "ignored");

  const t2 = new Date(s.E.getTime() + H + M);
  await collectPasses(s.biz.id, t2);
  inv = await invoiceRow(inv.id);
  ok(
    "(f) at the recheck the notice is sent but not yet executable: deferred again",
    (await paymentsFor(inv.id)).length === 0 &&
      same(inv.nextAttemptAt, new Date(s.E.getTime() + LEAD * H + MARGIN)),
    inv.nextAttemptAt?.toISOString(),
  );
  const t3 = new Date(s.E.getTime() + LEAD * H + MARGIN + M);
  await collectPasses(s.biz.id, t3);
  inv = await invoiceRow(inv.id);
  ok("(f) after the lead the debit collects", inv.status === "paid", inv.status);

  // The HTTP route attributes the delivery to its gateway account.
  const pending = await at(s.biz.id, t3, () =>
    sendGatewayNotice({
      organizationId: orgId,
      businessId: s.biz.id,
      adapter: resolveAdapter(s.notice),
      account: s.notice,
      pm: s.pm,
      amountMinor: 12_300n,
      currency: "INR",
      debitAt: new Date(t3.getTime() + 2 * 24 * H),
      idempotencyKey: "verify-route",
    }),
  );
  const signed = (eventId: string, status: string) => {
    const p = {
      id: eventId,
      type: "pre_debit_notice.updated",
      business: s.biz.id,
      occurred_at: t3.toISOString(),
      data: { notification_ref: pending.notificationRef, status, failure_code: "notice_rejected" },
    };
    return { rawBody: JSON.stringify(p), headers: { "x-tmtest-signature": signTmtest(p) } };
  };
  const wrongAcct = await ingestGatewayWebhook({
    gatewayKey: "tmtest",
    gatewayAccountPublicId: s.plain.publicId,
    ...signed("tmev_route_1", "failed"),
  });
  ok(
    "(f) the same ref arriving on another account is ignored",
    "handled" in wrongAcct &&
      wrongAcct.handled[0] === "ignored" &&
      (await noticesFor(s.pm.id)).find((x) => x.id === pending.id)?.status === "pending",
  );
  await ingestGatewayWebhook({
    gatewayKey: "tmtest",
    gatewayAccountPublicId: s.notice.publicId,
    ...signed("tmev_route_2", "failed"),
  });
  const failedRow = (await noticesFor(s.pm.id)).find((x) => x.id === pending.id);
  ok(
    "(f) a failed update on the right account marks the notice failed",
    failedRow?.status === "failed" && failedRow.failureCode === "notice_rejected",
    failedRow?.status,
  );
}

// ── (g) A backup that must wait yields; the primary's decline is booked once ────────────
{
  const s = await scenario("g-backup", { pre_debit_lead_hours: "24" }, { keepPlain: true });
  await swapCard(s.biz.id, s.pm, INSUFFICIENT);
  const backup = await mandatePm(s.biz.id, s.customer, s.notice);
  await at(s.biz.id, s.E, () => renewSubscription(orgId, s.sub.id, s.E));
  const inv = await latestInvoice(s.sub.id);
  const pays = await paymentsFor(inv.id);
  ok(
    "(g) exactly one payment: the primary's decline",
    pays.length === 1 &&
      pays[0]!.paymentMethodId === s.pm.id &&
      pays[0]!.failureCode === "insufficient_funds",
    pays
      .map((p) => `${p.paymentMethodId === s.pm.id ? "primary" : "other"}/${p.failureCode}`)
      .join(","),
  );
  ok(
    "(g) the invoice follows the primary's decline into dunning",
    inv.status === "payment_due" && inv.attemptCount === 1,
    `${inv.status} ${inv.attemptCount}`,
  );
  const [bn] = await noticesFor(backup.id);
  ok("(g) the backup got its notice for the next attempt", bn?.status === "sent", bn?.status);
  ok(
    "(g) no charge reached tmtest on the backup",
    (
      await systemDb
        .select()
        .from(tmtestCharges)
        .where(
          and(
            eq(tmtestCharges.vaultId, backup.providerPaymentMethodId),
            eq(tmtestCharges.kind, "charge"),
          ),
        )
    ).length === 0,
  );
}

// ── (h) Operator "Collect now" on a deferred debit: a readable refusal ─────────────────
// ── (i) A signup on a notice rail is not charged at once: deferred, or paid on-session ───
{
  const s = await scenario("h-operator", { pre_debit_lead_hours: "24" });
  const { invoice: inv } = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: s.biz.id,
    customerId: s.customer.id,
    currency: "INR",
    lines: [{ description: "One-off", amountMinor: 70_000n }],
    collect: false,
  });
  const t = new Date(T0.getTime() + H);
  // Net terms: posted, due in 30 days.
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({ status: "posted", dueDate: new Date(T0.getTime() + 30 * 24 * H) })
      .where(eq(invoices.id, inv.id)),
  );
  let err: unknown = null;
  try {
    await at(s.biz.id, t, () => collectInvoiceNow(orgId, s.biz.id, inv.publicId));
  } catch (e) {
    err = e;
  }
  ok(
    "(h) Collect now answers with the deferral message as an InvoiceOpsError",
    err instanceof InvoiceOpsError &&
      err.message.startsWith("This payment method needs an advance notice to the bank"),
    (err as Error | null)?.message,
  );
  ok("(h) …and books nothing", (await paymentsFor(inv.id)).length === 0);
  ok(
    "(h) …and the notice it promised was sent",
    (await noticesFor(s.pm.id)).some((n) => n.invoiceId === inv.id && n.status === "sent"),
  );
  const deferred = await invoiceRow(inv.id);
  ok(
    "(h) the posted invoice waits for the notice, not for its later due date",
    deferred.status === "posted" &&
      same(deferred.nextAttemptAt, new Date(t.getTime() + LEAD * H + MARGIN)),
    `${deferred.status} ${deferred.nextAttemptAt?.toISOString()}`,
  );
  await collectPasses(s.biz.id, new Date(t.getTime() + LEAD * H + MARGIN + M));
  ok(
    "(h) the due pass collects it then, weeks before the due date",
    (await invoiceRow(inv.id)).status === "paid",
    (await invoiceRow(inv.id)).status,
  );

  const before = (await noticesFor(s.pm.id)).length;
  const chargesBefore = (
    await systemDb.select().from(tmtestCharges).where(eq(tmtestCharges.kind, "charge"))
  ).length;
  const [subRow] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.id, s.sub.id)),
  );
  const outcome = await at(s.biz.id, t, () =>
    chargeBeforeSubscriptionInvoice({
      organizationId: orgId,
      businessId: s.biz.id,
      customerId: s.customer.id,
      subscription: subRow!,
      amountMinor: AMOUNT,
      currency: "INR",
      idempotencyScope: "verify-signup",
    }),
  );
  ok(
    "(i) an off-session signup charge on a notice rail is deferred: no charge, no notice yet",
    outcome.kind === "deferred" &&
      outcome.pm.id === s.pm.id &&
      (await noticesFor(s.pm.id)).length === before &&
      (await systemDb.select().from(tmtestCharges).where(eq(tmtestCharges.kind, "charge")))
        .length === chargesBefore,
    outcome.kind,
  );
  // What every caller does with `deferred`: commit the invoice with no charge.
  const plan = await at(s.biz.id, t, () =>
    planSubscriptionPeriodInvoice({
      organizationId: orgId,
      businessId: s.biz.id,
      subscription: subRow!,
      periodStart: s.E,
      periodEnd: new Date(s.E.getTime() + 30 * 24 * H),
    }),
  );
  const committed = await at(s.biz.id, t, () => commitSubscriptionPeriodInvoice(plan, {}));
  const signupInv = await invoiceRow(committed.invoice.id);
  ok(
    "(i) …the committed invoice waits on a sent notice, nothing booked",
    committed.payment === null &&
      (await paymentsFor(signupInv.id)).length === 0 &&
      (await noticesFor(s.pm.id)).some(
        (n) => n.invoiceId === signupInv.id && n.status === "sent",
      ) &&
      same(signupInv.nextAttemptAt, new Date(t.getTime() + LEAD * H + MARGIN)),
    `${signupInv.status} ${signupInv.nextAttemptAt?.toISOString()}`,
  );
  await collectPasses(s.biz.id, new Date(t.getTime() + LEAD * H + MARGIN + M));
  ok(
    "(i) …and is collected under the notice once the lead time has passed",
    (await invoiceRow(signupInv.id)).status === "paid",
    (await invoiceRow(signupInv.id)).status,
  );
  const onSession = await at(s.biz.id, t, () =>
    chargeBeforeSubscriptionInvoice({
      organizationId: orgId,
      businessId: s.biz.id,
      customerId: s.customer.id,
      subscription: subRow!,
      amountMinor: AMOUNT,
      currency: "INR",
      idempotencyScope: "verify-signup-on-session",
      session: "on_session",
      returnUrl: "https://example.com/return",
    }),
  );
  ok(
    "(i) an on-session signup on a notice rail is deferred too, nothing charged",
    onSession.kind === "deferred",
    onSession.kind,
  );

  // tmtest's own rule, so the positive checks above mean something.
  const adapter = resolveAdapter(s.notice);
  const sent = (await noticesFor(s.pm.id)).find((n) => n.invoiceId === inv.id)!;
  const charge = (amountMinor: bigint) =>
    adapter.charge({
      amountMinor,
      currency: "INR",
      customer: { providerKey: "tmtest", providerCustomerId: s.pm.providerCustomerId },
      paymentMethod: {
        providerKey: "tmtest",
        providerPaymentMethodId: s.pm.providerPaymentMethodId,
        display: { type: "upi" },
      },
      idempotencyKey: `verify-wrong-amount-${amountMinor}`,
      preDebitNotice: {
        notificationRef: sent.notificationRef!,
        amountMinor: sent.amountMinor,
        debitNumber: 1,
      },
    });
  const wrong = await charge(sent.amountMinor + 100n);
  ok(
    "tmtest: a debit for a different amount than the notice is refused",
    wrong.status === "failed" && wrong.failure?.code === "pre_debit_notice_missing",
    wrong.failure?.code,
  );
}

// ── (l) A one-off invoice raised with collect: deferred, not an error ──────────────────
{
  const s = await scenario("l-oneoff", { pre_debit_lead_hours: "24" });
  const t = new Date(T0.getTime() + H);
  let err: unknown = null;
  let out: Awaited<ReturnType<typeof createInvoiceFromLines>> | null = null;
  try {
    out = await at(s.biz.id, t, () =>
      createInvoiceFromLines({
        organizationId: orgId,
        businessId: s.biz.id,
        customerId: s.customer.id,
        currency: "INR",
        lines: [{ description: "One-off", amountMinor: 70_000n }],
        collect: true,
      }),
    );
  } catch (e) {
    err = e;
  }
  ok(
    "(l) the invoice is raised and the deferral does not escape (it was a 500)",
    err === null && out?.payment === null,
    (err as Error | null)?.message,
  );
  const inv = out ? await invoiceRow(out.invoice.id) : null;
  ok(
    "(l) …nothing booked, the notice sent, collection waits for it",
    !!inv &&
      (await paymentsFor(inv.id)).length === 0 &&
      (await noticesFor(s.pm.id)).some((n) => n.invoiceId === inv.id && n.status === "sent") &&
      same(inv.nextAttemptAt, new Date(t.getTime() + LEAD * H + MARGIN)),
    `${inv?.status} ${inv?.nextAttemptAt?.toISOString()}`,
  );
}

// ── (k) A paid wallet top-up waits on its own notice; the invoice's is left alone ──────
{
  const s = await scenario("k-wallet", { pre_debit_lead_hours: "24" });
  const TOPUP = 20_000n;
  await at(s.biz.id, s.E, () => renewSubscription(orgId, s.sub.id, s.E));
  const inv = await latestInvoice(s.sub.id);
  const topUp = (t: Date, amountMinor = TOPUP) =>
    at(s.biz.id, t, async () => {
      try {
        return await topUpWallet({
          organizationId: orgId,
          businessId: s.biz.id,
          customer: s.customer,
          amountMinor: Number(amountMinor),
          currency: "INR",
          type: "paid",
        });
      } catch (e) {
        if (e instanceof WalletError) return e;
        throw e;
      }
    });
  const topUpPayments = () =>
    withTenant(orgId, (tx) =>
      tx
        .select()
        .from(payments)
        .where(and(eq(payments.customerId, s.customer.id), isNull(payments.invoiceId))),
    );
  const byPurpose = async (purpose: string) =>
    (await noticesFor(s.pm.id)).filter((n) => n.purpose === purpose);

  const t1 = new Date(s.E.getTime() + H);
  const first = await topUp(t1);
  const ready = new Date(t1.getTime() + LEAD * H + MARGIN);
  ok(
    "(k) the top-up is not charged: WalletError with retry_after = notice + margin",
    first instanceof WalletError && same(first.retryAfter, ready),
    first instanceof WalletError ? first.retryAfter?.toISOString() : "charged",
  );
  ok("(k) …and books no payment", (await topUpPayments()).length === 0);
  const [wn] = await byPurpose("wallet_topup");
  ok(
    "(k) a wallet_topup notice was sent for the top-up amount, with no invoice",
    wn?.status === "sent" && wn.amountMinor === TOPUP && wn.invoiceId === null,
    `${wn?.status} ${wn?.amountMinor}`,
  );
  const [invNotice] = await byPurpose("invoice");
  ok(
    "(k) the invoice's notice is not superseded by the top-up",
    invNotice?.status === "sent" && invNotice.invoiceId === inv.id,
    invNotice?.status,
  );

  const again = await topUp(new Date(t1.getTime() + H));
  ok(
    "(k) a retry before the notice period ends waits on the same notice",
    again instanceof WalletError &&
      same(again.retryAfter, ready) &&
      (await byPurpose("wallet_topup")).length === 1,
  );

  await collectPasses(s.biz.id, new Date(s.E.getTime() + LEAD * H + MARGIN + M));
  ok("(k) the invoice collects on its own notice", (await invoiceRow(inv.id)).status === "paid");
  const [wnAfterInvoice] = await byPurpose("wallet_topup");
  ok(
    "(k) the invoice debit did not spend the top-up's notice",
    wnAfterInvoice?.debitsUsed === 0,
    wnAfterInvoice?.debitsUsed,
  );

  const done = await topUp(new Date(ready.getTime() + M));
  const pays = await topUpPayments();
  ok(
    "(k) after the notice period the same amount is charged and credited",
    !(done instanceof WalletError) &&
      done.amountMinor === TOPUP &&
      pays.length === 1 &&
      pays[0]!.status === "succeeded",
    done instanceof WalletError ? done.message : pays.map((p) => p.status).join(","),
  );
  const [spent] = await byPurpose("wallet_topup");
  const g = await gatewayNotice(spent?.notificationRef ?? null);
  ok(
    "(k) the charge ran under the top-up's notice",
    spent?.debitsUsed === 1 && g?.state.debits === 1 && g.state.lastChargeKey === pays[0]?.publicId,
    JSON.stringify(g?.state),
  );
  const credited = await withTenant(orgId, (tx) =>
    tx.select().from(walletTopups).where(eq(walletTopups.customerId, s.customer.id)),
  );
  ok("(k) one wallet credit", credited.length === 1, credited.length);
}

// ── (m) The gateway's own read says "not yet": deferred before the notice is counted ──
{
  const s = await scenario("m-check", {
    pre_debit_lead_hours: "24",
    pre_debit_check_late_hours: "3",
  });
  await at(s.biz.id, s.E, () => renewSubscription(orgId, s.sub.id, s.E));
  let inv = await latestInvoice(s.sub.id);
  const t1 = new Date(s.E.getTime() + LEAD * H + MARGIN + M);
  await collectPasses(s.biz.id, t1);
  inv = await invoiceRow(inv.id);
  let [n] = await noticesFor(s.pm.id);
  ok(
    "(m) the gateway's later time defers the debit: nothing booked, notice not counted",
    (await paymentsFor(inv.id)).length === 0 &&
      inv.attemptCount === 0 &&
      n?.debitsUsed === 0 &&
      n.status === "sent" &&
      same(n.executableAfter, new Date(t1.getTime() + 3 * H)),
    `${inv.attemptCount} ${n?.debitsUsed} ${n?.status} ${n?.executableAfter?.toISOString()}`,
  );
  ok(
    "(m) next_attempt_at = the gateway's time + margin",
    same(inv.nextAttemptAt, new Date(t1.getTime() + 3 * H + MARGIN)),
    inv.nextAttemptAt?.toISOString(),
  );
  await collectPasses(s.biz.id, new Date(inv.nextAttemptAt!.getTime() + M));
  inv = await invoiceRow(inv.id);
  [n] = await noticesFor(s.pm.id);
  ok(
    "(m) then the same notice collects",
    inv.status === "paid" && n?.debitsUsed === 1 && (await noticesFor(s.pm.id)).length === 1,
    `${inv.status} ${n?.debitsUsed}`,
  );
}

// ── (n) The gateway refuses the debit as too early: the notice is kept, not burned ────
{
  const s = await scenario("n-not-due", {
    pre_debit_lead_hours: "24",
    pre_debit_not_due_hours: "2",
  });
  await at(s.biz.id, s.E, () => renewSubscription(orgId, s.sub.id, s.E));
  let inv = await latestInvoice(s.sub.id);
  const t1 = new Date(s.E.getTime() + LEAD * H + MARGIN + M);
  await collectPasses(s.biz.id, t1);
  inv = await invoiceRow(inv.id);
  let [n] = await noticesFor(s.pm.id);
  ok(
    "(n) a too-early refusal books nothing and spends no dunning slot",
    (await paymentsFor(inv.id)).length === 0 && inv.attemptCount === 0,
    `${(await paymentsFor(inv.id)).length} ${inv.attemptCount}`,
  );
  ok(
    "(n) the notice is given back its debit and held until the time the gateway named",
    n?.status === "sent" &&
      n.debitsUsed === 0 &&
      same(n.executableAfter, new Date(t1.getTime() + 2 * H)) &&
      same(inv.nextAttemptAt, new Date(t1.getTime() + 2 * H + MARGIN)),
    `${n?.status} ${n?.debitsUsed} ${n?.executableAfter?.toISOString()} ${inv.nextAttemptAt?.toISOString()}`,
  );
  await collectPasses(s.biz.id, new Date(inv.nextAttemptAt!.getTime() + M));
  inv = await invoiceRow(inv.id);
  [n] = await noticesFor(s.pm.id);
  const g = await gatewayNotice(n?.notificationRef ?? null);
  ok(
    "(n) the retry collects on the SAME notice, no second notice sent",
    inv.status === "paid" &&
      (await noticesFor(s.pm.id)).length === 1 &&
      n?.debitsUsed === 1 &&
      g?.state.debits === 1,
    `${inv.status} ${n?.debitsUsed} ${g?.state.debits}`,
  );
}

// ── (o) A delivery report names a later earliest debit: an unused sent notice moves ───
{
  const s = await scenario("o-later", { pre_debit_lead_hours: "24" });
  await at(s.biz.id, s.E, () => renewSubscription(orgId, s.sub.id, s.E));
  let inv = await latestInvoice(s.sub.id);
  const [n0] = await noticesFor(s.pm.id);
  const later = new Date(n0!.executableAfter!.getTime() + H);
  const earlier = new Date(n0!.executableAfter!.getTime() - H);
  const update = (executableAfter: Date) =>
    applyGatewayNoticeUpdate({
      providerKey: "tmtest",
      businessId: s.biz.id,
      gatewayAccountId: s.notice.id,
      update: { notificationRef: n0!.notificationRef!, status: "sent", executableAfter },
    });
  const moved = await at(s.biz.id, new Date(s.E.getTime() + M), () => update(later));
  const back = await at(s.biz.id, new Date(s.E.getTime() + M), () => update(earlier));
  const [n1] = await noticesFor(s.pm.id);
  ok(
    "(o) a later time moves the sent notice; an earlier one is ignored",
    moved === "processed" && back === "ignored" && same(n1?.executableAfter, later),
    `${moved} ${back} ${n1?.executableAfter?.toISOString()}`,
  );
  await collectPasses(s.biz.id, new Date(s.E.getTime() + LEAD * H + MARGIN + M));
  inv = await invoiceRow(inv.id);
  ok(
    "(o) the debit waits for the later time",
    (await paymentsFor(inv.id)).length === 0 &&
      same(inv.nextAttemptAt, new Date(later.getTime() + MARGIN)),
    inv.nextAttemptAt?.toISOString(),
  );
}

// ── Direct gate calls for the claim rules below ─────────────────────────────────────────
type Scn = Awaited<ReturnType<typeof scenario>>;
const gateAt = (
  s: Scn,
  t: Date,
  debit: { purpose: PreDebitPurpose; invoiceId?: string; amountMinor?: bigint },
) =>
  at(s.biz.id, t, async () =>
    preDebitGate({
      organizationId: orgId,
      businessId: s.biz.id,
      adapter: resolveAdapter(s.notice),
      account: s.notice,
      pm: (await pmRow(s.pm.id))!,
      amountMinor: debit.amountMinor ?? AMOUNT,
      currency: "INR",
      contact: null,
      purpose: debit.purpose,
      ...(debit.purpose === "invoice"
        ? { invoiceId: debit.invoiceId ?? null, subscriptionId: s.sub.id }
        : {}),
    }),
  );
/** A notice sent ahead, as the reminders pass sends it: for the subscription, no invoice. */
const noticeAhead = (s: Scn, t: Date, purpose: PreDebitPurpose = "invoice", amountMinor = AMOUNT) =>
  at(s.biz.id, t, () =>
    sendGatewayNotice({
      organizationId: orgId,
      businessId: s.biz.id,
      adapter: resolveAdapter(s.notice),
      account: s.notice,
      pm: s.pm,
      amountMinor,
      currency: "INR",
      debitAt: new Date(t.getTime() + 25 * H),
      idempotencyKey: `ahead:${s.pm.publicId}:${purpose}:${t.getTime()}`,
      ...(purpose === "invoice" ? { subscriptionId: s.sub.id } : { purpose }),
    }),
  );
/** The answer a debit under the notice leaves behind, as collection books it. */
const bookDebit = (
  s: Scn,
  t: Date,
  invoiceId: string | null,
  status: "succeeded" | "failed",
  amountMinor = AMOUNT,
  purpose?: PreDebitPurpose,
) =>
  at(s.biz.id, t, () =>
    withTenant(orgId, (tx) =>
      tx.insert(payments).values({
        ...(purpose ? { metadata: { [PAYMENT_PURPOSE_KEY]: purpose } } : {}),
        organizationId: orgId,
        businessId: s.biz.id,
        customerId: s.customer.id,
        invoiceId,
        paymentMethodId: s.pm.id,
        publicId: newPublicId("pay"),
        status,
        amountMinor,
        currency: "INR",
        providerKey: "tmtest",
      }),
    ),
  );
/** An open invoice of AMOUNT for the scenario's customer, not collected. */
const openInvoice = async (s: Scn, t: Date) =>
  (
    await at(s.biz.id, t, () =>
      createInvoiceFromLines({
        organizationId: orgId,
        businessId: s.biz.id,
        customerId: s.customer.id,
        currency: "INR",
        lines: [{ description: "Usage", amountMinor: AMOUNT }],
        collect: false,
      }),
    )
  ).invoice.id;
async function noticeRow(id: string) {
  const [r] = await systemDb.select().from(preDebitNotices).where(eq(preDebitNotices.id, id));
  return r;
}

// ── (p) A notice sent ahead belongs to the first invoice debited under it ───────────────
{
  const s = await scenario("p-one-invoice", { pre_debit_lead_hours: "24" });
  const t0 = new Date(s.E.getTime() - 26 * H);
  const invOld = await openInvoice(s, t0);
  const invNew = await openInvoice(s, t0);
  const ahead = await noticeAhead(s, t0);
  const t1 = new Date(t0.getTime() + LEAD * H + MARGIN);
  const gNew = await gateAt(s, t1, { purpose: "invoice", invoiceId: invNew });
  const bound = await noticeRow(ahead.id);
  ok(
    "(p) the first invoice debits under the notice and the claim binds the notice to it",
    gNew.kind === "ready" && bound?.invoiceId === invNew && bound.debitsUsed === 1,
    `${gNew.kind} ${bound?.invoiceId === invNew} ${bound?.debitsUsed}`,
  );
  const inFlight = await gateAt(s, new Date(t1.getTime() + M), {
    purpose: "invoice",
    invoiceId: invOld,
  });
  ok(
    "(p) while that debit is in flight, another invoice of the same amount does not debit",
    inFlight.kind === "wait",
    inFlight.kind,
  );
  await bookDebit(s, new Date(t1.getTime() + 2 * M), invNew, "succeeded");
  const gOld = await gateAt(s, new Date(t1.getTime() + 3 * M), {
    purpose: "invoice",
    invoiceId: invOld,
  });
  const ns = await noticesFor(s.pm.id);
  const own = ns.find((n) => n.invoiceId === invOld && n.status === "sent");
  ok(
    "(p) after it succeeded, the other invoice waits for a new notice of its own",
    gOld.kind === "wait" && !!own && own.id !== ahead.id && own.debitsUsed === 0,
    `${gOld.kind} ${ns.map((n) => `${n.status}/${n.debitsUsed}`).join(",")}`,
  );
  ok(
    "(p) the notice that paid the first invoice is retired, never re-used",
    ns.find((n) => n.id === ahead.id)?.status === "exhausted",
    ns.find((n) => n.id === ahead.id)?.status,
  );
}
{
  const s = await scenario("p-race", { pre_debit_lead_hours: "24" });
  const t0 = new Date(s.E.getTime() - 26 * H);
  const invA = await openInvoice(s, t0);
  const invB = await openInvoice(s, t0);
  const ahead = await noticeAhead(s, t0);
  const t1 = new Date(t0.getTime() + LEAD * H + MARGIN);
  const [ga, gb] = await Promise.all([
    gateAt(s, t1, { purpose: "invoice", invoiceId: invA }),
    gateAt(s, t1, { purpose: "invoice", invoiceId: invB }),
  ]);
  const n = await noticeRow(ahead.id);
  const winner = ga.kind === "ready" ? invA : invB;
  ok(
    "(p) two invoices at once: exactly one debits under the notice, which is bound to it",
    [ga, gb].filter((g) => g.kind === "ready").length === 1 &&
      n?.invoiceId === winner &&
      n.debitsUsed === 1 &&
      n.status === "sent",
    `${ga.kind}/${gb.kind} ${n?.status} ${n?.debitsUsed}`,
  );
}

// ── (q) Two top-ups of one amount at once: one notice, one debit ────────────────────────
{
  const s = await scenario("q-topup-race", { pre_debit_lead_hours: "24" });
  const TOPUP = 30_000n;
  const t0 = new Date(s.E.getTime() - 26 * H);
  const ahead = await noticeAhead(s, t0, "wallet_topup", TOPUP);
  const t1 = new Date(t0.getTime() + LEAD * H + MARGIN);
  const topup = { purpose: "wallet_topup" as const, amountMinor: TOPUP };
  const both = await Promise.all([gateAt(s, t1, topup), gateAt(s, t1, topup)]);
  ok(
    "(q) two concurrent top-ups: exactly one claims the notice",
    both.filter((g) => g.kind === "ready").length === 1 &&
      (await noticeRow(ahead.id))?.debitsUsed === 1,
    both.map((g) => g.kind).join("/"),
  );
  const third = await gateAt(s, new Date(t1.getTime() + M), topup);
  ok("(q) a third, while that debit is in flight, waits", third.kind === "wait", third.kind);
  await bookDebit(s, new Date(t1.getTime() + 2 * M), null, "failed", TOPUP);
  const retry = await gateAt(s, new Date(t1.getTime() + 3 * M), topup);
  ok(
    "(q) once that debit is booked failed, a retry runs under the same notice",
    retry.kind === "ready" && retry.notice.debitNumber === 2,
    retry.kind === "ready" ? retry.notice.debitNumber : retry.kind,
  );
}

// ── (s) A wallet and a credit top-up notice of one amount: each counts only its own debits ─
{
  const s = await scenario("s-purposes", { pre_debit_lead_hours: "24" });
  const t0 = new Date(s.E.getTime() - 26 * H);
  const autoInv = await openInvoice(s, t0);
  const wallet = await noticeAhead(s, t0, "wallet_topup");
  const credit = await noticeAhead(s, t0, "credit_topup");
  const t1 = new Date(t0.getTime() + LEAD * H + MARGIN);
  const at1 = (m: number) => new Date(t1.getTime() + m * M);
  // The credit top-up debit fails (its payment carries the auto top-up invoice).
  const c1 = await gateAt(s, at1(0), { purpose: "credit_topup" });
  await bookDebit(s, at1(1), autoInv, "failed", AMOUNT, "credit_topup");
  // The wallet top-up debit succeeds under its own notice.
  const w1 = await gateAt(s, at1(2), { purpose: "wallet_topup" });
  await bookDebit(s, at1(3), null, "succeeded", AMOUNT, "wallet_topup");
  const c2 = await gateAt(s, at1(4), { purpose: "credit_topup" });
  const w2 = await gateAt(s, at1(5), { purpose: "wallet_topup" });
  const [wn, cn] = [await noticeRow(wallet.id), await noticeRow(credit.id)];
  ok(
    "(s) the wallet debit retires only the wallet notice; the credit notice takes its retry",
    c1.kind === "ready" &&
      w1.kind === "ready" &&
      c2.kind === "ready" &&
      c2.notice.debitNumber === 2 &&
      cn?.status === "sent" &&
      w2.kind === "wait" &&
      wn?.status === "exhausted",
    `${c1.kind} ${w1.kind} ${c2.kind}${c2.kind === "ready" ? `#${c2.notice.debitNumber}` : ""} ${w2.kind} wallet ${wn?.status} credit ${cn?.status}`,
  );
}
{
  const s = await scenario("s-in-flight", { pre_debit_lead_hours: "24" });
  const t0 = new Date(s.E.getTime() - 26 * H);
  await noticeAhead(s, t0, "credit_topup");
  const t1 = new Date(t0.getTime() + LEAD * H + MARGIN);
  const first = await gateAt(s, t1, { purpose: "credit_topup" });
  // A failed wallet top-up of the same amount is not the credit debit that is in flight.
  await bookDebit(s, new Date(t1.getTime() + M), null, "failed", AMOUNT, "wallet_topup");
  const second = await gateAt(s, new Date(t1.getTime() + 2 * M), { purpose: "credit_topup" });
  ok(
    "(s) a failed wallet top-up does not free a credit notice whose debit is in flight",
    first.kind === "ready" && second.kind === "wait",
    `${first.kind} ${second.kind}`,
  );
}

// ── (r) A retry must start an hour before its notice ends ───────────────────────────────
{
  const s = await scenario("r-retry-end", {
    pre_debit_lead_hours: "24",
    pre_debit_valid_hours: "30",
  });
  const t0 = new Date(s.E.getTime() - 26 * H);
  const inv = await openInvoice(s, t0);
  const ahead = await noticeAhead(s, t0);
  const t1 = new Date(t0.getTime() + LEAD * H + MARGIN);
  const first = await gateAt(s, t1, { purpose: "invoice", invoiceId: inv });
  await bookDebit(s, new Date(t1.getTime() + M), inv, "failed");
  const early = await gateAt(s, new Date(t0.getTime() + 28 * H), {
    purpose: "invoice",
    invoiceId: inv,
  });
  await bookDebit(s, new Date(t0.getTime() + 28 * H + M), inv, "failed");
  const late = await gateAt(s, new Date(t0.getTime() + 29 * H + M), {
    purpose: "invoice",
    invoiceId: inv,
  });
  ok(
    "(r) a retry 2 h before the notice ends runs under it; one 59 min before ends it",
    first.kind === "ready" &&
      early.kind === "ready" &&
      late.kind === "wait" &&
      (await noticeRow(ahead.id))?.status === "exhausted",
    `${first.kind} ${early.kind} ${late.kind} ${(await noticeRow(ahead.id))?.status}`,
  );
}

const failed = checks.filter(([, c]) => !c);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
console.log(failed.length ? "❌ PRE-DEBIT-NOTICES: FAIL" : "✅ PRE-DEBIT-NOTICES: PASS");
await closeDb();
process.exit(failed.length ? 1 : 0);
