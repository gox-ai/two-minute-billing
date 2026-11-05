/**
 * Dunning retry schedule (pure, no deps — shared by invoicing + dunning to avoid
 * an import cycle). After a failed charge, retry on these day offsets; once the
 * list is exhausted the invoice is uncollectible and the subscription is canceled.
 */
import {
  classifyDecline,
  HOLD_FOR_NEW_CARD,
  PARK_EVEN_IN_FIXED_MODE,
  RETRY_THEN_PARK,
  RETRY_THEN_PARK_ATTEMPTS,
  retryNotBefore,
} from "./decline-policy";
import {
  adaptiveNextRetryAt,
  retryClassOf,
  CADENCE_LIMITS,
  DEFAULT_ADAPTIVE_CADENCE,
  type AdaptiveCadence,
} from "./adaptive-schedule";
import { MANDATE_REVOKED_CODES, type MandateRevokedAction } from "./billing-rules-config";
import { BANK_DEBIT_METHODS } from "@/providers/method-types";

export const DUNNING_RETRY_DAYS = [1, 3, 5, 7];

/**
 * How long a PARKED invoice's dunning window stays open when the business has
 * configured no `dunningPeriodDays` — days from the invoice's due date.
 *
 * ── Why this is NOT the retry schedule's tail ─────────────────────────────────
 * It was, until 2026-09-01, and that was wrong by a factor of four. The two clocks
 * measure different things:
 *
 *   · a RETRIED invoice reaching the tail of [1,3,5,7] has had **four charge
 *     attempts**. Day 7 is a verdict on an instrument that has failed repeatedly.
 *   · a PARKED invoice has had **zero**. Nothing has been presented and nothing
 *     will be — re-presenting the debit is the whole thing `parked` rules out — so
 *     the clock is measuring how long the CUSTOMER has to go and clear the refusal:
 *     re-authorise an e-mandate at their bank, or complete a bank AFA.
 *
 * Borrowing the retry tail gave a customer 7 days to complete a bank-side
 * re-authorisation before their subscription was cancelled, on every business that
 * has never opened the Dunning settings form (`dunningPeriodDays` is null by
 * default, so that is all of them). An Indian e-mandate re-authorisation goes
 * through the customer's bank and the AFA window alone is 72 hours.
 *
 * ── Why 30, and why a deadline at all ────────────────────────────────────────
 * A dunning window must CLOSE. An invoice stays in dunning for the dunning period
 * and the final action is carried out at the end of it, whether or not anything was
 * retried inside it: a hard decline is not retried until the payment method changes,
 * and not retrying does not stop the clock. `afa_not_completed` is held for the whole
 * period and acted on once at the end, never parked forever.
 *
 * 30 applies only where the merchant typed no number — a generous window that still
 * closes. A merchant who sets `dunning_period_days` overrides it, in either
 * direction.
 */
export const PARKED_GRACE_DAYS = 30;

/**
 * Total attempts implied by the DEFAULT schedule: 1 initial charge + its retries.
 *
 * ⚠️ **Not a limit, and nothing in the engine enforces it.** Exhaustion is decided by
 * `nextRetryAt` running off the end of the RESOLVED per-business list, so a merchant
 * with three retries configured exhausts at four attempts and one with eight exhausts
 * at nine — neither consults this. It is derived from the fallback list purely so the
 * verify suites have a loop bound, and reading it as a cap is a mistake this comment
 * exists to prevent.
 */
export const MAX_ATTEMPTS = DUNNING_RETRY_DAYS.length + 1;

/**
 * The most times a mandate debit may be PRESENTED TO THE NETWORK, by rail.
 *
 * ⚠️ **The two rails differ, and an internal reference doc that said "three on both"
 * was wrong about NACH.** Checked against sources 2026-08-18 rather than taken on
 * trust, because this constant silently shortens dunning:
 *
 *  - **UPI Autopay — 1 execution + 3 retries.** NPCI tightened this from August 2025;
 *    attempts are sequence-numbered and the cap is enforced, so a fifth presentation
 *    is rejected by the network before the payer's bank sees it.
 *  - **NACH / e-NACH — 1 presentation + 2 re-presentations.** NPCI/NACH/OC No.010/
 *    2023-24 (addendum 2023-10-31 to NPCI/2023-24/NACH/007): participants must
 *    "exercise utmost restraint (1 presentation + 2 representations)". Note the
 *    mechanism is NOT a network rejection like UPI's — it is enforced through a
 *    PENALTY on members with a high debit-return percentage. Same practical answer,
 *    different reason, and worth knowing before anyone relaxes it.
 *
 * Keyed by `payment_methods.mandate_rail`. A rail that is absent is UNCAPPED, which
 * is the deliberate default: card mandates and every non-Indian instrument sit
 * outside NPCI's presentation rule, and silently shortening dunning for them would
 * weaken collections for a constraint they do not have.
 *
 * NACH also carries a 3-day cooling period between a return and its re-presentation
 * (`RAIL_MIN_RETRY_GAP_DAYS`, a floor on every retry) and a duty to notify the customer
 * before each one, which is not enforced here.
 *
 * The deadline attempt `scheduleTail` adds is a presentation too; `presentationBlock`
 * (invoicing/representment.ts) refuses one past the cap, so the invoice waits for the
 * period's end instead.
 *
 * ⚠️ The cap counts presentations at the NETWORK, which is not the same as the
 * invoice's `attempt_count`. They drift both ways: a `mandate_ceiling_exceeded`
 * refusal is raised pre-flight and bumps `attempt_count` without ever reaching the
 * network, while a manual Pay-now/Collect-now deliberately does NOT bump it and does
 * reach the network. So this bounds the SCHEDULE, and cannot bound what a customer
 * does by hand — see `docs/PROGRESS.md`.
 */
export const NETWORK_RETRY_CAP: Readonly<Record<string, number>> = {
  upi: 3,
  emandate: 2,
  nach: 2,
  bank_transfer: 2,
};

/**
 * NACH: a returned debit may be re-presented no sooner than 3 days after the return
 * (NPCI/NACH/OC No.010/2023-24). Keyed by `payment_methods.mandate_rail`.
 */
export const RAIL_MIN_RETRY_GAP_DAYS: Readonly<Record<string, number>> = {
  emandate: 3,
  nach: 3,
};

/** The earliest a retry on this rail may land after a failure at `now`, or null. */
export function railRetryNotBefore(rail: string | null | undefined, now: Date): Date | null {
  const gap = rail ? RAIL_MIN_RETRY_GAP_DAYS[rail.toLowerCase()] : undefined;
  return gap === undefined ? null : addUtcDays(now, gap);
}

/** The network's retry cap for a rail, or null when the rail has none. */
export function networkRetryCap(rail: string | null | undefined): number | null {
  if (!rail) return null;
  return NETWORK_RETRY_CAP[rail.toLowerCase()] ?? null;
}

/**
 * The merchant's schedule, truncated to what the rail will actually accept.
 *
 * Truncation rather than refusal at save time: the schedule is per BUSINESS while the
 * cap is per RAIL, so one setting legitimately serves card customers who can take
 * eight retries and UPI customers who can take three. Refusing the save would make a
 * mixed-rail business unconfigurable. The settings screen says this out loud instead —
 * a screen that showed eight retries while three ran would be the kind of lie we have
 * been removing all week.
 */
export function capRetryDaysForRail(
  retryDays: number[],
  rail: string | null | undefined,
): number[] {
  const cap = networkRetryCap(rail);
  return cap == null || retryDays.length <= cap ? retryDays : retryDays.slice(0, cap);
}

/**
 * When to make the next attempt, given how many have already been made.
 * `attemptCount` is the number of attempts so far (>= 1 after the first failure).
 * Returns null when retries are exhausted.
 *
 * ── The offsets are ABSOLUTE, measured from the invoice DUE DATE ──────────────
 * A schedule of 1, 4, 9 retries payment collection 1, 4 and 9 days FROM THE INVOICE
 * DUE DATE: the settings are offsets from one anchor, not gaps between attempts.
 *
 * This used to add each offset to the PREVIOUS FAILURE, which compounds: the same
 * 1, 3, 5 schedule fired on days 1, 4, 9 instead of 1, 3, 5, drifting further with
 * every retry. (The old doc comment even described "1, 3, 5, 7 → days 1, 4, 9, 16"
 * as intended, reading a schedule's OUTPUT as the settings themselves.)
 *
 * The due date was already the anchor everywhere else — `dunningPeriodEndsAt` is
 * `dueDate + dunningPeriodDays` — so the period and the retries inside it now finally
 * share one reference point.
 *
 * `anchor` omitted/null → fall back to `from`, which is exactly the old behaviour.
 * That keeps the invoice with no `due_date` (ours is nullable) working as before
 * rather than guessing a date.
 *
 * A slot that has already gone by is not skipped (that would shorten the schedule), but
 * it lands one day after `from`, never at `from`. `from` is the failure that just
 * happened, so "now" re-presents the same debit seconds later: an invoice first charged
 * a day after its due date got two refusals 58 s apart. `scheduleTail` still bounds
 * this — once the dunning period has also passed, the final action applies instead.
 */
