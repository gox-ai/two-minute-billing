/**
 * Stale-pending sweep — the backstop for a settlement webhook that never came.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * An asynchronous debit is booked as a `pending` payment + an `in_progress`
 * transaction, and the invoice is parked with `next_attempt_at = null` so dunning
 * does not retry an attempt that is still alive. Everything then waits for the
 * gateway's callback. That is correct, and it is the ONLY thing that ever resolves
 * such an attempt: `settlement.ts` is driven by the inbound webhook path or an
 * operator's manual reconcile, and `retryInvoice` deliberately treats a non-failed
 * payment as "not exhausted" and backs off.
 *
 * So a callback that never arrives — a mis-provisioned endpoint, an outage on
 * either side, a tunnel that was down during the window — strands the invoice
 * forever, with dunning halted, while the money may well have moved at the
 * gateway. Nothing in the engine revisits it and nothing alerts.
 *
 * That was survivable while async rails were the exception. It is not once INR
 * subscriptions renew over RazorPay: UPI Autopay settles minutes-to-hours after
 * the charge is accepted, and a netbanking e-mandate debit takes **up to 2 working
 * days** (RazorPay must receive the request by 08:59 on a bank working day for
 * same-day authorization). On those rails a long pending window is the normal
 * case, so "pending for a day" cannot be treated as a symptom — which is exactly
 * why the deadline has to be per rail rather than one global timeout.
 *
 * ── What it does NOT do ───────────────────────────────────────────────────────
 * It never decides an outcome. It asks the gateway (`fetchChargeStatus`) and hands
 * whatever comes back to the same `settleTransactionOutcome` path a webhook would
 * have used, so a swept settlement and a webhook settlement are byte-identical in
 * the ledger. A gateway that still says `pending` is left alone — however old the
 * attempt is, the engine's opinion is worth less than the gateway's.
 *
 * Adapters without `fetchChargeStatus` are skipped and COUNTED, never guessed at.
 */
