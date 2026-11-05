/**
 * Smart-dunning decline classification (Tier-1 gap M10).
 *
 * Smart dunning treats declines differently by REASON rather than as a single
 * retriable boolean. Given the engine's NORMALIZED decline code (see
 * `ChargeResult.failure.code` in `src/providers/types.ts`), decide the dunning
 * disposition:
 *
 *   code                        → policy      why
 *   ─────────────────────────── ─ ─────────── ──────────────────────────────────────
 *   insufficient_funds          → retry       transient — funds may arrive later
 *   processing_error            → retry       gateway/transient
 *   try_again_later             → retry       explicit transient signal
 *   issuer_unavailable          → retry       issuer down — transient
 *   (unknown / empty / other)   → retry       DEFAULT — safest, matches today
 *   ─────────────────────────── ─ ─────────── ──────────────────────────────────────
 *   card_declined               → retry, then park   generic decline — no reason given
 *   do_not_honor                → retry, then park   issuer soft-refusal — often clears
 *   expired_card                → park        needs a new card, not a cancellation
 *   incorrect_cvc               → park        re-entry / new card fixes it
 *   incorrect_number            → park        re-entry / new card fixes it
 *   card_restricted             → park        card blocked / not enabled for this payment — new card
 *   authentication_required     → park        3DS/SCA — customer action recovers it
 *   mandate_ceiling_exceeded    → park        re-authorizing the mandate recovers it
 *   mandate_cycle_limit_exceeded → park       the CYCLE's debits are spent — only TIME recovers it
 *   mandate_expired             → park        the mandate lapsed — only a new one recovers it
 *   mandate_spent               → park        a used one-shot mandate — only a new one recovers it
 *   gateway_limit_exceeded      → park        a GATEWAY/ACCOUNT limit — a human must raise it
 *   recurring_not_enabled       → park        MERCHANT config — a human must fix it
 *   ─────────────────────────── ─ ─────────── ──────────────────────────────────────
 *   stolen_card                 → park (held)  card is dead — hold for a new one, even with parking off
 *   lost_card                   → park (held)  card is dead — hold for a new one, even with parking off
 *   pickup_card                 → park (held)  issuer wants the card seized — hold for a new one
 *   fraudulent                  → terminate   unrecoverable
 *   revocation_of_authorization → terminate   mandate revoked — stop charging
 *   debit_not_authorized        → terminate   payer revoked / never authorised the debit
 *   bank_account_closed         → park        ACH/SEPA return — a new instrument recovers it
 *   bank_account_not_found      → park        ACH/SEPA return — a new instrument recovers it
 *   bank_account_invalid_details → park       ACH/SEPA return — a new instrument recovers it
 *
 * `retry` is the liberal default: any code not explicitly mapped to park/terminate
 * retries, which is the current (fixed-mode) behavior for retriable failures.
 */
export type DeclinePolicy = "retry" | "park" | "terminate";

/**
 * Generic issuer refusals. The issuer gives no reason and a later presentation often
 * clears, so smart mode RETRIES these on the merchant's schedule and parks only after
 * `RETRY_THEN_PARK_ATTEMPTS` failed attempts, or sooner if the schedule is spent. Parking
 * on the first one meant the most common decline was never retried at all.
 */
export const RETRY_THEN_PARK = new Set<string>(["card_declined", "do_not_honor"]);

/** Failed attempts (the first charge plus three retries) before a generic refusal parks. */
export const RETRY_THEN_PARK_ATTEMPTS = 4;