export function nextRetryAt(
  attemptCount: number,
  from: Date,
  retryDays?: number[] | null,
  anchor?: Date | null,
): Date | null {
  const days = retryDays && retryDays.length ? retryDays : DUNNING_RETRY_DAYS;
  const idx = attemptCount - 1; // after attempt N, use the Nth offset
  if (idx < 0 || idx >= days.length) return null;
  const candidate = addUtcDays(anchor ?? from, days[idx]!);
  return candidate.getTime() <= from.getTime() ? addUtcDays(from, 1) : candidate;
}

/** Add whole UTC days (the unit every dunning offset is expressed in). */
export function addUtcDays(from: Date, days: number): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Decide how a failed charge should (re)arm dunning on the invoice, honouring the
 * three cases the naive "always set payment_due + nextAttemptAt" path got wrong
 * (Phase E review): a merchant `stop_dunning` (`dunning_status='stopped'`), a
 * `pause_dunning` future window, and offline / auto-collect-off invoices that
 * must never be pulled into automatic dunning by a manual collect attempt.
 */
export type FailureRearm =
  | { action: "stopped" } // merchant halted dunning — leave not_paid/stopped
  | { action: "offline" } // dunning switched off / out of scope — settle not_paid, no retries
  /**
   * Auto-collection is OFF (send-invoice). The invoice's own state is LEFT ALONE —
   * status, `dunning_status` and `next_attempt_at` all untouched — and the attempt is
   * not counted.
   *
   * Split out of `offline` on 2026-08-31. An `auto_collection: off` unpaid invoice
   * must report:
   *
   *   status = payment_due · dunning_status = in_progress
   *   next_retry_at = invoice date + the first retry interval
   *   dunning_attempts = []   ← so `attempt_count` is 0: no attempt was made
   *
   * We reported `not_paid`, `next_attempt_at = null` and `attempt_count = 1` for the
   * same invoice — three errors from one branch, all of them because a charge
   * that auto-collection rules out was nevertheless attempted (`createInvoiceFromLines`
   * with `collect: true`) and then BOOKED against the invoice as a real dunning attempt.
   * A charge nobody should have made must not move the invoice at all.
   *
   * `offline` is kept, unchanged, for the OTHER thing it used to mean: dunning is
   * switched off for the business (or excluded for this invoice's class) while
   * auto-collection is ON. There a charge really was attempted and really failed, so
   * `not_paid` is the honest outcome — see `enabled` / `dunOneTimeInvoices`.
   */
  | { action: "send_invoice" }
  | { action: "paused"; until: Date } // a future pause window is in effect — keep it
  | { action: "retry"; nextAttempt: Date } // schedule the next retry
  | { action: "parked" } // smart mode: hard-recoverable decline — invoice stays open,
  //                          dunning parked, subscription retained; recovered when the
  //                          customer updates their card (collect-on-PM-update).
  | { action: "exhausted" }; // retries exhausted / non-retriable → final action