import { and, eq, lt, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { scanBusinessFilter } from "@/platform/clock";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";
import { joinSpan } from "@/platform/trace";
import type { ChargeResult } from "@/providers/types";
import {
  deferredUntilLater,
  deferPolls,
  clearPollSchedule,
  reapFinishedPollSchedules,
  type PollDeferral,
} from "./poll-schedule";
import { settleTransactionOutcome } from "./settlement";
import { adapterForTransaction } from "./transaction-adapter";
import { DEBIT_CANCELLED_CODE, bookDebitCancelledIn } from "./pending-debit";
import { setTransactionStatus } from "@/modules/transactions/service";
import { debitAwaitsBuyerAuthentication } from "@/modules/payment-methods/service";
import { invoices, payments, paymentIntents, paymentMethods, transactions } from "@db/schema";
import {
  voidPaymentIntent,
  PaymentIntentError,
  PaymentIntentVoidUnsupportedError,
} from "@/modules/payment-intents/service";

const log = createLogger("stale-pending");

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long an `in_progress` attempt may legitimately stay unsettled before the
 * sweep asks the gateway what happened, keyed by the PROVIDER's own rail name
 * (`payment_methods.mandate_rail`, falling back to the method `type`).
 *
 * These are grace periods, not timeouts: nothing is failed when one elapses, we
 * merely stop assuming the webhook is still on its way. Each is set from the
 * rail's documented worst case plus room, so a healthy debit is never swept:
 *
 *  - **emandate / nach** — up to 2 working days to authorize, and the token itself
 *    confirms T+1 on HDFC/SBI. A weekend sits inside that, so 7 calendar days.
 *  - **card** — above ₹15,000 an INR debit waits on the bank's AFA link, which is
 *    valid 72 hours. 96h leaves a margin past its expiry.
 *  - **upi** — minutes to hours in practice; 48h is already far outside normal.
 *  - default — 72h, for a rail we have not characterised. Deliberately generous:
 *    sweeping early costs a needless gateway call, sweeping late costs nothing but
 *    time, and the sweep cannot damage a live attempt either way.
 */
export const RAIL_GRACE_HOURS: Record<string, number> = {
  /**
   * ── The Stripe direct-debit rails, added 2026-09-05 with ACH and SEPA ─────────
   *
   * `us_bank_account` fell to the 72-hour default and that was TOO SHORT for the rail's
   * own verification. An ACH bank account that cannot be verified instantly falls back to
   * MICRODEPOSITS: Stripe takes 2–3 BUSINESS days to land them and gives the customer 10
   * days to enter the amounts. A setup started on a Thursday has its deposits arrive the
   * following week — while a 72-hour clock voided the intent on Sunday, before there was
   * anything for the customer to verify. They would have done everything right and found a
   * dead intent, with no event to tell anyone: Stripe sends NOTHING when microdeposits
   * land, by design.
   *
   * 10 days matches the window Stripe itself gives the customer. Ours must not be the
   * shorter clock — an authorization the gateway still considers live is not ours to
   * expire.
   *
   * `sepa_debit` keeps a shorter life on purpose: its mandate is accepted inline in the
   * payment sheet, so there is no out-of-band verification to wait for. 7 days is the same
   * value the other bank-debit rails carry.
   */
  us_bank_account: 24 * 10,
  sepa_debit: 24 * 7,
  emandate: 24 * 7,
  nach: 24 * 7,
  card: 96,
  upi: 48,
  bank_transfer: 24 * 7,
};
const DEFAULT_GRACE_HOURS = 72;

/**
 * When an authentication-pending debit stops being "in flight" and becomes a debit
 * the buyer did not authorise: **the AFA link's own expiry, and not an hour longer.**
 *
 * This is the ONE place the sweep overrules the gateway, so it is worth being precise
 * about what is being overruled. The AFA link an issuer sends is valid **72 hours**;
 * once it lapses the payment cannot be authenticated by anyone — not by the customer,
 * not by us, not by the bank — so a gateway still reporting `created` past that is
 * describing a corpse. There is nothing left to wait for.
 *
 * ── Why this was 120h, and why that was wrong (2026-08-28) ────────────────────
 * The extra 48h was margin against a real hazard: RazorPay cannot void or cancel a
 * recurring payment stuck in `created` (`intentVoid: false`, every documented cancel
 * route 404s — operator ask 5), so failing locally carries no guarantee at the
 * gateway, and a debit called dead while it could still capture lands on top of a
 * portal payment. But that hazard is bounded by the SAME 72 hours: past link expiry
 * the debit cannot capture, so there is no window left for the margin to protect.
 * All the extra two days bought was a customer staring at "a payment is already in
 * progress" — with Pay now blocked — for two days after the thing had died.
 *
 * Not a grace period: {@link RAIL_GRACE_HOURS} decides when we ASK the gateway, this
 * decides when a `pending` answer stops being accepted. An AFA debit's grace is
 * clamped to this figure (see the loop) precisely so it is polled once, here, rather
 * than sitting out a card's ordinary 96h before anyone looks.
 */
const AFA_ABANDON_HOURS = 72;

/**
 * The age floor the sweep SELECTS on — the smallest effective grace any row can have.
 *
 * Exported and computed once so it cannot drift from the graces it is meant to bound. The
 * rule it encodes: this must be ≤ every effective grace in the file, because a row is
 * dropped by its own rail's `continue` below AFTER selection but can never be rescued if
 * the query did not return it. Over-selecting costs one cheap row per sweep; under-selecting
 * loses the window entirely, which is what happened to INV-100002.
 */
export const SWEEP_SELECTION_GRACE_HOURS = Math.min(
  DEFAULT_GRACE_HOURS,
  AFA_ABANDON_HOURS,
  ...Object.values(RAIL_GRACE_HOURS),
);

/**
 * How long after a debit was CREATED we keep asking whether an abandoned authentication
 * was completed after all.
 *
 * ── The gap this closes ───────────────────────────────────────────────────────
 * Abandoning is local-only: the gateway keeps the debit `created` and the buyer can still
 * approve it at their bank, either by finishing the link they had ignored or — the case
 * that prompted this — by approving it BY MISTAKE after telling us in the portal that they
 * would not. That capture is real money, and the recovery for it
 * (`reconcileAbandonedCapture`) has always existed... reachable from the inbound webhook
 * and NOWHERE ELSE. `settleAbandonedCapture`'s own docblock said so: "if the capture
 * happens AND its webhook never arrives, nothing here fires… it is not covered." The main
 * pass cannot cover it either, because it selects `in_progress` and an abandoned debit is
 * `failure`. So one lost delivery — a mis-provisioned endpoint, a tunnel down during the
 * window, the gateway exhausting its retries — meant the customer's money was gone with
 * nothing in our books and nothing that would ever look again.
 *
 * ── Why 72 + 24 ───────────────────────────────────────────────────────────────
 * The AFA link is valid {@link AFA_ABANDON_HOURS} from the debit's creation, so past that
 * the debit CANNOT capture and there is nothing left to discover. The extra day is settle
 * margin: an approval at hour 71 can be reported by the gateway some time later, and a
 * poll that stops exactly at the link's expiry would miss precisely the last-minute
 * approvals this exists for. Past this window the row is left alone forever — which is
 * correct, not a give-up: the money cannot have moved.
 */
const AFA_RECHECK_UNTIL_HOURS = AFA_ABANDON_HOURS + 24;

/** Grace period for one attempt, from its instrument's rail. */
function graceHoursFor(rail: string | null, methodType: string | null): number {
  const key = (rail ?? methodType ?? "").toLowerCase();
  return RAIL_GRACE_HOURS[key] ?? DEFAULT_GRACE_HOURS;
}

export interface StalePendingResult {
  /** Attempts old enough to ask the gateway about. */
  examined: number;
  /** Resolved as money in hand. */
  settled: number;
  /** Resolved as a terminal failure (handed to dunning like any other). */
  failed: number;
  /** The gateway says it is still working — left untouched. */
  stillPending: number;
  /** Skipped because the adapter cannot be asked (no `fetchChargeStatus`). */
  unsupported: number;
  /** Abandoned AFA debits re-asked about (see the second pass). */
  afaRechecked: number;
  /** …of which the buyer had in fact authorised after all, and the money was booked. */
  afaRecovered: number;
  /** Live debits found against an invoice that owes nothing (see the third pass). */
  zeroDueExamined: number;
  /** …of which the outstanding request was ended — released, settled, or failed at the rail. */
  zeroDueClosed: number;
  /** Live at the rail, uncancellable, on an invoice that owes nothing. */
  zeroDueStillLive: number;
  /** Live payment INTENTS found against an invoice that owes nothing (see the fourth pass). */
  zeroDueIntentsExamined: number;
  /** …of which the hold was released at the gateway and the intent closed. */
  zeroDueIntentsVoided: number;
  /**
   * …of which the gateway would not, or could not, give the money back. Per TICK, not a
   * standing population: a row counted here is not re-examined by this process (see
   * `uncancellableZeroDueIntents`), so read the ops alert for what is still stranded.
   */
  zeroDueIntentsUncancellable: number;
  /**
   * Lost-answer charges (`timeout`) asked about at the gateway (`lost-answer.ts`): by our ref
   * when there is no gateway id, else by the stranded id.
   */
  lostAnswerExamined: number;
  /** …whose answer was found and booked (by ref, the id adopted too). */
  lostAnswerFound: number;
  /** …definitely never created: failed, and dunning resumes. */
  lostAnswerNotCreated: number;
  /** …that cannot be looked up (no `locateCharge` / `fetchChargeStatus`, or no ref recorded). */
  lostAnswerUnsupported: number;
  /** …of those, raised as an ops alert this tick: once per row, on its first sighting. */
  lostAnswerAlerted: number;
}

/**
 * Ask the gateway about `in_progress` attempts that are past their rail's grace
 * period, and settle whatever it reports.
 *
 * Bounded by `TICK_SCAN_LIMIT` and ordered oldest-first, matching the renewal
 * pass: a backlog is worked through across ticks rather than held in one, and the
 * longest-stranded attempt is always the next one resolved.
 */
export async function sweepStalePendingCharges(
  now: Date,
  /**
   * Scope the pass to ONE transaction — the operator's "Sync now".
   *
   * A manual sync runs the SAME pass rather than a second implementation of poll-and-settle:
   * the settle path books money, retracts failures and re-arms dunning, and a second copy of
   * that is how two callers drift into disagreeing about one charge. Scoping the candidate
   * query was the smaller change and keeps one implementation.
   *
   * Targeting deliberately BYPASSES the two "should we ask yet" guards — the rail grace
   * window and the recently-asked deferral. Both are the CLOCK's economy, stopping it
   * spending gateway calls on rows that will not have changed. An operator looking at a
   * stuck payment has already decided the call is worth making, and refusing them a fresh
   * answer because a cron asked four minutes ago is the opposite of what the button is for.
   */
  opts?: { onlyTransactionId?: string },
): Promise<StalePendingResult> {
  const targeted = opts?.onlyTransactionId;
  const out: StalePendingResult = {
    examined: 0,
    settled: 0,
    failed: 0,
    stillPending: 0,
    unsupported: 0,
    afaRechecked: 0,
    afaRecovered: 0,
    zeroDueExamined: 0,
    zeroDueClosed: 0,
    zeroDueStillLive: 0,
    zeroDueIntentsExamined: 0,
    zeroDueIntentsVoided: 0,
    zeroDueIntentsUncancellable: 0,
    lostAnswerExamined: 0,
    lostAnswerFound: 0,
    lostAnswerNotCreated: 0,
    lostAnswerUnsupported: 0,
    lostAnswerAlerted: 0,
  };

  // Coarse SQL bound, then the EXACT per-rail deadline in code — the rail lives on a
  // joined row, so a CASE across two tables buys nothing at this volume.
  //
  // ⚠️ The bound is the **narrowest** grace period, not the widest. It has to be: this
  // clause selects rows OLDER than the cutoff, so widening the cutoff EXCLUDES rows
  // that are already due under their own shorter rail. Measured 2026-08-13 against a
  // real RazorPay UPI debit — with the widest (netbanking, 168h) the fresh UPI
  // transaction was silently skipped and only a 2-week-old row came back, so UPI
  // (48h) would not have been swept until 120 hours after it was due, and the per-rail
  // table it exists to honour did nothing.
  //
  // Over-selecting is the safe direction: rows not yet due for their own rail are
  // dropped by the `continue` below, before any gateway call.
  // `AFA_ABANDON_HOURS` is in the min because an AFA debit's effective grace is clamped
  // to it below: leave it out and a rail whose ordinary grace is longer would not even
  // be SELECTED at the moment its authentication window closes.
  //
  // ⚠️ ANY future window shorter than these MUST be added here. The authentication probe
  // was one and was left out, so a card debit whose effective grace was 15 minutes went
  // unselected for 24 hours (INV-100002, 2026-09-12). The probe is gone now — it rested on
  // an inference RazorPay's Late Authorisation behaviour disproves — but the trap it fell
  // into is a property of this query, not of that feature.
  const narrowestGraceMs = SWEEP_SELECTION_GRACE_HOURS * HOUR_MS;
  const candidates = await systemDb
    .select({
      txn: transactions,
      mandateRail: paymentMethods.mandateRail,
      methodType: paymentMethods.type,
    })
    .from(transactions)
    .leftJoin(paymentMethods, eq(paymentMethods.id, transactions.paymentMethodId))
    .where(
      and(
        eq(transactions.status, "in_progress"),
        // Charges only: a pending refund's id is not a charge id, and asking
        // `fetchChargeStatus` about it spends the gateway's rate limit (or worse, an
        // adapter could read it as a charge). Refunds have their own sweep.
        eq(transactions.type, "payment"),
        // No gateway handle = nothing to ask about. Such a row is a different
        // problem (the charge was recorded without an id) and the operator
        // reconcile path owns it.
        isNotNull(transactions.idAtGateway),
        // The age floor is the clock's economy, not a correctness rule, so a targeted sync
        // ignores it — otherwise the button would silently do nothing on exactly the
        // freshly-stuck payment an operator is most likely to be staring at.
        targeted
          ? undefined
          : lt(transactions.createdAt, new Date(now.getTime() - narrowestGraceMs)),
        targeted ? eq(transactions.id, targeted) : undefined,
        scanBusinessFilter(transactions.businessId),
      ),
    )
    // Oldest first, so the longest-stranded attempt is always resolved next and a
    // backlog drains across ticks rather than being held in one (same contract as the
    // renewal pass). The cap counts rows SELECTED, not rows examined — a run can spend
    // its budget on rows that turn out not to be due yet, which costs a comparison
    // each and no gateway call, and the next tick re-scans regardless.
    .orderBy(transactions.createdAt)
    .limit(config.TICK_SCAN_LIMIT);

  // Rows this pass asked about and learned nothing from. Written once, after the loop.
  const defer: PollDeferral[] = [];
  /**
   * Push a row out to its next interval — and NEVER on a targeted run.
   *
   * `deferPolls` increments `attempts`, and the backoff is `60s * 2 ** (attempts - 1)`. So
   * routing an operator's "check now" through it made every press move the AUTOMATIC check
   * further away: five presses took the clock's next look from one minute to thirty-two. A
   * button meaning "check sooner" must not make the background checking later.
   *
   * A targeted run therefore writes NOTHING to the schedule. It is a read: ask the gateway,
   * book the answer if there is one, and leave the clock's own rhythm exactly as it was —
   * the webhook or the next scheduled poll will settle this regardless, and neither needs
   * the operator's curiosity recorded as an attempt.
   */
  const deferLater = (t: { organizationId: string; id: string }) => {
    if (targeted) return;
    defer.push({ organizationId: t.organizationId, transactionId: t.id });
  };
  const skip = targeted ? new Set<string>() : await deferredUntilLater("stale_pending", now);

  for (const row of candidates) {
    const { txn } = row;
    // Asked recently, and the answer changed nothing. See `poll-schedule.ts`: this is the
    // filter that took this pass from 103 fruitless gateway polls per tick to ~0.
    if (!targeted && skip.has(txn.id)) continue;
    /**
     * Does this debit stop and wait for the buyer? Answered ONCE, here, because it
     * decides two things that must not disagree: when we look (an AFA debit's window
     * closes at the link's expiry, however patient its rail normally is) and whether a
     * still-`created` answer may be overruled at all.
     *
     * Reads the gateway's recorded statement before the amount rule. A challenge below
     * ₹15,000 is real (measured: ₹885 in production) and its row lands here as an
     * ordinary `in_progress` — without the statement this pass would apply a
     * netbanking-sized patience to a link that expires, then never reach the abandon
     * branch below, and the attempt would sit `in_progress` for as long as the gateway
     * keeps saying `created`. Which is forever: it waits on a person.
     */
    const needsAfa = debitAwaitsBuyerAuthentication(
      txn,
      { mandateRail: row.mandateRail, type: row.methodType },
      txn.currency,
      txn.amountMinor,
    );
    /**
     * A rail that can be parked on the buyer, on a debit that has not said so yet, AT A
     * GATEWAY THAT WOULD NOT SAY SO. Such a row must be asked about early — the answer is
     * what turns the inference into a recorded fact below, and every protection
     * downstream is gated on that fact.
     *
     * ⚠️ THE GATEWAY GATE IS NOT OPTIONAL, and omitting it was a defect shipped earlier
     * on 2026-09-10. Stripe parks EVERY India e-mandate debit in `processing` for 26
     * hours to serve the pre-debit notification, whether or not anyone has to
     * authenticate it — `processing.card.customer_notification.approval_requested` is the
     * only thing that separates the two, and this pass never sees it. So a rail-and-age
     * inference stamped `AWAITING_AUTHENTICATION_CODE` on ordinary Stripe debits fifteen
     * minutes in, telling an operator and a buyer that the bank was waiting on them when
     * it was not, and clamping the grace to the 72h abandon clock on a debit that had 26
     * hours of legitimate waiting to do.
     *
     * The rule is the same one that governs the whole AFA path: a STATEMENT beats an
     * inference, and where a statement is coming the inference must not run at all.
     * Stripe states it (`requires_action`, and `applyActionRequired` by webhook).
     * RazorPay cannot, which is the case this probe exists for.
     *
     * The WINDOW below stays rail-only, deliberately: it is decided before the adapter is
     * resolved, looking sooner costs one poll that `deferPolls` immediately backs off, and
     * a poll is harmless. Only the RECORD can be wrong, so that is what carries the
     * gateway gate — see `mayRecordAuthenticationWait` further down, where the adapter
     * exists.
     */
    /**
     * ⚠️ THE AUTHENTICATION PROBE IS GONE (2026-09-12), and the reason is a measurement.
     *
     * It ran when `!needsAfa` — i.e. only BELOW the AFA-free ceiling — and stamped
     * `AWAITING_AUTHENTICATION_CODE` on any card/UPI debit a gateway still reported
     * unsettled after 15 minutes, on the premise that "RazorPay would have failed an
     * ordinary one at 10 minutes, so what holds this open is the bank's AFA link".
     *
     * RazorPay's own Late Authorisation page says otherwise: after the 10-minute timeout
     * they keep POLLING THE BANK FOR THREE DAYS and may mark the payment authorised
     * retroactively. So "still open" means "no answer from the bank yet" and nothing more.
     * Measured on one invoice, INV-100002: `pay_XXXXXXXXXXXX05` sat in `created` for 36
     * HOURS at ₹6,205.62 and then failed `insufficient_funds` — the probe would have told
     * that buyer their bank was waiting on them, clamped the grace to the 72h abandon
     * clock, and eventually booked `afa_not_completed` over the real reason.
     *
     * Nor can it be rescued by reading more: RazorPay publishes no in-flight signal at all
     * — status is `created` for both cases, no field on the Payment entity flags
     * authentication, there is no `payment.pending` webhook, and "Amount yet to be
     * authenticated by the bank" is dashboard-only copy over that same `created`. Their RBI
     * card-mandate page is explicit that AFA is between the issuing bank and the
     * cardholder: "You do not need to make any integration changes at your end."
     *
     * What remains is the AMOUNT rule, which is sound because it is a rule rather than an
     * inference: above `INR_AFA_FREE_CEILING_MINOR` RBI makes AFA compulsory, so
     * `needsAfa` still drives the abandon clamp below. Under the ceiling we simply do not
     * know, and the honest answer is to say nothing.
     */
    const graceHours = needsAfa
      ? Math.min(graceHoursFor(row.mandateRail, row.methodType), AFA_ABANDON_HOURS)
      : graceHoursFor(row.mandateRail, row.methodType);
    // Still inside its window — the clock waits; a targeted sync does not.
    if (!targeted && txn.createdAt.getTime() > now.getTime() - graceHours * HOUR_MS) continue;
    out.examined++;

    let adapter;
    try {
      adapter = await adapterForTransaction(txn);
    } catch (e) {
      // A gateway account that no longer resolves (deleted, credentials rotated
      // away) is an ops problem, not a verdict about the money. Count it as
      // unsupported and move on — inventing an outcome here is the one thing this
      // sweep must never do.
      out.unsupported++;
      // Back off too. This costs no gateway call, but an unresolvable gateway account does
      // not fix itself between ticks, and the row would otherwise hold a scan slot every
      // minute — pushing genuinely new stale charges past TICK_SCAN_LIMIT.
      deferLater(txn);
      log.warn("stale-pending: cannot resolve an adapter for this transaction", {
        txn: txn.publicId,
        error: String(e),
      });
      continue;
    }
    if (!adapter?.fetchChargeStatus) {
      out.unsupported++;
      // An adapter that cannot answer this question will not learn how before the next tick.
      deferLater(txn);
      continue;
    }

    let verdict;
    // In the charge's own span, so its "View request/response logs" shows these checks too.
    try {
      verdict = await joinSpan(txn.spanId, () =>
        adapter!.fetchChargeStatus!({ providerChargeId: txn.idAtGateway! }),
      );
    } catch (e) {
      // A failed poll says nothing about the payment. Leave it pending; the next
      // tick asks again.
      log.warn("stale-pending: gateway status poll failed", {
        txn: txn.publicId,
        error: String(e),
      });
      out.stillPending++;
      deferLater(txn);
      continue;
    }

    if (verdict.status === "succeeded") {
      await withTenant(txn.organizationId, (tx) => applyChargeVerdict(tx, txn, verdict, now));
      out.settled++;
    } else if (verdict.status === "failed") {
      await withTenant(txn.organizationId, (tx) => applyChargeVerdict(tx, txn, verdict, now));
      out.failed++;
    } else if (needsAfa && txn.createdAt.getTime() <= now.getTime() - AFA_ABANDON_HOURS * HOUR_MS) {
      // An authentication the buyer never completed, past the point where they still
      // could. The gateway says `created` (or `requires_action`) and will say it
      // forever — it is waiting on a person, not on a network — so deferring to it
      // here is what "parks until the heat death of the universe" looks like in code.
      //
      // Handed to dunning as NON-retriable: re-debiting the same amount on the same
      // rail stalls identically, so a retry is not a second chance, it is the same
      // stall with a fresh timer. `afa_not_completed` parks the invoice instead and
      // waits for the customer (portal Pay now, or a re-authorised mandate) —
      // bounded by the business's dunning period like every other parked invoice.
      await withTenant(txn.organizationId, async (tx) => {
        await setTransactionStatus(tx, txn.organizationId, txn.id, "failed", {
          errorCode: "afa_not_completed",
          retriable: false,
        });
        // The row now belongs to `recheckAbandonedAfaDebits`, which asks a DIFFERENT
        // question ("did they authorise it after all?"). Clear both schedules so that pass
        // starts at full attention rather than inheriting this one's patience.
        await clearPollSchedule(tx, txn.id, ["stale_pending", "afa_recheck"]);
        await settleTransactionOutcome(tx, {
          organizationId: txn.organizationId,
          businessId: txn.businessId,
          outcome: "failed",
          occurredAt: now,
          txn: {
            ...txn,
            errorCode: "afa_not_completed",
            errorText:
              "The customer did not complete their bank's additional-factor authentication for this " +
              "debit within the window it stays valid, so it can no longer be authorized. " +
              "Collect it through the portal, or have the customer re-authorize the mandate.",
          },
          retriable: false,
        });
      });
      out.failed++;
      log.info("stale-pending: abandoning a debit the buyer never authenticated", {
        event: "afa_not_completed",
        txn: txn.publicId,
        hours: AFA_ABANDON_HOURS,
      });
    } else {
      // `pending` or `requires_action`: the gateway is still working on it, and its
      // opinion outranks the clock's. Ask again later rather than in sixty seconds — this is
      // the branch that was the bulk of this pass's cost.
      out.stillPending++;
      deferLater(txn);
    }
  }

  await deferPolls("stale_pending", defer, now);

  // Charges whose answer was lost (`timeout`): found by our ref, or read by a stranded id.
  const { resolveLostAnswers } = await import("./lost-answer");
  await resolveLostAnswers(now, out, targeted ? { onlyTransactionId: targeted } : undefined);

  await recheckAbandonedAfaDebits(now, out);
  await abandonZeroDueDebits(now, out);
  await releaseZeroDueIntents(now, out);

  // Schedules whose transaction left every sweep's population by a route that never went
  // through `clearPollSchedule` — a webhook settling it, an operator reconciling by hand.
  await reapFinishedPollSchedules();

  if (
    out.settled > 0 ||
    out.failed > 0 ||
    out.afaRecovered > 0 ||
    out.zeroDueClosed > 0 ||
    out.zeroDueIntentsVoided > 0 ||
    out.lostAnswerFound > 0 ||
    out.lostAnswerNotCreated > 0
    // Not `zeroDueStillLive` / `zeroDueIntentsUncancellable`: those count rows that are
    // STILL stuck, so they would repeat this line every tick until someone intervened.
  ) {
    // Worth a line at info: every row here is an attempt whose webhook did NOT
    // arrive, which is a signal about webhook delivery health, not just about
    // these payments.
    log.info("stale-pending sweep: attempts whose settlement webhook never arrived", {
      event: "stale_pending_swept",
      ...out,
    });
  }
  return out;
}

/**
 * SECOND PASS: ask again about debits the buyer abandoned, in case they authorised one
 * after all.
 *
 * See {@link AFA_RECHECK_UNTIL_HOURS} for the hole this closes and why the window ends.
 * The shape is the first pass's, deliberately — over-select, ask the gateway, never decide
 * — with two differences:
 *
 *  · it selects `failure` + any {@link AFA_REVIVABLE_CODES} rather than `in_progress`,
 *    because those are the states abandoning leaves behind (`stale-pending`'s own 72-hour
 *    branch, and the portal's "I won't approve this");
 *
 *    ⚠️ It selected ONLY `afa_not_completed` until 2026-09-09, and that left the rows
 *    written by the pre-fix `requires_action` path with nobody asking about them —
 *    `txn_XXXXXXXXXXXXXXXXXXXXXX03` (INV-100001) among them, whose Stripe intent
 *    `pi_XXXXXXXXXXXXXXXXXXXXXX06` sat `Incomplete` with 3D Secure begun and finishable.
 *    The webhook path could still have settled it (`AFA_REVIVABLE_CODES` gates that too),
 *    but this sweep exists precisely because a settlement webhook may never arrive — and
 *    in the ₹17,736.11 case it arrived twice and was dropped both times. Sharing the set
 *    keeps the two halves of that repair from disagreeing about which rows are revivable;
 *  · a `succeeded` answer is NOT settled here. It goes to `reconcileAbandonedCapture`, the
 *    same function the webhook calls, which books the money and returns whatever the
 *    invoice could not take. Having the sweep book it its own way would be a second
 *    implementation of a money policy, and the two would drift.
 *
 * A `failed` or still-`created` answer is left EXACTLY as it is. The row is already a
 * terminal local failure that dunning has been told about and the customer may already have
 * paid another way; re-writing it would re-notify and re-park for no new information.
 */
async function recheckAbandonedAfaDebits(now: Date, out: StalePendingResult): Promise<void> {
  // Dynamic, like the `reconcileAbandonedCapture` import below: `webhooks/inbound` reaches
  // back into this module, and a static import would close the cycle.
  const { AFA_REVIVABLE_CODES } = await import("@/modules/webhooks/inbound");
  const candidates = await systemDb
    .select({ txn: transactions })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "failed"),
        inArray(transactions.errorCode, [...AFA_REVIVABLE_CODES]),
        // Nothing to ask about without a gateway handle — same rule as the first pass.
        isNotNull(transactions.idAtGateway),
        // Past the link's own validity plus settle margin the debit cannot have captured.
        gt(transactions.createdAt, new Date(now.getTime() - AFA_RECHECK_UNTIL_HOURS * HOUR_MS)),
        scanBusinessFilter(transactions.businessId),
      ),
    )
    .orderBy(transactions.createdAt)
    .limit(config.TICK_SCAN_LIMIT);

  const defer: PollDeferral[] = [];
  const deferLater = (t: { organizationId: string; id: string }) =>
    defer.push({ organizationId: t.organizationId, transactionId: t.id });
  const skip = await deferredUntilLater("afa_recheck", now);

  for (const { txn } of candidates) {
    // A row with no payment behind it cannot be reconciled by the shared policy (its claim
    // is the payment's `failed → succeeded` flip), and inventing one here would bypass the
    // one guard that makes redelivery safe. A payment request's charge is the exception: its
    // children carry the payments and the transaction's own flip is the claim.
    if (!txn.paymentId && !txn.paymentRequestId) continue;
    if (skip.has(txn.id)) continue;
    let adapter;
    try {
      adapter = await adapterForTransaction(txn);
    } catch (e) {
      log.warn("afa-recheck: cannot resolve an adapter for this transaction", {
        txn: txn.publicId,
        error: String(e),
      });
      deferLater(txn);
      continue;
    }
    if (!adapter?.fetchChargeStatus) {
      deferLater(txn);
      continue;
    }
    out.afaRechecked++;

    let verdict;
    try {
      verdict = await joinSpan(txn.spanId, () =>
        adapter!.fetchChargeStatus!({ providerChargeId: txn.idAtGateway! }),
      );
    } catch (e) {
      // Says nothing about the money. The next tick asks again, until the window closes.
      log.warn("afa-recheck: gateway status poll failed", { txn: txn.publicId, error: String(e) });
      deferLater(txn);
      continue;
    }
    // Still not authorised. That is the expected answer for almost every row here, every
    // tick, until the window closes — so it is the one that most needs backing off.
    if (verdict.status !== "succeeded") {
      deferLater(txn);
      continue;
    }

    const { reconcileAbandonedCapture, reconcileLateRequestCapture } =
      await import("@/modules/webhooks/inbound");
    const result = txn.paymentId
      ? await reconcileAbandonedCapture(txn, now)
      : await reconcileLateRequestCapture(txn, {
          providerKey: txn.gatewayKey ?? adapter.key,
          chargeId: txn.idAtGateway!,
          occurredAt: now,
        });
    // A newer attempt on the request is pending; ask again next tick.
    if (result === "in_flight") {
      deferLater(txn);
      continue;
    }
    if (result === "processed") out.afaRecovered++;
    log.warn("afa-recheck: a debit the buyer had abandoned was authorized after all", {
      event: "afa_recheck_recovered",
      txn: txn.publicId,
      payment: txn.paymentId,
      amountMinor: String(txn.amountMinor),
      currency: txn.currency,
      outcome: result,
    });
  }

  await deferPolls("afa_recheck", defer, now);
}