export const PARK = new Set<string>([
  "expired_card",
  // Blocked, inactive, not enrolled, the wrong type, or barred from this kind of payment.
  // No retry changes that; only a different card pays.
  "card_restricted",
  "incorrect_cvc",
  "incorrect_number",
  "authentication_required",
  // The instrument's mandate caps a single debit below what is due. Recoverable —
  // but only by the CUSTOMER re-authorizing at a higher ceiling, never by retrying,
  // so it parks (and `mandateRefusal` marks it non-retriable) rather than burning a
  // dunning schedule on a charge the rail will refuse every time.
  "mandate_ceiling_exceeded",
  // The mandate's END DATE has passed (`mandateExpiredRefusal`, invoicing/collection.ts).
  // Recoverable only by the CUSTOMER authorising again — an authorisation that has lapsed
  // does not come back, and no retry interval reaches a date in the past — so it parks
  // for exactly the reason `mandate_ceiling_exceeded` does. Leaving it unclassified was
  // not an option: a non-retriable code that is not in `PARK_EVEN_IN_FIXED_MODE` exhausts
  // dunning on the FIRST attempt in fixed mode (the only selectable mode), which is the
  // measured ₹66,025 silent-revenue-loss failure documented in `planFailureRearm`.
  "mandate_expired",
  // A SINGLE-USE mandate that has already carried its one debit (F-43,
  // `mandateSpentRefusal`). Recoverable only by the customer authorizing again — no
  // retry can ever work, because "used up" is not a transient condition — so it parks
  // for the same reason `mandate_ceiling_exceeded` does rather than burning a schedule
  // on a debit our own pre-flight refuses every time.
  "mandate_spent",
  // No mandate on file at all (`mandateMissingRefusal`, invoicing/collection.ts).
  // Recoverable only by the CUSTOMER authorising — there is nothing for a retry to
  // present — so it parks for exactly the reason `mandate_expired` does.
  "mandate_missing",
  // Recurring is not enabled on the merchant account (or for this card's origin) —
  // RazorPay's `recurring_payment_not_enabled`. Parks rather than terminates: the
  // fault is ours, not the customer's, so the invoice waits for an operator instead
  // of cancelling their subscription. Retrying is pointless; only a gateway-side
  // change clears it.
  "recurring_not_enabled",
  // The buyer never completed their bank's additional-factor authentication and the
  // window has closed (`stale-pending.ts`). NOT only above ₹15,000 — that is where
  // AFA is compulsory, not where an issuer may ask; production challenged ₹885.
  // Recoverable
  // only by the customer — paying through the portal, or authorising the next
  // attempt — never by retrying the same debit on the same rail, which stalls
  // identically. Parks for the same reason `mandate_ceiling_exceeded` does.
  "afa_not_completed",
  // A limit on the GATEWAY ACCOUNT, not on the instrument or the mandate — the amount
  // is simply larger than this merchant is allowed to charge in one payment.
  // Deliberately distinct from `mandate_ceiling_exceeded`, which the customer can clear
  // by re-authorizing at a higher ceiling: here the mandate is fine and re-authorizing
  // changes nothing. Only the merchant can clear it, by getting the limit raised or by
  // billing a smaller amount — so it parks for an operator rather than asking the
  // customer to fix an instrument that is not broken.
  "gateway_limit_exceeded",
  /**
   * RazorPay's per-CYCLE debit exhaustion (`card_mandate_current_cycle_allowed_debit_exceeds`,
   * "Maximum allowed debits in current cycle exceeded") — RBI/NPCI's rule about how many times
   * a mandate may be debited within ONE CYCLE, not a per-charge ceiling breach.
   *
   * Until 2026-09-03 both mapped onto `mandate_ceiling_exceeded`, so operator and payer alike
   * were told to re-authorize at a higher limit when the ceiling had never been the constraint
   * (defect #14, measured twice on sub_XXXXXXXXXXXXXXXXXXXXXX01: pay_XXXXXXXXXXXXXXXXXXXXXX06
   * on INV-7824, and txn_XXXXXXXXXXXXXXXXXXXXXX04 on INV-7826 carrying RazorPay's own words).
   * Re-authorizing changes nothing here; only the next cycle does.
   *
   * PARK rather than the `retry` default even though the code is `retriable`: card mandates
   * register `frequency: 'monthly'` (gateway/README.md), so the next cycle can be weeks away —
   * further than any fixed retry schedule reaches. A retry inside this cycle cannot succeed.
   */
  "mandate_cycle_limit_exceeded",
  // The GATEWAY refused the REQUEST, not the card (#63): Stripe's
  // `payment_intent_payment_attempt_failed`, which the adapter now books as an
  // attempt instead of letting it vanish. Ours to fix and the payer can do nothing,
  // so it parks in both modes; re-presenting an identical malformed request cannot
  // succeed, which is why it must never reach the retry schedule.
  "gateway_request_rejected",
  /**
   * ── BANK-DEBIT RETURNS (ACH / SEPA), 2026-09-05 ───────────────────────────────
   *
   * The account is closed, was never there, or the number is wrong. PARK for exactly the
   * reason `expired_card` does: a NEW instrument recovers it and no retry ever will, so
   * the invoice waits for the customer instead of burning a dunning ladder — which on
   * this rail also costs a gateway failure fee per attempt.
   *
   * These are TERMINAL in `decline-codes.ts` (never retriable) and parked here (never a
   * cancellation). Both halves are needed: terminal alone would exhaust dunning on the
   * FIRST attempt in fixed mode, which is the measured silent-revenue-loss shape
   * `mandate_expired` documents above.
   */
  "bank_account_closed",
  "bank_account_not_found",
  "bank_account_invalid_details",
  // The instrument is GONE at the gateway (#69): Stripe answers "No such PaymentMethod"
  // with a generic code, so only a message rule sees it. Retrying cannot conjure the
  // method back; the customer has to add another one, which is a park, not a schedule.
  "payment_method_not_found",
  // The card NETWORK told us to stop re-presenting this debit (#69):
  // `previously_declined_do_not_retry` / `highest_risk_level` / recommendation code 03.
  // Parks in both modes because a retry here is not merely futile — networks fine
  // acquirers for it, so the schedule must never touch it.
  "network_do_not_retry",
  // The PM's gateway account is disabled or mode-mismatched (`GatewayRouterError`,
  // invoicing/collection.ts). Same category as `recurring_not_enabled`: the refusal is
  // about OUR account, the instrument is fine, and the payer can do nothing. It was
  // unclassified and `retriable`, so it ran the whole ladder and exhausted — cancelling
  // a subscription over our own configuration, which is the harm `MERCHANT_SIDE_PARK`
  // exists to prevent. Raised before the gateway is called, so no instrument is ever
  // marked invalid on this path.
  "gateway_account_unavailable",
  /**
   * There is no instrument on file at all (`invoicing/service.ts`, `!primary`).
   *
   * The sharpest customer-side case in the set and, until now, the one treated worst: it
   * was unclassified and `retriable`, so a customer with NO card ran the full ladder and
   * was cancelled in about a week, while a customer whose card merely DECLINED parked and
   * got thirty days. The population that most obviously has to act got the shortest rope.
   *
   * Retrying cannot work in either mode, and not for a subtle reason — there is nothing
   * to present. Every rung is a charge the engine refuses before a gateway is asked.
   *
   * Parking is what the rest of the machinery already expects: the reminder ladder asks
   * them to add a method, `collect_on_payment_method_update` (default ON) charges the
   * moment they do, and the deadline attempt covers the case where it is off.
   */
  "no_payment_method",
  // Above the business's card limit (0482, `invoicing/card-limit.ts`): no card was presented,
  // a retry changes nothing, and another method pays it.
  "card_limit_exceeded",
]);