export function planFailureRearm(input: {
  dunningStatus: string | null;
  currentNextAttemptAt: Date | null;
  autoCollectOn: boolean;
  retriable: boolean;
  newAttemptCount: number;
  retryDays: number[];
  now: Date;
  /** 'fixed' (default) = historical behavior; 'smart' = decline-code aware (M10/M11). */
  mode?: "fixed" | "smart";
  /** Normalized decline code at the failure site (drives smart-mode disposition). */
  declineCode?: string | null;
  /**
   * "Skip retries for hard failures". Omitted/true → historical
   * behaviour (a hard decline ends dunning); false → the retry schedule applies to
   * every decline. Fixed mode only.
   */
  skipRetriesForHardFailures?: boolean;
  /**
   * `dunning_config.park_hard_declines`. Omitted/true → a park-class decline parks.
   * False → it retries on the schedule instead, and terminate-class declines still end
   * dunning. Callers pass the resolved config, whose default is false.
   */
  parkHardDeclines?: boolean;
  /**
   * Whether the business's dunning settings cover THIS invoice at all — the
   * master "Dunning" switch, "Dunning for 'Future' and 'Trial' subscriptions"
   * and "Dunning for one-time invoices", resolved by `dunningAppliesTo` at the
   * call site (which is where the subscription status lives). Omitted → true,
   * so every existing caller is unchanged. False behaves exactly like an
   * auto-collect-off invoice: the debt stands as `not_paid`, nothing retries.
   */
  dunningApplies?: boolean;
  /**
   * End of the business's dunning period for this invoice (`dunningPeriodEndsAt`).
   * Null/omitted → no deadline, i.e. the historical behaviour where the schedule
   * alone decides. See `scheduleTail` for the semantics.
   */
  periodEndsAt?: Date | null;
  /**
   * The invoice's DUE DATE — what every retry offset is measured from (see
   * `nextRetryAt`). Omitted/null falls back to `now`, the older behaviour and the
   * only sane choice for an invoice with no due date.
   */
  dueDate?: Date | null;
  /**
   * `payment_methods.mandate_rail` of the instrument this attempt used, so the
   * schedule can be truncated to the network's presentation cap (see
   * {@link capRetryDaysForRail}). Omitted/null → uncapped, which is both the
   * historical behaviour and the right answer for card and non-Indian rails.
   */
  mandateRail?: string | null;
  /**
   * Smart mode's adaptive timing (`dunning_config.adaptive_timing`). Omitted/false → the
   * merchant's offsets, as before. Never applies to a mandate rail: those debits carry
   * network presentation rules the merchant's schedule already honours.
   */
  adaptiveTiming?: boolean;
  /** The business's IANA timezone, for adaptive timing's local-morning attempts. */
  timezone?: string | null;
  /** `countries.timezones` of the failed instrument's issuing country; picks the customer's morning. */
  issuerZones?: readonly string[] | null;
  /**
   * A wait the network or gateway stated for THIS decline (`failure.retryAfterMs`), in
   * ms. A floor like `RETRY_NOT_BEFORE_MS`, in both modes: it only ever pushes later.
   */
  networkRetryAfterMs?: number;
  /**
   * `billing_rules_config.mandate_revoked`. Omitted or `follow_dunning` → the decline is
   * classified as before. Any other value ends retries on a revoked mandate: park for
   * `request_new_mandate`, else exhaust so the end action runs.
   */
  mandateRevoked?: MandateRevokedAction;
  /** `payment_methods.type` of the failed instrument; picks its schedule from `retriesByMethod`. */
  methodType?: string | null;
  /** `DunningConfig.retriesByMethod`; omitted = `retryDays` for every instrument. */
  retriesByMethod?: DunningConfig["retriesByMethod"];
  /** `DunningConfig.adaptiveCadence`; omitted = the coded cadences. */
  adaptiveCadence?: AdaptiveCadence;
  /** Instruments of the earlier failed attempts on this invoice, oldest first. */
  priorMethods?: ReadonlyArray<{ type: string | null; rail: string | null }>;
}): FailureRearm {
  // The schedule for this kind of instrument (card / bank debit), else the business's.
  const kind = dunningMethodKind(input.methodType, input.mandateRail);
  const listFor = (k: "card" | "bank_debit" | null) =>
    (k && input.retriesByMethod?.[k]) || input.retryDays;
  const retryDays = listFor(kind);
  // A switch of instrument kind mid-dunning must not end dunning early: the new kind's
  // schedule is indexed by ITS attempts, and the total stops at the longest schedule that
  // ran. Without a switch the slot is the invoice's attempt count, as before.
  const priorKinds = (input.priorMethods ?? []).map((m) => dunningMethodKind(m.type, m.rail));
  // Only with per-method schedules: without them every kind runs the same list, as before.
  const switched =
    !!(input.retriesByMethod?.card?.length || input.retriesByMethod?.bank_debit?.length) &&
    priorKinds.some((k) => k !== kind);
  const methodSlot = 1 + priorKinds.filter((k) => k === kind).length;
  const totalCap = Math.max(retryDays.length, ...priorKinds.map((k) => listFor(k).length));
  const overTotal = switched && input.newAttemptCount > totalCap;
  // What this rail will actually accept, which may be shorter than what the merchant
  // configured. Computed once, up front, so every branch below reasons about the
  // schedule that will really run rather than the one on the settings screen.
  const cappedRetryDays = capRetryDaysForRail(retryDays, input.mandateRail);
  const cadence = input.adaptiveCadence ?? DEFAULT_ADAPTIVE_CADENCE;
  // A generic refusal parks after its last adaptive retry; the default is 1 + 3.
  const retryThenParkAttempts =
    input.mode === "smart" && input.adaptiveTiming && !input.mandateRail
      ? cadence.genericDays.length + 1
      : RETRY_THEN_PARK_ATTEMPTS;

  // Parking off: a decline that would have parked retries on the schedule instead.
  const parks = input.parkHardDeclines !== false;
  const code = (input.declineCode ?? "").toLowerCase();
  const smartDisposition =
    input.mode === "smart" && input.declineCode !== undefined
      ? classifyDecline(input.declineCode)
      : null;
  const hardInFixed =
    smartDisposition === null && !(input.retriable || input.skipRetriesForHardFailures === false);
  const wouldPark =
    smartDisposition === "park" ||
    (smartDisposition !== null && RETRY_THEN_PARK.has(code)) ||
    (hardInFixed && PARK_EVEN_IN_FIXED_MODE.has(code));
  // …and keeps the window a park would have had when the business set no period. Not on a
  // mandate rail: the deadline attempt would be a presentation past NPCI's cap.
  const periodEndsAt =
    input.periodEndsAt ??
    (!parks && wouldPark && !input.mandateRail
      ? addUtcDays(input.dueDate ?? input.now, PARKED_GRACE_DAYS)
      : null);

  // Smart mode's next attempt: adaptive timing for a classed decline on a non-mandate
  // instrument when the business opted in, else the merchant's offsets.
  const retryClass =
    input.mode === "smart" && input.adaptiveTiming && !input.mandateRail
      ? retryClassOf(input.declineCode)
      : null;
  const smartNextAttempt = (slot: number): Date | null =>
    retryClass
      ? adaptiveNextRetryAt({
          retryClass,
          retryNumber: slot,
          now: input.now,
          dueDate: input.dueDate,
          timezone: input.timezone,
          issuerZones: input.issuerZones,
          cadence,
        })
      : nextRetryAt(slot, input.now, cappedRetryDays, input.dueDate);

  // Merchant/offline/pause guards run FIRST in BOTH modes — unchanged.
  if (input.dunningStatus === "stopped") return { action: "stopped" };
  // Auto-collect off: leave the invoice exactly as it stands (see `send_invoice` —
  // such an invoice stays `payment_due` with `dunning_attempts: []`). Deliberately
  // BEFORE the `dunningApplies` gate: the collection model decides the invoice's
  // status, and a business that also has dunning switched off does not turn a
  // send-invoice bill into a failed charge.
  if (!input.autoCollectOn) return { action: "send_invoice" };
  // Dunning switched off for the business, or excluded for this invoice's kind.
  if (input.dunningApplies === false) return { action: "offline" };
  // The payer revoked the mandate: never re-present it when the business chose an action.
  if (
    input.mandateRevoked &&
    input.mandateRevoked !== "follow_dunning" &&
    MANDATE_REVOKED_CODES.has(code)
  )
    return { action: input.mandateRevoked === "request_new_mandate" ? "parked" : "exhausted" };
  /**
   * A DISPOSITION OUTRANKS A SCHEDULE. Park and terminate are decided here, ahead of the
   * "already scheduled, leave it alone" guard below.
   *
   * ⚠️ MEASURED IN PRODUCTION, INV-100004 (2026-09-10). Stripe refused the renewal with
   * `payment_intent_mandate_invalid` — the mandate is inactive — which normalises to
   * `mandate_expired` and parks. The invoice was already `in_progress` with a retry armed
   * for the next midnight, so the guard below returned `paused` and exited BEFORE the
   * decline code was ever read. The verdict was computed, booked on the transaction, and
   * then ignored: the invoice kept its schedule and would have re-presented a dead mandate
   * every night until dunning exhausted and the final action cancelled a subscription
   * whose customer only ever needed to re-authorise.
   *
   * The guard's intent is right and is kept — a manual "Collect now" must not shove the
   * retry clock around (M12) — but it conflated two different things: *do not move the
   * schedule* (correct) with *do not change the disposition* (wrong). Nothing here moves
   * an interval; it records that retrying is pointless.
   *
   * Not specific to manual attempts, either: ANY failure landing while a future retry was
   * armed had its classification discarded — `expired_card`, `stolen_card`,
   * `recurring_not_enabled`, every mandate refusal.
   *
   * ⚠️ AND IT SUPERSEDES AN OPERATOR'S PAUSE, deliberately, because it cannot tell one
   * from an ordinary armed retry: `pauseDunning` writes exactly the same `in_progress` +
   * future `next_attempt_at`. That is acceptable in a way the reverse would not be — both
   * states mean "not retrying right now", so the pause's substance survives; what changes
   * is the ending. A park waits for the customer and gets its own deadline from
   * `sweepExpiredParkedDunning`, where the pause would have resumed retrying a debit that
   * cannot succeed. `stopped` is untouched: it is checked above and is a merchant's
   * explicit halt, not a schedule.
   *
   * SMART MODE ONLY, matching the classification at the foot of this function. Fixed mode
   * reaches park by a different route -- `scheduleApplies` plus `PARK_EVEN_IN_FIXED_MODE` --
   * and hoisting the smart verdict over it broke five `verify:dunning-smart` expectations on
   * the first attempt: it parked ordinary hard declines that the toggle deliberately still
   * cancels. Its twin of this hole is closed separately and narrowly, just below
   * (`fixedModeParks`) — carve-out codes only, so the toggle keeps its promise.
   */
  if (smartDisposition !== null) {
    const disposition = smartDisposition;
    if (disposition === "terminate") return { action: "exhausted" };
    // Lost / stolen / seized cards park whatever the toggle says: never re-present them.
    if ((parks || HOLD_FOR_NEW_CARD.has(code)) && disposition === "park")
      return { action: "parked" };
    // A generic refusal retries first; once the attempts or the schedule run out it parks
    // rather than exhausting, so the customer is still asked to fix the card.
    if (
      parks &&
      RETRY_THEN_PARK.has(code) &&
      (input.newAttemptCount >= retryThenParkAttempts ||
        smartNextAttempt(Math.max(input.newAttemptCount, 1)) === null)
    )
      return { action: "parked" };
  }

  /**
   * THE FIXED-MODE TWIN of the hoist above, closed 2026-09-10.
   *
   * The hoist fixed smart mode. Fixed mode reaches park by a different route — the
   * `PARK_EVEN_IN_FIXED_MODE` carve-out inside the branch below — and that route is
   * BELOW this guard, so it was reachable only when no retry happened to be armed. Same
   * defect, same shape: a schedule outranking a disposition.
   *
   * Narrow on purpose, and it is the narrowness that keeps the toggle's promise. This
   * bypass needs all three of fixed mode, a NON-retriable code with hardness honoured,
   * and membership of that carve-out list — refusals where the instrument is valid and
   * would pay (the mandate's per-debit cap, our own gateway configuration). An ordinary
   * hard decline is in none of them: it still meets the guard, still returns `paused`,
   * and still ends dunning when the armed attempt comes round — the toggle's promise
   * (`verify:dunning-smart` case 4) is untouched, and its TIMING is unchanged too, which
   * is why this bypass is not extended to it.
   *
   * It bypasses the guard rather than returning `parked` here, because the carve-out's
   * answer is not always "parked": with a dunning period configured it hands off to
   * `scheduleTail(null, periodEndsAt)` so the business's own deadline and final action
   * still fire. Duplicating that here is how the two answers would drift.
   *
   * M12 is not weakened: both outcomes END retrying rather than moving an interval, so a
   * manual attempt still cannot shove the retry clock around.
   */
  const fixedModeParks = parks && hardInFixed && PARK_EVEN_IN_FIXED_MODE.has(code);

  if (
    !fixedModeParks &&
    input.dunningStatus === "in_progress" &&
    input.currentNextAttemptAt &&
    input.currentNextAttemptAt.getTime() > input.now.getTime()
  )
    return { action: "paused", until: input.currentNextAttemptAt };

  /**
   * The offset slot to schedule from. `newAttemptCount` is the INDEX into the retry
   * offsets (see `nextRetryAt`), and 0 means "no such offset" — which for a MANUAL
   * attempt on an invoice that has never been dunned is NOT the same statement as
   * "the schedule is spent".
   *
   * A manual "Collect now" / "Pay now" deliberately holds the counter still (M12 —
   * `collectInvoice.manualAttempt`), so the FIRST human attempt on a never-dunned
   * invoice arrives here with 0. Read literally that scheduled nothing and, via
   * `scheduleTail`, exhausted dunning on the spot: `not_paid` / `exhausted`, no retry
   * ever armed — and for a subscription invoice the final action then cancelled the
   * subscription on a single click, before the clock had attempted even once. Found by
   * `verify:audit`, which declines a one-time invoice collected by hand and expects
   * `payment_due`.
   *
   * An attempt HAS just failed, so the right next step is the schedule's first offset.
   * Every automatic path arrives with ≥ 1, so this is a no-op for them.
   */
  const slot = switched ? methodSlot : Math.max(input.newAttemptCount, 1);

  /**
   * A FLOOR THE NETWORK SET, applied to whatever the merchant's schedule produced.
   *
   * RazorPay's `already_declined` means NPCI has blocked re-presents for 24 hours. The
   * merchant's own offsets can land inside that window (the first is often the next
   * midnight), and an attempt there is spent on a guaranteed refusal.
   *
   * Only ever pushes an attempt LATER, never earlier, and never converts a `retry` into
   * an `exhausted` — `scheduleTail` still decides that against the dunning period, so a
   * floor that overshoots the deadline lands on the deadline exactly as an overshooting
   * offset already does.
   */
  const codeFloor = retryNotBefore(input.declineCode, input.now);
  const networkFloor = input.networkRetryAfterMs
    ? new Date(input.now.getTime() + input.networkRetryAfterMs)
    : null;
  const railFloor = railRetryNotBefore(input.mandateRail, input.now);
  const notBefore =
    [codeFloor, networkFloor, railFloor]
      .filter((d): d is Date => d !== null)
      .sort((x, y) => y.getTime() - x.getTime())[0] ?? null;
  const withFloor = (d: Date | null): Date | null =>
    d && notBefore && d.getTime() < notBefore.getTime() ? notBefore : d;

  // Fixed mode (or no decline code available): EXACTLY the historical behavior,
  // except that a merchant may switch off "skip retries for hard failures" — in
  // which case the schedule applies to every decline and hardness stops mattering.
  if (input.mode !== "smart" || input.declineCode === undefined) {
    const honourHardness = input.skipRetriesForHardFailures !== false;
    // With parking off, the carve-out codes retry on the schedule rather than park.
    const scheduleApplies =
      input.retriable || !honourHardness || (!parks && PARK_EVEN_IN_FIXED_MODE.has(code));
    if (!scheduleApplies && PARK_EVEN_IN_FIXED_MODE.has(code)) {
      /**
       * This toggle is scoped to "payment methods with HARD DECLINES", and for those
       * it keeps its promise here unchanged — a declined or expired card still ends
       * dunning in fixed mode (`verify:dunning-smart` case 4 guards exactly that).
       *
       * `PARK_EVEN_IN_FIXED_MODE` is the carve-out for refusals that are not
       * payment-method declines at all: the instrument is valid and would pay, the
       * blocker is the mandate's per-debit cap or our own gateway configuration. See
       * that set for why each one is there.
       *
       * ── What it actually cost, measured 2026-08-14 by disabling this branch ──────
       * A ₹66,025 Business renewal on a ₹15,000 card mandate (the RBI AFA cap — see
       * `INR_AFA_FREE_CEILING_MINOR`) exhausted on its FIRST attempt: invoice `not_paid`
       * / `exhausted`, `next_attempt_at` null. And because exhaustion lands at the first
       * bill, no dunning pass ever revisits it — so the cancel-on-exhaust never fires and
       * the SUBSCRIPTION STAYS ACTIVE. The customer keeps the service, the invoice is
       * dead, and re-authorizing collects nothing because the invoice is no longer in a
       * collectible state. Not a visible cancellation — silent, permanent revenue loss on
       * a live subscription, which is harder to notice and harder to recover from.
       *
       * Neither position of the toggle avoided it: ON exhausts immediately as above, OFF
       * spends the whole retry schedule re-attempting a charge the rail refuses every
       * time and exhausts at the end. There is no configuration that saves that customer,
       * and smart mode — which classifies this correctly — is deliberately not selectable
       * (`src/api/routes.ts`, the dunning settings page).
       *
       * Reached ONLY on the branch already heading for exhaustion, and only for that
       * short carve-out list. Every retriable decline, every ordinary card hard decline,
       * every terminate-class and unmapped code keeps its exact previous path.
       *
       * Recovery needs nothing new: `collect_on_payment_method_update` (default ON)
       * charges the parked invoice the moment the customer adds or re-authorizes an
       * instrument.
       */
      /**
       * A configured dunning period is a DEADLINE the business set — "keep trying for
       * N days, then apply the final action to whatever is still unpaid". Parking
       * through it made these two codes silently opt out: no retries, no deadline, no
       * final action, so an invoice nobody paid stayed open FOREVER and the subscription
       * stayed active. Free service with no operator signal, which is not a kindness to
       * anyone — it was me over-correcting for the opposite bug (0a688a5).
       *
       * With a period set, `scheduleTail` gives the behaviour that was wanted all along:
       * nothing is retried during the window — the customer can pay by hand, and
       * `collect_on_payment_method_update` collects the moment they fix the instrument —
       * then ONE attempt on the deadline, and the final action if that fails. The
       * deadline attempt is not futile either: `recurring_not_enabled` is fixed by the
       * MERCHANT at the gateway, and nothing else would ever trigger a re-collect.
       *
       * With NO period configured there is no deadline to honour, and exhausting
       * immediately is the original bug. Park, and let the business set a period if it
       * wants an end date.
       */
      if (periodEndsAt) return scheduleTail(null, periodEndsAt, input.now);
      return { action: "parked" };
    }
    const nextAttempt =
      scheduleApplies && !overTotal
        ? nextRetryAt(slot, input.now, cappedRetryDays, input.dueDate)
        : null;
    return scheduleTail(withFloor(nextAttempt), periodEndsAt, input.now);
  }

  // Smart mode, and by here the decline is `retry`, or `park` with parking off: `terminate`
  // (and `park` with parking on) returned from the disposition check above, which had to run BEFORE the schedule guard
  // (see its docblock — a verdict computed and then discarded is what INV-100004 was).
  // The fixed-mode branch above always returns, so this line is smart-mode only.
  //
  // A soft decline that has run out of retries (next attempt → null) still reaches the
  // final action via scheduleTail.
  return scheduleTail(
    withFloor(overTotal ? null : smartNextAttempt(slot)),
    periodEndsAt,
    input.now,
  );
}

