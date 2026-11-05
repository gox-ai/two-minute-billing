/**
 * Proves the stale-pending sweep — the backstop for a settlement webhook that never
 * came, and the only thing that stops an async debit parking an invoice forever.
 *
 *   pnpm verify:stale-pending
 *
 * ── Why this suite exists ─────────────────────────────────────────────────────
 * The sweep shipped with NO unattended coverage. `sweepStalePendingCharges` was
 * referenced by exactly one script, `verify:razorpay-emandate-live`, which skips
 * without real RazorPay credentials — and tmtest had no `fetchChargeStatus`, so the
 * sweep counted every simulated row `unsupported` and did nothing. The AFA-abandon
 * branch inside it (added 2026-08-17) had therefore never executed at all: a timeout
 * that fails a debit and hands it to dunning, taken entirely on faith.
 *
 * Every case below backdates `transactions.created_at`, because the deadlines are
 * days long and the sweep reads the clock. That is the only fiction; the charge, the
 * poll and the settlement are the real code paths.
 *
 * ── The cases ─────────────────────────────────────────────────────────────────
 *   A  a card AFA debit past its window is abandoned (and proves the grace clamp)
 *   B  the same debit INSIDE the window is not even examined
 *   C  a netbanking debit is polled and never abandoned — the rail rule, not the clock
 *   D  the sweep's original job: a webhook that never came for a debit that landed
 *   E  a PARKED invoice reaches a deadline and closes — including on a business with
 *      no configured dunning period, which is the default and was the whole hole
 *   F  a MERCHANT-side park never acquires that deadline
 *   G  the buyer says they will not authorise it, and the invoice is released at once
 *   H  …but the gateway is asked first, so a debit that already landed is settled
 *   I  …and a debit that does not wait on the buyer is not theirs to abandon
 *
 * ⚠️ E and F assert on THEIR OWN INVOICE, never on the sweep's global counters. This
 * database is not truncated between runs, so a parked row left by an earlier run is
 * legitimately closed by the same pass — which made a counter-based assertion fail on
 * the first run after a change and pass on every run after it.
 */
import { and, eq, desc, inArray } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  sweepStalePendingCharges,
  abandonAuthenticationPendingDebit,
  __afaAbandonHours,
  __graceHoursFor,
} from "@/modules/payments/stale-pending";
// Case N: the intent TTL table is a deliberate COPY of this sweep's grace table (the
// import that would share it closes a cycle — see `ttl.ts`), so the copy is pinned here.
import {
  RAIL_TTL_HOURS,
  DEFAULT_RAIL_TTL_HOURS,
  railTtlHours,
} from "@/modules/payment-intents/ttl";
import { sweepExpiredParkedDunning } from "@/modules/subscriptions/dunning";
import { runWithClockScope } from "@/platform/clock";

/**
 * ⚠️ SCOPED. `sweepExpiredParkedDunning` is a clock pass: it scans EVERY parked invoice
 * in the database. These cases backdate their OWN row and then sweep, so an unscoped
 * call also closes anyone else's park that happens to be past its deadline. Same
 * mechanism and same reason as `verify-dunning-smart.ts` — see the note there, which
 * records the 41 subscriptions an unscoped run cancelled.
 */
const sweepParked = (bizId: string) =>
  runWithClockScope({ onlyBusinessId: bizId }, () => sweepExpiredParkedDunning(new Date()));
// Scoped for the same reason: the pass takes the OLDEST `TICK_SCAN_LIMIT` stuck charges
// estate-wide, so on a long-lived database a fresh fixture is never selected at all.
const sweepCharges = (bizId: string) =>
  runWithClockScope({ onlyBusinessId: bizId }, () => sweepStalePendingCharges(new Date()));
import { MERCHANT_SIDE_PARK } from "@/modules/subscriptions/decline-policy";
import {
  resolveDunningConfig,
  parkedDunningDeadline,
} from "@/modules/subscriptions/dunning-schedule";
import { businesses, settlementPollSchedule } from "@db/schema";
import { setChargeStatus } from "@/providers/tmtest/store";
import {
  createPaymentIntent,
  voidPaymentIntent,
  liveIntentForInvoice,
} from "@/modules/payment-intents/service";
import { paymentIntents, paymentMethods as pmTable } from "@db/schema";
// Cases T/U read the GATEWAY's own row and move it independently of ours — the
// divergence between the two records is the whole of #21 and #26.
import { tmtestCharges, customers } from "@db/schema";
import { TmtestProvider } from "@/providers/tmtest";
import { getSpanId } from "@/platform/trace";
import { advanceTmtest } from "@/providers/tmtest/webhooks";
import { recordOfflinePayment as recordOfflinePaymentGuarded } from "@/modules/invoicing/ops";
import { paidTotals } from "@/modules/invoicing/service";
import { bucketBalance, EXCESS_PAYMENT } from "@/modules/customers/balances-read";
import { invoices, payments, paymentMethods, refunds, transactions } from "@db/schema";
import { ledgerEntries } from "@db/schema";
import { refundPayment } from "@/modules/refunds/service";
import { estimateChange } from "@/modules/subscriptions/estimate";
import { subscriptions as subsTable, subscriptionItems } from "@db/schema";

const HOUR = 3600_000;
/** tmtest's live-async instrument: charge returns `pending` and never self-settles. */
const ASYNC_PENDING = "4000000000000101";

let pass = true;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) pass = false;
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

/**
 * One customer with a live async debit against an invoice, on a chosen rail.
 * `amountMinor` decides whether the debit needs the buyer's authentication.
 */
/**
 * Record an offline payment OVER a live debit. The engine now cancels or refuses that
 * (`clearPendingDebits`), but these cases need the state it leaves on older rows and on
 * other producers: the payment is hidden from the guard for the call, then restored.
 */
async function recordOfflinePayment(
  input: Parameters<typeof recordOfflinePaymentGuarded>[0],
): ReturnType<typeof recordOfflinePaymentGuarded> {
  const [inv] = await withTenant(input.organizationId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.publicId, input.invoicePublicId)).limit(1),
  );
  const hidden = await withTenant(input.organizationId, (tx) =>
    tx
      .update(payments)
      .set({ status: "requires_action" })
      .where(and(eq(payments.invoiceId, inv!.id), eq(payments.status, "pending")))
      .returning({ id: payments.id }),
  );
  try {
    return await recordOfflinePaymentGuarded(input);
  } finally {
    if (hidden.length)
      await withTenant(input.organizationId, (tx) =>
        tx
          .update(payments)
          .set({ status: "pending" })
          .where(
            inArray(
              payments.id,
              hidden.map((h) => h.id),
            ),
          ),
      );
  }
}