/**
 * Exported so any mirror of it can be tested for drift rather than trusted.
 *
 * The mirror that motivated exporting it — `providers/shadow/declines.ts`, a HAND-COPY —
 * is gone with the shadow programme, so nothing duplicates this set today. The export
 * stays: the lesson is why. A second copy of "what is terminal" that drifts from this one
 * cancels subscriptions the other side kept, for a reason nobody chose, and the drift is
 * invisible until it has. Anything that needs this ladder derives it from HERE.
 */
export const TERMINATE = new Set<string>([
  "fraudulent",
  "revocation_of_authorization",
  /**
   * The payer told their bank to stop the debit, or says they never authorised it. Same
   * meaning as `revocation_of_authorization`, terminated for the same reason: a retry is a
   * SECOND unauthorised debit, and on SEPA that is what a 13-month dispute is made of.
   */
  "debit_not_authorized",
]);

/**
 * Lost, stolen or seized cards. The card is dead; the customer usually isn't. Never
 * re-present it (networks penalise retries on these) and always hold the invoice for a
 * new instrument in smart mode, whatever `parkHardDeclines` says. Classifies as `park`.
 */
export const HOLD_FOR_NEW_CARD = new Set<string>(["lost_card", "stolen_card", "pickup_card"]);

/**
 * The park-classified codes that park in **fixed** mode too, not only in smart mode.
 *
 * "Skip retries for hard failures" is scoped precisely: retry attempts are skipped for
 * PAYMENT METHODS WITH HARD DECLINES, and the custom retry schedule still applies to
 * every other payment method.
 *
 * `card_declined`, `expired_card`, `incorrect_cvc` and friends are exactly that — a
 * payment method the issuer refused — and the toggle must keep doing what it promises
 * for them, in fixed mode, unchanged.
 *
 * These are NOT payment-method declines at all, which is why they are carved out:
 *
 *   `mandate_ceiling_exceeded` — the instrument is valid and would pay a SMALLER amount
 *     today; only this debit is over the mandate's per-debit cap. Nothing about the card
 *     is wrong.
 *   `recurring_not_enabled`    — the refusal is about the MERCHANT's gateway account.
 *     The customer's instrument is fine and they cannot do anything about it.
 *   `afa_not_completed`        — the card was never even asked to pay. The debit was
 *     accepted and then expired waiting on the buyer's bank authentication, which is
 *     an unanswered request, not a refusal.
 *   `mandate_expired`          — the card was never asked to pay: the authorisation
 *     behind it lapsed on the gateway's own end date. Nothing about the instrument is
 *     refused, and re-authorising the very same card clears it.
 *   `mandate_spent`            — the card was never asked to pay either: our own
 *     pre-flight refused, because the one-shot authorization behind it was already used.
 *     The instrument is not declined, it is un-authorized, and a customer who authorizes
 *     again pays immediately. Without the carve-out a fixed-mode business would exhaust
 *     dunning on the FIRST attempt — the measured failure below, in `planFailureRearm`.
 *
 * None is a case the toggle contemplates, so treating them as hard card
 * declines is a category error — and an expensive one: see the measurement in
 * `planFailureRearm`, where a ₹66,025 renewal on a ₹15,000 mandate abandoned the invoice
 * on its first attempt and left a live subscription permanently unpaid.
 *
 * Deliberately a short, explicit list rather than "everything `classifyDecline` parks":
 * that wider rule silently stopped fixed-mode businesses from ever cancelling an
 * ordinary declined card, which `verify:dunning-smart` case 4 exists to prevent.
 */