/**
 * Turn "the next scheduled retry" into a disposition, honouring the business's
 * DUNNING PERIOD (Settings → Dunning).
 *
 * ── Why this is not simply "retries exhausted" ────────────────────────────────
 * The final action belongs at the END OF THE DUNNING PERIOD; we historically
 * applied it the moment `nextRetryAt` returned null, i.e. as soon as the last
 * scheduled retry failed. Those differ by a day whenever the period outlasts the
 * schedule (retries on 1/3/5 within a 6-day period must act on day 6, not when the
 * day-5 attempt fails), which lands as a one-day drift in CANCELLATION DATES. So
 * the period is modelled explicitly:
 *
 *  - `periodEndsAt == null` (the default, and every business today) → unchanged:
 *    the schedule alone decides, and exhaustion fires the final action at once.
 *  - `periodEndsAt` set → the period is BOTH a ceiling and a floor. A scheduled
 *    retry that lands inside the period runs as normal; once the schedule is spent
 *    (or its next offset would overshoot the deadline) the invoice gets ONE last
 *    attempt ON the period end, and only when THAT fails does the final action
 *    apply. That is what "we keep trying during this period, and act on what's
 *    still unpaid at the end of it" means.
 *
 * Deliberately NOT a new `FailureRearm` variant: the "wait until the period ends"
 * state is a retry scheduled at the deadline, which is byte-identical to what each
 * of the three failure writers already persists for `retry` (payment_due +
 * in_progress + next_attempt_at). Adding a variant would have meant touching every
 * call site's switch for no behavioural difference.
 */
function scheduleTail(
  scheduled: Date | null,
  periodEndsAt: Date | null | undefined,
  now: Date,
): FailureRearm {
  if (!periodEndsAt)
    return scheduled === null
      ? { action: "exhausted" }
      : { action: "retry", nextAttempt: scheduled };
  if (scheduled && scheduled.getTime() <= periodEndsAt.getTime())
    return { action: "retry", nextAttempt: scheduled };
  // Schedule spent, or the next offset overshoots the deadline: last attempt at
  // the period end. Already past it → the period is over, apply the final action.
  if (periodEndsAt.getTime() > now.getTime()) return { action: "retry", nextAttempt: periodEndsAt };
  return { action: "exhausted" };
}