/**
 * How long a live debit and a zero balance may legitimately coexist before this pass
 * treats the pair as real rather than as a settle in flight.
 *
 * The two can be true at once for an instant by construction: applying a payment drives
 * `amount_due_minor` to 0 and flips the transaction to `success`, and a reader between
 * those two writes sees exactly the shape this pass hunts for. That window is one database
 * transaction wide — sub-second — and the only thing this margin has to clear. It is
 * measured in minutes and not hours on purpose: the AFA link the buyer may act on is valid
 * 72 HOURS, so anything at the scale of the real hazard would leave the request live for
 * most of its life, which is the whole defect.
 */
const ZERO_DUE_SETTLE_MARGIN_MS = 15 * 60 * 1000;

/**
 * "This invoice owes nothing" — `invoiceOutstanding`'s rule, expressed in SQL.
 *
 * ⚠️ **`amount_due_minor = 0` is NOT that test, and reading it as one is a documented
 * misreading of this schema** (`db/schema/invoices.ts`: "Never decremented as payments
 * land … Read this column and you will conclude a settled invoice is still owed; that
 * misreading has happened"). The column is the ISSUE-TIME collectible, moved afterwards by
 * CREDIT applications only — `credit-notes/service.ts` decrements it, cash never does. So
 * keying on it would have covered exactly one producer, the adjustment credit note the
 * portal report happened to come from, and missed every invoice settled by money: a buyer
 * paying in the portal, an operator recording a cheque, a customer-credit application.
 * Those are the ones where a live debit on top is a genuine DOUBLE collection.
 *
 * Caught by `verify:stale-pending` § Q on its first run — the fixture settles the invoice
 * with a real offline payment, and under an `amount_due_minor = 0` predicate the pass
 * examined 0 rows against an invoice reading `paid` with the column still at its full
 * ₹56,715. The same misreading is why the headline figure in the original report needed
 * re-measuring; see `scripts/probe-zero-due-debits.ts` § C.
 *
 * `coalesce(amount_due_minor, total_minor)` because null means "the whole total", and
 * `<= 0` rather than `= 0` because a credit note can take the collectible below zero.
 */