/**
 * Codes where the NETWORK told us when it will accept a re-present, in ms from the failure.
 *
 * A floor on WHEN, never on whether: these stay retriable and keep the merchant's own retry
 * schedule, they just cannot be attempted before the window the bank named. Retrying inside
 * it spends a dunning attempt on a guaranteed refusal, and repeated fast re-presents are what
 * card networks read as card testing.
 *
 * Sourced from the gateway's own published resolution, never guessed — the same rule the
 * whole decline taxonomy follows. Today that is RazorPay's e-mandate error page
 * (`docs/references/RAZORPAY_EMANDATE_ERROR_CODES.md`), which gives `already_declined` as
 * "Retry after 24 hours". `duplicate_request` on the same page says 30 minutes and is NOT
 * here: it is a registration-surface code we have never seen on a debit, and a floor for a
 * code that cannot arrive is dead configuration.
 */
export const RETRY_NOT_BEFORE_MS: Readonly<Record<string, number>> = {
  retry_too_soon: 24 * 60 * 60 * 1000,
};

/**
 * The earliest a debit refused with this code may be re-presented, or null when the code
 * carries no such instruction.
 */
export function retryNotBefore(code: string | null | undefined, now: Date): Date | null {
  const ms = RETRY_NOT_BEFORE_MS[(code ?? "").trim().toLowerCase()];
  return ms === undefined ? null : new Date(now.getTime() + ms);
}

export const PARK_EVEN_IN_FIXED_MODE = new Set<string>([
  "mandate_ceiling_exceeded",
  "mandate_spent",
  // No authorisation on file at all. The sharpest case of this whole category: our own
  // pre-flight refuses before the gateway is asked, so the card is not declined — it is
  // un-authorised. Without the carve-out a fixed-mode business would exhaust dunning on
  // the FIRST attempt (the measured failure in `planFailureRearm`) on the one population
  // that provably cannot pay until it acts.
  "mandate_missing",
  // Our own pre-flight again, and the card was never asked to pay: the AUTHORISATION
  // behind it ended on the date the bank set. Same category as `mandate_spent` — the
  // instrument is not declined, it is un-authorised — and a customer who authorises again
  // pays immediately (`collect_on_payment_method_update`, default ON).
  "mandate_expired",
  "recurring_not_enabled",
  "afa_not_completed",
  // Same category as `recurring_not_enabled`: a MERCHANT-side limit the customer has no
  // way to clear. Cancelling their subscription because our account cannot charge the
  // amount would punish them for our configuration, and no retry interval moves it.
  "gateway_limit_exceeded",
  // The RAIL's per-cycle rule, and the customer cannot clear this one either: there is
  // nothing wrong with their instrument and no action available to them. Cancelling a
  // subscription because NPCI's cycle allowance is spent would punish the payer for a rule
  // neither party can move.
  "mandate_cycle_limit_exceeded",
  // The GATEWAY refused the REQUEST, not the card (#63): Stripe's
  // `payment_intent_payment_attempt_failed`, which the adapter now books as an
  // attempt instead of letting it vanish. Ours to fix and the payer can do nothing,
  // so it parks in both modes; re-presenting an identical malformed request cannot
  // succeed, which is why it must never reach the retry schedule.
  "gateway_request_rejected",
  // The instrument is GONE at the gateway (#69): Stripe answers "No such PaymentMethod"
  // with a generic code, so only a message rule sees it. Retrying cannot conjure the
  // method back; the customer has to add another one, which is a park, not a schedule.
  "payment_method_not_found",
  // The card NETWORK told us to stop re-presenting this debit (#69):
  // `previously_declined_do_not_retry` / `highest_risk_level` / recommendation code 03.
  // Parks in both modes because a retry here is not merely futile — networks fine
  // acquirers for it, so the schedule must never touch it.
  "network_do_not_retry",
  // Our gateway account, not their instrument — see the entry in `PARK`. Carved out of
  // the "skip retries for hard failures" toggle for the same reason
  // `recurring_not_enabled` is: it is not a payment-method decline at all.
  "gateway_account_unavailable",
  // Not a payment-method decline either — there IS no payment method. The toggle is
  // scoped to "payment methods with hard declines" and there is no instrument here to
  // have declined, so the carve-out applies for the same reason `mandate_missing` does.
  "no_payment_method",
  // Above the business's card limit (0482, `invoicing/card-limit.ts`): no card was presented,
  // a retry changes nothing, and another method pays it.
  "card_limit_exceeded",
]);