/** Parse a business's dunning_retry_days jsonb into a valid offsets list (or null → default). */
export function parseRetryDays(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const days = raw.filter(
    (n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 90,
  );
  return days.length ? days : null;
}

// ── Structured dunning config (E3 / INV-3) ────────────────────────────────────

/**
 * What happens to the invoice when dunning is exhausted. Four options: Mark as Not
 * Paid · Mark as Voided · Write-off · Reverse the Invoice.
 */
export type FinalInvoiceAction = "not_paid" | "void" | "write_off" | "reverse";
/** What happens to the subscription when dunning is exhausted (SUB-7: it may survive). */
export type FinalSubscriptionAction =
  | "cancel"
  | "cancel_at_term_end"
  | "pause"
  | "stop_charging"
  | "retain";

/** Every end action, in screen order (2.17). `cancel` and `retain` are the original two. */
export const FINAL_SUBSCRIPTION_ACTIONS = [
  "cancel",
  "cancel_at_term_end",
  "pause",
  "stop_charging",
  "retain",
] as const satisfies readonly FinalSubscriptionAction[];

/** The instrument groups a schedule can be set for (2.48). */
export type DunningMethodKind = "card" | "bank_debit" | "offline";
export const DUNNING_METHOD_KINDS = ["card", "bank_debit", "offline"] as const;
/** Bank-debit schedules stay within what every debit scheme allows. */
export const BANK_DEBIT_MAX_RETRIES = 5;

/**
 * Which schedule a failed instrument follows: `card`, `bank_debit` (ACH, SEPA, Bacs,
 * e-mandate, NACH …), or null for anything else (UPI, wallets, PayPal), which keeps the
 * business schedule. `offline` is never returned: it is the auto-collection-off ladder.
 */
export function dunningMethodKind(
  type: string | null | undefined,
  rail?: string | null,
): "card" | "bank_debit" | null {
  const r = (rail ?? "").toLowerCase();
  if (r === "emandate" || r === "nach") return "bank_debit";
  const t = (type ?? "").toLowerCase();
  if (t === "card") return "card";
  return BANK_DEBIT_METHODS.has(t) ? "bank_debit" : null;
}

export interface DunningConfig {
  /**
   * Dunning mode (M10/M11). 'fixed' (default) = fixed schedule, decline-retriable
   * as a boolean (historical). 'smart' = decline-code-aware: soft declines retry,
   * hard-recoverable declines PARK (keep the invoice open, retain the sub), and
   * unrecoverable declines terminate. Opt-in — only `dunning_config.mode='smart'`
   * enables it; anything else resolves to 'fixed'.
   */
  mode: "fixed" | "smart";
  retryDays: number[];
  finalAction: { invoice: FinalInvoiceAction; subscription: FinalSubscriptionAction };
  /** Per-instrument retry offsets (2.48). An absent kind uses `retryDays`. */
  retriesByMethod: Partial<Record<DunningMethodKind, number[]>>;
  /** Smart mode's adaptive cadences (2.59). Default = the coded values. */
  adaptiveCadence: AdaptiveCadence;
  /**
   * When a customer adds/updates a payment method, immediately attempt to collect
   * their open `payment_due` invoices ("Collect Invoice on Payment Method Update").
   * Defaults on.
   */
  collectOnPaymentMethodUpdate: boolean;
  /**
   * Whether a REACTIVATION requires its charge to succeed. ON: a reactivation whose
   * charge fails is refused and the subscription stays cancelled. OFF: it reactivates
   * anyway and the unpaid invoice is left for dunning to chase.
   *
   * ⚠️ SPLIT OUT OF `collectOnPaymentMethodUpdate` on 2026-09-07. One control used to
   * carry both, which the operator who has to use it reported as confusing — and it
   * genuinely bundles two independent decisions: "charge a new card immediately" and
   * "refuse to reactivate on a failed charge" are preferences a merchant can reasonably
   * hold in any combination.
   *
   * Absent → falls back to `collect_on_payment_method_update`, so every business
   * configured before the split behaves exactly as it did. There is no migration.
   */
  requireSuccessfulChargeOnReactivation: boolean;
  /**
   * "Skip retries for hard failures" (Settings → Dunning). When ON — our historical
   * and default behaviour — a non-retriable decline ends dunning immediately, on the
   * reasoning that retrying a stolen card cannot succeed.
   *
   * A merchant can turn it OFF, and some do: the custom retry schedule then applies
   * to every decline regardless of hardness. We modelled only the ON case, so a
   * business with it OFF terminated where it should have retried.
   *
   * Smart mode ignores this: there the decline code drives the disposition directly,
   * which is the whole point of smart mode.
   */
  skipRetriesForHardFailures: boolean;
  /**
   * The master "Dunning" switch. OFF → a failed charge settles the invoice
   * to `not_paid` and NOTHING is retried automatically (the debt still stands and
   * can be collected manually) — the same disposition as an auto-collect-off
   * invoice, which is exactly what "dunning is off" means. Default ON.
   */
  enabled: boolean;
  /**
   * "Dunning period", in days after the invoice's DUE DATE: the window
   * during which collection is retried, at the end of which the final action
   * applies. Null (the default) = no deadline, i.e. the historical behaviour where
   * the retry schedule alone decides when dunning ends. See `scheduleTail` for the
   * full semantics and why null had to stay the default.
   */
  dunningPeriodDays: number | null;
  /**
   * "Dunning for 'Future' and 'Trial' subscriptions" — dun a failed
   * activation charge on a subscription still in `future` or `in_trial`. Default
   * ON, which is what our engine has always done (the dunning path never looked at
   * the subscription's status), so existing businesses are unaffected.
   */
  dunTrialAndFutureSubscriptions: boolean;
  /**
   * "Dunning for one-time invoices" — dun invoices with no subscription behind them.
   *
   * Default OFF. `runDunningPass` has always skipped invoices with no
   * `subscription_id`, so defaulting this ON would silently start dunning — and, on
   * exhaustion, voiding or writing off — one-off invoices that every existing
   * business currently expects to be left alone. Preserving today's behaviour won;
   * merchants opt in.
   */
  dunOneTimeInvoices: boolean;
  /**
   * Dun AUTO-COLLECT-OFF (send-invoice) invoices.
   *
   * ── Default flipped to ON, 2026-08-31 (explicitly approved) ───────────────────
   * An `auto_collection: off` unpaid invoice belongs in dunning THE MOMENT IT IS
   * RAISED — `status: payment_due`, `dunning_status: in_progress`, `next_retry_at =
   * invoice date + the first retry interval`, `dunning_attempts: []`. Dunning is
   * "in progress" even though no charge will ever be attempted, because for a
   * send-invoice bill dunning means REMINDERS, not retries. So OFF was wrong.
   *
   * OFF now means "opt out": the pre-parity behaviour, kept intact and reachable —
   * the invoice is issued, never charged, flips to `not_paid` at its due date and
   * sits there. Nothing reminds the customer and the final action can never fire.
   *
   * ON, an offline invoice enters dunning at raise (or, for a Net-D bill, at its due
   * date — every dunning offset is measured FROM the due date, so there is nothing to
   * count from before then):
   *   · `status` stays `payment_due` for the whole window. It must NOT flip to
   *     `not_paid` at the due date: that is the collection-FAILED status, and
   *     it is also what collided with defaulting `due_date` to the invoice date —
   *     every offline invoice would have gone `not_paid` on day 0. See
   *     `runInvoiceDueTransitions`.
   *   · `dunning_status = in_progress`, `next_attempt_at` = the next REMINDER instant
   *     (`nextOfflineReminderAt`), walked forward one retry offset at a time.
   *   · `attempt_count` stays 0 — nothing is ever presented to a gateway.
   *   · **No charge is ever attempted.** Attempting one is the entire thing
   *     auto-collect-off rules out; `runDunningPass` and `sweepStrandedRetries` both
   *     skip these rows for exactly that reason.
   *   · At `dunningPeriodDays` past the due date the configured final action applies
   *     (void / write_off / reverse + cancel / retain), and only THEN does the
   *     invoice become `not_paid` + `exhausted`.
   *
   * ⚠️ `dunningPeriodDays` is still the only thing that ENDS the window, and it is
   * null by default. With no period the reminders run and the invoice stays payable
   * indefinitely — the same open-ended outcome as OFF, minus the misleading
   * `not_paid` and minus the silence. This deliberately NARROWS the old invariant
   * "ON without dunning_period_days is a no-op": enrolment needs no deadline, only
   * EXHAUSTION does, so nothing is ever voided or cancelled without a configured
   * period.
   */
  dunOfflineInvoices: boolean;
  /**
   * What a renewal does when the customer has NO payment method at all (auto-collect on).
   * `follow_final_action` (default) defers to `finalAction.subscription`; `cancel`
   * cancels at the boundary even when the final action is `retain` — a customer with
   * nothing to charge is not the same case as a card that keeps declining.
   */
  noPaymentMethodAtRenewal: "follow_final_action" | "cancel";
  /**
   * Adaptive retry timing (smart mode only; see `adaptive-schedule.ts`). Off unless the
   * business stored an explicit `true`.
   */
  adaptiveTiming: boolean;
  /**
   * Park hard-recoverable declines (no retries until the customer acts). Off unless the
   * business stored an explicit `true`: gateways' decline codes proved unreliable
   * (a do-not-retry card declined generically the next time), so by default every
   * decline except the terminate class keeps retrying on the schedule.
   */
  parkHardDeclines: boolean;
  /**
   * Minimum outstanding amount, per currency (upper-case code → minor units), before dunning
   * chases an invoice. Below it dunning does not start and running dunning makes no attempt
   * or reminder. Empty = no minimum.
   */
  minimumAmounts: Readonly<Record<string, number>>;
}

/** The default when a business configures nothing: fixed mode, 4 retries, invoice not_paid, sub cancelled, collect-on-PM-update on. */
export const DEFAULT_DUNNING_CONFIG: DunningConfig = {
  mode: "fixed",
  requireSuccessfulChargeOnReactivation: true,
  retryDays: DUNNING_RETRY_DAYS,
  finalAction: { invoice: "not_paid", subscription: "cancel" },
  retriesByMethod: {},
  adaptiveCadence: DEFAULT_ADAPTIVE_CADENCE,
  collectOnPaymentMethodUpdate: true,
  skipRetriesForHardFailures: true,
  enabled: true,
  dunningPeriodDays: null,
  dunTrialAndFutureSubscriptions: true,
  dunOneTimeInvoices: false,
  // ON since 2026-08-31 — see the field doc: offline invoices are dunned from the
  // moment they are raised.
  dunOfflineInvoices: true,
  noPaymentMethodAtRenewal: "follow_final_action",
  adaptiveTiming: false,
  parkHardDeclines: false,
  minimumAmounts: {},
};

/**
 * Resolve a business's effective dunning config. `dunning_config.retries` (if
 * present) overrides `dunning_retry_days`; the final action falls back to the
 * default (invoice not_paid, subscription cancel — the historical behavior).
 */
export function resolveDunningConfig(
  biz: { dunningConfig?: unknown; dunningRetryDays?: unknown } | null | undefined,
  policyConfig?: unknown,
): DunningConfig {
  const raw = overlayPolicy(biz?.dunningConfig ?? null, policyConfig) as {
    mode?: unknown;
    retries?: unknown;
    final_action?: { invoice?: unknown; subscription?: unknown };
    retries_by_method?: unknown;
    adaptive_cadence?: unknown;
    collect_on_payment_method_update?: unknown;
    require_successful_charge_on_reactivation?: unknown;
    skip_retries_for_hard_failures?: unknown;
    enabled?: unknown;
    dunning_period_days?: unknown;
    dun_trial_and_future_subscriptions?: unknown;
    dun_one_time_invoices?: unknown;
    dun_offline_invoices?: unknown;
    no_payment_method_at_renewal?: unknown;
    adaptive_timing?: unknown;
    park_hard_declines?: unknown;
    minimum_amounts?: unknown;
  } | null;
  const structuredRetries = Array.isArray(raw?.retries)
    ? raw!.retries
        .map((r) => (r && typeof r === "object" ? (r as { after_days?: unknown }).after_days : r))
        .filter(
          (n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 90,
        )
    : [];
  const retryDays = structuredRetries.length
    ? structuredRetries
    : (parseRetryDays(biz?.dunningRetryDays) ?? DUNNING_RETRY_DAYS);
  const inv = raw?.final_action?.invoice;
  const sub = raw?.final_action?.subscription;
  const collectOnPmUpdate = raw?.collect_on_payment_method_update;
  const requireChargeOnReactivation = raw?.require_successful_charge_on_reactivation;
  const skipHardRetries = raw?.skip_retries_for_hard_failures;
  return {
    // Only an explicit 'smart' enables smart dunning; anything else → 'fixed'.
    mode: raw?.mode === "smart" ? "smart" : "fixed",
    retryDays,
    finalAction: {
      invoice: (["not_paid", "void", "write_off", "reverse"] as const).includes(
        inv as FinalInvoiceAction,
      )
        ? (inv as FinalInvoiceAction)
        : "not_paid",
      subscription: (FINAL_SUBSCRIPTION_ACTIONS as readonly string[]).includes(sub as string)
        ? (sub as FinalSubscriptionAction)
        : "cancel",
    },
    retriesByMethod: parseRetriesByMethod(raw?.retries_by_method),
    adaptiveCadence: parseAdaptiveCadence(raw?.adaptive_cadence),
    // Default ON — only an explicit `false` disables it.
    collectOnPaymentMethodUpdate: collectOnPmUpdate === false ? false : true,
    /**
     * FALLS BACK to `collect_on_payment_method_update`, and that fallback IS the migration.
     * Before the split one field meant both things, so a business that had turned collection
     * off had also turned the reactivation refusal off — and reading the new key as "default
     * ON" would silently switch the refusal back on for exactly those businesses. Only an
     * explicit value overrides the inherited one.
     */
    requireSuccessfulChargeOnReactivation:
      requireChargeOnReactivation === undefined || requireChargeOnReactivation === null
        ? collectOnPmUpdate === false
          ? false
          : true
        : requireChargeOnReactivation !== false,
    // Default ON = the historical behaviour, so existing businesses are unchanged.
    skipRetriesForHardFailures: skipHardRetries === false ? false : true,
    // Master switch: only an explicit `false` turns dunning off.
    enabled: raw?.enabled === false ? false : true,
    // Absent / invalid → null = no deadline (the historical behaviour).
    dunningPeriodDays: parsePeriodDays(raw?.dunning_period_days),
    // Both default to today's behaviour: trial/future subs ARE dunned, one-off
    // invoices are NOT (see the field docs).
    dunTrialAndFutureSubscriptions:
      raw?.dun_trial_and_future_subscriptions === false ? false : true,
    dunOneTimeInvoices: raw?.dun_one_time_invoices === true,
    /**
     * Default ON (see the field doc), so only an explicit `false` opts out.
     *
     * This is a PURE CODE DEFAULT: `businesses.dunning_config` is jsonb with no column
     * default, so the businesses it changes are exactly the ones whose stored config is
     * null or lacks the key — i.e. every business that has never saved the Dunning
     * settings form. Any business that HAS saved that form carries an explicit boolean
     * (the dashboard action writes `fd.get(...) != null`), so its choice is preserved and
     * no migration is needed either way.
     */
    dunOfflineInvoices: raw?.dun_offline_invoices === false ? false : true,
    noPaymentMethodAtRenewal:
      raw?.no_payment_method_at_renewal === "cancel" ? "cancel" : "follow_final_action",
    adaptiveTiming: raw?.adaptive_timing === true,
    parkHardDeclines: raw?.park_hard_declines === true,
    minimumAmounts: parseMinimumAmounts(raw?.minimum_amounts),
  };
}

/**
 * The per-invoice keys a named dunning policy owns (0386). Business-wide keys
 * (`collect_on_payment_method_update`, `require_successful_charge_on_reactivation`,
 * `no_payment_method_at_renewal`, `dunning_retry_days`) stay on the business.
 */
export const DUNNING_POLICY_KEYS = [
  "enabled",
  "mode",
  "retries",
  "final_action",
  "dunning_period_days",
  "skip_retries_for_hard_failures",
  "park_hard_declines",
  "adaptive_timing",
  "minimum_amounts",
  "dun_offline_invoices",
  "dun_one_time_invoices",
  "dun_trial_and_future_subscriptions",
  "retries_by_method",
  "adaptive_cadence",
] as const;

/** A policy replaces the business's per-invoice keys; its business-wide keys are ignored. */
function overlayPolicy(bizRaw: unknown, policyConfig: unknown): unknown {
  if (!policyConfig || typeof policyConfig !== "object" || Array.isArray(policyConfig))
    return bizRaw;
  const base =
    bizRaw && typeof bizRaw === "object" && !Array.isArray(bizRaw)
      ? { ...(bizRaw as Record<string, unknown>) }
      : {};
  const pol = policyConfig as Record<string, unknown>;
  for (const k of DUNNING_POLICY_KEYS) {
    if (k in pol) base[k] = pol[k];
    else delete base[k];
  }
  return base;
}

/** The full stored form of a policy: every per-invoice key, resolved from `input`. */
export function dunningPolicyConfigJson(input: unknown): Record<string, unknown> {
  const c = resolveDunningConfig({ dunningConfig: input });
  return {
    enabled: c.enabled,
    mode: c.mode,
    retries: c.retryDays.map((d) => ({ after_days: d })),
    final_action: { invoice: c.finalAction.invoice, subscription: c.finalAction.subscription },
    retries_by_method: Object.fromEntries(
      Object.entries(c.retriesByMethod).map(([k, days]) => [
        k,
        days.map((d) => ({ after_days: d })),
      ]),
    ),
    adaptive_cadence: serializeAdaptiveCadence(c.adaptiveCadence),
    dunning_period_days: c.dunningPeriodDays,
    skip_retries_for_hard_failures: c.skipRetriesForHardFailures,
    park_hard_declines: c.parkHardDeclines,
    adaptive_timing: c.adaptiveTiming,
    minimum_amounts: { ...c.minimumAmounts },
    dun_offline_invoices: c.dunOfflineInvoices,
    dun_one_time_invoices: c.dunOneTimeInvoices,
    dun_trial_and_future_subscriptions: c.dunTrialAndFutureSubscriptions,
  };
}

/** One stored schedule (`[{after_days}]` or bare numbers) → valid offsets, or null. */
function parseOffsets(raw: unknown, max: number): number[] | null {
  if (!Array.isArray(raw)) return null;
  const days = raw
    .map((r) => (r && typeof r === "object" ? (r as { after_days?: unknown }).after_days : r))
    .filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 90);
  return days.length ? days.slice(0, max) : null;
}

/** `{ card?, bank_debit?, offline? }`. A bank-debit schedule never exceeds 5 retries. */
function parseRetriesByMethod(raw: unknown): DunningConfig["retriesByMethod"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: DunningConfig["retriesByMethod"] = {};
  for (const k of DUNNING_METHOD_KINDS) {
    const days = parseOffsets(src[k], k === "bank_debit" ? BANK_DEBIT_MAX_RETRIES : 8);
    if (days) out[k] = days;
  }
  return out;
}

/** Each cadence falls back on its own: one malformed list does not reset the others. */
function parseAdaptiveCadence(raw: unknown): AdaptiveCadence {
  const src =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const list = (v: unknown, lim: { min: number; max: number }) =>
    Array.isArray(v) &&
    v.length >= 1 &&
    v.length <= CADENCE_LIMITS.maxSteps &&
    v.every((n) => typeof n === "number" && Number.isInteger(n) && n >= lim.min && n <= lim.max)
      ? (v as number[])
      : null;
  const int = (v: unknown, lim: { min: number; max: number }) =>
    typeof v === "number" && Number.isInteger(v) && v >= lim.min && v <= lim.max ? v : null;
  const d = DEFAULT_ADAPTIVE_CADENCE;
  return {
    transientHours: list(src.transient_hours, CADENCE_LIMITS.transientHours) ?? d.transientHours,
    genericDays: list(src.generic_days, CADENCE_LIMITS.genericDays) ?? d.genericDays,
    fundsGapDays: int(src.funds_gap_days, CADENCE_LIMITS.fundsGapDays) ?? d.fundsGapDays,
    fundsMaxRetries:
      int(src.funds_max_retries, CADENCE_LIMITS.fundsMaxRetries) ?? d.fundsMaxRetries,
  };
}

/** The resolved cadence in the stored snake_case shape. */
export function serializeAdaptiveCadence(c: AdaptiveCadence) {
  return {
    transient_hours: [...c.transientHours],
    generic_days: [...c.genericDays],
    funds_gap_days: c.fundsGapDays,
    funds_max_retries: c.fundsMaxRetries,
  };
}

/** `{ "USD": 500 }` → the valid entries only: ISO-style codes, positive integer minor units. */
function parseMinimumAmounts(raw: unknown): Readonly<Record<string, number>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [cur, v] of Object.entries(raw as Record<string, unknown>)) {
    if (/^[A-Z]{3}$/.test(cur) && typeof v === "number" && Number.isSafeInteger(v) && v > 0)
      out[cur] = v;
  }
  return out;
}