const OWES_NOTHING = sql`
  coalesce(${invoices.amountDueMinor}, ${invoices.totalMinor})
    - coalesce((
        select sum(${payments.amountMinor}) from ${payments}
         where ${payments.invoiceId} = ${invoices.id}
           and ${payments.status} = 'succeeded'
      ), 0) <= 0`;

/**
 * THIRD PASS: end a debit request that is still live at the rail against an invoice which
 * owes NOTHING.
 *
 * ── The defect ────────────────────────────────────────────────────────────────
 * Reported from the buyer portal 2026-08-31: four invoices read "Paid", due ₹0.00, and in
 * the same row invited the customer to approve their bank's request. Each had been settled
 * by an adjustment credit note from the next plan change, driving `amount_due` to 0 — and
 * the debit already dispatched to the rail was left `pending`. The prompt is not
 * decorative: it is the RBI/NPCI above-₹15,000 AFA approval, so approving really does move
 * money, for an invoice that owes none. The portal copy was fixed first, and fixing copy
 * does not cancel a request — hiding the prompt only means the buyer meets it at their
 * bank instead of here.
 *
 * Measured across the whole dev database 2026-09-01 (`scripts/probe-zero-due-debits.ts`
 * § C), under {@link OWES_NOTHING} rather than the report's `amount_due_minor = 0`:
 * **212 non-terminal payments on invoices that really owe nothing**, every one against an
 * invoice already `status = 'paid'` — 8 INR card debits totalling **₹2,39,087.90** (7 of
 * them RazorPay) and 204 tmtest USD test rows at $18,258.00. The original reading found 7
 * INR / ₹2,06,921.10; the debit it missed is one settled by MONEY rather than by a credit
 * note, which is the shape where a live debit on top double-collects.
 *
 * ── Why a SWEEP, and not a hook on the credit note ────────────────────────────
 * The tempting fix is to call this where a credit note settles an invoice, because that is
 * where the reported four came from. It is the wrong shape. "Owes nothing" has many
 * producers — an applied credit note, a portal card payment, an operator recording a
 * cheque, customer credit, a write-off, a void — and each is a separate site that can be
 * added later and forgotten, which is precisely how these four survived
 * `pendingPaymentForInvoice` and `CollectionInFlightError` already existing on the
 * collection side. A sweep is producer-agnostic: it keys on the CONDITION, so a settlement
 * path nobody has written yet is covered on the day it ships, and the 211-row backlog is
 * covered too, which no hook could reach. It also costs no latency worth having — the
 * hazard it closes is a 72-hour bank link, and the clock ticks far more often than that.
 *
 * ── What it does NOT do ───────────────────────────────────────────────────────
 * It does not decide anything itself. It hands each invoice to
 * {@link abandonAuthenticationPendingDebit} — the SAME function the portal's "I won't
 * approve this" calls — which asks the gateway first and only overrules a still-unsettled
 * answer. A debit that has landed is settled and booked as it always would be.
 *
 * ⚠️ **`not_authentication` is left alone, deliberately, and that is not a gap.** An
 * ordinary slow settlement — a netbanking presentation, a UPI Autopay debit, an ACH cycle
 * — is not waiting on the buyer and WILL land on its own. Failing it locally would not stop
 * it; it would only make the real settlement arrive as `settlement_dropped_not_pending`,
 * losing the booking for money that moved. So only debits that wait on a person are ended,
 * which is exactly the population the portal was inviting approval for. In the measured
 * data that restriction is what separates the 7 INR card debits from the 204 USD test rows.
 *
 * ── The peer report of "held authorisations nothing alerts on" is THIS, not a second bug ─
 * Seven debits reported in flight on one subscription — five from ~11:00 totalling
 * ₹1,85,790 with real RazorPay charge ids, plus ₹32,166.80 and ₹16,130.10 — against
 * invoices since credited in full, alerting nowhere and not due for a stale-pending poll
 * for days on a card's 96h grace. Measured (probe § C5): the seven are exactly the seven
 * RazorPay `type = 'payment'` rows in this pass's population, **₹2,34,087.90**, every one
 * of them AFA-eligible and so every one of them closed here. No second mechanism was
 * built; the reason they alerted nowhere is that `unapplied_gateway_money` counts
 * `needs_attention` holds and detached captures, and an `in_progress` debit is neither.
 *
 * ⚠️ A `type = 'authorization'` row against a zero-owing invoice is a DIFFERENT shape and
 * is deliberately out of scope: a hold wants RELEASING at the gateway (`voidPaymentIntent`
 * / `releaseHoldBeforeExpiry`), not abandoning locally, and the two must not be conflated.
 *
 * ⚠️ **"None exist in the measured data" — that justification is FALSE, as of 2026-09-03.**
 * It was true of `transactions`, and it was read as if it were true of the hazard. Two live
 * buyer checkouts sat on invoices owing nothing, ₹53,241.60 together (`…kRpVDGwi`
 * ₹22,184.00 on INV-7824, `…ipb8QtRU` ₹31,057.60 on INV-6287) — as `payment_intents` rows,
 * which have no transaction row and so appear in NO population this pass can select. The
 * out-of-scope reasoning above still holds, which is why the answer is
 * {@link releaseZeroDueIntents} below rather than a widened selector here.
 *
 * ⚠️ **Abandoning stays local-only at RazorPay** (`intentVoid: false`, every cancel route
 * 404s), so this cannot promise the request is gone from the bank's side. What it changes
 * is that the request is no longer OUTSTANDING in our books, and an approval that arrives
 * anyway is now covered by the second pass above — `recheckAbandonedAfaDebits` selects
 * exactly the `failure` + `afa_not_completed` rows this leaves behind and hands a
 * `succeeded` answer to `reconcileAbandonedCapture`, which books the money and refunds
 * what the invoice cannot take. Before this pass such an approval had no policy at all: it
 * arrived against a zero-due invoice as an ordinary settlement.
 */