/**
 * Parked declines caused by US, not by the payer — the ones an ops alert must name.
 *
 * There is no longer a set that decides WHETHER a park gets a deadline: every park
 * gets one (`sweepExpiredParkedDunning`). This set exists because that change made a
 * merchant-side park dangerous in a way a customer-side one is not — the payer's
 * instrument is fine, they can do nothing about it, and with the default
 * `finalAction.subscription = 'cancel'` the window now closes on a subscription
 * nobody had any way to save. Cancelling over our own gateway configuration would
 * punish them for our bug, so the alert has to reach a human first.
 *
 *   `recurring_not_enabled`  — the gateway account is not enabled for recurring
 *     debits. Ours to fix, at the gateway, for every customer at once.
 *   `gateway_limit_exceeded` — a ceiling on OUR account, not on their instrument.
 *
 * Deliberately NOT here: `mandate_cycle_limit_exceeded`. It is the RAIL's per-cycle
 * allowance (NPCI), so it is nobody's misconfiguration — neither ours to fix nor the
 * payer's to clear — and it is the one park code that self-clears with time when the
 * cycle rolls over. Whether it should therefore RETRY at the next cycle boundary
 * rather than park at all is a real question and a separate item; see
 * `docs/PROGRESS.md`. Alerting on it would train people to ignore the alert.
 *
 * History: until 2026-09-04 this file held `PARKED_WITH_DEADLINE`, an allowlist of the
 * declines a customer can clear — `afa_not_completed` plus the three mandate refusals,
 * 4 of `PARK`'s 13. Everything else parked forever, including `expired_card`,
 * `card_declined` and `incorrect_cvc`: an expired card, the textbook dunning case,
 * could never reach a final action. It had been grown one code at a time and never
 * swept back over the card declines. Measured on a real database: 50 of 52 parked
 * invoices could never close, the oldest parked for 13 months. Decision (the user,
 * 2026-09-04): a park is a dunning state and every dunning state ends; whether closing
 * cancels stays `finalAction.subscription`, which is where a merchant already says it.
 */
export const MERCHANT_SIDE_PARK = new Set<string>([
  "recurring_not_enabled",
  "gateway_limit_exceeded",
  // #63: the gateway rejected OUR request. Nobody but us can clear it.
  "gateway_request_rejected",
  // The gateway account this instrument is bound to is disabled or in the wrong mode.
  // Ours to fix, in our own settings, and it takes every customer on that account down
  // at once — exactly the shape this alert exists for.
  "gateway_account_unavailable",
]);

export function classifyDecline(code: string | null | undefined): DeclinePolicy {
  if (!code) return "retry";
  const c = code.toLowerCase();
  if (TERMINATE.has(c)) return "terminate";
  if (PARK.has(c) || HOLD_FOR_NEW_CARD.has(c)) return "park";
  // insufficient_funds / processing_error / try_again_later / issuer_unavailable /
  // generic / unknown / everything else → retry (safest default, matches today).
  return "retry";
}