/**
 * What every dunning step is measured from: the due date, moved later by the time a
 * customer exclusion froze this invoice's dunning. Null when there is no due date.
 */
export function dunningAnchor(inv: {
  dueDate: Date | null;
  dunningHeldMs?: number | null;
}): Date | null {
  if (!inv.dueDate) return null;
  return new Date(inv.dueDate.getTime() + (inv.dunningHeldMs ?? 0));
}

/** Why dunning is held for one invoice. Null = dunning may run. */
export type DunningHold = "customer_excluded" | "below_minimum";

/**
 * The customer-level exclusion and the per-currency minimum, checked together. Uses the
 * OUTSTANDING amount (what is left after payments), never the invoice total.
 */
export function dunningHoldReason(
  config: DunningConfig,
  facts: { customerExcluded: boolean; currency: string; outstandingMinor: bigint },
): DunningHold | null {
  if (facts.customerExcluded) return "customer_excluded";
  const min = config.minimumAmounts[facts.currency.toUpperCase()];
  if (min !== undefined && facts.outstandingMinor < BigInt(min)) return "below_minimum";
  return null;
}

/** Parse the dunning period (whole days, 1..365). Anything else → null = no deadline. */
function parsePeriodDays(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 365 ? raw : null;
}

/**
 * When this invoice's dunning period ends, or null when the business has set no
 * period (then the retry schedule alone decides — see `scheduleTail`).
 *
 * Measured from the invoice's DUE DATE ("retried after 1, 4 and 9 days from the
 * invoice due date"). An invoice with no due date has no anchor to measure from,
 * so it gets no deadline.
 */