async function abandonZeroDueDebits(now: Date, out: StalePendingResult): Promise<void> {
  const candidates = await systemDb
    .selectDistinctOn([transactions.invoiceId], {
      txn: transactions,
      organizationId: transactions.organizationId,
      businessId: transactions.businessId,
      invoiceId: transactions.invoiceId,
    })
    .from(transactions)
    .innerJoin(invoices, eq(invoices.id, transactions.invoiceId))
    .where(
      and(
        eq(transactions.status, "in_progress"),
        // Debits only — an in-flight REFUND is `in_progress` on the same invoice and is
        // nobody's outstanding request (see the same filter in the abandon function).
        eq(transactions.type, "payment"),
        // Nothing to ask the gateway about without a handle — same rule as both passes above.
        isNotNull(transactions.idAtGateway),
        OWES_NOTHING,
        // See ZERO_DUE_SETTLE_MARGIN_MS: clears the instant in which a settle is mid-write.
        lt(transactions.createdAt, new Date(now.getTime() - ZERO_DUE_SETTLE_MARGIN_MS)),
        scanBusinessFilter(transactions.businessId),
      ),
    )
    // `selectDistinctOn` requires the distinct columns to lead the ordering; oldest-first
    // after that, for the same reason as the passes above — the longest-outstanding
    // request is the one a buyer is most likely to be staring at.
    .orderBy(transactions.invoiceId, transactions.createdAt)
    .limit(config.TICK_SCAN_LIMIT);

  const defer: PollDeferral[] = [];
  const skip = await deferredUntilLater("zero_due", now);

  for (const row of candidates) {
    if (!row.invoiceId) continue;
    if (skip.has(row.txn.id)) continue;
    out.zeroDueExamined++;
    let result;
    try {
      result = await abandonAuthenticationPendingDebit({
        organizationId: row.organizationId,
        businessId: row.businessId,
        invoiceId: row.invoiceId,
        now,
        // The invoice owes nothing, so a debit that lands on its own is the problem and
        // not the happy path — ask about EVERY provider's in-flight debit, not just the
        // ones waiting on an Indian bank's additional-factor step.
        requireAuthenticationShape: false,
        endedBy: "credited_invoice",
      });
    } catch (e) {
      // One row must never stop the sweep — the same rule the other two passes keep.
      log.warn("zero-due: could not end an outstanding debit on a settled invoice", {
        txn: row.txn.publicId,
        invoice: row.invoiceId,
        error: String(e),
      });
      defer.push({ organizationId: row.organizationId, transactionId: row.txn.id });
      continue;
    }
    // `none_pending` means another writer got there between the scan and the call;
    // `not_authentication` and `unsupported` are the documented leave-alone verdicts.
    // `none_pending`, `not_authentication` and `unsupported` are the documented
    // leave-alone verdicts, and they are what 209 rows a tick were returning. A row that
    // answered one of them will answer it again next minute.
    if (
      result.outcome !== "released" &&
      result.outcome !== "settled" &&
      result.outcome !== "failed_at_gateway"
    ) {
      defer.push({ organizationId: row.organizationId, transactionId: row.txn.id });
    }
    /**
     * MONEY THAT CAN STILL ARRIVE FOR A DEBT THAT NO LONGER EXISTS, and no way to stop it.
     *
     * Deliberately not booked as failed: it is live at the rail. Deliberately not silent
     * either — this is the one outcome of this sweep an operator may need to act on, by
     * asking the customer to release the debit from the portal before it settles. It was
     * invisible until now: the AFA gate returned `not_authentication` here and the row was
     * deferred like an uninteresting one, every tick, for as long as it stayed live.
     */
    if (result.outcome === "still_live") {
      out.zeroDueStillLive++;
      log.warn("a live debit cannot be stopped and the invoice it targets owes nothing", {
        event: "zero_due_debit_still_live",
        txn: row.txn.publicId,
        invoice: row.invoiceId,
        gateway: row.txn.gatewayKey,
        amountMinor: String(row.txn.amountMinor),
      });
    }
    if (
      result.outcome === "released" ||
      result.outcome === "settled" ||
      result.outcome === "failed_at_gateway"
    ) {
      out.zeroDueClosed++;
      log.warn("a debit was still live at the rail against an invoice that owed nothing", {
        event: "zero_due_debit_closed",
        outcome: result.outcome,
        txn: row.txn.publicId,
        invoice: row.invoiceId,
        amountMinor: String(row.txn.amountMinor),
        currency: row.txn.currency,
      });
    }
  }

  await deferPolls("zero_due", defer, now);
}