async function scenario(label: string, rail: string, amountMinor: number) {
  const org = await createOrganization({ name: `StalePending ${label} ${Date.now()}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Biz",
    defaultCurrency: "INR",
    livemode: "test",
  });
  // These cases exercise parking, which is off by default.
  await systemDb
    .update(businesses)
    .set({ dunningConfig: { park_hard_declines: true } })
    .where(eq(businesses.id, biz.id));
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "sp@a.com",
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: ASYNC_PENDING,
  });
  // Stamp the mandate the way a RazorPay vault would (0179). The ceiling is huge on
  // purpose: this suite is about the RBI threshold and the clock, not about the
  // mandate cap, which would refuse the charge before it ever reached the gateway.
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateRail: rail, mandateMaxAmountMinor: 99_999_999n, mandateCurrency: "INR" })
      .where(eq(paymentMethods.id, pm.id)),
  );
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plan" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "INR",
    amountMinor,
    interval: "month",
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    // Non-null by construction: this fixture creates a subscription with NO trial, so it
    // starts `active` with a term. A trialling subscription has none (2026-08-25).
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  return { orgId, bizId: biz.id, pmId: pm.id, invoiceId: invoice.id };
}

/**
 * Age the attempt so the sweep considers it — the deadlines are days long.
 *
 * ⚠️ Callers derive `hours` from the deadline CONSTANTS, so this suite pins the
 * BEHAVIOUR at the boundary, never the boundary's value: raise `AFA_ABANDON_HOURS`
 * and the backdating scales with it, so every case still passes. That is deliberate
 * (the suite should not break when the margin is retuned) but it means it cannot
 * catch a constant set to something absurd — `test/unit/mandate.test.ts` owns that,
 * asserting the window stays clear of the 72h AFA link. Disabling the branch is what
 * proves these cases non-vacuous, and it does: case A loses four of six assertions.
 */
async function backdate(orgId: string, invoiceId: string, hours: number) {
  const at = new Date(Date.now() - hours * HOUR);
  await withTenant(orgId, (tx) =>
    tx
      .update(transactions)
      .set({ createdAt: at })
      .where(and(eq(transactions.invoiceId, invoiceId), eq(transactions.status, "in_progress"))),
  );
}

/**
 * Age an INTENT the way `backdate` ages a transaction. The zero-due intent pass clears the
 * instant in which a settle is mid-write (`ZERO_DUE_SETTLE_MARGIN_MS`, 15 minutes) by
 * reading the intent's last write, so a freshly minted fixture is deliberately invisible
 * to it — which reads exactly like a pass that does not work.
 */
async function backdateIntent(orgId: string, intentId: string, hours: number) {
  const at = new Date(Date.now() - hours * HOUR);
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentIntents)
      .set({ createdAt: at, updatedAt: at })
      .where(eq(paymentIntents.id, intentId)),
  );
}

const state = async (orgId: string, invoiceId: string) =>
  withTenant(orgId, async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    const [txn] = await tx
      .select()
      .from(transactions)
      .where(eq(transactions.invoiceId, invoiceId))
      .orderBy(desc(transactions.createdAt))
      .limit(1);
    const [pay] = await tx
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, invoiceId))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    return { inv: inv!, txn: txn!, pay: pay! };
  });

console.log(
  `AFA abandon window: ${__afaAbandonHours}h · card grace: ${__graceHoursFor("card", null)}h` +
    ` · emandate grace: ${__graceHoursFor("emandate", null)}h\n`,
);

// ── A: a card debit the buyer never authenticated, past the window ────────────
// The case the whole AFA timeout exists for. RazorPay would still be reporting
// `created`; the AFA link it is waiting on has just expired.
//
// This also proves the GRACE CLAMP, and non-vacuously while the abandon window is
// shorter than a card's ordinary grace (72h vs 96h): without it the row would not be
// selected for a poll at all at this age, and nothing here would fire.
{
  const s = await scenario("A card afa", "card", 5_671_500);
  await backdate(s.orgId, s.invoiceId, __afaAbandonHours + 1);
  const r = await sweepCharges(s.bizId);
  const { inv, txn, pay } = await state(s.orgId, s.invoiceId);
  const [pm] = await withTenant(s.orgId, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.id, s.pmId)).limit(1),
  );
  console.log(`A: sweep=${JSON.stringify(r)}`);
  ok("A: the abandoned debit is counted as failed", r.failed >= 1);
  ok(
    "A: the transaction fails with afa_not_completed",
    txn.status === "failed" && txn.errorCode === "afa_not_completed",
    `${txn.status}/${txn.errorCode}`,
  );
  ok(
    "A: it is non-retriable — the same debit on the same rail stalls identically",
    txn.retriable === false,
    String(txn.retriable),
  );
  ok("A: the payment is no longer pending", pay.status !== "pending", pay.status);
  // Parked, NOT exhausted: the customer recovers this by paying in the portal or
  // re-authorising, so the invoice has to still be there when they do.
  ok(
    "A: the invoice stays open and parked",
    inv.status === "payment_due" && inv.nextAttemptAt === null,
    `${inv.status} next=${inv.nextAttemptAt}`,
  );
  ok(
    "A: the instrument is NOT blamed — the card was never asked to pay",
    pm!.status !== "invalid",
    pm!.status,
  );
}

// ── B: the same debit, still inside the window ────────────────────────────────
// The control that makes A meaningful. One hour SHORT of the authentication window:
// the buyer can still approve their bank's request, so the sweep must not touch it.
//
// This used to sit between the card grace (96h) and a 120h abandon — a gap where the
// sweep polled but would not overrule. That gap is gone by design: an AFA debit's
// grace is now clamped to the abandon window, so the poll and the verdict coincide
// and there is no state where we ask the gateway about an AFA debit and then ignore
// the answer. "Polled and left alone" is now proved by C, on a rail that has no
// authentication to give up on.
{
  const s = await scenario("B card inside", "card", 5_671_500);
  await backdate(s.orgId, s.invoiceId, __afaAbandonHours - 1);
  const r = await sweepCharges(s.bizId);
  const { inv, txn } = await state(s.orgId, s.invoiceId);
  console.log(`B: sweep=${JSON.stringify(r)}`);
  ok(
    "B: inside the authentication window it is not even examined",
    txn.status === "in_progress",
    txn.status,
  );
  ok("B: the invoice is untouched", inv.status === "payment_due" && inv.nextAttemptAt === null);
}

// ── C: netbanking, past the same window ──────────────────────────────────────
// The control that proves the abandon is keyed on the RAIL and not just the clock.
// A netbanking e-mandate authenticates once at registration and debits unattended,
// so there is no authentication to give up on — however old it gets.
//
// Backdated past the EMANDATE grace (168h), not past the abandon window: at 73h this
// row would not be selected at all, and "still in_progress" would prove nothing about
// the rail rule. Now the gateway really is asked and its `pending` really does win.
{
  const s = await scenario("C emandate", "emandate", 6_602_500);
  await backdate(s.orgId, s.invoiceId, __graceHoursFor("emandate", null) + 1);
  const r = await sweepCharges(s.bizId);
  const { txn } = await state(s.orgId, s.invoiceId);
  console.log(`C: sweep=${JSON.stringify(r)}`);
  ok('C: polled, and the gateway\'s "still working" wins', r.stillPending >= 1, JSON.stringify(r));
  ok(
    "C: a netbanking debit is never abandoned for non-authentication",
    txn.status === "in_progress",
    txn.status,
  );
}

// ── D: the sweep's ORIGINAL job still works ──────────────────────────────────
// A webhook that never arrived for a debit the gateway actually captured. Proves the
// AFA branch did not swallow the settle path it sits next to.
{
  const s = await scenario("D settles", "card", 1_387_000);
  const { txn: before } = await state(s.orgId, s.invoiceId);
  await setChargeStatus(before.idAtGateway!, "succeeded");
  await backdate(s.orgId, s.invoiceId, __graceHoursFor("card", null) + 1);
  const r = await sweepCharges(s.bizId);
  const { inv, txn, pay } = await state(s.orgId, s.invoiceId);
  console.log(`D: sweep=${JSON.stringify(r)}`);
  ok(
    "D: a settled-at-the-gateway debit is booked",
    r.settled >= 1 && txn.status === "succeeded",
    txn.status,
  );
  ok("D: the invoice is paid", inv.status === "paid", inv.status);
  ok("D: the payment succeeded", pay.status === "succeeded", pay.status);
}

// ── E: a parked invoice has a DEADLINE, and reaches it ───────────────────────
// The half of the AFA story that was missing. `afa_not_completed` parks the invoice
// (`next_attempt_at = null`, `dunning_status = 'parked'`) and `runDunningPass` scans
// `WHERE next_attempt_at IS NOT NULL` — so before `sweepExpiredParkedDunning` nothing
// in the clock ever looked at the row again: no deadline, no final action, and a live
// subscription on an invoice nobody was collecting. Measured 2026-08-28.
{
  const s = await scenario("E parked deadline", "card", 5_671_500);
  await backdate(s.orgId, s.invoiceId, __afaAbandonHours + 1);
  await sweepCharges(s.bizId);
  const parkedNow = await state(s.orgId, s.invoiceId);
  ok(
    "E: the AFA failure parks the invoice",
    parkedNow.inv.dunningStatus === "parked",
    String(parkedNow.inv.dunningStatus),
  );

  /**
   * Inside the dunning period nothing happens — the customer still has time to pay.
   *
   * Asserted on THIS INVOICE, never on the sweep's counter. The counter is global and
   * this suite runs against a database that is not truncated between runs, so a parked
   * row left by an earlier run is legitimately closed by this same pass — which made
   * `early.exhausted === 0` fail on the first run after a change and pass on every run
   * after it. A green suite that depends on what the previous run left behind is not
   * evidence of anything.
   */
  await sweepParked(s.bizId);
  const stillParked = await state(s.orgId, s.invoiceId);
  ok(
    "E: before the deadline the parked invoice is left alone",
    stillParked.inv.status === "payment_due" && stillParked.inv.dunningStatus === "parked",
    `${stillParked.inv.status}/${stillParked.inv.dunningStatus}`,
  );

  /**
   * This business has NO configured dunning period — the default, and the case that
   * made the first version of this sweep a no-op everywhere. The deadline must still
   * exist, from `PARKED_GRACE_DAYS` (`parkedDunningDeadline`).
   */
  const cfg = await withTenant(s.orgId, async (tx) => {
    const [biz] = await tx
      .select({ retryDays: businesses.dunningRetryDays, dunningConfig: businesses.dunningConfig })
      .from(businesses)
      .where(eq(businesses.id, s.bizId))
      .limit(1);
    return resolveDunningConfig(biz);
  });
  ok(
    "E: the default business has no dunning period configured — the hard case",
    cfg.dunningPeriodDays == null,
    String(cfg.dunningPeriodDays),
  );
  ok(
    "E: and still gets a deadline, from the parked grace default",
    parkedDunningDeadline(cfg, new Date(0)).getTime() > 0,
  );
  // Age the invoice past it. Since 0232 the parked window is measured from
  // `dunning_parked_at`, so that is the field to move — moving `due_date` alone leaves
  // the deadline 30 days in the future and this case passes for the wrong reason.
  await withTenant(s.orgId, (tx) =>
    tx
      .update(invoices)
      .set({
        dueDate: new Date(Date.now() - 400 * 24 * HOUR),
        dunningParkedAt: new Date(Date.now() - 400 * 24 * HOUR),
      })
      .where(eq(invoices.id, s.invoiceId)),
  );

  const late = await sweepParked(s.bizId);
  const closed = await state(s.orgId, s.invoiceId);
  console.log(`E: parked sweep=${JSON.stringify(late)}`);
  ok("E: past the deadline the window closes", late.exhausted >= 1, JSON.stringify(late));
  ok(
    "E: in the SAME terminal shape a retry-exhausted invoice reaches",
    closed.inv.status === "not_paid" && closed.inv.dunningStatus === "exhausted",
    `${closed.inv.status}/${closed.inv.dunningStatus}`,
  );

  // Idempotent: a second pass must not re-fire the final action. Again read off the
  // ROW — the terminal state is what proves it was claimed exactly once, and unlike a
  // global counter it cannot be moved by anything else in the database.
  await sweepParked(s.bizId);
  const twice = await state(s.orgId, s.invoiceId);
  ok(
    "E: a second pass leaves it exactly as it was",
    twice.inv.status === "not_paid" && twice.inv.dunningStatus === "exhausted",
    `${twice.inv.status}/${twice.inv.dunningStatus}`,
  );
}

// ── F: a MERCHANT-side park reaches its deadline TOO (2026-09-04) ───────────
// ⚠️ INVERTED on 2026-09-04. This case used to assert the opposite — that a
// `recurring_not_enabled` park could never be closed — because cancelling a
// subscription over OUR gateway misconfiguration punishes a blameless payer. The
// reasoning was right and the remedy was wrong: an exemption bought the invoice
// immortality, and 35 subscriptions sat parked on this code for 13 months, ₹19,85,025
// unbilled. The user's call (2026-09-04): a park is a dunning state and every dunning
// state ends; whether closing CANCELS stays `finalAction.subscription`, and the payer
// is protected by an ops alert raised while the window is still open, not by an
// invoice that can never close.
//
// Note what this case CANNOT do: it cannot pass by accident. A merchant-side park with
// a recent `dunning_parked_at` stays open whatever the code says, so the backdate below
// is load-bearing — without it this asserts nothing.
{
  const s = await scenario("F merchant park", "card", 5_671_500);
  await backdate(s.orgId, s.invoiceId, __afaAbandonHours + 1);
  await sweepCharges(s.bizId);
  // Same parked state, different reason — rewritten on the payment the sweep books.
  await withTenant(s.orgId, (tx) =>
    tx
      .update(payments)
      .set({ failureCode: "recurring_not_enabled" })
      .where(eq(payments.invoiceId, s.invoiceId)),
  );
  await withTenant(s.orgId, (tx) =>
    tx
      .update(invoices)
      .set({
        dueDate: new Date(Date.now() - 400 * 24 * HOUR),
        dunningParkedAt: new Date(Date.now() - 400 * 24 * HOUR),
      })
      .where(eq(invoices.id, s.invoiceId)),
  );
  await sweepParked(s.bizId);
  const { inv } = await state(s.orgId, s.invoiceId);
  // This row, not the counter — see case E on why a global count is not hermetic here.
  ok(
    "F: a merchant-side park now closes at its deadline, like every other park",
    inv.status === "not_paid" && inv.dunningStatus === "exhausted",
    `${inv.status}/${inv.dunningStatus}`,
  );
  // …and the thing that replaced the exemption actually covers this code. Without this
  // the change is a silent cancellation instead of a flagged one.
  ok(
    "F: and the code is in MERCHANT_SIDE_PARK, so the ops alert will name it",
    MERCHANT_SIDE_PARK.has("recurring_not_enabled") &&
      MERCHANT_SIDE_PARK.has("gateway_limit_exceeded"),
    `set=${[...MERCHANT_SIDE_PARK].join(",")}`,
  );
}

// ── G: the buyer says they will not authorise it ─────────────────────────────
// The portal escape hatch. Inside the window — the whole point is that they do not
// have to wait it out — and the gateway still says `created`, so their word is what
// releases it. Nothing here may touch money: the debit is unsettled at the gateway.
{
  const s = await scenario("G buyer abandons", "card", 5_671_500);
  const res = await abandonAuthenticationPendingDebit({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoiceId: s.invoiceId,
    // These sections exercise the PORTAL path — the buyer releasing their own debit.
    endedBy: "customer",
    now: new Date(),
  });
  const { inv, txn, pay } = await state(s.orgId, s.invoiceId);
  ok("G: the debit is released on the buyer's word", res.outcome === "released", res.outcome);
  ok(
    "G: with no backdating at all — they never wait out the window",
    txn.status === "failed",
    txn.status,
  );
  ok(
    "G: booked as afa_not_completed, non-retriable",
    txn.errorCode === "afa_not_completed" && txn.retriable === false,
    `${txn.errorCode}/${txn.retriable}`,
  );
  ok(
    "G: the payment is no longer pending, so Pay now is unblocked",
    pay.status !== "pending",
    pay.status,
  );
  ok("G: the invoice is still open and collectible", inv.status === "payment_due", inv.status);
  /**
   * The text names the buyer — correctly, HERE. This surface is the buyer saying "I won't
   * approve this", so the sentence may attribute it to them. Paired with the Q assertion
   * below, which proves the sweep does NOT reuse it. The pair is the point: one of these
   * passing alone would not tell you the attribution is decided by cause.
   */
  ok(
    "G: …and the text attributes it to the buyer, who did in fact end it",
    /at their request/.test(pay.failureMessage ?? ""),
    pay.failureMessage ?? "(none)",
  );
}

// ── H: the buyer is wrong — it had already gone through ──────────────────────
// The reason this asks the gateway before it believes anyone. A buyer about to pay
// again must be told their money already arrived, not handed a Pay-now button.
{
  const s = await scenario("H already paid", "card", 5_671_500);
  const { txn: before } = await state(s.orgId, s.invoiceId);
  await setChargeStatus(before.idAtGateway!, "succeeded");
  const res = await abandonAuthenticationPendingDebit({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoiceId: s.invoiceId,
    // These sections exercise the PORTAL path — the buyer releasing their own debit.
    endedBy: "customer",
    now: new Date(),
  });
  const { inv, txn } = await state(s.orgId, s.invoiceId);
  ok("H: a landed debit is settled, never overruled", res.outcome === "settled", res.outcome);
  ok(
    "H: the invoice is PAID",
    inv.status === "paid" && txn.status === "succeeded",
    `${inv.status}/${txn.status}`,
  );
}

// ── I: a debit that does not wait on the buyer is not theirs to abandon ──────
// A netbanking presentation lands on its own. Letting it be "abandoned" would invite
// exactly the double payment the in-flight block exists to prevent.
{
  const s = await scenario("I not afa", "emandate", 6_602_500);
  const res = await abandonAuthenticationPendingDebit({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoiceId: s.invoiceId,
    // These sections exercise the PORTAL path — the buyer releasing their own debit.
    endedBy: "customer",
    now: new Date(),
  });
  const { txn } = await state(s.orgId, s.invoiceId);
  ok(
    "I: refused — this one is not waiting on them",
    res.outcome === "not_authentication",
    res.outcome,
  );
  ok("I: and the debit is untouched", txn.status === "in_progress", txn.status);
}

/**
 * Deliver a real `charge.succeeded` for a charge, through the REAL inbound pipeline
 * (signature verify → normalize → dedup → reconcile) rather than by calling the
 * handler. `triggerSyntheticEvent` is the gateway's own test hook.
 */
async function captureLands(orgId: string, bizId: string, chargeId: string) {
  await setChargeStatus(chargeId, "succeeded");
  const provider = new TmtestProvider(bizId);
  await provider.triggerSyntheticEvent("charge.succeeded", { charge_id: chargeId });
  return advanceTmtest(orgId, new Date());
}

const refundsFor = (orgId: string, paymentId: string) =>
  withTenant(orgId, (tx) => tx.select().from(refunds).where(eq(refunds.paymentId, paymentId)));
const excessOf = (orgId: string, customerId: string, currency: string) =>
  withTenant(orgId, (tx) => bucketBalance(tx, customerId, EXCESS_PAYMENT, currency));

// ── J: the capture lands and the invoice can still take it ───────────────────
// The case that is NOT a double payment: the buyer abandoned, never got round to
// paying, and the debit arrived late. Before this the event was dropped as
// `'ignored'` and we kept dunning them for money they had paid.
{
  const s = await scenario("J late capture applies", "card", 5_671_500);
  const { txn: live } = await state(s.orgId, s.invoiceId);
  await abandonAuthenticationPendingDebit({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoiceId: s.invoiceId,
    // These sections exercise the PORTAL path — the buyer releasing their own debit.
    endedBy: "customer",
    now: new Date(),
  });
  await captureLands(s.orgId, s.bizId, live.idAtGateway!);
  const { inv, txn, pay } = await state(s.orgId, s.invoiceId);
  ok("J: the invoice is PAID by the late capture", inv.status === "paid", inv.status);
  ok(
    "J: the payment is succeeded and still linked to its invoice",
    pay.status === "succeeded" && pay.invoiceId != null,
    `${pay.status}/${pay.invoiceId != null}`,
  );
  ok(
    "J: the failure is retracted, not left beside a success",
    txn.status === "succeeded" && txn.errorCode === null,
    `${txn.status}/${txn.errorCode}`,
  );
  ok(
    "J: nothing is refunded — this money was owed",
    (await refundsFor(s.orgId, pay.id)).length === 0,
  );
}

// ── K: the capture lands after they already paid — the real double payment ───
// Abandon, pay the invoice by another means (the whole point of the escape hatch),
// then the bank's request is approved after all. Two payments, one bill.
{
  const s = await scenario("K double payment", "card", 5_671_500);
  const { txn: live, inv: before } = await state(s.orgId, s.invoiceId);
  await abandonAuthenticationPendingDebit({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoiceId: s.invoiceId,
    // These sections exercise the PORTAL path — the buyer releasing their own debit.
    endedBy: "customer",
    now: new Date(),
  });
  // They pay it another way — the released invoice settled by a second, real payment.
  await recordOfflinePayment({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoicePublicId: before.publicId,
    method: "wire",
  });
  await captureLands(s.orgId, s.bizId, live.idAtGateway!);

  const { inv } = await state(s.orgId, s.invoiceId);
  const [captured] = await withTenant(s.orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(
        and(eq(payments.providerChargeId, live.idAtGateway!), eq(payments.status, "succeeded")),
      ),
  );
  ok("K: the duplicate capture is booked, not dropped", captured != null);
  ok(
    "K: DETACHED from the invoice, so it cannot inflate what the invoice collected",
    captured?.invoiceId == null,
    String(captured?.invoiceId),
  );
  ok("K: the invoice is paid exactly once", inv.status === "paid", inv.status);
  const invPaid = await withTenant(s.orgId, (tx) => paidTotals(tx, [s.invoiceId]));
  ok(
    "K: …and its amount_paid is the ONE payment that paid it",
    (invPaid.get(s.invoiceId) ?? 0n) === before.totalMinor,
    `${invPaid.get(s.invoiceId)} vs ${before.totalMinor}`,
  );

  const refs = await refundsFor(s.orgId, captured!.id);
  ok(
    "K: the duplicate is refunded automatically",
    refs.length === 1 && refs[0]!.status === "succeeded",
    refs.map((r) => r.status).join(",") || "none",
  );
  // Booked as a liability, then cleared by the payout — the bucket nets to zero.
  ok(
    "K: the customer credit it was booked against is back to zero",
    (await excessOf(s.orgId, captured!.customerId, captured!.currency)) === 0n,
    String(await excessOf(s.orgId, captured!.customerId, captured!.currency)),
  );
}

// ── L: a SECOND capture event for the same charge books nothing ──────────────
// Not the dedup layer — that catches a redelivery of the same event id. This is two
// DIFFERENT events naming one charge, which gateways really do send. The claim inside
// `settleAbandonedCapture` is the only thing standing between that and a double
// booking plus a second refund.
{
  const s = await scenario("L twice", "card", 5_671_500);
  const { txn: live, inv: before } = await state(s.orgId, s.invoiceId);
  await abandonAuthenticationPendingDebit({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoiceId: s.invoiceId,
    // These sections exercise the PORTAL path — the buyer releasing their own debit.
    endedBy: "customer",
    now: new Date(),
  });
  await recordOfflinePayment({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoicePublicId: before.publicId,
    method: "wire",
  });
  await captureLands(s.orgId, s.bizId, live.idAtGateway!);
  await captureLands(s.orgId, s.bizId, live.idAtGateway!); // a second, differently-identified event
  const [captured] = await withTenant(s.orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(
        and(eq(payments.providerChargeId, live.idAtGateway!), eq(payments.status, "succeeded")),
      ),
  );
  const refs = await refundsFor(s.orgId, captured!.id);
  ok("L: still exactly one refund", refs.length === 1, String(refs.length));
  ok(
    "L: and the credit bucket is still zero, not negative",
    (await excessOf(s.orgId, captured!.customerId, captured!.currency)) === 0n,
    String(await excessOf(s.orgId, captured!.customerId, captured!.currency)),
  );
}

// ── M: the refund itself fails — the money stays as customer credit ──────────
// The fallback that makes the auto-refund safe to attempt. A failed payout must not
// lose the money or the record of it: it stays in `excess_payment_balance`, which is
// a real state the customer's balances panel shows and an operator can act on.
{
  // Amount ending in 13 → tmtest fails the refund (`isNeedsAttentionAmount`). The payout
  // is genuinely ATTEMPTED and rejected by the gateway, which is what this case is about.
  // It used to be forced by NULLing the payment's `provider_charge_id`, and that stopped
  // simulating anything once `settleAbandonedCapture` began backfilling the reference —
  // the refund then succeeded and this section asserted the wrong outcome.
  const s = await scenario("M refund fails", "card", 5_671_513);
  const { txn: live, inv: before } = await state(s.orgId, s.invoiceId);
  await abandonAuthenticationPendingDebit({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoiceId: s.invoiceId,
    // These sections exercise the PORTAL path — the buyer releasing their own debit.
    endedBy: "customer",
    now: new Date(),
  });
  await recordOfflinePayment({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoicePublicId: before.publicId,
    method: "wire",
  });
  await captureLands(s.orgId, s.bizId, live.idAtGateway!);
  const [captured] = await withTenant(s.orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.id, live.paymentId!)),
  );
  ok("M: the capture is still booked", captured?.status === "succeeded", String(captured?.status));
  ok("M: no refund was recorded", (await refundsFor(s.orgId, live.paymentId!)).length === 0);
  ok(
    "M: and the money is held as customer credit, not lost",
    (await excessOf(s.orgId, captured!.customerId, captured!.currency)) === captured!.amountMinor,
    `${await excessOf(s.orgId, captured!.customerId, captured!.currency)} vs ${captured!.amountMinor}`,
  );
}

// ── N: the intent TTL table has not drifted from this sweep's grace table ────
/**
 * The one thing that stops two copies of one table diverging in silence.
 *
 * `payment-intents/ttl.ts` decides how long a payment intent stays live, and it needs
 * the SAME per-rail worst cases this sweep uses — an e-mandate that takes 2 working days
 * to authorize is 2 working days at both ends of the flow. It cannot import them: that
 * import closes a cycle (payment-intents/service → payments/stale-pending →
 * payments/settlement → invoicing/service → payment-intents/service), so the table is
 * duplicated there with a comment pointing at this check.
 *
 * Retuning one rail is fine — retuning it in ONE file is what this catches. Both
 * directions matter: a TTL shorter than its grace period expires an intent while the
 * sweep still considers the debit healthy (which is how a late authorization gets
 * dropped: INV-5510, `pay_XXXXXXXXXXXX03`), and one longer holds the double-charge guard
 * open past the point anyone is still waiting.
 */
{
  const rails = [
    ...new Set([
      ...Object.keys(RAIL_TTL_HOURS),
      "emandate",
      "nach",
      "card",
      "upi",
      "bank_transfer",
    ]),
  ];
  const drifted = rails.filter((rail) => railTtlHours(rail) !== __graceHoursFor(rail, null));
  ok(
    "N: every rail's intent TTL matches its sweep grace period",
    drifted.length === 0,
    drifted
      .map((r) => `${r}: ttl ${railTtlHours(r)}h vs grace ${__graceHoursFor(r, null)}h`)
      .join(", ") || rails.map((r) => `${r}=${railTtlHours(r)}h`).join(" "),
  );
  // The default is the other half of the table: an uncharacterised rail must get the same
  // benefit of the doubt in both files, not 72h here and an hour there.
  ok(
    "N: and so does the uncharacterised-rail default",
    DEFAULT_RAIL_TTL_HOURS === __graceHoursFor("a-rail-nobody-has-characterised", null),
    `${DEFAULT_RAIL_TTL_HOURS}h vs ${__graceHoursFor("a-rail-nobody-has-characterised", null)}h`,
  );
  /**
   * A rail added to the SWEEP's table and forgotten in the TTL copy would slip past the
   * loop above — it iterates the TTL table's own keys, so a rail absent from it is never
   * compared, and both files would answer the default while the deadlines diverge.
   *
   * The sweep does not export its table (only `__graceHoursFor`), so the check probes
   * every rail name this codebase can put in `mandate_rail` or `payment_methods.type`
   * and asks which of them the sweep treats specially. Any rail it does, and the TTL
   * table does not name, is drift.
   */
  const KNOWN_RAILS = [
    "card",
    "upi",
    "emandate",
    "nach",
    "bank_transfer",
    "netbanking",
    "wallet",
    "paypal",
    "ach",
    "sepa",
    "bacs",
    "apple_pay",
    "google_pay",
  ];
  const gracedButUnpinned = KNOWN_RAILS.filter(
    (r) =>
      __graceHoursFor(r, null) !== __graceHoursFor("a-rail-nobody-has-characterised", null) &&
      !(r in RAIL_TTL_HOURS),
  );
  ok(
    "N: no rail is graced by the sweep but missing from the TTL table",
    gracedButUnpinned.length === 0,
    gracedButUnpinned.map((r) => `${r}=${__graceHoursFor(r, null)}h`).join(", "),
  );
}

// ── O: the capture lands and NO WEBHOOK EVER ARRIVES ─────────────────────────
// J and K both depend on a delivery. Until 2026-08-31 that dependency WAS the recovery:
// `settleAbandonedCapture` was reachable from the inbound webhook and nowhere else (its
// own docblock said so), and the main pass cannot reach these rows because it selects
// `in_progress` while an abandoned debit is `failed`. So one lost delivery — a
// mis-provisioned endpoint, a tunnel down during the window, the gateway exhausting its
// retries — meant the buyer's money was gone with nothing in our books and nothing that
// would ever look again.
//
// Same shape as J, with the webhook deliberately NOT delivered: the charge simply
// succeeds at the gateway and the sweep has to find it by asking.
{
  const s = await scenario("O no webhook", "card", 5_671_500);
  const { txn: live } = await state(s.orgId, s.invoiceId);
  await abandonAuthenticationPendingDebit({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoiceId: s.invoiceId,
    // These sections exercise the PORTAL path — the buyer releasing their own debit.
    endedBy: "customer",
    now: new Date(),
  });
  // The buyer approves it at their bank after telling us they would not — by mistake, or
  // by finishing the link they had ignored. NO `triggerSyntheticEvent`: this is the whole
  // point of the case.
  await setChargeStatus(live.idAtGateway!, "succeeded");

  // A debit that came back `requires_action` never had a charge, so the payment row
  // carries NO gateway reference. Forced here because the harness fills it in and the
  // real thing does not — and without that gap the backfill assertion below is vacuous.
  await withTenant(s.orgId, (tx) =>
    tx.update(payments).set({ providerChargeId: null }).where(eq(payments.id, live.paymentId!)),
  );

  const before = await state(s.orgId, s.invoiceId);
  ok(
    "O: precondition — the local record says the debit failed",
    before.txn.status === "failed" && before.txn.errorCode === "afa_not_completed",
    `${before.txn.status}/${before.txn.errorCode}`,
  );
  ok(
    "O: precondition — and the payment has no gateway reference to refund against",
    before.pay.providerChargeId == null,
    String(before.pay.providerChargeId),
  );
  ok(
    "O: precondition — and the invoice is still unpaid",
    before.inv.status !== "paid",
    before.inv.status,
  );

  const r = await sweepCharges(s.bizId);
  ok(
    "O: the sweep re-asks about the abandoned debit",
    r.afaRechecked >= 1,
    `rechecked=${r.afaRechecked}`,
  );
  ok("O: …and recovers it", r.afaRecovered >= 1, `recovered=${r.afaRecovered}`);

  const { inv, txn, pay } = await state(s.orgId, s.invoiceId);
  ok("O: the invoice is PAID with no webhook involved", inv.status === "paid", inv.status);
  ok("O: the payment is succeeded", pay.status === "succeeded", pay.status);
  ok(
    "O: the failure is retracted, not left beside a success",
    txn.status === "succeeded" && txn.errorCode === null,
    `${txn.status}/${txn.errorCode}`,
  );
  ok(
    "O: nothing is refunded — this money was owed",
    (await refundsFor(s.orgId, pay.id)).length === 0,
  );
  /**
   * Refundability is part of booking it, not a later nicety.
   *
   * Without the backfill in `settleAbandonedCapture` the revived payment keeps a NULL
   * `provider_charge_id`, so `refundPayment` throws "Payment has no provider charge to
   * refund" — swallowed by `refundUnappliedExcess` into a log line — and the money lands
   * as excess credit that nothing can hand back. Two real Stripe captures (₹35,472.22)
   * reached that state on 2026-09-05.
   */
  ok(
    "O: the revived payment carries the gateway reference, so it CAN be refunded",
    pay.providerChargeId === live.idAtGateway,
    `${pay.providerChargeId} vs ${live.idAtGateway}`,
  );

  // The claim inside `settleAbandonedCapture` is the only idempotency guard, and the sweep
  // runs every tick — so a second pass must find nothing left to do.
  const again = await sweepCharges(s.bizId);
  ok(
    "O: a second sweep recovers nothing twice",
    again.afaRecovered === 0,
    `recovered=${again.afaRecovered}`,
  );
}

// ── P: a SECOND checkout on one invoice — the INV-5510 shape, end to end ─────
// The production incident, reproduced through the real inbound pipeline. A buyer pressed
// portal "Pay now" twice; the first payment settled the invoice and the second
// (pay_XXXXXXXXXXXX03, real money) arrived as a charge the engine had NO transactions row
// for — `reconcileChargeSucceeded` did `if (!txn) return "ignored"`, three times, and the
// money existed nowhere: not in the ledger, not in Transactions, not refundable.
//
// The route guard now stops the second order being minted at all
// (verify:customer-portal), so this case covers the OTHER half: a capture that reaches us
// anyway must be booked and — since 2026-09-01, when the two excess policies were
// converged — handed straight back.
//
// An UNCONSUMED intent is the one way to get a real gateway charge with no transaction
// behind it (`providers/types.ts`: "an unconsumed intent has no `transactions` row"), which
// is exactly what the second "Pay now" leaves.
{
  const s = await scenario("P second checkout", "card", 5_671_500);
  const { inv: before } = await state(s.orgId, s.invoiceId);

  // The first payment settles the invoice, by any means.
  await recordOfflinePayment({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoicePublicId: before.publicId,
    method: "wire",
  });

  // The second "Pay now": its own intent, its own gateway order — never consumed.
  const [pm] = await withTenant(s.orgId, (tx) =>
    tx.select().from(pmTable).where(eq(pmTable.id, s.pmId)),
  );
  const second = await createPaymentIntent({
    organizationId: s.orgId,
    businessId: s.bizId,
    paymentMethodPublicId: pm!.publicId,
    amountMinor: Number(before.totalMinor),
    currency: before.currency,
    invoicePublicId: before.publicId,
  });
  const gatewayIntentId = second.intent.intentAtGateway!;
  const chargeId = second.attempt.idAtGateway ?? gatewayIntentId;
  ok("P: the second checkout has an intent and no transaction of its own", gatewayIntentId != null);

  // The buyer completes it at their bank. The charge is real; our side never consumed it.
  await setChargeStatus(chargeId, "succeeded");
  const provider = new TmtestProvider(s.bizId);
  // `provider_intent_id` alongside the charge is what lets an unmatched capture be
  // ATTRIBUTED at all — the RazorPay adapter reads it off payment.entity.order_id, and
  // tmtest carried no equivalent until 2026-09-01, which made this path untestable.
  await provider.triggerSyntheticEvent("charge.succeeded", {
    charge_id: chargeId,
    provider_intent_id: gatewayIntentId,
  });
  await advanceTmtest(s.orgId, new Date());

  const [captured] = await withTenant(s.orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.providerChargeId, chargeId)),
  );
  ok("P: the unmatched capture is BOOKED, not ignored", captured != null);
  ok("P: …and succeeded", captured?.status === "succeeded", captured?.status ?? "—");
  ok(
    "P: …DETACHED from the invoice, so it cannot inflate what the invoice collected",
    captured != null && captured.invoiceId === null,
    String(captured?.invoiceId),
  );
  // The VALUE matters, not just the key: it is the cause the alert reports to an operator,
  // and the specific caller must win over the generic one it delegates to (see
  // `markUnapplied` — the first run of this case caught exactly that overwrite).
  ok(
    "P: …and marked for the ops alert with the SPECIFIC cause",
    (captured?.metadata as Record<string, unknown> | null)?.unapplied_gateway_capture ===
      "second_checkout",
    JSON.stringify(captured?.metadata ?? null),
  );

  const { inv: after } = await state(s.orgId, s.invoiceId);
  ok("P: the invoice is paid exactly once", after.status === "paid", after.status);
  const paid = await withTenant(s.orgId, (tx) => paidTotals(tx, [s.invoiceId]));
  ok(
    "P: …and its amount_paid is the ONE payment that paid it",
    (paid.get(s.invoiceId) ?? 0n) === before.totalMinor,
    `${paid.get(s.invoiceId)} vs ${before.totalMinor}`,
  );

  // The converged policy: money nothing can apply goes BACK.
  const refs = captured ? await refundsFor(s.orgId, captured.id) : [];
  ok(
    "P: the duplicate is refunded automatically (converged policy, 2026-09-01)",
    refs.length === 1 && refs[0]!.status === "succeeded",
    refs.map((r) => r.status).join(",") || "none",
  );
}

// ── Q: a debit still LIVE at the rail against an invoice that owes NOTHING ────
/**
 * The buyer-portal report of 2026-08-31: four invoices reading "Paid", due ₹0.00, each
 * inviting the customer in the same row to approve their bank's request. The copy was
 * fixed first; copy does not cancel a request, so the mandate stayed live at the rail and
 * an approval outside our UI would still have collected against an invoice owing nothing.
 *
 * Measured database-wide 2026-09-01 (`scripts/probe-zero-due-debits.ts` § C): 211
 * `in_progress` transactions on invoices with `amount_due_minor = 0`, every one against an
 * invoice already `paid`.
 *
 * The producer here is a buyer paying ANOTHER WAY while the e-mandate debit is still in
 * flight — not the credit note the report came from. That is the point of the pass and so
 * of the case: it keys on the CONDITION rather than on any one producer, so a settlement
 * path nobody has written yet is covered on the day it ships.
 *
 * ⚠️ Backdated ONE hour, deliberately far inside a card's 96h grace. The first pass will
 * not poll this row for days — which is exactly the gap: without a third pass the request
 * stays live at the bank for the whole of the AFA link's 72 hours.
 */
{
  const s = await scenario("Q zero due afa", "card", 5_671_500);
  const start = await state(s.orgId, s.invoiceId);
  const debitTxnId = start.txn.id;
  const debitPayId = start.pay.id;
  ok(
    "Q: precondition — a live AFA debit is in flight",
    start.txn.status === "in_progress" && start.pay.status === "pending",
    `${start.txn.status}/${start.pay.status}`,
  );

  // The buyer pays another way. The invoice settles; the debit is left where it was.
  await recordOfflinePayment({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoicePublicId: start.inv.publicId,
    method: "cheque",
  });
  /**
   * ⚠️ "Owes nothing" is the DERIVED outstanding, never `amount_due_minor`.
   *
   * That column is the issue-time collectible and cash never moves it
   * (`db/schema/invoices.ts`). This assertion was written against it on the first draft and
   * FAILED here reading `paid/5671500` — a settled invoice whose column still says the full
   * ₹56,715 — which is what proved the sweep's own predicate had the same bug. Kept as a
   * derived check so the case can never quietly go back to the column.
   */
  const owed = async () =>
    withTenant(s.orgId, async (tx) => {
      const [i] = await tx.select().from(invoices).where(eq(invoices.id, s.invoiceId)).limit(1);
      const paid = (await paidTotals(tx, [s.invoiceId])).get(s.invoiceId) ?? 0n;
      return { inv: i!, remaining: (i!.amountDueMinor ?? i!.totalMinor) - paid };
    });
  const settled = await owed();
  ok(
    "Q: precondition — the invoice now owes nothing",
    settled.inv.status === "paid" && settled.remaining <= 0n,
    `${settled.inv.status}/remaining=${settled.remaining}`,
  );
  const stillLive = await withTenant(s.orgId, (tx) =>
    tx.select().from(transactions).where(eq(transactions.id, debitTxnId)).limit(1),
  );
  ok(
    "Q: precondition — and the debit is STILL live at the rail",
    stillLive[0]!.status === "in_progress",
    stillLive[0]!.status,
  );

  await backdate(s.orgId, s.invoiceId, 1);
  const q = await sweepCharges(s.bizId);
  // A lower bound, per this file's header: the database is not truncated between runs, so
  // the counter is shared. The row assertions below are the exact ones.
  ok("Q: the zero-due pass examined it", q.zeroDueExamined >= 1, `examined=${q.zeroDueExamined}`);
  const closedTxn = (
    await withTenant(s.orgId, (tx) =>
      tx.select().from(transactions).where(eq(transactions.id, debitTxnId)).limit(1),
    )
  )[0]!;
  ok(
    "Q: the outstanding debit is no longer live at the rail",
    closedTxn.status === "failed" && closedTxn.errorCode === "afa_not_completed",
    `${closedTxn.status}/${closedTxn.errorCode}`,
  );
  /**
   * AND IT DOES NOT BLAME THE CUSTOMER. Nobody declined anything here — an operator's
   * credit note cleared the invoice and the sweep ended the debit. Until 2026-09-03 this
   * path reused the buyer's sentence from G, and because `emailTypeForEvent` maps every
   * `payment_failed` to the payer's mail unconditionally, the customer was told they had
   * declined the debit and asked to pay another way.
   */
  ok(
    "Q: …and non-retriable — re-presenting a debit nobody owes is not a second chance",
    closedTxn.retriable === false,
    String(closedTxn.retriable),
  );
  const closedPay = (
    await withTenant(s.orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.id, debitPayId)).limit(1),
    )
  )[0]!;
  ok("Q: the pending payment row is closed too", closedPay.status === "failed", closedPay.status);
  ok(
    "Q: …and the text blames the credit, not a customer who did nothing",
    /no longer owes anything/.test(closedPay.failureMessage ?? "") &&
      !/customer declined|at their request/i.test(closedPay.failureMessage ?? ""),
    closedPay.failureMessage ?? "(none)",
  );
  // The whole point is that a SETTLED invoice must come out unchanged: this pass ends a
  // request, it does not reopen a debt.
  const afterInv = await owed();
  ok(
    "Q: the invoice is left paid and owing nothing",
    afterInv.inv.status === "paid" && afterInv.remaining <= 0n,
    `${afterInv.inv.status}/remaining=${afterInv.remaining}`,
  );

  // Idempotent across ticks — asserted on the ROW, never on the shared counter.
  await sweepCharges(s.bizId);
  const twice = (
    await withTenant(s.orgId, (tx) =>
      tx.select().from(transactions).where(eq(transactions.id, debitTxnId)).limit(1),
    )
  )[0]!;
  ok(
    "Q: a second tick finds nothing left to do on it",
    twice.status === "failed" && twice.errorCode === "afa_not_completed",
    `${twice.status}/${twice.errorCode}`,
  );
}

// ── Q3: a non-AFA debit that ALREADY SETTLED is detected, not ignored ─────────
/**
 * Q2 establishes that a debit which lands on its own must NOT be failed locally, and that
 * is right. But until 2026-09-03 the pass drew the wrong conclusion from it: the AFA gate
 * returned `not_authentication` BEFORE resolving an adapter, so a non-AFA debit on a
 * zero-due invoice was never ASKED ABOUT AT ALL — including one that had already settled
 * at the rail. Money arrives for a debt a credit note relieved, and nothing notices.
 *
 * Measured the same day: 209 in-flight debits sat on zero-due invoices — the population
 * the leave-alone comment in `abandonZeroDueDebits` counts — and not one of them was
 * queried, on any provider, because none was INR-above-₹15,000 on an AFA rail.
 *
 * This is the assertion that would have caught it. Same shape as Q2 (₹120, below the AFA
 * threshold, so `debitNeedsBuyerAuthentication` is false), except the rail reports the
 * debit SUCCEEDED. The row must end up booked as money that moved.
 */
{
  const s = await scenario("Q3 zero due non-afa settled", "card", 12_000);
  const start = await state(s.orgId, s.invoiceId);
  const startPays = await withTenant(s.orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, s.invoiceId)),
  );
  // Zero the invoice with cash, exactly as Q2 does — so the debit below is chasing a debt
  // that no longer exists.
  await recordOfflinePayment({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoicePublicId: start.inv.publicId,
    method: "cheque",
  });
  // …and the rail says the debit went through after all. This is the case that was silent.
  await setChargeStatus(start.txn.idAtGateway!, "succeeded");
  await backdate(s.orgId, s.invoiceId, 1);
  await sweepCharges(s.bizId);
  const after = (
    await withTenant(s.orgId, (tx) =>
      tx.select().from(transactions).where(eq(transactions.id, start.txn.id)).limit(1),
    )
  )[0]!;
  ok(
    "Q3: a settled non-AFA debit on a zero-due invoice is detected and booked",
    after.status === "succeeded",
    `${after.status}/${after.errorCode ?? "-"}`,
  );
  // The other half of Q2's rule still holds: nothing was invented for it on the way.
  ok(
    "Q3: …and no failure code was invented for money that moved",
    after.errorCode === null,
    String(after.errorCode),
  );
  /**
   * WHERE THE MONEY GOES, which is the half that matters to a customer.
   *
   * The debit landed for a debt that was already cleared in cash, so applying it to the
   * invoice would over-pay a paid invoice. The engine books it `succeeded` and DETACHES it
   * (`invoice_id` null) — money held against the customer, attached to nothing. Asserted
   * because both halves can fail independently and quietly: losing the payment row would
   * lose the record of money that moved, and leaving it attached would show an invoice
   * paid twice.
   *
   * Measured by probe 2026-09-03 before being written as an assertion — a per-invoice
   * query cannot tell "no row" from "row moved", since `settlement.ts` re-points
   * `payments.invoice_id`.
   */
  const [invRow] = await withTenant(s.orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, s.invoiceId)).limit(1),
  );
  const cusPays = await withTenant(s.orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.customerId, invRow!.customerId)),
  );
  const late = cusPays.find((x) => x.providerKey === "tmtest");
  ok(
    "Q3: the late capture is booked as money that moved",
    late?.status === "succeeded",
    `${late?.status ?? "missing"}/${late?.amountMinor ?? "-"}`,
  );
  ok(
    "Q3: …and detached from the invoice it can no longer pay",
    late?.invoiceId === null,
    `invoice_id=${late?.invoiceId ?? "null"}`,
  );
  ok(
    "Q3: …leaving the settled invoice paid exactly once",
    invRow!.status === "paid" &&
      cusPays.filter((x) => x.invoiceId === s.invoiceId && x.status === "succeeded").length === 1,
    `${invRow!.status}/${cusPays.filter((x) => x.invoiceId === s.invoiceId && x.status === "succeeded").length} applied`,
  );

  /**
   * ── Q4: and the money we hold can be PAID BACK, against the right account ────
   *
   * The exit that makes the detach above acceptable rather than a trap. `refundPayment`
   * takes `contraAccount: 'excess_payment_balance'` for exactly this money, and the reason
   * is an accounting one the source states plainly: the capture was booked as a LIABILITY
   * to the customer and never as revenue, so paying it back must CLEAR that liability.
   * Posting it to `refunds` instead would invent a contra-revenue entry for revenue that
   * was never recognised — a misstatement that changes NO customer-visible number, which
   * is why no screen would ever reveal it and why it is asserted here.
   *
   * Written 2026-09-03 because nothing tested this leg: the contract was read from the
   * source and taken on trust in the same session that had already been wrong five times
   * by reading instead of measuring.
   */
  /**
   * Stamp the gateway's own charge id first, which production has and this fixture did not:
   * tmtest books the capture without one, and `refundPayment` refuses a payment it cannot
   * name at the rail ("Payment has no provider charge to refund"). Measured on the real
   * journey, captures DO carry it (`pay_XXXXXXXXXXXX08`), and 320 of the 341 detached
   * captures in the dev database have one — so refusing is the minority path, and the
   * documented fallback (hold as credit, alert, refund by hand) covers it. What was never
   * tested is the majority path, which is what this asserts.
   */
  await withTenant(s.orgId, (tx) =>
    tx
      .update(payments)
      .set({ providerChargeId: `ch_${late!.publicId.slice(-10)}` })
      .where(eq(payments.id, late!.id)),
  );
  const refunded = await refundPayment({
    organizationId: s.orgId,
    businessId: s.bizId,
    paymentPublicId: late!.publicId,
    contraAccount: "excess_payment_balance",
  });
  ok(
    "Q4: money held with no invoice can be refunded",
    refunded !== undefined,
    String(refunded?.publicId ?? "none"),
  );
  // The contra account is debited ON SETTLE, not at creation (see `refundPayment`'s doc),
  // so the ledger is empty until the rail confirms. tmtest confirms on advance.
  await advanceTmtest(s.orgId, new Date());
  const [refundRow] = await withTenant(s.orgId, (tx) =>
    tx.select().from(refunds).where(eq(refunds.id, refunded!.id)).limit(1),
  );
  const q4Ledger = await withTenant(s.orgId, (tx) =>
    // `sourceId` is the refund's PUBLIC id, not its uuid (`refunds/service.ts:377`) — the
    // first draft of this query read `.id` and found nothing, which looks identical to a
    // ledger that was never written.
    tx.select().from(ledgerEntries).where(eq(ledgerEntries.sourceId, refunded!.publicId)),
  );
  const debited = q4Ledger.filter((e) => e.direction === "debit").map((e) => e.account);
  const credited = q4Ledger.filter((e) => e.direction === "credit").map((e) => e.account);
  ok(
    "Q4: …clearing the liability we booked, not revenue we never recognised",
    debited.includes("excess_payment_balance") && !debited.includes("refunds"),
    `refund=${refundRow?.status ?? "missing"} debit=[${debited.join(",")}]`,
  );
  ok("Q4: …and the cash leaves", credited.includes("cash"), `credit=[${credited.join(",")}]`);
}

// ── Q5: the change screen is TOLD before it credits an invoice with a live debit ──
/**
 * The preventive half of everything above. Crediting an invoice does not cancel a debit
 * already in flight against it, and on a card mandate nothing can — so the operator can
 * spare the customer a charge-then-refund detour by having them release it first. They can
 * only choose that if the estimate says so, which it did not until 2026-09-03.
 *
 * Uses `scenario()` untouched: it bills through the real collection path with the
 * live-async instrument, so the invoice is left UNPAID with a debit the rail has accepted
 * and not settled — exactly the state the change screen needs to warn about. Then a
 * downgrade, whose credit routes to that open invoice.
 */
{
  const s5 = await scenario("Q5 estimate warns", "card", 5_671_500);
  const start5 = await state(s5.orgId, s5.invoiceId);
  const [sub5] = await withTenant(s5.orgId, (tx) =>
    tx.select().from(subsTable).where(eq(subsTable.id, start5.inv.subscriptionId!)).limit(1),
  );
  const cheapProduct = await createProduct({
    organizationId: s5.orgId,
    businessId: s5.bizId,
    name: "Q5 cheaper",
    kind: "plan",
  });
  const cheapPrice = await createPrice({
    organizationId: s5.orgId,
    businessId: s5.bizId,
    productId: cheapProduct.id,
    type: "recurring",
    model: "flat",
    currency: "INR",
    amountMinor: 100_000,
    interval: "month",
  });
  const items5 = await withTenant(s5.orgId, (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub5!.id)),
  );
  const est5: any = await estimateChange({
    organizationId: s5.orgId,
    businessId: s5.bizId,
    subscriptionId: sub5!.id,
    now: new Date(),
    changes: [{ itemId: items5[0]!.publicId, newPriceId: cheapPrice.publicId }],
  });
  const named = (est5.debits_in_flight ?? []) as Array<{
    invoice: string;
    awaiting_buyer: boolean;
  }>;
  ok(
    "Q5: the estimate names the invoice whose debit is still live",
    named.length >= 1,
    `debits_in_flight=${JSON.stringify(named)} toOpen=${est5.credit_applied_to_open_invoices_minor ?? 0}`,
  );
  // ₹56,715 on a card mandate is above the ₹15,000 additional-factor threshold, so this
  // debit is waiting on the BUYER — the one case where "ask them to release it" is advice
  // rather than noise, and the flag the copy branches on.
  ok(
    "Q5: …and says the bank is waiting on the customer, which is what makes it actionable",
    named[0]?.awaiting_buyer === true,
    String(named[0]?.awaiting_buyer),
  );
  /**
   * AND IT IS NOT ALWAYS ON. A warning that fires on every edit is one an operator learns
   * to click past, so the same estimate must come back CLEAN once nothing is in flight.
   * This is the half a new field cannot pass by accident: the assertions above hold for a
   * function that hard-codes the flag, and this one does not.
   */
  /**
   * End the PAYMENT, not the transaction. `pendingPaymentsForInvoices` keys on
   * `payments.status = 'pending'` (`invoicing/service.ts:3257`) — the first draft of this
   * teardown ended the transaction only, the warning correctly kept firing, and it read as
   * a false positive in the engine when it was a false premise in the test.
   */
  await withTenant(s5.orgId, (tx) =>
    tx
      .update(payments)
      .set({ status: "failed", failureCode: "q5_ended_the_debit" })
      .where(eq(payments.id, start5.pay.id)),
  );
  const est5After: any = await estimateChange({
    organizationId: s5.orgId,
    businessId: s5.bizId,
    subscriptionId: sub5!.id,
    now: new Date(),
    changes: [{ itemId: items5[0]!.publicId, newPriceId: cheapPrice.publicId }],
  });
  ok(
    "Q5: …and the warning is GONE once no debit is in flight",
    (est5After.debits_in_flight ?? []).length === 0,
    JSON.stringify(est5After.debits_in_flight ?? []),
  );
}

// ── Q2: an ORDINARY slow settlement on a zero-due invoice is LEFT ALONE ───────
/**
 * The negative half of Q, and the reason it is not a bug. A debit that does not wait on
 * the buyer — a netbanking presentation, a UPI Autopay debit, an ACH cycle — WILL land on
 * its own, and failing it locally would not stop it: it would only make the real
 * settlement arrive as `settlement_dropped_not_pending`, losing the booking for money that
 * moved. So `abandonAuthenticationPendingDebit` answers `not_authentication` and the pass
 * leaves the row exactly as it found it.
 *
 * ₹120 on the same card rail: below the RBI/NPCI ₹15,000 AFA threshold, so
 * `debitNeedsBuyerAuthentication` is false for the same instrument that made Q true. That
 * threshold is what separates the 7 INR card debits from the 204 USD test rows in the
 * measured population.
 */
{
  const s = await scenario("Q2 zero due non-afa", "card", 12_000);
  const start = await state(s.orgId, s.invoiceId);
  await recordOfflinePayment({
    organizationId: s.orgId,
    businessId: s.bizId,
    invoicePublicId: start.inv.publicId,
    method: "cheque",
  });
  await backdate(s.orgId, s.invoiceId, 1);
  await sweepCharges(s.bizId);
  const untouched = (
    await withTenant(s.orgId, (tx) =>
      tx.select().from(transactions).where(eq(transactions.id, start.txn.id)).limit(1),
    )
  )[0]!;
  ok(
    "Q2: a non-AFA debit on a zero-due invoice is left in_progress",
    untouched.status === "in_progress",
    untouched.status,
  );
  ok(
    "Q2: …and carries no failure code invented for it",
    untouched.errorCode === null,
    String(untouched.errorCode),
  );
}

// ── R: an INTENT-ONLY debit is in flight, and the change screen must SEE it ────
/**
 * The exact case the in-flight warning missed on 2026-09-03, INV-7824.
 *
 * A buyer-initiated checkout writes a `payment_intents` row and NO `payments` row until
 * its capture settles, so `pendingPaymentsForInvoices` — which selects
 * `payments.status = 'pending'` — reported nothing while ₹22,184.00 was live at RazorPay.
 * 47 seconds later a downgrade credited the invoice to zero, the money captured anyway,
 * and it had to be refunded. The operator was shown no warning because the query could
 * not express one.
 *
 * The fixture is Q5's, minus the payment: bill through the real collection path, then END
 * the payment row (`failed`), so the invoice is open with NOTHING pending — which is the
 * state Q5's last assertion proves is clean — and only then mint the intent. So a warning
 * here can come from the intent alone and from nothing else.
 */
{
  const sR = await scenario("R intent-only", "card", 5_671_500);
  const startR = await state(sR.orgId, sR.invoiceId);
  await withTenant(sR.orgId, (tx) =>
    tx
      .update(payments)
      .set({ status: "failed", failureCode: "r_ended_the_debit" })
      .where(eq(payments.id, startR.pay.id)),
  );
  const [pmR] = await withTenant(sR.orgId, (tx) =>
    tx.select().from(pmTable).where(eq(pmTable.id, sR.pmId)).limit(1),
  );
  const [subR] = await withTenant(sR.orgId, (tx) =>
    tx.select().from(subsTable).where(eq(subsTable.id, startR.inv.subscriptionId!)).limit(1),
  );
  const itemsR = await withTenant(sR.orgId, (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, subR!.id)),
  );
  const cheapR = await createPrice({
    organizationId: sR.orgId,
    businessId: sR.bizId,
    productId: (
      await createProduct({
        organizationId: sR.orgId,
        businessId: sR.bizId,
        name: "R cheaper",
        kind: "plan",
      })
    ).id,
    type: "recurring",
    model: "flat",
    currency: "INR",
    amountMinor: 100_000,
    interval: "month",
  });
  const estR = () =>
    estimateChange({
      organizationId: sR.orgId,
      businessId: sR.bizId,
      subscriptionId: subR!.id,
      now: new Date(),
      changes: [{ itemId: itemsR[0]!.publicId, newPriceId: cheapR.publicId }],
    }) as Promise<any>;
  const beforeIntent = await estR();
  ok(
    "R: with the payment ended and no intent yet, the estimate is CLEAN (the premise)",
    (beforeIntent.debits_in_flight ?? []).length === 0,
    JSON.stringify(beforeIntent.debits_in_flight ?? []),
  );
  const { intent: piR } = await createPaymentIntent({
    organizationId: sR.orgId,
    businessId: sR.bizId,
    purpose: "payment",
    paymentMethodPublicId: pmR!.publicId,
    amountMinor: Number(startR.inv.totalMinor),
    currency: "INR",
    invoicePublicId: startR.inv.publicId,
  });
  const pendingRows = await withTenant(sR.orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, sR.invoiceId), eq(payments.status, "pending"))),
  );
  ok(
    "R: the checkout has an intent and NO payments row — the shape that missed",
    piR.status === "authorized" && pendingRows.length === 0,
    `intent=${piR.status} pending_payments=${pendingRows.length}`,
  );
  const withIntent = await estR();
  const namedR = (withIntent.debits_in_flight ?? []) as Array<{
    invoice: string;
    awaiting_buyer: boolean;
    kind?: string;
  }>;
  ok(
    "R: the estimate names the invoice whose INTENT is live at the gateway",
    namedR.length === 1 && Boolean(namedR[0]!.invoice),
    `debits_in_flight=${JSON.stringify(namedR)}`,
  );
  ok(
    "R: …and says it is an intent, because the remedy differs from a debit's",
    namedR[0]?.kind === "intent",
    String(namedR[0]?.kind),
  );
  /**
   * An AUTHORIZED intent is waiting on the GATEWAY, not on the buyer: the money is held
   * and there is nothing for them to do (the portal's own resume branch says exactly that
   * — it refuses to hand back a checkout for an authorized intent because `next_action` is
   * deliberately cleared). Telling the operator to go ask the customer would send them to
   * a control that cannot act.
   */
  ok(
    "R: an AUTHORIZED intent is not waiting on the buyer",
    namedR[0]?.awaiting_buyer === false,
    String(namedR[0]?.awaiting_buyer),
  );
  /**
   * …and an `in_progress` one IS. That is the state a buyer sits in with the gateway's
   * sheet open (INV-7824's intent was `in_progress` for the whole 47 seconds), and the one
   * where "close the window you have open" is real advice. tmtest authorizes an intent on
   * creation whatever the instrument, so the status is set directly here — the same
   * fixture fiction as `backdate` above, and for the same reason: the mapping is the
   * behaviour under test, not tmtest's timing.
   */
  await withTenant(sR.orgId, (tx) =>
    tx.update(paymentIntents).set({ status: "in_progress" }).where(eq(paymentIntents.id, piR.id)),
  );
  const midCheckout = await estR();
  ok(
    "R: …while an IN-PROGRESS checkout is waiting on the buyer",
    (midCheckout.debits_in_flight ?? [])[0]?.awaiting_buyer === true,
    JSON.stringify(midCheckout.debits_in_flight ?? []),
  );
  /**
   * AND IT IS NOT ALWAYS ON, the same non-vacuity check Q5 carries: void the intent and
   * the warning must go, or the field is a constant.
   */
  await withTenant(sR.orgId, (tx) =>
    tx
      .update(paymentIntents)
      .set({ status: "voided", voidedAt: new Date() })
      .where(eq(paymentIntents.id, piR.id)),
  );
  const afterVoid = await estR();
  ok(
    "R: …and the warning is GONE once the intent is voided",
    (afterVoid.debits_in_flight ?? []).length === 0,
    JSON.stringify(afterVoid.debits_in_flight ?? []),
  );
}

// ── S: a live INTENT on an invoice that owes nothing is ended, or surfaced ─────
/**
 * The sweep half of #16. `abandonZeroDueDebits` above keys on
 * `transactions.status = 'in_progress' AND type = 'payment' AND id_at_gateway IS NOT NULL`
 * and an intent has NO transaction row, so a buyer-initiated checkout on an invoice that
 * has since been credited to zero was invisible to it. Measured 2026-09-03: two such
 * intents, ₹53,241.60 (`…kRpVDGwi` ₹22,184.00 on INV-7824, `…ipb8QtRU` ₹31,057.60 on
 * INV-6287), both invoices `paid` with ₹0 due, neither examined by any pass.
 *
 * Three cases, because the answer differs by what the gateway allows:
 *   S1  the hold CAN be released → the intent is voided
 *   S2  the invoice still OWES → the intent is left strictly alone
 *   S3  the money has already moved at the gateway and no release is possible → nothing
 *       local claims otherwise, and it is counted so an operator can be told
 */
{
  // S1 — releasable
  const s1 = await scenario("S1 zero-due intent", "card", 5_671_500);
  const st1 = await state(s1.orgId, s1.invoiceId);
  await withTenant(s1.orgId, (tx) =>
    tx
      .update(payments)
      .set({ status: "failed", failureCode: "s1_ended_the_debit" })
      .where(eq(payments.id, st1.pay.id)),
  );
  const [pm1] = await withTenant(s1.orgId, (tx) =>
    tx.select().from(pmTable).where(eq(pmTable.id, s1.pmId)).limit(1),
  );
  const { intent: pi1 } = await createPaymentIntent({
    organizationId: s1.orgId,
    businessId: s1.bizId,
    purpose: "payment",
    paymentMethodPublicId: pm1!.publicId,
    amountMinor: Number(st1.inv.totalMinor),
    currency: "INR",
    invoicePublicId: st1.inv.publicId,
  });
  // The measured sequence: the buyer starts paying, and the invoice closes under them.
  await recordOfflinePayment({
    organizationId: s1.orgId,
    businessId: s1.bizId,
    invoicePublicId: st1.inv.publicId,
    method: "cheque",
  });
  await backdateIntent(s1.orgId, pi1.id, 1);

  // S2 — an invoice that still owes, same shape otherwise
  const s2 = await scenario("S2 owing intent", "card", 5_671_500);
  const st2 = await state(s2.orgId, s2.invoiceId);
  await withTenant(s2.orgId, (tx) =>
    tx
      .update(payments)
      .set({ status: "failed", failureCode: "s2_ended_the_debit" })
      .where(eq(payments.id, st2.pay.id)),
  );
  const [pm2] = await withTenant(s2.orgId, (tx) =>
    tx.select().from(pmTable).where(eq(pmTable.id, s2.pmId)).limit(1),
  );
  const { intent: pi2 } = await createPaymentIntent({
    organizationId: s2.orgId,
    businessId: s2.bizId,
    purpose: "payment",
    paymentMethodPublicId: pm2!.publicId,
    amountMinor: Number(st2.inv.totalMinor),
    currency: "INR",
    invoicePublicId: st2.inv.publicId,
  });
  await backdateIntent(s2.orgId, pi2.id, 1);

  // S3 — the gateway has the money and will not release it (the webhook never came)
  const s3 = await scenario("S3 uncancellable intent", "card", 5_671_500);
  const st3 = await state(s3.orgId, s3.invoiceId);
  await withTenant(s3.orgId, (tx) =>
    tx
      .update(payments)
      .set({ status: "failed", failureCode: "s3_ended_the_debit" })
      .where(eq(payments.id, st3.pay.id)),
  );
  const [pm3] = await withTenant(s3.orgId, (tx) =>
    tx.select().from(pmTable).where(eq(pmTable.id, s3.pmId)).limit(1),
  );
  const { intent: pi3, attempt: at3 } = await createPaymentIntent({
    organizationId: s3.orgId,
    businessId: s3.bizId,
    purpose: "payment",
    paymentMethodPublicId: pm3!.publicId,
    amountMinor: Number(st3.inv.totalMinor),
    currency: "INR",
    invoicePublicId: st3.inv.publicId,
  });
  // Captured at the gateway with no callback to us — INV-7824 exactly. tmtest then
  // refuses the void (`captured`), which is the same answer RazorPay gives structurally
  // (`intentVoid: false`): the hold cannot be given back from here.
  await setChargeStatus(at3.idAtGateway ?? pi3.intentAtGateway!, "succeeded");
  await recordOfflinePayment({
    organizationId: s3.orgId,
    businessId: s3.bizId,
    invoicePublicId: st3.inv.publicId,
    method: "cheque",
  });
  await backdateIntent(s3.orgId, pi3.id, 1);

  const swept = await sweepStalePendingCharges(new Date());

  const live = async (orgId: string, id: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(paymentIntents).where(eq(paymentIntents.id, id)).limit(1),
      )
    )[0]!;
  const after1 = await live(s1.orgId, pi1.id);
  ok(
    "S1: a releasable intent on an invoice that owes nothing is voided",
    after1.status === "voided" && after1.voidedAt !== null,
    `${after1.status}/${after1.voidedAt?.toISOString() ?? "null"}`,
  );
  const after2 = await live(s2.orgId, pi2.id);
  ok(
    "S2: an intent on an invoice that STILL OWES is left alone",
    after2.status === "authorized" && after2.voidedAt === null,
    `${after2.status}/${after2.voidedAt?.toISOString() ?? "null"}`,
  );
  const after3 = await live(s3.orgId, pi3.id);
  ok(
    "S3: money already taken at the gateway is NOT declared gone locally",
    after3.status !== "voided" && after3.voidedAt === null,
    `${after3.status}/${after3.voidedAt?.toISOString() ?? "null"}`,
  );
  /**
   * …and it is COUNTED, which is what an operator is told from. Asserted `>= 1` rather
   * than `=== 1` for the reason E and F state: this database is not truncated between
   * runs, so another run's intent is legitimately in the same population.
   */
  ok(
    "S3: …and the sweep reports it as an intent it could not cancel",
    swept.zeroDueIntentsUncancellable >= 1,
    `examined=${swept.zeroDueIntentsExamined} voided=${swept.zeroDueIntentsVoided} uncancellable=${swept.zeroDueIntentsUncancellable}`,
  );
}

// ── T/U shared fixtures ───────────────────────────────────────────────────────
/**
 * tmtest's 3DS card. It is what makes T and U honest fixtures rather than forced
 * ones: `createIntent` leaves the gateway's row `requires_action` and OUR row
 * `in_progress` with `authorized_at` NULL — byte for byte the shape Vinay's 17:47
 * and 18:10 tests produced, and the shape every case below depends on.
 */
const THREE_DS = "4000000000003155";

/** The `payment_reversal` rows `voidPaymentIntent` books, per intent (0172). */
const reversalsFor = (orgId: string, piId: string) =>
  withTenant(orgId, (tx) =>
    tx
      .select()
      .from(transactions)
      .where(
        and(eq(transactions.paymentIntentId, piId), eq(transactions.type, "payment_reversal")),
      ),
  );
/**
 * How many ledger rows this business has. Counted rather than netted: the harm in #21
 * is a claim entered in the money log at all, and a zero-sum pair of entries would
 * pass a balance check while still asserting a release that never happened.
 */
const ledgerRowCount = async (orgId: string, bizId: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(ledgerEntries).where(eq(ledgerEntries.businessId, bizId)),
    )
  ).length;
const gatewayRow = async (chargeId: string) =>
  (
    await systemDb.select().from(tmtestCharges).where(eq(tmtestCharges.chargeId, chargeId)).limit(1)
  )[0];
/**
 * Move the GATEWAY's own row, leaving ours alone.
 *
 * ⚠ Never `resolveChallenge(id, true)` for this: that drives OUR intent row too, so a
 * fixture built on it authorizes both records and the divergence under test disappears
 * — a suite that then passes for a reason unrelated to the code (A1 hit exactly that
 * while writing #17's gate, and `verify-gateway.ts` § #15 carries the same warning).
 * Every case below therefore asserts BOTH preconditions before it acts.
 */
const gatewaySays = (chargeId: string, status: string) =>
  systemDb.update(tmtestCharges).set({ status }).where(eq(tmtestCharges.chargeId, chargeId));

/**
 * A live buyer checkout on an invoice, minted with the 3DS card so the intent really is
 * `in_progress` at our end and `requires_action` at the gateway's.
 *
 * `scenario`'s own mandate debit is ENDED first, so the only thing in flight against the
 * invoice is the checkout — the same premise § R establishes for the same reason: a
 * finding must be attributable to the intent and to nothing else.
 */
async function liveCheckout(label: string) {
  const s = await scenario(label, "card", 5_671_500);
  const st = await state(s.orgId, s.invoiceId);
  await withTenant(s.orgId, (tx) =>
    tx
      .update(payments)
      .set({ status: "failed", failureCode: "fixture_ended_the_debit" })
      .where(eq(payments.id, st.pay.id)),
  );
  const [cus] = await withTenant(s.orgId, (tx) =>
    tx.select().from(customers).where(eq(customers.id, st.inv.customerId!)).limit(1),
  );
  const pm = await vaultPaymentMethod({
    organizationId: s.orgId,
    businessId: s.bizId,
    customer: cus!,
    token: THREE_DS,
  });
  const { intent, attempt } = await createPaymentIntent({
    organizationId: s.orgId,
    businessId: s.bizId,
    purpose: "payment",
    paymentMethodPublicId: pm.publicId,
    amountMinor: Number(st.inv.totalMinor),
    currency: "INR",
    invoicePublicId: st.inv.publicId,
  });
  return {
    ...s,
    customerId: cus!.id,
    inv: st.inv,
    intent,
    // On tmtest the intent row IS the charge row (one id), unlike RazorPay's
    // order/payment split — so this is both the gateway intent id and the charge id.
    gwId: attempt.idAtGateway ?? intent.intentAtGateway!,
  };
}

/** Our intent row, read back fresh. */
const intentRow = async (orgId: string, id: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(paymentIntents).where(eq(paymentIntents.id, id)).limit(1),
    )
  )[0]!;

// ── T: a VOID must not book a reversal for a hold that never existed ──────────
/**
 * #21, found by agent B1 on 2026-09-03 while reviewing § S's new pass.
 *
 * `voidPaymentIntent` refuses `consumed`, `voided` and `expired`-with-a-reversal, and
 * calls the gateway on everything else — including an `in_progress` checkout the buyer
 * walked away from mid-challenge. The void SUCCEEDS there (tmtest's `voidIntentCharge`
 * accepts `inited`/`requires_action`/`authorized`, and Stripe cancels a
 * `requires_action` intent just as happily), and a full-amount `payment_reversal` was
 * then recorded — a money-log row asserting we released a hold on money the buyer's
 * bank never took. § S is what makes it routine rather than exotic: `releaseZeroDueIntents`
 * voids live checkouts on invoices that owe nothing, and most of those are mid-challenge.
 *
 * The three cases are one fixture and one variable — what the GATEWAY says:
 *   T1  the gateway holds nothing        → the checkout ends, and NO reversal is booked
 *   T2  the gateway says `authorized`    → a reversal is booked, on the gateway's word
 *                                          alone (our row still says `in_progress`)
 *   T3  the gateway cannot be ASKED      → unchanged: the reversal is still booked
 * T3 is not a nicety. Stripe and PayPal leave `capabilities.intentStatus` undefined, so
 * without it a fix measured on tmtest would silently change every other provider.
 */
{
  const t1 = await liveCheckout("T1 nothing held");
  ok(
    "T1 (premise): our row says in_progress with authorized_at NULL — the 17:47 shape",
    t1.intent.status === "in_progress" && t1.intent.authorizedAt === null,
    `${t1.intent.status}/authorized_at=${t1.intent.authorizedAt ?? "null"}`,
  );
  ok(
    "T1 (premise): …and the GATEWAY's own row holds nothing (requires_action)",
    (await gatewayRow(t1.gwId))?.status === "requires_action",
    String((await gatewayRow(t1.gwId))?.status),
  );
  const ledgerBefore1 = await ledgerRowCount(t1.orgId, t1.bizId);
  const voided1 = await voidPaymentIntent(t1.orgId, t1.bizId, t1.intent.publicId);
  ok(
    "T1: the void still ENDS the checkout — the operator's action works",
    voided1?.intent.status === "voided" && voided1.intent.voidedAt != null,
    `${voided1?.intent.status}/${voided1?.intent.voidedAt?.toISOString() ?? "null"}`,
  );
  ok(
    "T1: …and the gateway really released it",
    (await gatewayRow(t1.gwId))?.status === "voided",
    String((await gatewayRow(t1.gwId))?.status),
  );
  ok(
    "T1: …and NO payment_reversal is booked, because nothing was ever held",
    (await reversalsFor(t1.orgId, t1.intent.id)).length === 0,
    `reversals=${(await reversalsFor(t1.orgId, t1.intent.id)).length}`,
  );
  ok(
    "T1: …and nothing moves in the ledger",
    (await ledgerRowCount(t1.orgId, t1.bizId)) === ledgerBefore1,
    `${await ledgerRowCount(t1.orgId, t1.bizId)} vs ${ledgerBefore1}`,
  );

  const t2 = await liveCheckout("T2 held at the gateway");
  await gatewaySays(t2.gwId, "authorized");
  const t2Local = await intentRow(t2.orgId, t2.intent.id);
  ok(
    "T2 (premise): the GATEWAY authorized and OUR row never heard — the #15 divergence",
    t2Local.status === "in_progress" &&
      t2Local.authorizedAt === null &&
      (await gatewayRow(t2.gwId))?.status === "authorized",
    `local=${t2Local.status}/authorized_at=${t2Local.authorizedAt ?? "null"} gateway=${(await gatewayRow(t2.gwId))?.status}`,
  );
  await voidPaymentIntent(t2.orgId, t2.bizId, t2.intent.publicId);
  const rev2 = await reversalsFor(t2.orgId, t2.intent.id);
  ok(
    "T2: a hold the GATEWAY reports IS reversed — read off the gateway, not our row",
    rev2.length === 1 && rev2[0]!.status === "succeeded",
    `reversals=${rev2.length} ${rev2.map((r) => r.status).join(",")}`,
  );
  ok(
    "T2: …for the intent's full amount, exactly as before",
    rev2[0]?.amountMinor === t2.inv.totalMinor,
    `${rev2[0]?.amountMinor} vs ${t2.inv.totalMinor}`,
  );

  /**
   * T2b — the ORDINARY void, and the one rule that is a DECISION rather than a
   * measurement: `authorized_at` is our own record that a hold once existed (the
   * column's stated purpose), written from the gateway's own `intent.authorized`, and a
   * reversal is what records releasing it. So a row carrying one is reversed without
   * asking anybody, which is how every void the engine has ever performed keeps its
   * behaviour.
   *
   * The gateway's row is then pushed BACK to `requires_action` on purpose. On tmtest an
   * authorized intent authorizes at both ends, so without that a poll would answer
   * `authorized` too and this case could not tell the two rules apart — it would pass
   * whether or not `authorized_at` were consulted at all. With it, the assertion is
   * exactly "our own authorization record still counts", and a future change that polls
   * unconditionally reddens here instead of shipping. #21 is a hold that NEVER existed,
   * not one that has since lapsed.
   */
  const t2bScenario = await scenario("T2b ordinary void", "card", 5_671_500);
  const [pm2b] = await withTenant(t2bScenario.orgId, (tx) =>
    tx.select().from(pmTable).where(eq(pmTable.id, t2bScenario.pmId)).limit(1),
  );
  const { intent: pi2b, attempt: at2b } = await createPaymentIntent({
    organizationId: t2bScenario.orgId,
    businessId: t2bScenario.bizId,
    purpose: "payment",
    paymentMethodPublicId: pm2b!.publicId,
    amountMinor: 5_671_500,
    currency: "INR",
  });
  const gw2b = at2b.idAtGateway ?? pi2b.intentAtGateway!;
  await gatewaySays(gw2b, "requires_action");
  ok(
    "T2b (premise): OUR row records the authorization and the gateway now denies it",
    pi2b.status === "authorized" &&
      pi2b.authorizedAt != null &&
      (await gatewayRow(gw2b))?.status === "requires_action",
    `local=${pi2b.status}/authorized_at=${pi2b.authorizedAt?.toISOString() ?? "null"} gateway=${(await gatewayRow(gw2b))?.status}`,
  );
  await voidPaymentIntent(t2bScenario.orgId, t2bScenario.bizId, pi2b.publicId);
  ok(
    "T2b: voiding an intent WE know was authorized still books its reversal",
    (await reversalsFor(t2bScenario.orgId, pi2b.id)).length === 1,
    `reversals=${(await reversalsFor(t2bScenario.orgId, pi2b.id)).length}`,
  );

  /**
   * T3 — a gateway that cannot be asked. The prototype patch is the same technique
   * `verify-gateway.ts` uses on `createIntent`, and it is the only way to reach the
   * branch offline: `capabilities` is an instance field, while an absent METHOD is what
   * the guard actually reads (`!adapter.fetchIntent || intentStatus !== true`), which is
   * precisely Stripe's and PayPal's shape.
   */
  const t3 = await liveCheckout("T3 unaskable gateway");
  ok(
    "T3 (premise): the same in_progress / requires_action pair as T1",
    t3.intent.status === "in_progress" && (await gatewayRow(t3.gwId))?.status === "requires_action",
    `local=${t3.intent.status} gateway=${(await gatewayRow(t3.gwId))?.status}`,
  );
  /**
   * ⚠ SPLIT 2026-09-04, because #30's contract divided this case in two and the original
   * assertion silently covered only one of them.
   *
   * T3 as first written pinned "cannot be asked ⇒ book the reversal", and that was right
   * while a gateway that could not be POLLED told us nothing at all. `VoidIntentResult.held`
   * changed that: Stripe's cancel response carries `status` / `amount_capturable`, and
   * PayPal's void takes an authorization id that only exists once funds were held — so both
   * can now say what they released WITHOUT a poll. Continuing to book a reversal in the face
   * of a gateway saying "nothing was held" would perpetuate #21 on exactly the two providers
   * #30 exists to fix, so the fallback now applies only where there is NO evidence either way.
   *
   * T3  — unaskable AND silent (`held: undefined`)  ⇒ book, unchanged. The safety property
   *       D2 pinned, kept intact: absence of evidence must not stop a real reversal.
   * T3b — unaskable but REPORTS `held: false`       ⇒ do not book. This is Stripe/PayPal
   *       after #30, and it is the whole point of the contract.
   */
  type Askable = { fetchIntent?: TmtestProvider["fetchIntent"] };
  type Voidable = { voidIntent?: TmtestProvider["voidIntent"] };
  const proto = TmtestProvider.prototype as Askable & Voidable;
  const originalFetchIntent = proto.fetchIntent;
  const originalVoidIntent = proto.voidIntent;
  proto.fetchIntent = undefined;
  // Silent about the hold as well as unpollable — a provider with neither signal.
  proto.voidIntent = async function (this: TmtestProvider, ...args) {
    const res = await originalVoidIntent!.apply(this, args);
    return {
      voided: res.voided,
      ...(res.providerTransactionId ? { providerTransactionId: res.providerTransactionId } : {}),
    };
  } as TmtestProvider["voidIntent"];
  try {
    await voidPaymentIntent(t3.orgId, t3.bizId, t3.intent.publicId);
  } finally {
    proto.fetchIntent = originalFetchIntent;
    proto.voidIntent = originalVoidIntent;
  }
  ok(
    "T3: a gateway that can be neither asked NOR reports a hold keeps its old behaviour — the reversal is booked",
    (await reversalsFor(t3.orgId, t3.intent.id)).length === 1,
    `reversals=${(await reversalsFor(t3.orgId, t3.intent.id)).length}`,
  );

  // T3b — the Stripe/PayPal shape after #30: unpollable, but it tells us nothing was held.
  const t3b = await liveCheckout("T3b unaskable but reports held");
  ok(
    "T3b (premise): the same in_progress / requires_action pair, so only the void's answer differs",
    t3b.intent.status === "in_progress" &&
      (await gatewayRow(t3b.gwId))?.status === "requires_action",
    `local=${t3b.intent.status} gateway=${(await gatewayRow(t3b.gwId))?.status}`,
  );
  proto.fetchIntent = undefined;
  try {
    await voidPaymentIntent(t3b.orgId, t3b.bizId, t3b.intent.publicId);
  } finally {
    proto.fetchIntent = originalFetchIntent;
  }
  ok(
    "T3b: an unpollable gateway that REPORTS nothing was held books no reversal (#30)",
    (await reversalsFor(t3b.orgId, t3b.intent.id)).length === 0,
    `reversals=${(await reversalsFor(t3b.orgId, t3b.intent.id)).length}`,
  );
}

// ── U: a capture that is booked AND refunded must CLOSE its intent ────────────
/**
 * #26, measured on a second failure test: `pi_XXXXXXXXXXXXXXXXXXXXXX03` is still
 * `in_progress` with `authorized_at` NULL while its charge `pay_XXXXXXXXXXXX09` captured
 * at 18:10:35 and was auto-refunded at 18:10:38. The ledger is square and the money is
 * safe; the INTENT is not. A1's `closeIntentForReturnedCharge` fires on a late
 * `intent.authorized` — and no such event ever arrived, because the CAPTURE came
 * instead, and `reconcileUnmatchedCapture` never closed the intent.
 *
 * What that costs: a dead intent is still LIVE to `liveIntentForInvoice`, so the buyer
 * is told "a payment is already in progress" for a payment that finished and was handed
 * back, and § S's pass keeps offering the row to a gateway that cannot void it.
 *
 * § P is this fixture's money half, already proven end to end. What U adds is the
 * INTENT, and the premise that matters: our row never saw an `intent.authorized`
 * (`in_progress`, `authorized_at` NULL), so nothing but the capture path can close it.
 */
{
  const u = await liveCheckout("U captured then refunded");
  // The invoice closes under the buyer — a downgrade did it at 18:10 on the real row,
  // an offline payment does it here. Either way the capture arrives with no room.
  await recordOfflinePayment({
    organizationId: u.orgId,
    businessId: u.bizId,
    invoicePublicId: u.inv.publicId,
    method: "wire",
  });
  const before = await intentRow(u.orgId, u.intent.id);
  ok(
    "U (premise): the intent is in_progress with authorized_at NULL — no intent.authorized ever arrived",
    before.status === "in_progress" && before.authorizedAt === null,
    `${before.status}/authorized_at=${before.authorizedAt ?? "null"}`,
  );
  ok(
    "U (premise): …and it is LIVE to the checkout guard, which is the blockage",
    (await liveIntentForInvoice(u.orgId, u.invoiceId, new Date()))?.id === u.intent.id,
  );
  // The buyer finishes at their bank. The capture reaches us through the REAL inbound
  // pipeline; `provider_intent_id` is what lets an unmatched capture be attributed at all.
  await setChargeStatus(u.gwId, "succeeded");
  await new TmtestProvider(u.bizId).triggerSyntheticEvent("charge.succeeded", {
    charge_id: u.gwId,
    provider_intent_id: u.intent.intentAtGateway!,
  });
  await advanceTmtest(u.orgId, new Date());

  const [captured] = await withTenant(u.orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.providerChargeId, u.gwId)),
  );
  ok(
    "U: the capture is BOOKED and detached (§ P's shape, restated as this case's premise)",
    captured?.status === "succeeded" && captured.invoiceId === null,
    `${captured?.status}/invoice=${String(captured?.invoiceId)}`,
  );
  const refs = captured ? await refundsFor(u.orgId, captured.id) : [];
  ok(
    "U: …and handed straight back, so the net is zero",
    refs.length === 1 && refs[0]!.status === "succeeded",
    refs.map((r) => r.status).join(",") || "none",
  );
  ok(
    "U: …leaving no excess credit behind",
    (await excessOf(u.orgId, u.customerId, "INR")) === 0n,
    String(await excessOf(u.orgId, u.customerId, "INR")),
  );

  const after = await intentRow(u.orgId, u.intent.id);
  ok(
    "U: the intent does NOT stay in_progress once its money has been booked and returned",
    after.status !== "in_progress",
    `${after.status}`,
  );
  ok(
    "U: …it is consumed — the money arrived, which is what that status means",
    after.status === "consumed",
    `${after.status}`,
  );
  ok(
    "U: …so the buyer's next checkout is not blocked by a finished payment",
    (await liveIntentForInvoice(u.orgId, u.invoiceId, new Date())) === null,
  );
  /**
   * …and it has left § S's population, which selects `status in ('in_progress',
   * 'authorized')`. Asserted on the ROW rather than by running the sweep: this database
   * is not truncated between runs, so a counter would answer for every other run's rows
   * too (the rule § E and § F state).
   */
  ok(
    "U: …and the zero-due pass is no longer offered a row it can never void",
    !["in_progress", "authorized"].includes(after.status) && after.voidedAt === null,
    `${after.status}/${after.voidedAt?.toISOString() ?? "null"}`,
  );
}

// ── V: a BANK DEBIT is held as credit, never handed back unprompted ──────────
/**
 * § U's twin, and the only difference is the RAIL.
 *
 * Stripe documents a double-refund risk specific to bank debits: refund proactively while
 * the payer is also disputing and they are credited TWICE. The window makes that likely
 * rather than theoretical — SEPA gives an unconditional right to a refund for 8 weeks and
 * 13 MONTHS to dispute an unauthorised debit — so "they have not disputed yet" is never a
 * safe read here. Cards stay automatic (§ U): a chargeback against an already-refunded
 * charge is refused, so the two cannot both land.
 *
 * Holding is not a silent failure. It is the same state a FAILED payout leaves (§ M),
 * which is already built and already alerted: credit stamped `unapplied_gateway_capture`,
 * counted by `unapplied_gateway_money`, drawn down by the next invoice, refundable by an
 * operator who knows the dispute window. A recoverable delay instead of an unrecoverable
 * double credit.
 */
{
  const v = await liveCheckout("V bank debit held");
  // The invoice is settled by other means FIRST — § U's premise. Without it the capture is
  // simply APPLIED and the refund policy is never reached, so the case tests nothing.
  await recordOfflinePayment({
    organizationId: v.orgId,
    businessId: v.bizId,
    invoicePublicId: v.inv.publicId,
    method: "wire",
  });
  // The instrument's TYPE is what decides this, not the mandate rail: one gateway carries
  // several rails and only the type says which one took the money.
  // Every instrument this customer has, not just `scenario`'s: the checkout flow vaults its
  // own, and updating the wrong row leaves the capture on a card and the case vacuous —
  // which is exactly how it first passed the "not refunded" assertion for the wrong reason.
  await withTenant(v.orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ type: "sepa_debit" })
      .where(eq(paymentMethods.customerId, v.customerId)),
  );

  await setChargeStatus(v.gwId, "succeeded");
  await new TmtestProvider(v.bizId).triggerSyntheticEvent("charge.succeeded", {
    charge_id: v.gwId,
    provider_intent_id: v.intent.intentAtGateway!,
  });
  await advanceTmtest(v.orgId, new Date());

  const [captured] = await withTenant(v.orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.providerChargeId, v.gwId)),
  );
  ok(
    "V: the capture is still BOOKED and detached, exactly as on a card",
    captured?.status === "succeeded" && captured.invoiceId === null,
    `${captured?.status}/invoice=${String(captured?.invoiceId)}`,
  );
  ok(
    "V: …and NOT refunded — a bank debit is never handed back unprompted",
    captured ? (await refundsFor(v.orgId, captured.id)).length === 0 : false,
  );
  ok(
    "V: …the money is held as customer credit instead, where the alert can see it",
    (await excessOf(v.orgId, v.customerId, "INR")) === captured?.amountMinor,
    `${await excessOf(v.orgId, v.customerId, "INR")} vs ${String(captured?.amountMinor)}`,
  );
}

// ── W: a TARGETED sync is a read — it must not spend the clock's backoff ─────
/**
 * `deferPolls` increments `attempts`, and the wait is `60s * 2 ** (attempts - 1)`. Routing
 * an operator's "check now" through it made every press push the AUTOMATIC check further
 * away — five presses took the next scheduled look from one minute to thirty-two. A button
 * meaning "check sooner" must not make the background checking later.
 *
 * So a targeted run writes NOTHING to the schedule: it asks the gateway, books an answer if
 * there is one, and leaves the clock's rhythm alone. The webhook or the next scheduled poll
 * settles the row regardless; neither needs the operator's curiosity recorded as an attempt.
 */
{
  const w = await scenario("W targeted read-only", "card", 4_242_00);
  const { txn: live } = await state(w.orgId, w.invoiceId);

  // Give the row a schedule FIRST, at a deliberately advanced backoff. `rows 0→0` proves a
  // targeted run creates nothing; the bug was pressing the button on a row that already has
  // a schedule, where each press incremented `attempts` and pushed `next_at` further out.
  const pinnedNext = new Date(Date.now() + 45 * 60_000);
  await withTenant(w.orgId, (tx) =>
    tx.insert(settlementPollSchedule).values({
      organizationId: w.orgId,
      transactionId: live.id,
      pass: "stale_pending",
      attempts: 5,
      nextAt: pinnedNext,
    }),
  );

  const before = await withTenant(w.orgId, (tx) =>
    tx
      .select()
      .from(settlementPollSchedule)
      .where(eq(settlementPollSchedule.transactionId, live.id)),
  );
  ok("W (premise): the row carries a schedule at attempt 5", before[0]?.attempts === 5);

  // tmtest answers a status poll from its own store and logs no request, so read the span
  // the poll RUNS in; a real adapter's request log takes exactly that (providers/http.ts).
  const pollSpans: (string | undefined)[] = [];
  const realFetch = TmtestProvider.prototype.fetchChargeStatus;
  TmtestProvider.prototype.fetchChargeStatus = function (input) {
    pollSpans.push(getSpanId());
    return realFetch.call(this, input);
  };
  // Targeted: bypasses the grace window, so it really does reach the gateway.
  const r = await sweepStalePendingCharges(new Date(), { onlyTransactionId: live.id }).finally(
    () => (TmtestProvider.prototype.fetchChargeStatus = realFetch),
  );
  ok(
    "span: the status poll runs in the charge's own span",
    !!live.spanId && pollSpans.length >= 1 && pollSpans.every((sp) => sp === live.spanId),
    `span=${live.spanId} polls=${JSON.stringify(pollSpans)}`,
  );
  ok(
    "W: a targeted run examines the row even inside its grace window",
    r.examined >= 1,
    `examined=${r.examined}`,
  );

  const after = await withTenant(w.orgId, (tx) =>
    tx
      .select()
      .from(settlementPollSchedule)
      .where(eq(settlementPollSchedule.transactionId, live.id)),
  );
  ok(
    "W: …and leaves attempts and next_at exactly as they were",
    after.length === before.length &&
      // Keyed on (transaction, pass) — the schedule has no surrogate id, and that pair is
      // what identifies a row.
      after.every((a) => {
        const b = before.find((x) => x.transactionId === a.transactionId && x.pass === a.pass);
        return b && b.attempts === a.attempts && b.nextAt.getTime() === a.nextAt.getTime();
      }),
    `attempts ${before[0]?.attempts}→${after[0]?.attempts}, rows ${before.length}→${after.length}`,
  );

  // Three more presses. Under the old behaviour this alone took the next scheduled check
  // from 32 minutes to hours — the button meaning "sooner" making the clock later.
  for (let i = 0; i < 3; i++) {
    await sweepStalePendingCharges(new Date(), { onlyTransactionId: live.id });
  }
  const [spammed] = await withTenant(w.orgId, (tx) =>
    tx
      .select()
      .from(settlementPollSchedule)
      .where(eq(settlementPollSchedule.transactionId, live.id)),
  );
  ok(
    "W: …and repeated presses never push the scheduled check further out",
    spammed?.attempts === 5 && spammed.nextAt.getTime() === pinnedNext.getTime(),
    `attempts=${spammed?.attempts} next_at moved by ${
      spammed ? spammed.nextAt.getTime() - pinnedNext.getTime() : "?"
    }ms`,
  );
}

// ── X: a pending REFUND is not a charge — the charge sweep never asks about it ─────
/**
 * The sweep selected every `in_progress` transaction with a gateway id, refunds included, and
 * called `fetchChargeStatus` with the refund's id. Measured on PayU: ~30 status calls in five
 * seconds against a 60-per-minute limit. Refunds have their own sweep.
 */
{
  const x = await scenario("X refund not a charge", "card", 4_343_00);
  const { txn: charge } = await state(x.orgId, x.invoiceId);
  const [refund] = await withTenant(x.orgId, (tx) =>
    tx
      .insert(transactions)
      .values({
        organizationId: x.orgId,
        businessId: x.bizId,
        publicId: `txn_stalerefund${Date.now()}`,
        type: "refund",
        status: "in_progress",
        amountMinor: charge!.amountMinor,
        currency: charge!.currency,
        gatewayKey: charge!.gatewayKey,
        idAtGateway: `${charge!.idAtGateway}:rf1`,
        invoiceId: charge!.invoiceId,
        customerId: charge!.customerId,
        occurredAt: new Date(Date.now() - 30 * 24 * HOUR),
        createdAt: new Date(Date.now() - 30 * 24 * HOUR),
      })
      .returning(),
  );
  const r = await sweepStalePendingCharges(new Date(), { onlyTransactionId: refund!.id });
  ok(
    "X: a pending refund is not examined by the charge sweep",
    r.examined === 0,
    `examined=${r.examined}`,
  );
}

console.log("");
console.log(pass ? "✅ STALE PENDING: PASS" : "❌ STALE PENDING: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