export function dunningPeriodEndsAt(
  config: DunningConfig,
  dueDate: Date | null | undefined,
): Date | null {
  if (config.dunningPeriodDays == null || !dueDate) return null;
  return addUtcDays(dueDate, config.dunningPeriodDays);
}

/**
 * When a PARKED invoice's dunning window closes.
 *
 * Unlike every other dunning state, a park has no natural end. A retried invoice
 * exhausts by running off the end of its retry schedule (`nextRetryAt` returns null);
 * a parked one never retries, so nothing counts down — and `dunningPeriodDays` is
 * **null by default**, which meant "no deadline" and therefore "parked forever". That
 * default is exactly the case the deadline exists for, so falling back to null here
 * would have made `sweepExpiredParkedDunning` a no-op on most businesses. Found by
 * `verify:stale-pending` case E rather than by reading, which is the point of it.
 *
 * So there is a fallback, and since 2026-09-01 it is `PARKED_GRACE_DAYS` (30 days
 * from the anchor) rather than the retry schedule's last offset. Read that constant
 * for why: a retried invoice at the tail of [1,3,5,7] has had four charge attempts,
 * a parked one has had none, and what the parked clock actually measures is how long
 * the CUSTOMER has to clear a refusal at their bank. Reusing the retry tail set that
 * at 7 days for every business that has never opened the Dunning settings form.
 *
 * Never null, deliberately. "Never cancel" is a real merchant choice, but it is
 * `finalAction.subscription = 'retain'` — a decision about WHAT closing does, not
 * about whether the window closes. Leaving the window open forever expressed that
 * choice by accident, for every merchant, including the ones who had configured a
 * cancellation and were not getting it.
 *
 * `anchor` is `dunning_parked_at` — the moment the invoice PARKED (0232). It used to
 * be the due date, borrowed from `dunningPeriodEndsAt` where that is right (retries
 * run "1, 4 and 9 days from the invoice due date"). A park is not a retry, and
 * what this clock measures is stated two paragraphs up: time for the CUSTOMER to act
 * at their bank. That starts at the refusal. Callers fall back to the due date, then
 * creation, for rows parked before 0232's backfill — an invoice with no due date is
 * due on issue (see `invoicing/status.ts`).
 */
export function parkedDunningDeadline(config: DunningConfig, anchor: Date): Date {
  // An explicitly configured dunning period always wins, in either direction: it is
  // the merchant's own answer to "how long does an unpaid invoice stay open", and a
  // park is inside that window, not beside it.
  if (config.dunningPeriodDays != null) return addUtcDays(anchor, config.dunningPeriodDays);
  return addUtcDays(anchor, PARKED_GRACE_DAYS);
}

/**
 * The next REMINDER instant for a PARKED invoice, or null when there is none left.
 *
 * ── Why a parked invoice needs one at all ─────────────────────────────────────
 * A park says the debit will not be re-presented, because only the customer (or the
 * merchant) can clear the refusal. Everything else in dunning talks to the payer by
 * ATTEMPTING: a retried invoice mails `payment_failed` each time a charge fails, so the
 * schedule is also the contact ladder. A park makes no attempts, so it made no contact —
 * one failure notice at the moment of parking, then thirty days of silence, then the
 * window closes and the final action cancels a subscription whose customer was told once,
 * a month earlier, in an email they may never have opened.
 *
 * That is the one state where contact is the ONLY thing that can recover the money, and
 * it was the state with the least of it.
 *
 * ── Why the ladder is the RETRY offsets, measured from the PARK ───────────────
 * The merchant already stated how often they are willing to chase an unpaid invoice; that
 * is what `retryDays` is. Reusing it keeps one cadence in the product instead of inventing
 * a second, and a business that sets a gentle schedule gets gentle reminders. The anchor is
 * `dunning_parked_at` rather than the due date for the reason `parkedDunningDeadline`
 * states: a park's clock measures how long the CUSTOMER has to act, and that starts at the
 * refusal.
 *
 * Re-derived from the anchor on every advance rather than counted, exactly as
 * `nextOfflineReminderAt` is: `attempt_count` cannot serve as the ladder index (a park
 * makes no attempts), and a derived instant cannot drift out of step with the deadline the
 * way a stored counter can.
 *
 * ── Strictly inside the window, and strictly future ───────────────────────────
 * `> now` so a single tick cannot walk the whole ladder and mail the customer once per
 * rung. `< deadline` because the deadline is not a reminder: `sweepExpiredParkedDunning`
 * makes its one attempt there and closes the window, and that path emits its own events. A
 * reminder ON the deadline would be a "you have time" message sent at the moment the time
 * ran out.
 *
 * Null means the ladder is spent and the invoice waits out the rest of its window. That is
 * a real state, not an omission — the merchant's cadence is shorter than the grace period
 * by default (7 days of offsets inside 30 days of window).
 */