/**
 * Intents this process has already found uncancellable — the fourth pass's stand-in for
 * a poll schedule, and the reason it is in memory rather than in a table.
 *
 * `settlement_poll_schedule.transaction_id` carries `references(() => transactions.id)`,
 * and an intent has NO transaction row (that absence is the whole defect below), so the
 * deferral the other three passes use cannot express one. Without SOME memory a single
 * stranded intent would repeat its warning every 60 seconds for the days its TTL runs —
 * 1,440 identical lines a day, which is how a signal becomes noise.
 *
 * Losing it on restart is acceptable and slightly useful: the retry costs no gateway call
 * on a provider that cannot void (the capability is checked before the network), and an
 * intent whose invoice has since been re-opened deserves a fresh look. What must NOT
 * depend on this set is knowing the money is stranded — that is state, and it is read
 * from the database by the ops alert, not from a counter or a log line.
 */
const uncancellableZeroDueIntents = new Set<string>();

/**
 * FOURTH PASS: a buyer's own CHECKOUT is live at the gateway for an invoice that owes
 * nothing.
 *
 * ── The defect, measured to the second on INV-7824 (2026-09-03) ────────────────
 *  · 11:59:10        portal "Pay now" minted intent `pi_XXXXXXXXXXXXXXXXXXXXXX05`,
 *                    ₹22,184.00, RazorPay order `order_XXXXXXXXXXXX03`.
 *  · 11:59:57.948    a PRO→LITE downgrade raised adjustment CN-3007 for exactly
 *                    ₹22,184.00 against that same invoice and applied it there — invoice
 *                    `paid`, ₹0.00 due. Forty-seven seconds.
 *  · 12:15:57        the capture landed, was booked as excess and auto-refunded three
 *                    seconds later. The accounting was right; the collision was never
 *                    prevented and went unremarked for sixteen minutes.
 *
 * {@link abandonZeroDueDebits} above cannot see this, and its docblock says why in the
 * wrong tense: it keys on `transactions.status = 'in_progress' AND type = 'payment' AND
 * id_at_gateway IS NOT NULL`, and an intent has no transaction row at all until its
 * capture settles. That docblock also put `type = 'authorization'` out of scope on the
 * grounds that "None exist in the measured data" — **that justification was falsified the
 * same day**: two live intents on zero-owing invoices, ₹53,241.60 together
 * (`…kRpVDGwi` ₹22,184.00 on INV-7824, `…ipb8QtRU` ₹31,057.60 on INV-6287). The REASONING
 * held — a hold wants releasing at the gateway, not abandoning locally — so this is a
 * pass of its own rather than a widened selector on that one.
 *
 * ── What it does ──────────────────────────────────────────────────────────────
 * It hands the intent to `voidPaymentIntent`, the same function an operator's "Void"
 * calls, which asks the GATEWAY to release the hold and only then closes our row (and
 * records the `payment_reversal` transaction + `payment_intent_voided` event that make the
 * release visible). No local status is invented here.
 *
 * ── What it does NOT do, and this is the important half ───────────────────────
 * Where the gateway will not release — RazorPay declares `intentVoid: false` and every
 * documented cancel route 404s, and any gateway refuses once the money has actually been
 * captured — **nothing local is changed**. Marking our intent `voided` would assert the
 * buyer's money is back when it is not, which is precisely the class of lie #15 was filed
 * for (our status going stale against the gateway's). What happens instead is that it is
 * counted, logged by name, and left visible: to the OPERATOR through
 * `debits_in_flight` on the change screen (`kind: 'intent'`), and to the BUYER through the
 * portal's zero-due reply, which now says their payment is still with the bank and will
 * come back on its own. A capture that lands anyway is already covered —
 * `reconcileUnmatchedCapture` books it, detaches it and refunds it, and
 * `auto_refunded_unapplied_money` fires (it did, on this very event).
 *
 * ⚠️ It deliberately does not touch an invoice that STILL OWES. A live intent there is a
 * buyer paying a real debt: the portal resumes that checkout on a second click, and
 * voiding it would take the money they are trying to give us out from under them.
 */
async function releaseZeroDueIntents(now: Date, out: StalePendingResult): Promise<void> {
  const candidates = await systemDb
    .select({ pi: paymentIntents })
    .from(paymentIntents)
    .innerJoin(invoices, eq(invoices.id, paymentIntents.invoiceId))
    .where(
      and(
        // Money only. A `setup` intent vaults an instrument at amount 0 and has nothing
        // to do with what an invoice owes.
        eq(paymentIntents.purpose, "payment"),
        // The same live predicate `liveIntentForInvoice` and the portal's resume guard
        // use. `inited` is excluded on purpose: a REFUSED authorization leaves the intent
        // open with its ATTEMPT failed, so nothing is held and there is nothing to release.
        inArray(paymentIntents.status, ["in_progress", "authorized"]),
        isNull(paymentIntents.voidedAt),
        or(isNull(paymentIntents.expiresAt), gt(paymentIntents.expiresAt, now)),
        OWES_NOTHING,
        /**
         * See {@link ZERO_DUE_SETTLE_MARGIN_MS}. Read off the INTENT's last write rather
         * than the transaction's creation, because the race here is the intent's own
         * consume: settling drives the invoice to zero and flips the intent to `consumed`
         * in one database transaction, and a reader between those writes sees exactly the
         * shape this pass hunts. One tx is sub-second; fifteen minutes clears it with
         * room, and is nowhere near the days an intent's TTL can run.
         */
        lt(paymentIntents.updatedAt, new Date(now.getTime() - ZERO_DUE_SETTLE_MARGIN_MS)),
        scanBusinessFilter(paymentIntents.businessId),
      ),
    )
    // Oldest first, same rule as the three passes above: the longest-outstanding checkout
    // is the one a buyer is most likely to still have open.
    .orderBy(paymentIntents.createdAt)
    .limit(config.TICK_SCAN_LIMIT);

  for (const { pi } of candidates) {
    if (uncancellableZeroDueIntents.has(pi.id)) continue;
    out.zeroDueIntentsExamined++;
    try {
      await voidPaymentIntent(pi.organizationId, pi.businessId, pi.publicId);
      out.zeroDueIntentsVoided++;
      log.warn("a checkout was live at the gateway for an invoice that owed nothing", {
        event: "zero_due_intent_voided",
        intent: pi.publicId,
        invoice: pi.invoiceId,
        amountMinor: String(pi.amountMinor ?? 0n),
        currency: pi.currency,
      });
    } catch (e) {
      /**
       * SOMEONE ELSE GOT THERE FIRST is not a failure. The scan runs outside any
       * transaction, so between it and this call the buyer's own second leg or the
       * webhook harvest can consume the intent, or another tick can void it. Both answer
       * `PaymentIntentError` by name, and neither is money stranded — counting them as
       * uncancellable would report a problem that resolved itself correctly.
       */
      if (e instanceof PaymentIntentError && /already (consumed|voided)/i.test(e.message)) {
        out.zeroDueIntentsExamined--;
        continue;
      }
      out.zeroDueIntentsUncancellable++;
      uncancellableZeroDueIntents.add(pi.id);
      /**
       * The buyer's money may still arrive for a debt that no longer exists, and we
       * cannot stop it. Named at WARN because it is the one outcome of this pass a human
       * may need to act on — and named honestly: `gateway_cannot_void` is a capability
       * (RazorPay), `gateway_refused` is usually money that has ALREADY been captured,
       * and either way the local row is left exactly as it was.
       */
      log.warn("a live checkout cannot be cancelled and the invoice it targets owes nothing", {
        event: "zero_due_intent_uncancellable",
        reason:
          e instanceof PaymentIntentVoidUnsupportedError
            ? "gateway_cannot_void"
            : "gateway_refused",
        intent: pi.publicId,
        invoice: pi.invoiceId,
        amountMinor: String(pi.amountMinor ?? 0n),
        currency: pi.currency,
        error: String(e),
      });
    }
  }
}

/**
 * The buyer says they will not authorise the debit that is blocking their invoice.
 *
 * ── The problem this solves ───────────────────────────────────────────────────
 * An AFA debit holds the invoice for the full life of the bank's link. Pay now is
 * blocked the whole time (`CollectionInFlightError` — correctly: two live attempts on
 * one invoice is how you double-charge someone). So a customer who has decided not to
 * use that mandate — wrong account, link never arrived, they would rather pay by card
 * — can do nothing but wait out a window measured in days for a payment they have
 * already decided against. That is the wait the buyer was complaining about, and no
 * amount of better copy fixes it: the block is real, only the customer can release it,
 * and until now they had no way to say so.
 *
 * ── What it does, and the one thing it must never do ──────────────────────────
 * It ASKS THE GATEWAY FIRST, always. The buyer's intent decides nothing about money
 * that has already moved: if the debit has landed we settle it as paid and tell them
 * so, and if the gateway has already failed it we book that failure with the gateway's
 * own reason. Only a debit the gateway still reports as unsettled is overruled, and
 * only then because the buyer — the one person whose action it was waiting on — has
 * said it will never come.
 *
 * ⚠️ **The residual hazard, stated plainly.** RazorPay cannot void a recurring payment
 * stuck in `created` (`intentVoid: false`, every cancel route 404s), so abandoning is
 * local-only: within the link's 72 hours the buyer could still authenticate it, and it
 * would capture on top of whatever they pay in the portal. Nothing in the engine can
 * prevent that. What it can do is refuse to be silent — `settleTransactionOutcome`
 * logs `settlement_dropped_not_pending` when a success arrives for a payment that is
 * no longer pending, which is the line an operator reconciles a double charge from.
 * The portal copy carries the other half: tell the buyer to decline the bank's request
 * if it still arrives.
 *
 * Deliberately restricted to debits that WAIT ON THE BUYER
 * (`debitAwaitsBuyerAuthentication`). An ordinary slow settlement — a netbanking
 * presentation, an ACH cycle — is not waiting on them and will land on its own; letting
 * a buyer "abandon" one would invite exactly the double payment above for no reason.
 *
 * ⚠️ That restriction is on the SHAPE, never on the amount. It used to read the AFA
 * amount rule, so a buyer challenged for ₹885 was told there was nothing to abandon —
 * on the one invoice `CollectionInFlightError` had locked them out of. Reading the
 * gateway's recorded statement is what makes the release available to everyone the
 * gateway actually stopped.
 */
export async function abandonAuthenticationPendingDebit(input: {
  organizationId: string;
  businessId: string;
  /** Internal invoice id (the caller has already proven ownership). */
  invoiceId: string;
  now: Date;
  /**
   * Refuse anything that is not waiting on the buyer's bank. Defaults to TRUE, which is
   * the portal's contract; only the zero-due sweep passes false. See the note at the gate.
   */
  requireAuthenticationShape?: boolean;
  /**
   * WHO ended it. The text booked below names them, and exactly one caller is the customer.
   *
   * Required, with no default, because getting this wrong is not cosmetic: the text rides
   * `payment_failed`, and `emailTypeForEvent` maps every one of those to the payer's mail
   * unconditionally. Until 2026-09-03 the sweep reused the customer's sentence, so a buyer
   * whose invoice an OPERATOR had credited was emailed that THEY declined the debit and
   * asked to pay another way. Nobody had.
   */
  endedBy: "customer" | "credited_invoice";
}): Promise<
  /**
   * `voidedAtGateway` is the OBSERVED result of cancelling, never "we tried" and never
   * "the gateway supports it". It decides whether the buyer is warned that the original
   * debit could still capture — a warning that is true when we could not cancel and a
   * lie when we could, so it must not be guessed.
   */
  | { outcome: "released"; voidedAtGateway: boolean }
  | { outcome: "settled" }
  | { outcome: "failed_at_gateway"; code: string | null }
  | { outcome: "none_pending" }
  | { outcome: "not_authentication" }
  | { outcome: "still_live" }
  | { outcome: "unsupported" }