export function nextParkedReminderAt(
  config: DunningConfig,
  parkedAt: Date | null | undefined,
  now: Date,
  /** The failed instrument's schedule (`retryDaysForMethod`); omitted = the business's. */
  retryDays?: number[] | null,
): Date | null {
  if (!parkedAt) return null;
  const deadline = parkedDunningDeadline(config, parkedAt);
  const days = retryDays?.length
    ? retryDays
    : config.retryDays.length
      ? config.retryDays
      : DUNNING_RETRY_DAYS;
  const future = days
    .map((d) => addUtcDays(parkedAt, d))
    .filter((c) => c.getTime() > now.getTime() && c.getTime() < deadline.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
  return future[0] ?? null;
}

/**
 * When an AUTO-COLLECT-OFF invoice's dunning window closes, or null for "never".
 *
 * One place, deliberately, because the rule that makes this feature honest is easy to
 * forget at a call site: an offline invoice has no retries, so `dunningPeriodDays` is
 * the ONLY thing that can end its window. Without one there is no deadline, and the
 * flag must then change nothing at all rather than park an invoice in `in_progress`
 * that no pass will ever resolve.
 *
 * Also gates on the master switch and on `dunningAppliesTo`, so a business that turns
 * dunning off, or excludes this invoice's class, does not get offline dunning through
 * the side door.
 */
export function offlineDunningDeadline(
  config: DunningConfig,
  dueDate: Date | null | undefined,
  ctx: { hasSubscription: boolean; subscriptionStatus?: string | null },
): Date | null {
  if (!offlineDunningApplies(config, ctx)) return null;
  return dunningPeriodEndsAt(config, dueDate);
}

/**
 * Whether offline (auto-collect-off) dunning covers this invoice at all — the
 * `dunOfflineInvoices` opt-out plus everything `dunningAppliesTo` gates (the master
 * switch, trial/future subscriptions, one-time invoices).
 *
 * Split out of `offlineDunningDeadline` because ENROLMENT and EXHAUSTION now have
 * different requirements and conflating them is exactly the bug this feature shipped
 * with. Enrolment needs only this predicate; exhaustion additionally needs a
 * `dunningPeriodDays` deadline. Before the split, an offline invoice on a business
 * with no dunning period got no dunning at all — when it should report
 * `dunning_status: in_progress` with a `next_retry_at`.
 */
export function offlineDunningApplies(
  config: DunningConfig,
  ctx: { hasSubscription: boolean; subscriptionStatus?: string | null },
): boolean {
  return config.dunOfflineInvoices && dunningAppliesTo(config, ctx);
}

/**
 * The next REMINDER instant for an offline (auto-collect-off) invoice in dunning, or
 * null when there is none left.
 *
 * ── Why this is not `nextRetryAt` ─────────────────────────────────────────────
 * `nextRetryAt` indexes the offsets by `attempt_count`, and an offline invoice's
 * `attempt_count` is permanently 0 — `dunning_attempts` stays empty, because no
 * charge is ever presented and none may be counted. So the ladder is walked by TIME
 * instead: every offset is an absolute day count from the due date (the anchor
 * `nextRetryAt`, `dunningPeriodEndsAt` and the settings screen all share), so "the
 * next reminder" is simply the earliest of them that is still in the
 * future. No per-invoice counter to keep, and re-deriving it on any tick gives the
 * same answer.
 *
 * The dunning period, when one is configured, is BOTH a ceiling and the last stop:
 * offsets beyond it are dropped and the deadline itself becomes the final instant, so
 * the row is guaranteed to come back for the final action rather than idling past it.
 * That mirrors `scheduleTail`, which does the same thing for retried invoices.
 *
 * Strictly `> now` — with ONE exception. An instant at or before `now` would be
 * re-picked by the same tick's scan and the ladder would spin through every offset in
 * one pass, mailing the customer once per step. The exception is a dunning period that
 * has ALREADY elapsed: then the (past) deadline is returned anyway, so the row carries
 * a due `next_attempt_at` and the exhaustion scan closes it on the next pass. Without
 * that, enrolling a BACKDATED invoice — an existing `posted` bill whose due date plus
 * period is long gone, or an import — would arm nothing, and an invoice past its
 * deadline would sit `payment_due` + `in_progress` forever with the configured final
 * action never firing. The pre-parity code armed `next_attempt_at = deadline` directly
 * and got this right by accident; it is explicit here.
 *
 * The ladder branch in `runInvoiceDueTransitions` only calls this while the deadline is
 * still in the FUTURE, so it can never receive a past instant and cannot spin.
 *
 * Null means "no further reminder, and nothing to close": no period configured and
 * every offset spent. The invoice then stays `payment_due` and payable, which is the
 * whole point of the feature.
 *
 * `dueDate` null (a legacy or imported invoice with no due date) → null: there is no
 * anchor to measure an offset from, and guessing one would date reminders wrongly.
 */
export function nextOfflineReminderAt(
  config: DunningConfig,
  dueDate: Date | null | undefined,
  now: Date,
  ctx: { hasSubscription: boolean; subscriptionStatus?: string | null },
): Date | null {
  if (!offlineDunningApplies(config, ctx) || !dueDate) return null;
  const deadline = dunningPeriodEndsAt(config, dueDate);
  const days = offlineRetryDays(config);
  const candidates = days
    .map((d) => addUtcDays(dueDate, d))
    .filter((c) => !deadline || c.getTime() <= deadline.getTime());
  if (deadline) candidates.push(deadline);
  const future = candidates
    .filter((c) => c.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
  // `?? deadline`: see the doc above — an already-elapsed period must still be armed so
  // the window can CLOSE, rather than leaving the invoice mid-chase forever.
  return future[0] ?? deadline ?? null;
}

/** The retry offsets for a payment method of this type and rail (2.48). */
export function retryDaysForMethod(
  config: DunningConfig,
  type: string | null | undefined,
  rail?: string | null,
): number[] {
  const kind = dunningMethodKind(type, rail);
  return (kind && config.retriesByMethod[kind]) || config.retryDays;
}

/** The reminder offsets for auto-collection-off invoices: the offline schedule, else the business's. */
export function offlineRetryDays(config: DunningConfig): number[] {
  const own = config.retriesByMethod.offline;
  if (own?.length) return own;
  return config.retryDays.length ? config.retryDays : DUNNING_RETRY_DAYS;
}

/**
 * Whether the business's dunning settings cover this invoice at all — the master
 * switch plus the two scope toggles. Called at each failure site (that is
 * where the subscription status lives) and passed to `planFailureRearm`.
 */
export function dunningAppliesTo(
  config: DunningConfig,
  ctx: { hasSubscription: boolean; subscriptionStatus?: string | null },
): boolean {
  if (!config.enabled) return false;
  // No subscription behind it → a one-time invoice ("Dunning for one-time invoices").
  if (!ctx.hasSubscription) return config.dunOneTimeInvoices;
  if (
    !config.dunTrialAndFutureSubscriptions &&
    (ctx.subscriptionStatus === "future" || ctx.subscriptionStatus === "in_trial")
  )
    return false;
  return true;
}

/**
 * The retry write for a failed charge on an invoice with `retry_hold_until`
 * (`failed_change_charge = next_renewal`): while the hold is later than the planned retry,
 * the retry waits for it as a dunning pause, so `resume_dunning` can restore the plan.
 */
export function heldRetry(
  nextAttempt: Date,
  holdUntil: Date | null | undefined,
): {
  nextAttemptAt: Date;
  dunningPause?: { until: string; next_attempt_at: string; dunning_status: string };
} {
  if (!holdUntil || holdUntil.getTime() <= nextAttempt.getTime())
    return { nextAttemptAt: nextAttempt };
  return {
    nextAttemptAt: holdUntil,
    dunningPause: {
      until: holdUntil.toISOString(),
      next_attempt_at: nextAttempt.toISOString(),
      dunning_status: "in_progress",
    },
  };
}