> {
  const [row] = await systemDb
    .select({
      txn: transactions,
      mandateRail: paymentMethods.mandateRail,
      methodType: paymentMethods.type,
    })
    .from(transactions)
    .leftJoin(paymentMethods, eq(paymentMethods.id, transactions.paymentMethodId))
    .where(
      and(
        eq(transactions.organizationId, input.organizationId),
        eq(transactions.invoiceId, input.invoiceId),
        eq(transactions.status, "in_progress"),
        // A DEBIT, not merely an in-flight row. `transactions` is the whole gateway-side
        // money log, and a refund in flight is `in_progress` on the same invoice — measured
        // 2026-09-01: 3 such rows in the dev database sit on invoices that owe nothing. With
        // no type filter and a bare `limit(1)` this could pick the refund, answer
        // `not_authentication` for it and report "no debit to abandon" on an invoice that
        // has one. Nothing about a refund is waiting on the buyer's bank.
        eq(transactions.type, "payment"),
        isNotNull(transactions.idAtGateway),
      ),
    )
    // Deterministic, so two calls on one invoice cannot disagree about which debit they
    // are talking about. Oldest first: the debit that has been blocking longest.
    .orderBy(transactions.createdAt)
    .limit(1);
  if (!row) return { outcome: "none_pending" };
  const { txn } = row;
  const authenticationShaped = debitAwaitsBuyerAuthentication(
    txn,
    { mandateRail: row.mandateRail, type: row.methodType },
    txn.currency,
    txn.amountMinor,
  );
  /**
   * The AFA shape is REQUIRED of the portal and OPTIONAL of the zero-due sweep, and the
   * asymmetry is principled rather than a convenience.
   *
   * For the portal the gate is load-bearing: a debit that lands on its own is one the
   * buyer must not be able to abandon, or we invite the double payment the guard exists
   * to prevent (see the 400 it returns). The invoice there is OWED, so a debit that
   * completes by itself is the good outcome.
   *
   * For the sweep the invoice owes NOTHING, so "it will complete on its own" is precisely
   * the danger. Measured 2026-09-03: 209 in-flight debits sit on zero-due invoices and
   * this gate returned `not_authentication` for every one of them, tick after tick — the
   * count the leave-alone comment in `abandonZeroDueDebits` records. So a debit that had
   * ALREADY SETTLED at the rail against an invoice owing nothing was never even asked
   * about, on any provider. Asking is always safe; what to DO about one that is still
   * live is a separate decision (see `still_live` below).
   */
  if (input.requireAuthenticationShape !== false && !authenticationShaped)
    return { outcome: "not_authentication" };

  let adapter;
  try {
    adapter = await adapterForTransaction(txn);
  } catch (e) {
    log.warn("abandon: cannot resolve an adapter for this transaction", {
      txn: txn.publicId,
      error: String(e),
    });
    return { outcome: "unsupported" };
  }
  // No way to ask ⇒ no way to know. Refusing here is the same invariant the sweep
  // keeps: this module never invents an outcome, not even a convenient one.
  if (!adapter?.fetchChargeStatus) return { outcome: "unsupported" };

  let verdict;
  try {
    verdict = await joinSpan(txn.spanId, () =>
      adapter!.fetchChargeStatus!({ providerChargeId: txn.idAtGateway! }),
    );
  } catch (e) {
    log.warn("abandon: could not reach the gateway to confirm the debit", {
      txn: txn.publicId,
      error: String(e),
    });
    return { outcome: "unsupported" };
  }

  if (verdict.status === "succeeded") {
    await withTenant(input.organizationId, async (tx) => {
      await setTransactionStatus(tx, input.organizationId, txn.id, "succeeded", {});
      await settleTransactionOutcome(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        outcome: "succeeded",
        occurredAt: input.now,
        txn,
      });
    });
    return { outcome: "settled" };
  }

  if (verdict.status === "failed") {
    const errorCode = verdict.failure?.code ?? "async_failed";
    const retriable = verdict.failure?.retriable ?? true;
    await withTenant(input.organizationId, async (tx) => {
      await setTransactionStatus(tx, input.organizationId, txn.id, "failed", {
        errorCode,
        retriable,
      });
      await settleTransactionOutcome(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        outcome: "failed",
        occurredAt: input.now,
        txn: {
          ...txn,
          errorCode,
          ...(verdict.failure?.message ? { errorText: verdict.failure.message } : {}),
        },
        retriable,
      });
    });
    return { outcome: "failed_at_gateway", code: errorCode };
  }

  /**
   * STILL LIVE AT THE RAIL, and not waiting on the buyer — so nobody has told us it will
   * not land, and we have no way to stop it: `voidIntent` takes an INTENT id and not one
   * in-flight debit in this database carries one (measured across razorpay, stripe and
   * tmtest), so there is no cancellation to attempt here on any provider.
   *
   * Reported as its own outcome rather than booked. Booking it `failed` would be a lie
   * about live money, and reusing the text below would tell a customer they declined
   * something they never saw. The caller decides what to do with a debit it cannot stop.
   */
  if (!authenticationShaped) return { outcome: "still_live" };

  /**
   * CANCEL IT AT THE GATEWAY FIRST, where the gateway lets us.
   *
   * The order is the buyer's rule and it is not negotiable: we have already ASKED
   * (`fetchChargeStatus` above), and a debit that succeeded or failed never reaches here.
   * Only something the gateway still reports as unsettled may be cancelled.
   *
   * Stripe can: `paymentIntents.cancel` from `requires_action` genuinely kills the intent,
   * so the buyer cannot later complete the 3D Secure and be charged on top of what they
   * pay in the portal. RazorPay cannot — `intentVoid: false`, every documented cancel
   * route 404s for a recurring payment stuck in `created` — and neither can Stripe during
   * an India e-mandate's 26-hour pre-debit window, which their own docs say "can't be
   * cancelled". So this is best-effort by construction, and the buyer is told the truth
   * either way.
   *
   * ⚠️ THE RACE IS THE WHOLE RISK. Between the status read and this cancel the buyer can
   * finish authenticating. Stripe then refuses with "not in a cancelable state" — the SAFE
   * failure, but it must never be recorded as a void. We re-read instead, and a debit that
   * has landed takes the `settled` path: they paid, there is nothing to abandon.
   *
   * ⚠️ A void we cannot confirm is NOT a void. `voidIntent` answers `held: undefined` for
   * "cannot say", and reading that as "nothing was held" is defect #21 with the sign
   * flipped. Anything short of an observed `voided: true` leaves the warning in place.
   *
   * Never fatal: releasing the buyer's invoice must not depend on the gateway cooperating.
   */
  let voidedAtGateway = false;
  if (adapter.capabilities?.intentVoid && adapter.voidIntent && txn.idAtGateway) {
    try {
      const res = await adapter.voidIntent({
        intentId: txn.idAtGateway,
        idempotencyKey: `abandon-${txn.publicId}`,
      });
      voidedAtGateway = res.voided === true;
    } catch (e) {
      // Did they authenticate while we were deciding? Ask again — the gateway's answer
      // outranks our intention, exactly as it did before we started.
      let recheck;
      try {
        recheck = await adapter.fetchChargeStatus?.({ providerChargeId: txn.idAtGateway });
      } catch {
        recheck = undefined;
      }
      if (recheck?.status === "succeeded") {
        log.info("abandon: the buyer authenticated while we were cancelling — settling instead", {
          event: "afa_abandon_raced_settlement",
          txn: txn.publicId,
          invoice: input.invoiceId,
        });
        await withTenant(input.organizationId, async (tx) => {
          await setTransactionStatus(tx, input.organizationId, txn.id, "succeeded", {
            settledAt: input.now,
          });
          await settleTransactionOutcome(tx, {
            organizationId: input.organizationId,
            businessId: input.businessId,
            outcome: "succeeded",
            occurredAt: input.now,
            txn,
          });
        });
        return { outcome: "settled" };
      }
      log.warn("abandon: could not cancel at the gateway — releasing locally", {
        event: "afa_abandon_void_failed",
        txn: txn.publicId,
        gateway: txn.gatewayKey,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Still unsettled, and the buyer has told us it never will be.
   *
   * Booked as `afa_not_completed` — the SAME code the 72-hour sweep uses, deliberately.
   * The decline ladder's answer is identical either way (park, no retries, and a
   * deadline — which since 2026-09-04 every park gets), and a second code would have to
   * be added to three separate sets plus the shadow's mirror of them for no behavioural
   * gain. WHO ended it lives in the transaction's text, where it belongs.
   */
  await withTenant(input.organizationId, async (tx) => {
    await setTransactionStatus(tx, input.organizationId, txn.id, "failed", {
      errorCode: "afa_not_completed",
      retriable: false,
    });
    await settleTransactionOutcome(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      outcome: "failed",
      occurredAt: input.now,
      txn: {
        ...txn,
        errorCode: "afa_not_completed",
        // One code for both causes, deliberately — the decline ladder answers the same way
        // either way. Only the SENTENCE distinguishes them, which is exactly where this
        // file already says WHO ended it belongs.
        errorText:
          input.endedBy === "customer"
            ? "The customer declined to complete their bank's additional-factor authentication for " +
              "this debit and asked to pay another way, so it was abandoned at their request."
            : "This debit was abandoned because the invoice it was collecting no longer owes " +
              "anything — the balance was cleared by a credit note. Nothing was charged, and no " +
              "action is needed.",
      },
      retriable: false,
    });
  });
  log.info("buyer abandoned an authentication-pending debit", {
    event: "afa_abandoned_by_customer",
    txn: txn.publicId,
    invoice: input.invoiceId,
    voided_at_gateway: voidedAtGateway,
  });
  return { outcome: "released", voidedAtGateway };
}

/**
 * Book a gateway's TERMINAL answer about a charge through the path a webhook takes, so a
 * swept outcome and a delivered one are identical in the ledger. Returns what it booked,
 * or null for a non-terminal answer (nothing is written).
 */
export async function applyChargeVerdict(
  tx: Tx,
  txn: typeof transactions.$inferSelect,
  verdict: ChargeResult,
  now: Date,
): Promise<"settled" | "failed" | null> {
  if (verdict.status === "succeeded") {
    await setTransactionStatus(tx, txn.organizationId, txn.id, "succeeded", { settledAt: now });
    await settleTransactionOutcome(tx, {
      organizationId: txn.organizationId,
      businessId: txn.businessId,
      outcome: "succeeded",
      occurredAt: now,
      txn,
    });
    return "settled";
  }
  if (verdict.status !== "failed") return null;
  // Stopped at the gateway before the bank collected it: booked as the webhook books it.
  if (verdict.failure?.code === DEBIT_CANCELLED_CODE && (await bookDebitCancelledIn(tx, txn, now)))
    return "failed";
  const errorCode = verdict.failure?.code ?? "async_failed";
  const errorText = verdict.failure?.message ?? null;
  // Unknown stays retriable. Persisted on the ROW too, not only handed to dunning —
  // otherwise the Retries screen shows a swept failure as neither Hard nor Soft, because
  // null there means "not a failure".
  const retriable = verdict.failure?.retriable ?? true;
  await setTransactionStatus(tx, txn.organizationId, txn.id, "failed", { errorCode, retriable });
  await settleTransactionOutcome(tx, {
    organizationId: txn.organizationId,
    businessId: txn.businessId,
    outcome: "failed",
    occurredAt: now,
    txn: { ...txn, errorCode, ...(errorText ? { errorText } : {}) },
    // Same rule as the webhook path: unknown stays retriable, so a failure the adapter
    // could not classify never marks a working instrument `invalid`.
    retriable,
  });
  return "failed";
}

export { adapterForTransaction };

/** Exported for the verify suite — the grace period the sweep will apply to a rail. */
export const __graceHoursFor = graceHoursFor;
/** Exported for the tests that pin the safety margin past the 72h AFA link. */
export const __afaAbandonHours = AFA_ABANDON_HOURS;
