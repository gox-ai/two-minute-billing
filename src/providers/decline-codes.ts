/**
 * Per-gateway decline-code normalization.
 *
 * Smart dunning (`classifyDecline` in src/modules/subscriptions/decline-policy.ts)
 * routes retry / park / terminate off a NORMALIZED code, not a raw gateway string.
 * RazorPay and PayPal previously surfaced their raw provider codes, which fall through
 * to the liberal `retry` default and so never park/terminate.
 *
 * ⚠️ This file used to say "Stripe was already normalized inline". It was normalized, but
 * NOT here — by a five-case switch in `providers/stripe.ts` that never consulted `TERMINAL`.
 * Measured 2026-09-04, feeding the same code to both paths: **five declines diverged, all in
 * the same direction.** `stolen_card`, `lost_card`, `fraudulent`, `pickup_card` and
 * `revocation_of_authorization` came back `retriable: true` from Stripe and `false` from
 * RazorPay — so a card reported stolen was retried through the dunning ladder on one gateway
 * and treated as a hard decline on the other. The AFA tokens only LOOKED aligned, because
 * that switch passed unknown provider codes through verbatim and Stripe's spelling happens
 * to match our token for `authentication_required`. Coincidence, not design: any Stripe code
 * whose name differs from our token reached a policy that had no case for it. This module maps each gateway's decline vocabulary into
 * the canonical tokens `decline-policy.ts` understands, with a conservative
 * `retriable` flag (false only for clearly-terminal declines, so the backup-card
 * / dunning machinery treats it as a hard decline).
 *
 * Unknown codes return `{ code: <raw or 'charge_failed'>, retriable: true }` — the
 * safe default that preserves today's behavior.
 */

import { resolveErrorId, type ResolvedErrorId } from "../platform/error-taxonomy";
import type { ProviderKey } from "./types";

export interface NormalizedDecline {
  code: string;
  retriable: boolean;
  /** Our sentence, when a rule supplied one. Absent means "use the gateway's". */
  message?: string;
  /** Whether `message` may be shown to the payer. Absent or false means operator-only. */
  exposedToPayer?: boolean;
  /**
   * WHICH rule decided this, when one did. Absent means the legacy table or the
   * passthrough answered.
   *
   * Carried because a merchant override is keyed on a rule id, and the override can only
   * be applied by whoever knows the tenant — which is the module layer, not here.
   * `providers/` may not import from `modules/`, so normalisation stays pure and reports
   * what matched; the business's own answer is layered on afterwards. It is also what
   * lets an operator screen say WHY a decline was classified the way it was.
   */
  ruleId?: string;
  /**
   * A minimum wait before re-presenting, when the network or gateway STATES one outright
   * (a Mastercard "retry after" advice code, a RazorPay reason whose next step names a
   * duration). Independent of `code`: the decline keeps its own classification.
   */
  retryAfterMs?: number;
}

// Canonical tokens that are terminal for the INSTRUMENT (never retriable; the method is
// marked invalid). Dunning may still park them — see `classifyDecline`.
const TERMINAL = new Set([
  "stolen_card",
  "lost_card",
  "fraudulent",
  "pickup_card",
  "revocation_of_authorization",
  /**
   * ADDED 2026-09-04, resolving a gateway divergence rather than inventing a policy.
   *
   * Stripe's inline normalizer already answered `retriable: false` here; RazorPay's did
   * not, because this set is what decides it and `expired_card` was missing. So the same
   * expired card was a bad instrument on one gateway and a retryable failure on the other.
   *
   * Stripe's answer is the correct one and that is not a preference: `isHardDecline` reads
   * `retriable: false` as a bad instrument, which marks the method `invalid` and moves
   * collection to the backup card. An expired card cannot succeed on a retry, today or on
   * any later attempt, so retrying it burns a dunning schedule and delays the backup that
   * could actually pay. It is NOT exempted in `NOT_THE_INSTRUMENTS_FAULT`, and should not
   * be: unlike a ceiling refusal, the instrument really is the problem, so `invalid` puts
   * the issuer's verdict in the column where it belongs.
   *
   * ⚠️ This changes LIVE dunning for RazorPay subscriptions whose card expires — the next
   * attempt marks the method invalid instead of retrying. Nothing is reclassified
   * retroactively: classification happens per ATTEMPT, so an in-flight ladder simply
   * behaves differently on its next one, which is the intended outcome. Measured before
   * the change: 679 invoices sit `in_progress` across EUR/INR/USD, so in-flight ladders do
   * exist — the India book alone had none.
   */
  "expired_card",
  /**
   * ── BANK-DEBIT RETURNS, added 2026-09-05 with the ACH/SEPA rails ──────────────
   *
   * A direct debit does not decline at the till; it is RETURNED, up to five business days
   * later, carrying an ACH return code (R02 account closed, R03 no account, R04 invalid
   * number) or a SEPA equivalent. None of them can succeed on a retry — the account is
   * gone or was never there — and Stripe says so itself: a non-retryable return code
   * cannot be retried without a NEW payment method.
   *
   * Terminal is therefore the correct classification, and it is the same argument
   * `expired_card` settled: retrying burns a dunning ladder against an account that
   * cannot pay, and delays the backup instrument that could. Left out, they fell to the
   * liberal retry default and each retry costs a $4 ACH failure fee.
   */
  "bank_account_closed",
  "bank_account_not_found",
  "bank_account_invalid_details",
  // The account exists but this rail may not debit it (blocked, restricted, wrong
  // currency). Same argument: only a different account pays.
  "bank_account_restricted",
  "debit_not_authorized",
  // ── Added 2026-11-18 (decline audit): a table mapping must not retry these. ──
  // The network said never resubmit.
  "network_do_not_retry",
  // The number cannot exist or has no issuer (Visa 14/15). Name and card-type refusals
  // map elsewhere, so this code means the number alone.
  "incorrect_number",
  // The stored method or UPI ID is gone at the gateway.
  "payment_method_not_found",
  // The authorization behind the method ended. `isHardDecline` still exempts it (not the
  // instrument's fault) and the policy parks it; this only makes every gateway agree.
  "mandate_expired",
]);

// RazorPay: `error.reason` / `error.code` strings → canonical tokens.
// See https://razorpay.com/docs/payments/payments/decline-error-codes/.
export const RAZORPAY_CODE_TABLE: Record<string, string> = {
  payment_failed: "card_declined",
  card_declined: "card_declined",
  payment_declined_by_bank: "do_not_honor",
  gateway_error: "processing_error",
  server_error: "processing_error",
  // Our request, not their card — see the rule of the same name in RAZORPAY_RULES.
  BAD_REQUEST_ERROR: "gateway_request_rejected",
  GATEWAY_ERROR: "processing_error",
  SERVER_ERROR: "processing_error",
  // RazorPay spells this SINGULAR (`insufficient_fund`) in its published card error
  // table. The plural key was a guess and never matched a real refusal; both land on
  // `retry` so nothing behaved wrongly, but the plural entry is exactly the dead key
  // the note below warns about. Keep both: plural costs nothing and the singular is
  // the one that actually arrives.
  insufficient_fund: "insufficient_funds",
  insufficient_funds: "insufficient_funds",
  incorrect_cvv: "incorrect_cvc",
  invalid_card: "incorrect_number",
  // ── From RazorPay's published card error table (Test Card Details docs) ────
  // `declineFailure` prefers `error.reason`, so these are the strings that actually
  // arrive. Unmapped they took the liberal `retry` default, which is wrong for all
  // three: no retry interval fixes a card the issuer has disabled for online use, a
  // mistyped number, or a failed OTP. Each maps to a canonical token that already
  // parks, so dunning asks the customer to fix the instrument instead of burning the
  // schedule on a refusal that can never change.
  card_disabled_for_online_payments: "card_declined",
  card_number_invalid: "incorrect_number",
  authentication_failed: "authentication_required",
  // Deliberately NOT mapped — their default of `retry` is already correct:
  // `payment_timed_out` is transient, and `payment_cancelled` means the buyer walked
  // away from a surface they can revisit. `gateway_technical_error` was in this list
  // until 2026-09-10; it is now a RULE mapping to `processing_error`, which keeps the
  // retry and adds the thing the passthrough could not give it — a taxonomy family and
  // a row on the merchant's Error handling screen.
  expired_card: "expired_card",
  card_lost_or_stolen: "stolen_card",
  fraudulent_transaction: "fraudulent",
  // ── Mandate vocabulary (INR recurring rails) ──────────────────────────────
  // Only codes we have SEEN are mapped. RazorPay's error tables are rendered
  // client-side and could not be read, and a guessed key is a dead entry that
  // makes the map look more complete than it is — so the liberal `retry` default
  // still covers everything unlisted, exactly as before.
  //
  // `recurring_payment_not_enabled` is quoted verbatim from a live refusal (see
  // src/modules/gateway/README.md, operator ask 3). It names MERCHANT
  // configuration — recurring is not enabled for this account or card origin — so
  // no retry can ever succeed. It maps to a park, never a terminate, and stays
  // `retriable: true` on purpose:
  //   • not terminal, because cancelling a subscription over our own gateway
  //     misconfiguration punishes the customer for it;
  //   • not `retriable: false`, because that is what `isHardDecline` reads as a
  //     BAD INSTRUMENT — it would mark a perfectly good card `invalid` and burn
  //     the backup. Same reasoning the `order_failed` path already documents.
  // Smart dunning therefore parks the invoice and waits for a human. ⚠️ In FIXED
  // dunning mode `classifyDecline` is not consulted, so this still rides the
  // ordinary retry schedule — the honest limit of a code-only signal.
  recurring_payment_not_enabled: "recurring_not_enabled",
  // From RazorPay's own eMandate error framework sample. The buyer failed or
  // skipped the authentication step — recoverable by them, never by a retry.
  invalid_otp: "authentication_required",
  // RBI's ₹15,000 additional-factor ceiling, as RazorPay actually reports it —
  // "Maximum allowed debits in current cycle exceeded". Observed twice on one
  // subscription: 2026-08-13 debiting ₹28,215 and ₹56,715 against a
  // CARD mandate whose ceiling was ₹84,645 (far below the mandate's own limit), and
  // again 2026-09-03 on two payments,
  // both ₹22,184.00 (INV-7824, INV-7826) against a mandate whose own ceiling was
  // never the constraint. This is the per-cycle AFA rule, NOT our own
  // `mandate_ceiling_exceeded` (raised in `mandateRefusal`, before the gateway is
  // even called), and they used to share one token — which told the customer to
  // re-authorize at a higher ceiling when re-authorizing changes nothing; the
  // mandate's per-charge ceiling was never breached, only its per-cycle debit count.
  //
  // ⚠️ Deliberately its OWN token, not `mandate_ceiling_exceeded`: the two failures
  // have OPPOSITE remedies. A ceiling breach needs a new authorization at a higher
  // limit; a cycle-limit exhaustion needs neither — it clears itself once the cycle
  // rolls over, or the customer can pay this invoice through a different rail
  // (netbanking) right now. Conflating them made every downstream surface — the
  // ladder, the buyer/operator-facing text, the payment-method-invalid decision —
  // repeat a remedy that does not apply.
  //
  // `retriable` computes to `true` here (below, via the TERMINAL check — this token
  // is not in TERMINAL), same as `recurring_not_enabled`'s reasoning: `isHardDecline`
  // reads `retriable: false` as a BAD INSTRUMENT, and this card is not bad — a
  // smaller debit on the very same mandate, today, still succeeds. See
  // `decline-policy.ts` for the ladder classification this token needs (PARK, with
  // its own remedy text — not a deadline keyed to a customer-side authorization,
  // since re-authorizing is not the fix).
  card_mandate_current_cycle_allowed_debit_exceeds: "mandate_cycle_limit_exceeded",
  // ⚠️ RazorPay's opaque catch-all for "this amount cannot be charged", observed
  // 2026-08-19 (`verify:razorpay-pro-amounts`) on THREE distinct refusals — a UPI debit
  // exceeding its own mandate ceiling, and a card *and* netbanking debit exceeding the
  // ACCOUNT's ₹5,00,000 per-payment maximum. Unmapped it took the liberal `retry`
  // default, so a limit refusal burned the entire dunning schedule on a charge the
  // gateway will refuse identically every time.
  //
  // Mapped to its own token rather than to `mandate_ceiling_exceeded`, which was the
  // tempting shortcut: that one promises the CUSTOMER can clear it by re-authorizing at
  // a higher ceiling, and for the account-maximum cause the mandate is already fine and
  // re-authorizing changes nothing. Both park, but they tell an operator to do different
  // things, and a park whose remedy text is wrong is a park nobody can action.
  //
  // ⚠️ The code itself is GENERIC — RazorPay does not document it as limit-specific — so
  // this is the one entry here inferred from behaviour rather than from their error
  // table. It is worth it because the asymmetry is lopsided: a false park holds an
  // invoice open for a human (the instrument is never marked bad — this is not TERMINAL),
  // while a false retry burns the schedule and can end in a wrongful cancellation. If a
  // transient `order_failed` ever shows up, split it by `error.description`.
  order_failed: "gateway_limit_exceeded",
};

// PayPal: order/capture failure `name` / `issue` codes → canonical tokens.
// See https://developer.paypal.com/api/rest/reference/orders/v2/errors/.
export const PAYPAL_CODE_TABLE: Record<string, string> = {
  INSTRUMENT_DECLINED: "card_declined",
  PAYER_CANNOT_PAY: "do_not_honor",
  INSUFFICIENT_FUNDS: "insufficient_funds",
  CARD_EXPIRED: "expired_card",
  TRANSACTION_REFUSED: "card_declined",
  PAYER_ACTION_REQUIRED: "authentication_required",
  CANNOT_PROCESS: "processing_error",
  INTERNAL_SERVICE_ERROR: "processing_error",
  // Capture and authorization statuses: the fallback when no processor code came back.
  DECLINED: "card_declined",
  DENIED: "card_declined",
  FAILED: "processing_error",
  // An order released before capture: no money moved.
  VOIDED: "intent_expired",
};

/**
 * Stripe: `decline_code` (and top-level `code`) → canonical tokens.
 *
 * Short by design. `build()` applies `TERMINAL` to the code it ends up with, mapped or
 * not, and Stripe's vocabulary already matches most of our tokens exactly — so listing
 * `stolen_card: "stolen_card"` would be noise. Only the names that DIFFER are here.
 *
 * ⚠️ NOT LISTED, because they are not measured: Stripe's India e-mandate refusal codes.
 * The AFA rule is a property of the rail (`INR_AFA_FREE_CEILING_MINOR`), so a Stripe India
 * e-mandate obeys it identically — but this repo has RazorPay's actual strings from
 * production (`card_mandate_current_cycle_allowed_debit_exceeds`, observed four times) and
 * has never seen Stripe refuse one. Guessing a code would create a mapping that silently
 * never fires, which is worse than the honest fall-through: an unmapped code keeps its raw
 * name, reaches `classifyDecline`'s default, and is visibly unclassified in the error feed.
 * ✅ ANSWERED 2026-09-05 by reading Stripe's DOCUMENTED code union rather than waiting for
 * traffic: there is no Stripe equivalent of RazorPay's per-cycle token to map. Stripe does
 * not model "this cycle's AFA-free allowance is spent" as its own code — an off-session
 * debit needing additional-factor authentication surfaces as `authentication_required` or a
 * `*_authentication_failure` code, all of which are now mapped to the authentication family
 * below. The instruction to map a future code onto `mandate_cycle_limit_exceeded` is
 * therefore WITHDRAWN: it would have told the payer to wait out a cycle Stripe never
 * mentions. The gateways differ in what they REPORT, not merely in spelling.
 *
 * ⏰ THE OBSERVATION WINDOW OPENS WITH THE INR CUTOVER. Test mode cannot produce it: an
 * India card mandate stays `pending` there indefinitely, so no Stripe mandate ever went
 * ACTIVE and no refusal path was ever reachable (PROGRESS #51c — the three runs that exist
 * are an international card with no mandate succeeding, an Indian card with no mandate
 * declining `authentication_required` at ₹90, and a RazorPay mandate token returning HTTP
 * 500; none is a mandate refusal). Production gets live Stripe and RazorPay accounts for
 * the cutover, so the first real string should appear within days of it. **Watch the
 * UNCLASSIFIED bucket in the ops error feed** — an unmapped code keeps its raw name, which
 * is precisely how we will learn it.
 *
 * The pre-flight half of AFA is already shared and gateway-agnostic: `mandateRefusal`
 * (invoicing/collection.ts) raises `mandate_ceiling_exceeded` from
 * `payment_methods.mandate_max_amount_minor` BEFORE any gateway is called, and Stripe now
 * populates that column. What was missing was only the classification of a refusal that
 * comes back.
 */
export const STRIPE_CODE_TABLE: Record<string, string> = {
  // ── Bank-debit returns (ACH / SEPA). See the note in TERMINAL. ────────────────
  // Stripe reports these on `charge.failed` for a debit it already accepted, so they
  // arrive DAYS after the charge looked successful and land on the late-failure path.
  account_closed: "bank_account_closed",
  no_account: "bank_account_not_found",
  account_frozen: "bank_account_closed",
  invalid_account_number: "bank_account_invalid_details",
  // The payer told their bank to stop the debit, or never authorised it. A retry is a
  // second unauthorised debit, which on SEPA is what a 13-month dispute is made of.
  debit_not_authorized: "debit_not_authorized",
  payment_method_not_available: "processing_error",
  // Genuinely transient: the money was not there TODAY. Deliberately NOT terminal, so the
  // dunning ladder still gets to try — the account exists and can be funded.
  insufficient_funds: "insufficient_funds",
  // A SEPA/BACS mandate the payer or their bank cancelled. The instrument is dead, but
  // this is the MANDATE's death rather than the account's — `mandate_expired` already
  // carries that meaning and its own re-authorisation flow.
  debit_disputed: "mandate_expired",
  // Stripe's catch-all "the issuer declined and said nothing useful". Our token for that
  // is `card_declined`, which the policy parks — `generic_decline` is not a token it knows,
  // so unmapped it reached the liberal retry default.
  generic_decline: "card_declined",
  do_not_honor: "do_not_honor",
  // Visa Category 1 ("must never resubmit") in Stripe's words: the cardholder stopped or
  // revoked the payment. Unmapped they reached the retry default.
  stop_payment_order: "revocation_of_authorization",
  revocation_of_all_authorizations: "revocation_of_authorization",
  // Stripe's deprecated decline code for the same instruction as advice code 03.
  do_not_try_again: "network_do_not_retry",
  // The card or its account cannot be used (Visa 46 closed account, 62 restricted, MAC 01
  // new account information): only a different or updated card pays.
  invalid_account: "card_restricted",
  restricted_card: "card_restricted",
  new_account_information_available: "card_restricted",
  // "Declined for an unknown reason" per Stripe: the generic refusal, retried then parked.
  not_permitted: "card_declined",
  service_not_allowed: "card_declined",
  security_violation: "card_declined",
  no_action_taken: "card_declined",
  // Transient by Stripe's own description ("try the payment again later"), so it belongs
  // with the other retryable processing faults rather than keeping a name nothing handles.
  try_again_later: "processing_error",
  issuer_not_available: "processing_error",
  // Stripe: "declined for an unknown reason"; the customer asks the issuer. Not our setup.
  transaction_not_allowed: "card_declined",
  // The card cannot pay this kind of purchase or currency (hard: `stripe.code.*` rules).
  card_not_supported: "card_restricted",
  currency_not_supported: "card_restricted",
  // The MERCHANT's configuration refuses the transaction type, not the card — same shape
  // as RazorPay's `recurring_not_enabled`, which the policy parks for a human to fix.
  payment_method_unactivated: "recurring_not_enabled",

  /* ── The rest of Stripe's decline codes (docs.stripe.com/declines/codes, 2026-11-18;
   * docs/references/STRIPE_DECLINE_CODES.md). Hard ones have a rule in STRIPE_RULES. */
  approve_with_id: "card_declined",
  authentication_not_handled: "authentication_required",
  mobile_device_authentication_required: "authentication_required",
  customer_declined: "authentication_required",
  call_issuer: "do_not_honor",
  card_velocity_exceeded: "insufficient_funds",
  withdrawal_count_limit_exceeded: "insufficient_funds",
  card_already_activated: "card_declined",
  code_expired: "card_declined",
  code_invalid: "card_declined",
  compliance_violation: "card_restricted",
  duplicate_transaction: "card_declined",
  incorrect_pin: "card_declined",
  invalid_pin: "card_declined",
  offline_pin_required: "card_declined",
  online_or_offline_pin_required: "card_declined",
  pin_try_exceeded: "card_declined",
  invalid_amount: "card_declined",
  invalid_track_data: "card_declined",
  klarna_payment_declined: "card_declined",
  // Stripe: present it as `generic_decline`.
  merchant_blacklist: "card_declined",
  // "The payment provider doesn't support this action": our integration, not the payer.
  partner_action_not_supported: "gateway_request_rejected",
  partner_generic_decline: "card_declined",
  partner_high_risk_customer: "card_declined",
  payment_disputed: "card_declined",
  payment_limit_exceeded: "card_declined",
  testmode_decline: "card_declined",
  // "Retry attempts might succeed after the customer takes action".
  invalid_customer_account: "card_declined",
  partner_payment_not_found: "processing_error",
  reenter_transaction: "processing_error",
  // Our Stripe account is deactivated.
  invalid_business_account: "gateway_account_unavailable",
  expired_payment_information: "expired_card",
  lost_or_stolen_card: "stolen_card",
  invalid_billing_agreement: "mandate_expired",
  invalid_authorization: "mandate_expired",
  invalid_payment_information: "card_restricted",
  recurring_not_supported_by_bank: "card_restricted",

  /* ── MANDATE FAILURES, from Stripe's DOCUMENTED error-code union ──────────────────
   * Not guesses: every key below is a member of `LastFinalizationError.Code` /
   * `LastPaymentError.Code` in the installed SDK's own types (stripe 22.2.2, OpenAPI
   * v2277). They are top-level `code` values rather than `decline_code`, which is why
   * `stripeDeclineReason` falls back to `code` — these arrive there.
   *
   * All four mean the same thing operationally: the mandate cannot be used and only a
   * NEW authorisation replaces it. That is exactly `mandate_expired`, which the policy
   * already parks with "the mandate lapsed — only a new one recovers it". Mapping them to
   * `card_declined` would have told the payer to try the card again, which cannot work. */
  india_recurring_payment_mandate_canceled: "mandate_expired",
  payment_intent_mandate_invalid: "mandate_expired",
  setup_intent_mandate_invalid: "mandate_expired",
  billing_invalid_mandate: "mandate_expired",

  /* ── AUTHENTICATION, and the answer to a question left open earlier ────────────────
   * These are the codes an India AFA refusal actually arrives as. RazorPay has a DISTINCT
   * per-cycle token (`card_mandate_current_cycle_allowed_debit_exceeds`, observed four
   * times in production) and this file's earlier note said to map Stripe's equivalent onto
   * `mandate_cycle_limit_exceeded` once observed.
   *
   * ⚠️ Reading Stripe's full documented code union shows there is NO such equivalent to
   * wait for: Stripe does not model "this cycle's AFA-free allowance is spent" as its own
   * code. An off-session debit that needs additional-factor authentication surfaces as
   * `authentication_required` (a `decline_code`) or as one of the `*_authentication_failure`
   * codes below. So the honest mapping is to the authentication family — which the policy
   * parks as "3DS/SCA, customer action recovers it", the correct remedy — rather than to a
   * cycle-limit token that would tell the payer to wait for a cycle Stripe never mentions.
   * The two gateways genuinely differ in what they report, not just in spelling. */
  payment_intent_authentication_failure: "authentication_required",
  setup_intent_authentication_failure: "authentication_required",

  /* Transient, by Stripe's own descriptions — the retry these SHOULD get. */
  card_decline_rate_limit_exceeded: "processing_error",
  payment_method_provider_timeout: "processing_error",
  /* The issuer wants the cardholder to call them: nothing we or a retry can do. */
  refer_to_customer: "do_not_honor",

  /* ── API version 2022-11-15 codes ──────────────────────────────────────────────────
   * "The latest payment attempt ... has expired" and "The customer didn't approve the
   * payment": the payer did not complete an approval, so only the payer recovers it.
   * The instrument is not at fault. "Declined by the issuer or customer" gives no
   * reason, so it is the generic refusal: retried, then parked. */
  payment_intent_payment_attempt_expired: "authentication_required",
  payment_method_customer_decline: "authentication_required",
  payment_method_provider_decline: "card_declined",
};

// ── THE RULE ENGINE (#69 stage 1) ────────────────────────────────────────────────
/**
 * WHY A DICTIONARY IS THE WRONG SHAPE, and what replaces it.
 *
 * Until 2026-09-06 normalisation was `Record<string, string>` — exact match, one field,
 * the gateway's error CODE. What error handling actually needs is predicates over SIX
 * fields with THREE operators: a meaningful share of real rules are shapes a dictionary
 * cannot hold at all. No number of new entries expresses any of these:
 *
 *   Error category = invalid_request_error
 *   Error message matches (No such PaymentMethod[^<]+)
 *   Network error message = previously_declined_do_not_retry      ← the CARD NETWORK
 *                                                                   telling us not to
 *                                                                   retry. Sourced from
 *                                                                   `charge.outcome`
 *                                                                   since 2026-09-06 —
 *                                                                   see the note there.
 *
 * That last one is not a nicety: networks fine acquirers for retrying a debit
 * they were told to stop retrying.
 *
 * Rules are evaluated IN ORDER and the first match wins, so specificity is expressed by
 * position — a message regex must sit above the category catch-all that would otherwise
 * swallow it. The legacy tables remain as the FALLBACK, so this change is additive: a
 * signal no rule matches resolves exactly as it did before.
 */
export type DeclineField =
  | "code"
  | "decline_code"
  | "message"
  | "category"
  | "network_message"
  | "recommendation_code";

export type DeclineOp = "eq" | "contains" | "matches";

export interface DeclineRule {
  /**
   * STABLE IDENTITY, and the reason it is hand-written rather than derived (#69 stage 3).
   *
   * A merchant override points at a rule. If the id were a hash of the rule's contents,
   * correcting a typo in a pattern would silently orphan every override attached to it —
   * the override would still exist, match nothing, and a merchant would find their setting
   * had quietly stopped applying with nothing to see. So the id is authored once and is
   * the one field a later edit must never change; everything else about a rule may.
   *
   * Shape: `<gateway>.<what it matches on>.<slug>`, readable because it is what the
   * settings screen and the overrides table both key on.
   */
  id: string;
  field: DeclineField;
  op: DeclineOp;
  value: string;
  /** Our canonical code. */
  code: string;
  /**
   * OUR sentence for this failure, replacing whatever the gateway said.
   *
   * A gateway's own text is written for a developer reading an API response, and it
   * reaches a payer's inbox unedited: `payment_failed`'s `message` becomes
   * `declineMessage` in "We were unable to charge your payment method for {{amount}}
   * ({{declineMessage}})". On 2026-09-04 that delivered
   * "The parameter `mandate` is not provided or invalid" — a Stripe API complaint about
   * OUR request — to an operator, and it would have reached a customer the same way.
   *
   * Written by us: the codes and hardness are gateway behaviour, the prose is ours.
   */
  message?: string;
  /**
   * May the payer be told this? The split is not squeamishness — it is whether the
   * sentence describes something the CUSTOMER can act on.
   * "Your card was declined by the issuer" helps them;
   * "we sent the gateway a malformed request" tells them we are broken and gives them
   * nothing to do, so it belongs in the operator's log and nowhere near an inbox.
   *
   * Defaults to false: a new rule is internal until someone decides otherwise, which is
   * the safe direction for a field that decides what a stranger reads.
   */
  exposedToPayer?: boolean;
  /**
   * Overrides the `TERMINAL` answer for this rule. Set it only where the gateway's own
   * table says HARD and the reason cannot change on a retry — an unknown instrument, a
   * malformed request, a network refusal. Leave it undefined and `TERMINAL` decides, so
   * a rule added for CLASSIFICATION does not silently change retryability too.
   */
  retriable?: boolean;
}

/**
 * Everything a rule may look at. A bare string is `{ code }`, which is what every call
 * site passed before this existed and what most still pass.
 */
export interface DeclineSignal {
  code?: string | null;
  declineCode?: string | null;
  message?: string | null;
  category?: string | null;
  networkMessage?: string | null;
  recommendationCode?: string | null;
  /** Card network, lower-cased as the gateway reports it. Advice codes mean different things per network. */
  cardBrand?: string | null;
}

const FIELD_OF = (s: DeclineSignal, f: DeclineField): string | null | undefined =>
  f === "code"
    ? s.code
    : f === "decline_code"
      ? s.declineCode
      : f === "message"
        ? s.message
        : f === "category"
          ? s.category
          : f === "network_message"
            ? s.networkMessage
            : s.recommendationCode;

/**
 * `matches` is a REGEX, and every pattern here is authored by us — never by a merchant.
 * When stage 3 lets a business write its own rule it must be restricted to `eq` and
 * `contains`, or run under a timeout: a pattern evaluated on every decline is a ReDoS
 * surface pointed at the billing path. Recorded here because the guard belongs where the
 * operator is implemented, not only in the plan.
 */
function ruleMatches(rule: DeclineRule, signal: DeclineSignal): boolean {
  const raw = FIELD_OF(signal, rule.field);
  if (raw == null || raw === "") return false;
  const hay = raw.toLowerCase();
  const needle = rule.value.toLowerCase();
  if (rule.op === "eq") return hay === needle;
  if (rule.op === "contains") return hay.includes(needle);
  try {
    return new RegExp(rule.value, "i").test(raw);
  } catch {
    // A malformed built-in pattern must not take the billing path down with it.
    return false;
  }
}

/**
 * What a rule answers before any merchant override — the ONE definition of it.
 *
 * Exported because the settings screen has to show exactly this. It used to compute its
 * own version (`retriable ?? true`), which disagreed with the line below for four rules:
 * the page said "retries" where the engine did not. A screen that resolves behaviour by
 * a second copy of the rule will drift from the engine eventually; sharing the function
 * is the only version of this that stays true.
 */
export function builtInDeclineAnswer(rule: DeclineRule): {
  retriable: boolean;
  message: string | null;
  exposedToPayer: boolean;
} {
  return {
    retriable: OUR_REQUEST_REFUSED.has(rule.code.toLowerCase())
      ? true
      : (rule.retriable ?? !TERMINAL.has(rule.code.toLowerCase())),
    message: rule.message ?? null,
    exposedToPayer: rule.exposedToPayer ?? false,
  };
}

function evaluate(
  signal: DeclineSignal,
  rules: readonly DeclineRule[],
  table: Record<string, string>,
): NormalizedDecline {
  for (const rule of rules) {
    if (!ruleMatches(rule, signal)) continue;
    const answer = builtInDeclineAnswer(rule);
    return {
      code: rule.code,
      retriable: answer.retriable,
      ...(answer.message ? { message: answer.message } : {}),
      exposedToPayer: answer.exposedToPayer,
      ruleId: rule.id,
    };
  }
  return build(signal.code, table);
}

/**
 * Engine-minted codes whose message is OUR text — an exception, a router refusal, a
 * malformed gateway response — and no rule to say so. Hidden like a rule-marked one.
 */
const OURS_WITHOUT_A_RULE = new Set(["gateway_error", "gateway_account_unavailable"]);

/**
 * IS THIS FAILURE EXPLICITLY OURS TO KEEP QUIET ABOUT?
 *
 * `payment_failed`'s `message` becomes `declineMessage` in the mail a customer receives —
 * "We were unable to charge your payment method for {{amount}} ({{declineMessage}})" — so
 * whatever lands there is read by a stranger.
 *
 * ⚠️ The default is NOT suppression, and the direction matters. Most codes have no rule,
 * and a helper that hid anything unruled would silence "insufficient funds" and "expired
 * card" — the sentences that actually help someone fix their payment. So this answers TRUE
 * only where a rule explicitly says `exposedToPayer: false`: a deliberate "this one is
 * ours". Everything else keeps the behaviour it had.
 *
 * Decided from the rules rather than a second list, so a code's exposure lives beside its
 * copy and the two cannot drift.
 */
export function declineHiddenFromPayer(code: string | null | undefined): boolean {
  if (!code) return false;
  const c = code.toLowerCase();
  if (OURS_WITHOUT_A_RULE.has(c)) return true;
  for (const set of [
    STRIPE_RULES,
    PAYPAL_RULES,
    RAZORPAY_RULES,
    GOCARDLESS_RULES,
    BRAINTREE_RULES,
    CASHFREE_RULES,
    AUTHORIZENET_RULES,
    ADYEN_RULES,
    CHECKOUTCOM_RULES,
    MOLLIE_RULES,
    SQUARE_RULES,
    PAYU_RULES,
    CYBERSOURCE_RULES,
  ])
    for (const r of set)
      if (r.code.toLowerCase() === c && r.message && r.exposedToPayer !== true) return true;
  return false;
}

/** Canonical code for a card the business cannot accept (see `isStripeCardNotAccepted`). */
export const CARD_NOT_ACCEPTED_CODE = "card_restricted";

/**
 * Stripe refused the request because of the card itself: `invalid_request_error` on
 * `param: "card"` with no code (an India-issued American Express for a business in India).
 * A card the business cannot accept, not our own request fault.
 */
export function isStripeCardNotAccepted(e: {
  type?: string | null;
  code?: string | null;
  decline_code?: string | null;
  param?: string | null;
}): boolean {
  return e.type === "invalid_request_error" && e.param === "card" && !e.code && !e.decline_code;
}

/** Our token for "the cardholder must authenticate this payment" (3DS, AFA). */
export const AUTHENTICATION_REQUIRED_CODE = "authentication_required";

/** The payer's sentence when the failure was ours. Gives them nothing to do, because there is nothing. */
export const PAYER_SAFE_INTERNAL_FAILURE =
  "We could not complete the payment because of a problem on our side. Your payment method is fine. We are examining the problem.";

/**
 * A buyer-present refusal the browser reports with no reason (Adyen's session result). A
 * webhook that names the real reason may replace it on the attempt, in either order.
 */
export const GENERIC_CLIENT_REFUSAL = {
  code: "card_declined",
  message: "The card was refused. Use a different card, or contact your bank.",
} as const;

export function isGenericClientRefusal(f: {
  code?: string | null;
  message?: string | null;
}): boolean {
  return (
    f.code === GENERIC_CLIENT_REFUSAL.code && f.message?.trim() === GENERIC_CLIENT_REFUSAL.message
  );
}

/** The payer's sentence when the business chose not to show the reason. Blames nobody. */
export const PAYER_REASON_WITHHELD = "We could not complete the payment.";

/**
 * The gateway refused OUR request (bad keys, a malformed or unsupported request). Retried on
 * the dunning schedule on every gateway and never brands the instrument (user decision
 * 2026-11-17); the ops alert `gateway_request_faults` gets it fixed. This overrides the
 * `retriable: false` many rules still carry.
 */
export const OUR_REQUEST_REFUSED: ReadonlySet<string> = new Set(["gateway_request_rejected"]);

let requestFaultTextSet: Set<string> | null = null;
/** Our sentence on every `gateway_error` rule: what a stored request fault reads as. */
export function requestFaultTexts(): ReadonlySet<string> {
  requestFaultTextSet ??= new Set(
    ALL_DECLINE_RULES.filter((r) => r.code === "gateway_error" && r.message).map((r) => r.message!),
  );
  return requestFaultTextSet;
}

/**
 * Did the gateway refuse OUR request? `gateway_request_rejected`, or a `gateway_error` a rule
 * recognised (by rule id live, by the rule's text once stored). A bare `gateway_error` from an
 * adapter throw is not: its cause is unknown. Dunning never ends one in a final action.
 */
export function isOurRequestFault(f: {
  code?: string | null;
  ruleId?: string | null;
  message?: string | null;
}): boolean {
  const code = f.code?.toLowerCase();
  if (!code) return false;
  if (OUR_REQUEST_REFUSED.has(code)) return true;
  if (code !== "gateway_error") return false;
  if (f.ruleId) return declineRuleById(f.ruleId)?.code === "gateway_error";
  return !!f.message && requestFaultTexts().has(f.message.trim());
}

/** The built-in retriability, before a merchant override: our refused request retries. */
export function withBuiltInRetry<T extends { code?: string | null; retriable?: boolean }>(
  failure: T,
): T {
  return failure.code && OUR_REQUEST_REFUSED.has(failure.code.toLowerCase())
    ? { ...failure, retriable: true }
    : failure;
}

/**
 * Codes the ENGINE mints with a sentence written for the payer, and no gateway emits. A
 * stored message under one of these is always ours.
 */
const ENGINE_PAYER_CODES = new Set([
  "no_payment_method",
  "mandate_pending",
  "mandate_spent",
  "mandate_currency_mismatch",
  "mandate_paused",
  "card_limit_exceeded",
  "payment_method_unusable",
  "invoice_attempt_limit",
  "card_attempt_limit",
]);

const DECLINED_BY_BANK =
  "Your bank declined the payment. Contact your bank, or use a different payment method.";
const AUTHORIZATION_NOT_ACTIVE =
  "The authorization for automatic payments is not active. Set up the payment method again.";
const BANK_ACCOUNT_REFUSED =
  "The bank did not accept a payment from this bank account. Use a different bank account, or contact your bank.";

/**
 * Our generic payer sentence per canonical code, for a decline no rule wrote a payer sentence
 * for. Lost, stolen and fraud codes read as a plain bank decline on purpose.
 */
const PAYER_SENTENCE: Record<string, string> = {
  insufficient_funds:
    "Your bank declined the payment because the account does not have sufficient money. Add money to the account, or use a different payment method.",
  expired_card: "The card expired. Add a new card, or use a different payment method.",
  incorrect_cvc:
    "The security code of the card is not correct. Check the card details, then try again.",
  incorrect_number: "The card number is not correct. Check the card details, then try again.",
  card_declined: DECLINED_BY_BANK,
  do_not_honor: DECLINED_BY_BANK,
  card_restricted: DECLINED_BY_BANK,
  lost_card: DECLINED_BY_BANK,
  stolen_card: DECLINED_BY_BANK,
  pickup_card: DECLINED_BY_BANK,
  fraudulent: DECLINED_BY_BANK,
  authentication_required:
    "Your bank must confirm this payment. Try again, and complete the check from your bank.",
  processing_error: "The payment provider could not process the payment. Try again later.",
  try_again_later: "The payment provider could not process the payment. Try again later.",
  mandate_expired: AUTHORIZATION_NOT_ACTIVE,
  mandate_missing: AUTHORIZATION_NOT_ACTIVE,
  debit_not_authorized: AUTHORIZATION_NOT_ACTIVE,
  revocation_of_authorization: AUTHORIZATION_NOT_ACTIVE,
  bank_account_closed: BANK_ACCOUNT_REFUSED,
  bank_account_not_found: BANK_ACCOUNT_REFUSED,
  bank_account_invalid_details: BANK_ACCOUNT_REFUSED,
  payment_abandoned: "The payment was not completed. Try again, or use a different payment method.",
  debit_cancelled_by_payer:
    "You stopped this payment at your bank. Pay this invoice now, or allow the next automatic payment.",
};

let payerRuleSentences: Set<string> | null = null;
/** Every built-in rule sentence written for the payer. Lazy: the rule sets are declared below. */
function isPayerRuleSentence(message: string): boolean {
  payerRuleSentences ??= new Set(
    ALL_DECLINE_RULES.filter((r) => r.message && r.exposedToPayer === true).map((r) => r.message!),
  );
  return payerRuleSentences.has(message);
}

/**
 * Every sentence this module may give a payer: the per-code sentences, the rules' payer
 * sentences, our own-fault and withheld sentences and the fixed parts of `payerRefusal`.
 * The buyer-error leak check reads it, so a sentence added here is never a leak.
 */
export function payerWordingTexts(): readonly string[] {
  return [
    ...Object.values(PAYER_SENTENCE),
    ...ALL_DECLINE_RULES.filter((r) => r.message && r.exposedToPayer === true).map(
      (r) => r.message!,
    ),
    PAYER_SAFE_INTERNAL_FAILURE,
    PAYER_REASON_WITHHELD,
    "We did not charge you.",
    "Your payment method is fine.",
    "Try again in a few minutes.",
    "Try again, or use a different payment method.",
  ];
}

/**
 * Short operator labels for canonical codes. A code that is not here has no label, never a
 * guess.
 */
const DECLINE_LABEL: Record<string, string> = {
  card_declined: "Card declined",
  insufficient_funds: "Insufficient funds",
  expired_card: "Card expired",
  incorrect_cvc: "Incorrect security code",
  incorrect_number: "Incorrect card number",
  do_not_honor: "The bank refused the payment",
  fraudulent: "Refused as fraud",
  stolen_card: "Card reported stolen",
  lost_card: "Card reported lost",
  pickup_card: "The bank asked to keep the card",
  card_restricted: "The card cannot be used for this payment",
  authentication_required: "The customer must authenticate the payment",
  network_do_not_retry: "The bank asked us not to try again",
  processing_error: "Gateway processing error",
  no_payment_method: "No payment method on file",
  // Every gateway's account-setup refusal lands here, not only recurring: keep it general.
  recurring_not_enabled: "The gateway account is not set up for this type of payment",
  mandate_expired: "The mandate expired",
  gateway_request_rejected: "The gateway refused our request",
  gateway_error: "The gateway had an error",
  charge_failed: "The gateway refused the payment",
  authorization_failed: "The gateway refused the authorization",
  setup_failed: "The gateway refused to save the payment method",
  setup_cancelled: "The payer did not complete the authorization",
  payment_abandoned: "The payer did not complete the payment",
  try_again_later: "The gateway asked us to try again later",
  debit_not_authorized: "The payer did not authorize the debit",
  bank_account_closed: "The bank account is closed",
};

/** The operator label of a canonical code, or null when we have none. */
export function declineLabel(code: string | null | undefined): string | null {
  return code ? (DECLINE_LABEL[code.toLowerCase()] ?? null) : null;
}

/** A bare token (`E308`, `payment_cancelled`): a code, not a sentence. */
const BARE_CODE = /^[\w.:-]+$/;

/**
 * The OPERATOR's text for a failure: the gateway's or our rule's words when they are a
 * sentence, else the code's label with the gateway's own code beside it. Never a bare code.
 */
export function operatorFailureText(f: {
  code?: string | null;
  providerCode?: string | null;
  message?: string | null;
}): string {
  const said = f.message?.trim() || null;
  const theirs = f.providerCode?.trim() || null;
  // Some gateways put their sentence where the code goes.
  for (const t of [said, theirs]) if (t && !BARE_CODE.test(t)) return t;
  const label = declineLabel(f.code);
  const raw = theirs ?? said ?? (label ? null : (f.code ?? null));
  const text = label ?? "The gateway refused the payment";
  return raw && !(label && raw === f.code) ? `${text}. Gateway code: ${raw}.` : `${text}.`;
}

const OPENS_WITH_LEAD = /^We could not /;
const HAS_NEXT_STEP = /\b(try again|contact|do not pay)\b/i;

/**
 * One refusal for a buyer who is present: ONE opening, the reason, "We did not charge
 * you." and ONE next step. A reason that is a whole message itself (our own-fault and
 * withheld sentences, a gateway text that opens "We could not") takes the place of the
 * lead instead of following it.
 */
export function payerRefusal(
  lead: string,
  reason: string,
  nextStep = "Try again, or use a different payment method.",
): string {
  const said = reason.trim();
  const sentence = /[.!?]$/.test(said) ? said : `${said}.`;
  // Our fault: the method is fine, so never send the buyer to another one.
  if (sentence === PAYER_SAFE_INTERNAL_FAILURE)
    return `${lead.replace(/\.$/, "")} because of a problem on our side. Your payment method is fine. We did not charge you. Try again in a few minutes.`;
  if (sentence === PAYER_REASON_WITHHELD) return `${lead} We did not charge you. ${nextStep}`;
  const opening = OPENS_WITH_LEAD.test(sentence) ? sentence : `${lead} ${sentence}`;
  const step = HAS_NEXT_STEP.test(sentence) ? "" : ` ${nextStep}`;
  return `${opening} We did not charge you.${step}`;
}

/**
 * The decline sentence a PAYER may read — the ONE helper every payer surface goes through
 * (the `payment_failed` message, dunning and failed-payment emails, portal and checkout).
 *
 * The payer reads only OUR words (user decision 2026-11-17): never a gateway's text, never a
 * raw code like `E308`. In order:
 *  1. `exposedToPayer` set (a rule matched, or a merchant override): `true` shows `message`,
 *     `false` withholds it.
 *  2. Unset (a stored failure, or no rule): `message` is shown when it is a rule's payer
 *     sentence, or the code is one the engine mints with its own payer sentence.
 *  3. Otherwise our sentence: "a problem on our side" for our codes, our generic sentence
 *     for a known canonical code, else a neutral one.
 */
export function payerDeclineMessage(
  failure: { code?: string | null; message?: string | null; exposedToPayer?: boolean },
  fallback: string,
): string {
  const internal = declineHiddenFromPayer(failure.code);
  const message = failure.message?.trim() || null;
  const ours =
    message != null &&
    (isPayerRuleSentence(message) ||
      (!!failure.code && ENGINE_PAYER_CODES.has(failure.code.toLowerCase())));
  const shown = failure.exposedToPayer ?? ours;
  if (shown) return message ?? fallback;
  if (internal) return PAYER_SAFE_INTERNAL_FAILURE;
  if (failure.exposedToPayer === false) return PAYER_REASON_WITHHELD;
  return (failure.code && PAYER_SENTENCE[failure.code.toLowerCase()]) || PAYER_REASON_WITHHELD;
}

/** `payerDeclineMessage` for a failure that may be absent. */
export function payerFailureText(
  failure:
    | { code?: string | null; message?: string | null; exposedToPayer?: boolean }
    | null
    | undefined,
  fallback: string,
): string {
  return failure ? payerDeclineMessage(failure, fallback) : fallback;
}

/**
 * A rule by its stable id, or undefined if it has been removed.
 *
 * `undefined` is a real answer and callers must handle it: an override can outlive the
 * rule it points at, and the honest response to that is to ignore the override and say so
 * — never to guess a replacement by matching on the rule's contents, which is exactly the
 * coupling the stable id exists to avoid.
 */
export function declineRuleById(id: string): DeclineRule | undefined {
  return ALL_DECLINE_RULES.find((r) => r.id === id);
}

/**
 * A gateway code we RECOGNISE but that no rule names.
 *
 * The legacy tables still carry entries the rule sets do not, and they are not dead: a
 * decline matching one still normalises correctly through the fallback in `evaluate`.
 * What they cannot do is carry a merchant's override, because an override keys on a rule
 * id and there is none — so a screen must show them, and must not offer a control that
 * would 404.
 *
 * Promoting one to a rule is what makes it configurable, which is exactly what happened to
 * RazorPay's twenty.
 */
export interface KnownDeclineCode {
  gateway: DeclineGatewayKey;
  /** The gateway's own spelling. */
  value: string;
  /** Our canonical code. */
  code: string;
}

/** Codes whose instrument cannot pay again: the payer needs a different payment method. */
const NEEDS_NEW_METHOD = new Set([
  "incorrect_number",
  "mandate_expired",
  "mandate_missing",
  "debit_not_authorized",
  "bank_account_closed",
  "bank_account_not_found",
  "bank_account_invalid_details",
]);

/**
 * True when retrying the same payment method cannot succeed (a dead, expired or
 * de-authorized instrument), so the portal leads with "add a payment method", not "Pay".
 */
export function payerNeedsNewMethod(code: string | null | undefined): boolean {
  if (!code) return false;
  const c = code.toLowerCase();
  return TERMINAL.has(c) || NEEDS_NEW_METHOD.has(c);
}

/** Is this canonical code one we never retry? Mirrors what `build()` decides. */
export function isTerminalDeclineCode(code: string): boolean {
  return TERMINAL.has(code.toLowerCase());
}

/**
 * Every code in the tables that no rule already names, so a catalogue can be complete.
 *
 * Case variants collapse: the tables carry `GATEWAY_ERROR` beside `gateway_error` because
 * a lookup tries both spellings, and listing both would show a merchant the same code
 * twice.
 */
export function knownDeclineCodesWithoutRules(): KnownDeclineCode[] {
  const out: KnownDeclineCode[] = [];
  for (const [gateway, { table, rules }] of declineSets()) {
    const named = new Set(
      rules.filter((r) => r.field === "code").map((r) => r.value.toLowerCase()),
    );
    const seen = new Set<string>();
    for (const [value, code] of Object.entries(table)) {
      const key = value.toLowerCase();
      if (named.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ gateway, value, code });
    }
  }
  return out;
}

/** A bare code keeps working; a richer caller passes what the gateway actually said. */
const HOUR_MS = 3_600_000;

/**
 * Mastercard Merchant Advice Codes that name a wait, as processors publish Mastercard's
 * table (TabaPay, payabl: 24 "Retry after 1 hour" … 30 "Retry after 10 days"). Stripe
 * passes MAC through as `network_advice_code`; read only for a Mastercard card, because
 * the same digits mean something else on another network.
 */
export const MASTERCARD_ADVICE_WAIT_MS: Readonly<Record<string, number>> = {
  "24": HOUR_MS,
  "25": 24 * HOUR_MS,
  "26": 48 * HOUR_MS,
  "27": 96 * HOUR_MS,
  "28": 144 * HOUR_MS,
  "29": 192 * HOUR_MS,
  "30": 240 * HOUR_MS,
};

/**
 * RazorPay reasons whose documented next step names a duration
 * (`docs/references/RAZORPAY_EMANDATE_ERROR_CODES.md`). `already_declined` ("Retry after
 * 24 hours") is not here: it normalises to `retry_too_soon`, whose floor already says so.
 */
export const RAZORPAY_REASON_WAIT_MS: Readonly<Record<string, number>> = {
  // "Gateway is blocking duplicate requests" → "Retry after 30 minutes".
  duplicate_request: HOUR_MS / 2,
};

const withWait = (n: NormalizedDecline, ms: number | undefined): NormalizedDecline =>
  ms ? { ...n, retryAfterMs: ms } : n;

const asSignal = (raw: string | DeclineSignal | undefined | null): DeclineSignal =>
  typeof raw === "string" || raw == null ? { code: raw ?? undefined } : raw;

function build(code: string | undefined | null, table: Record<string, string>): NormalizedDecline {
  if (!code) return { code: "charge_failed", retriable: true };
  const mapped = table[code] ?? table[code.toUpperCase()] ?? table[code.toLowerCase()];
  // An unknown raw value never becomes our code: a gateway sentence once landed in
  // `error_code` this way. Only a spelling that already is one of ours passes through;
  // the adapter keeps the raw value as `providerCode`.
  const canonical = mapped ?? (resolveErrorId(code).known ? code : "charge_failed");
  return { code: canonical, retriable: !TERMINAL.has(canonical.toLowerCase()) };
}

/** `{ code: reason }` for whitespace-separated documented codes our calls never raise. */
function neverRaised(reason: string, codes: string, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    codes
      .split(/\s+/)
      .filter(Boolean)
      .map((c) => [`${prefix}${c}`, reason]),
  );
}

const rzpCode = (value: string, code: string, extra: Partial<DeclineRule> = {}): DeclineRule => ({
  id: `razorpay.code.${value}`,
  field: "code",
  op: "eq",
  value,
  code,
  ...extra,
});

/** A payer-actionable Razorpay rule: our sentence, shown to the payer. */
const rzpPayer = (value: string, code: string, message: string, retriable?: boolean) =>
  rzpCode(value, code, {
    message,
    exposedToPayer: true,
    ...(retriable === undefined ? {} : { retriable }),
  });

const IN_PAYER_LIMIT =
  "Your bank refused the payment because it is more than the limit set on your account. Ask your bank to increase the limit, or use a different payment method.";
const IN_DAILY_LIMIT =
  "Your bank refused the payment because the daily limit of your account is reached. We will try again after one day. You can also use a different payment method.";
const IN_EXPIRY_WRONG =
  "The card expiry date is not correct. Check the card details, then try again.";
const IN_BANK_DETAILS =
  "The bank could not confirm the bank account details. Check the details, or use a different bank account.";
const IN_WRONG_CODE_TOO_OFTEN =
  "You entered a wrong code too many times. Wait, then try again, or use a different payment method.";
const IN_CARD_NAME_WRONG =
  "The name on the card is not correct. Check the card details, then try again.";
const IN_MERCHANT_BLOCKED =
  "You blocked payments to this business in your UPI app. Unblock it, then try again, or use a different payment method.";
const IN_OVER_MANDATE =
  "The payment is more than the maximum amount of your automatic payment authorization. Set up the payment method again with a higher maximum amount, or pay this invoice now.";

export const RAZORPAY_RULES: readonly DeclineRule[] = [
  /**
   * An eMandate debit above the mandate's own maximum. Razorpay refuses it at creation as
   * `input_validation_failed` ("Amount exceeds maximum amount allowed"), so the words decide
   * it before the code rule below calls it our request.
   */
  {
    id: "razorpay.message.amount_exceeds_maximum",
    field: "message",
    op: "contains",
    value: "amount exceeds maximum amount allowed",
    code: "mandate_ceiling_exceeded",
    message: IN_OVER_MANDATE,
    exposedToPayer: true,
  },
  /**
   * PROMOTED FROM THE TABLE (#69).
   *
   * Generic three-code RazorPay coverage is not enough: the India book is ours — AFA, the
   * mandate cycle allowance, netbanking, the RazorPay spellings of an ordinary decline.
   *
   * Every entry below already existed in `RAZORPAY_CODE_TABLE` mapping to the same
   * canonical code. Promoting it changes NO behaviour — none sets `retriable`, so
   * `TERMINAL` still decides exactly as `build()` did — and buys two things the table
   * could not: the code appears on the merchant's Error handling screen, and it has a
   * stable id an override can point at. Before this, a business on RazorPay opened that
   * page and found it empty, which for the India book is most of the book.
   *
   * ⚠️ Case variants are NOT duplicated as rules. The table carries both `gateway_error`
   * and `GATEWAY_ERROR` because a lookup tries both spellings; `ruleMatches` already
   * compares case-insensitively, so a second rule would be dead weight with a colliding
   * id. The uniqueness assertion in `decline-rules.test.ts` is what caught that.
   */
  /**
   * NPCI HAS ALREADY SAID NO, AND SAID WHEN TO COME BACK.
   *
   * RazorPay's e-mandate error page (captured 2026-09-10 as
   * `docs/references/RAZORPAY_EMANDATE_ERROR_CODES.md`): `already_declined` — "NPCI blocks
   * retry attempts to avoid duplicate requests", recommended action **"Retry after 24
   * hours"**. Unmapped it took the liberal `retry` default and re-presented on the ordinary
   * schedule, which can be the same night — inside a window the network has already closed,
   * so the attempt is spent on a guaranteed refusal. Repeated fast re-presents are also what
   * card networks read as testing.
   *
   * Its own code rather than `charge_failed`, because the SCHEDULE has to key on something:
   * `planFailureRearm` receives the normalised code and nothing else, and `RETRY_NOT_BEFORE_MS`
   * is what turns this into a 24-hour floor. Retriable — the refusal is about timing, not the
   * instrument — so `isHardDecline` stays false and the card is never branded.
   */
  {
    id: "razorpay.code.already_declined",
    field: "code",
    op: "eq",
    value: "already_declined",
    code: "retry_too_soon",
    retriable: true,
    message:
      "Your bank's network declined this attempt as a duplicate and asks us to wait a day " +
      "before we try again. We will retry automatically. You do not need to do anything.",
  },
  {
    id: "razorpay.code.payment_failed",
    field: "code",
    op: "eq",
    value: "payment_failed",
    code: "card_declined",
  },
  {
    id: "razorpay.code.card_declined",
    field: "code",
    op: "eq",
    value: "card_declined",
    code: "card_declined",
  },
  {
    id: "razorpay.code.payment_declined_by_bank",
    field: "code",
    op: "eq",
    value: "payment_declined_by_bank",
    code: "do_not_honor",
  },
  {
    id: "razorpay.code.gateway_error",
    field: "code",
    op: "eq",
    value: "gateway_error",
    code: "processing_error",
  },
  {
    id: "razorpay.code.server_error",
    field: "code",
    op: "eq",
    value: "server_error",
    code: "processing_error",
  },
  /**
   * RazorPay's envelope code for ANY 400 — OURS, not the customer's.
   *
   * It mapped to `card_declined` until 2026-09-10, which told an operator (and very nearly
   * a payer) that a working card had failed when the request was ours to fix. Six such
   * production rows sat on one customer. `razorpay.ts` had already reached this conclusion
   * for the intent path — "`RAZORPAY_CODE_TABLE` maps `BAD_REQUEST_ERROR` to
   * `card_declined`, which would report our own malformed request as the customer's card
   * failing" — but the table itself was never corrected.
   *
   * ⚠️ SAFE BECAUSE `reason` WINS. `declineFailure` normalises
   * `json.error.reason ?? json.error.code`, so a genuine decline — which always carries a
   * `reason` — is classified by that reason and NEVER reaches this rule. Only the
   * ambiguous, request-level case gets here, which is exactly the case this code names.
   * On the code alone it is undecidable.
   */
  {
    id: "razorpay.code.bad_request_error",
    field: "code",
    op: "eq",
    value: "BAD_REQUEST_ERROR",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  },
  {
    id: "razorpay.code.insufficient_fund",
    field: "code",
    op: "eq",
    value: "insufficient_fund",
    code: "insufficient_funds",
  },
  {
    id: "razorpay.code.insufficient_funds",
    field: "code",
    op: "eq",
    value: "insufficient_funds",
    code: "insufficient_funds",
  },
  {
    id: "razorpay.code.incorrect_cvv",
    field: "code",
    op: "eq",
    value: "incorrect_cvv",
    code: "incorrect_cvc",
  },
  {
    id: "razorpay.code.invalid_card",
    field: "code",
    op: "eq",
    value: "invalid_card",
    code: "incorrect_number",
  },
  {
    id: "razorpay.code.card_disabled_for_online_payments",
    field: "code",
    op: "eq",
    value: "card_disabled_for_online_payments",
    code: "card_declined",
  },
  {
    id: "razorpay.code.card_number_invalid",
    field: "code",
    op: "eq",
    value: "card_number_invalid",
    code: "incorrect_number",
  },
  {
    id: "razorpay.code.authentication_failed",
    field: "code",
    op: "eq",
    value: "authentication_failed",
    code: "authentication_required",
  },
  {
    id: "razorpay.code.expired_card",
    field: "code",
    op: "eq",
    value: "expired_card",
    code: "expired_card",
  },
  {
    id: "razorpay.code.card_lost_or_stolen",
    field: "code",
    op: "eq",
    value: "card_lost_or_stolen",
    code: "stolen_card",
  },
  {
    id: "razorpay.code.fraudulent_transaction",
    field: "code",
    op: "eq",
    value: "fraudulent_transaction",
    code: "fraudulent",
  },
  {
    id: "razorpay.code.recurring_payment_not_enabled",
    field: "code",
    op: "eq",
    value: "recurring_payment_not_enabled",
    code: "recurring_not_enabled",
  },
  {
    id: "razorpay.code.invalid_otp",
    field: "code",
    op: "eq",
    value: "invalid_otp",
    code: "authentication_required",
  },
  {
    id: "razorpay.code.card_mandate_current_cycle_allowed_debit_excee",
    field: "code",
    op: "eq",
    value: "card_mandate_current_cycle_allowed_debit_exceeds",
    code: "mandate_cycle_limit_exceeded",
  },
  {
    id: "razorpay.code.order_failed",
    field: "code",
    op: "eq",
    value: "order_failed",
    code: "gateway_limit_exceeded",
  },
  /**
   * ── RAZORPAY'S PUBLISHED ERROR REASONS (2026-09-10) ─────────────────────────────
   *
   * `declineFailure` normalises `error.reason ?? error.code`, and RazorPay's three
   * committed captures — `docs/references/RAZORPAY_ERROR_CODES.md`, `_CARD_`, `_UPI_` —
   * document 111 REASONS. Twenty-two were named here. The rest fell through `build()` to
   * the passthrough, which stores the raw string as our canonical code and computes
   * `retriable = !TERMINAL.has(raw)` — always true, because no raw RazorPay spelling is
   * in TERMINAL. So every unnamed reason armed a full dunning ladder and put a string
   * nothing downstream understands in front of an operator.
   *
   * The measured case: `card_expired` (theirs) retried while `expired_card` (ours)
   * parked. The same dead card, handled two opposite ways, decided by a spelling.
   *
   * Only reasons whose HANDLING changes are added. A reason that should retry already
   * retries, so mapping it buys a name and not a behaviour — which is why the transient
   * block at the end is the single group here that is about naming, and it earns its
   * place because the passthrough leaves those in the taxonomy's `unknown` bucket.
   *
   * ⚠️ Every `value` below is quoted VERBATIM from one of the three captures.
   * `razorpay-documented-reasons.test.ts` re-reads the files and fails on any that is
   * not: a rule invented from a half-read doc is worse than no rule, because it asserts
   * a remedy. That is not hypothetical — a Stripe rule for a code that does not exist
   * was deleted the same day, claiming the OPPOSITE fix to the real one.
   *
   * ⚠️ None of these carries a `message`, deliberately. `declineHiddenFromPayer` hides a
   * canonical code from the payer as soon as ANY rule for it has an unexposed sentence,
   * so one message on a `card_declined` rule would silence the dunning mail's reason for
   * every card decline on every gateway.
   */
  // THE HEADLINE. RazorPay spells the expiry `card_expired`; ours is `expired_card`,
  // which is TERMINAL and parks. Unmapped, an expired card burned the schedule against a
  // certainty instead of asking the customer for a new one.
  {
    id: "razorpay.code.card_expired",
    field: "code",
    op: "eq",
    value: "card_expired",
    code: "expired_card",
  },
  // ── The instrument was refused; only a DIFFERENT one gets paid ─────────────────
  // None terminates: RazorPay's own next step for each is "retry with a different card
  // or method", which is a park, not a cancellation. The five that describe the CARD
  // (blocked, inactive, not enrolled, wrong type, no international use) are
  // `card_restricted` and park at once; the plain refusals stay `card_declined`, which
  // smart mode retries before parking. `payment_risk_check_failed` is deliberately NOT `fraudulent` — that
  // token TERMINATES the subscription, and "the bank declined it citing fraud" is a
  // suspicion we should not cancel a paying customer over.
  {
    id: "razorpay.code.debit_instrument_blocked",
    field: "code",
    op: "eq",
    value: "debit_instrument_blocked",
    code: "card_restricted",
  },
  {
    id: "razorpay.code.debit_instrument_inactive",
    field: "code",
    op: "eq",
    value: "debit_instrument_inactive",
    code: "card_restricted",
  },
  {
    id: "razorpay.code.card_not_enrolled",
    field: "code",
    op: "eq",
    value: "card_not_enrolled",
    code: "card_restricted",
  },
  {
    id: "razorpay.code.card_type_invalid",
    field: "code",
    op: "eq",
    value: "card_type_invalid",
    code: "card_restricted",
    // A card of this type cannot pay this payment; only another card does.
    retriable: false,
  },
  {
    id: "razorpay.code.international_transaction_not_allowed",
    field: "code",
    op: "eq",
    value: "international_transaction_not_allowed",
    code: "card_restricted",
  },
  // Arrives as the reason itself, in words (ISO 8583 response 57): the issuer does not let
  // this card make this payment, so only a different card pays. Observed in production.
  // Razorpay's payer text for it is generic ("a temporary issue … any debited amount will
  // be refunded"), which tells the payer to wait. Our sentence names the real next step.
  {
    id: "razorpay.code.transaction_not_permitted_to_cardholder",
    field: "code",
    op: "eq",
    value: "Transaction not permitted to issuer/cardholder",
    code: "card_restricted",
    // Visa 57 is category 1: never resubmit.
    retriable: false,
    message:
      "Your bank does not allow this payment on this card. Contact your bank to allow it, or use a different card.",
    exposedToPayer: true,
  },
  {
    id: "razorpay.code.payment_risk_check_failed",
    field: "code",
    op: "eq",
    value: "payment_risk_check_failed",
    code: "card_declined",
  },
  {
    id: "razorpay.code.payment_declined",
    field: "code",
    op: "eq",
    value: "payment_declined",
    code: "card_declined",
  },
  {
    id: "razorpay.code.debit_declined",
    field: "code",
    op: "eq",
    value: "debit_declined",
    code: "card_declined",
  },
  // The details we hold are wrong, not the card. Re-entry fixes it; a retry never does.
  {
    id: "razorpay.code.incorrect_card_details",
    field: "code",
    op: "eq",
    value: "incorrect_card_details",
    code: "incorrect_number",
    // Unlike a number that cannot exist, the details may be any field: kept retriable.
    retriable: true,
  },
  // ── The account behind the debit is not one we can charge ──────────────────────
  // `bank_account_invalid_details` is TERMINAL, so these mark the method invalid and
  // move collection to the backup — the same call the ACH/SEPA returns above make, for
  // the same reason: the account is closed or was never there. `invalid_vpa` is the UPI
  // shape of it — the UPI capture says the payer is "not a valid user on the UPI App",
  // so the identifier on file cannot be debited by anyone at any interval.
  {
    id: "razorpay.code.bank_account_invalid",
    field: "code",
    op: "eq",
    value: "bank_account_invalid",
    code: "bank_account_invalid_details",
  },
  {
    id: "razorpay.code.invalid_vpa",
    field: "code",
    op: "eq",
    value: "invalid_vpa",
    code: "bank_account_invalid_details",
  },
  // ── The payer failed the authentication step ───────────────────────────────────
  // The token `authentication_failed` and `invalid_otp` already use.
  // `otp_attempts_exceeded` and `pin_attempts_exceeded` are deliberately left out:
  // RazorPay's next step for both is "wait and retry after some time", which is the
  // retry default already doing the right thing.
  {
    id: "razorpay.code.incorrect_otp",
    field: "code",
    op: "eq",
    value: "incorrect_otp",
    code: "authentication_required",
  },
  {
    id: "razorpay.code.otp_expired",
    field: "code",
    op: "eq",
    value: "otp_expired",
    code: "authentication_required",
  },
  {
    id: "razorpay.code.incorrect_pin",
    field: "code",
    op: "eq",
    value: "incorrect_pin",
    code: "authentication_required",
  },
  {
    id: "razorpay.code.incorrect_atm_pin",
    field: "code",
    op: "eq",
    value: "incorrect_atm_pin",
    code: "authentication_required",
  },
  // ── The debit was never refused — the payer never answered ─────────────────────
  // Parks in FIXED mode too (`PARK_EVEN_IN_FIXED_MODE`), because the instrument was
  // never asked to pay: a collect request that ran out its ten minutes and a mandate the
  // payer did not acknowledge are unanswered requests, not declines. Same category as
  // `afa_not_completed`'s stale-pending sweep, so it uses the same token.
  {
    id: "razorpay.code.payment_collect_request_expired",
    field: "code",
    op: "eq",
    value: "payment_collect_request_expired",
    code: "afa_not_completed",
  },
  {
    id: "razorpay.code.reqauth_mandate_not_acknowledged",
    field: "code",
    op: "eq",
    value: "reqauth_mandate_not_acknowledged",
    code: "afa_not_completed",
  },
  // ── THE MANDATE BEHIND THE DEBIT ───────────────────────────────
  // From RazorPay's e-mandate SUBSEQUENT-payment table. The two entries there read
  // alike and are not the same failure, so they are split: their documented next steps
  // are opposites, and a park whose remedy is wrong is a park nobody can action.
  //
  // "The registered mandate is no longer active." → "The customer must re-register for
  // the mandate." That is `mandate_expired`, and this is RazorPay's twin of Stripe's
  // `payment_intent_mandate_invalid`, which STRIPE_CODE_TABLE already maps there.
  // Unmapped it kept its raw name, `classifyDecline` fell to its liberal `retry`, and
  // the ladder re-presented a debit against an authorisation that is gone.
  //
  // `retriable` left undefined (→ true, the token is not in TERMINAL) so the answer
  // matches Stripe's for the same fact. The retrying stops at the PARK, not here.
  {
    id: "razorpay.code.mandate_not_active",
    field: "code",
    op: "eq",
    value: "mandate_not_active",
    code: "mandate_expired",
    // Non-retriable for the same reason as the Stripe pair above: re-registration is the
    // only thing that recovers it, and `NOT_THE_INSTRUMENTS_FAULT` keeps the card clean.
    retriable: false,
  },
  // ⚠️ NOT `mandate_expired`, despite the spelling. "The registered mandate is not yet
  // activated at the bank" — pending, not dead — and RazorPay's next step is "please
  // retry after some time", the same sentence they give `bank_technical_error` and
  // `gateway_technical_error` above. e-NACH activation lands days after registration, so
  // waiting IS the fix; parking it would tell a customer to re-register an authorisation
  // that is about to start working.
  {
    id: "razorpay.code.payment_mandate_not_active",
    field: "code",
    op: "eq",
    value: "payment_mandate_not_active",
    code: "processing_error",
  },
  // ── OURS TO FIX: the request, or the merchant account. Never the card ──────────
  // Two shapes with one remedy. A request RazorPay will refuse identically every time
  // (malformed, or inconsistent with the order we created), and a rail that is not
  // enabled on our RazorPay account — where their own next step is literally "reach out
  // to Razorpay". No retry interval reaches either, and the payer can do nothing about
  // either, so the whole group takes `gateway_request_rejected`: it parks in both
  // dunning modes and sits in `MERCHANT_SIDE_PARK`, which pages an operator before the
  // park deadline can cancel a subscription over our own configuration.
  //
  // ⚠️ `retriable` is left undefined (→ true) on purpose, unlike the `BAD_REQUEST_ERROR`
  // rule above. `isHardDecline` reads `retriable: false` as a BAD INSTRUMENT, and
  // branding a working card `invalid` because our account is not set up would punish the
  // customer for our mistake — the reasoning `recurring_not_enabled` already records.
  {
    id: "razorpay.code.merchant_not_activated",
    field: "code",
    op: "eq",
    value: "merchant_not_activated",
    code: "gateway_request_rejected",
  },
  {
    id: "razorpay.code.live_mode_not_enabled",
    field: "code",
    op: "eq",
    value: "live_mode_not_enabled",
    code: "gateway_request_rejected",
  },
  {
    id: "razorpay.code.payment_method_not_enabled",
    field: "code",
    op: "eq",
    value: "payment_method_not_enabled",
    code: "gateway_request_rejected",
  },
  {
    id: "razorpay.code.bank_not_enabled",
    field: "code",
    op: "eq",
    value: "bank_not_enabled",
    code: "gateway_request_rejected",
  },
  {
    id: "razorpay.code.card_network_not_enabled",
    field: "code",
    op: "eq",
    value: "card_network_not_enabled",
    code: "gateway_request_rejected",
  },
  {
    id: "razorpay.code.upi_collect_not_enabled",
    field: "code",
    op: "eq",
    value: "upi_collect_not_enabled",
    code: "gateway_request_rejected",
  },
  {
    id: "razorpay.code.upi_intent_not_enabled",
    field: "code",
    op: "eq",
    value: "upi_intent_not_enabled",
    code: "gateway_request_rejected",
  },
  {
    id: "razorpay.code.input_validation_failed",
    field: "code",
    op: "eq",
    value: "input_validation_failed",
    code: "gateway_request_rejected",
  },
  {
    id: "razorpay.code.invalid_request",
    field: "code",
    op: "eq",
    value: "invalid_request",
    code: "gateway_request_rejected",
  },
  {
    id: "razorpay.code.invalid_amount",
    field: "code",
    op: "eq",
    value: "invalid_amount",
    code: "gateway_request_rejected",
  },
  {
    id: "razorpay.code.invalid_currency",
    field: "code",
    op: "eq",
    value: "invalid_currency",
    code: "gateway_request_rejected",
  },
  {
    id: "razorpay.code.invalid_order_id",
    field: "code",
    op: "eq",
    value: "invalid_order_id",
    code: "gateway_request_rejected",
  },
  {
    id: "razorpay.code.order_amount_mismatch",
    field: "code",
    op: "eq",
    value: "order_amount_mismatch",
    code: "gateway_request_rejected",
  },
  {
    id: "razorpay.code.order_payment_method_mismatch",
    field: "code",
    op: "eq",
    value: "order_payment_method_mismatch",
    code: "gateway_request_rejected",
  },
  {
    id: "razorpay.code.payment_amount_tampered",
    field: "code",
    op: "eq",
    value: "payment_amount_tampered",
    code: "gateway_request_rejected",
  },
  {
    id: "razorpay.code.amount_less_than_minimum_amount",
    field: "code",
    op: "eq",
    value: "amount_less_than_minimum_amount",
    code: "gateway_request_rejected",
  },
  // ── Transient, and named only so it can be COUNTED ─────────────────────────────
  // These already retried and retrying is right — every one is a downtime, a cutoff
  // window or a timeout by RazorPay's own description, so the dunning behaviour is
  // unchanged. They are mapped because the passthrough left them resolving to
  // `gateway.general.unknown`, which made "what did bank downtime cost us last month"
  // unanswerable, and because a code with no rule cannot carry a merchant override or
  // appear on the Error handling screen.
  {
    id: "razorpay.code.gateway_technical_error",
    field: "code",
    op: "eq",
    value: "gateway_technical_error",
    code: "processing_error",
  },
  {
    id: "razorpay.code.bank_technical_error",
    field: "code",
    op: "eq",
    value: "bank_technical_error",
    code: "processing_error",
  },
  {
    id: "razorpay.code.issuer_technical_error",
    field: "code",
    op: "eq",
    value: "issuer_technical_error",
    code: "processing_error",
  },
  {
    id: "razorpay.code.upi_app_technical_error",
    field: "code",
    op: "eq",
    value: "upi_app_technical_error",
    code: "processing_error",
  },
  {
    id: "razorpay.code.bank_not_available",
    field: "code",
    op: "eq",
    value: "bank_not_available",
    code: "processing_error",
  },
  {
    id: "razorpay.code.bank_cutoff_in_progress",
    field: "code",
    op: "eq",
    value: "bank_cutoff_in_progress",
    code: "processing_error",
  },
  {
    id: "razorpay.code.payment_declined_due_to_high_traffic",
    field: "code",
    op: "eq",
    value: "payment_declined_due_to_high_traffic",
    code: "processing_error",
  },
  {
    id: "razorpay.code.request_timed_out",
    field: "code",
    op: "eq",
    value: "request_timed_out",
    code: "processing_error",
  },
  {
    id: "razorpay.code.invalid_response_from_gateway",
    field: "code",
    op: "eq",
    value: "invalid_response_from_gateway",
    code: "processing_error",
  },
  {
    id: "razorpay.code.psp_not_available",
    field: "code",
    op: "eq",
    value: "psp_not_available",
    code: "processing_error",
  },
  {
    id: "razorpay.code.psp_app_not_available",
    field: "code",
    op: "eq",
    value: "psp_app_not_available",
    code: "processing_error",
  },
  {
    id: "razorpay.code.vpa_resolution_failed",
    field: "code",
    op: "eq",
    value: "vpa_resolution_failed",
    code: "processing_error",
  },

  // ── THE REST OF RAZORPAY'S DOCUMENTED REASONS (2026-11-17) ────────────────────
  // Every reason in the captures now has a rule or a never-raised entry
  // (`RAZORPAY_CODES_OUR_CALLS_NEVER_RAISE`); razorpay-error-code-coverage.test.ts holds it.

  // eMandate subsequent payments: "IFSC code no longer valid" → "Re-register for mandate".
  rzpCode("incorrect_ifsc", "bank_account_invalid_details"),
  // "Retry or contact Razorpay": the details may be fine, so the method is not branded.
  rzpPayer("bank_account_validation_failed", "bank_account_invalid_details", IN_BANK_DETAILS, true),

  // The payer's own bank or card limit (user decision 2026-11-17): retried, never branded.
  rzpPayer("transaction_limit_exceeded", "insufficient_funds", IN_PAYER_LIMIT),
  rzpCode("funds_blocked_by_mandate", "insufficient_funds"),
  // NPCI's and the card's per-day limits: the next day can pay, a same-day retry cannot.
  ...[
    "transaction_daily_limit_exceeded",
    "transaction_frequency_limit_exceeded",
    "transaction_daily_count_exceeded",
  ].map((v) => rzpPayer(v, "retry_too_soon", IN_DAILY_LIMIT)),

  // The payer typed it wrong. Same answers as Stripe's `invalid_expiry_*`.
  rzpPayer("incorrect_card_expiry_date", "expired_card", IN_EXPIRY_WRONG),
  // A wrong name is not a wrong number: soft, payer re-enters it.
  rzpPayer("incorrect_cardholder_name", "card_declined", IN_CARD_NAME_WRONG),
  // "Wait and retry after some time": a later try works, so these do not park.
  ...["otp_attempts_exceeded", "pin_attempts_exceeded"].map((v) =>
    rzpPayer(v, "try_again_later", IN_WRONG_CODE_TOO_OFTEN),
  ),
  rzpPayer(
    "pin_not_set",
    "card_restricted",
    "This card has no PIN. Set a PIN with your bank, then try again, or use a different card.",
  ),

  // The payer cancelled at the bank or app step. A debit on a mandate rail is booked
  // `debit_cancelled_by_payer` by the adapter (`razorpayPayerStoppedDebit`).
  rzpCode("payment_cancelled", "afa_not_completed"),
  // Checkout or mandate setup left unfinished: no instrument was asked to pay.
  ...["payment_session_expired", "mandate_creation_expired", "mandate_creation_timeout"].map((v) =>
    rzpCode(v, "payment_abandoned"),
  ),
  ...["mandate_creation_declined", "authorisation_declined_by_psp"].map((v) =>
    rzpCode(v, "card_declined"),
  ),
  rzpCode("compliance_violation", "do_not_honor"),

  // The payer's app, account or bank cannot carry this payment: only another one pays.
  rzpPayer(
    "upi_autopay_not_supported_on_psp",
    "card_restricted",
    "Your UPI app does not support automatic payments. Use a different UPI app or payment method.",
  ),
  rzpPayer(
    "psp_app_not_supported",
    "card_restricted",
    "We cannot accept payments from this UPI app. Use a different UPI app or payment method.",
  ),
  ...["psp_not_registered", "transaction_on_vpa_restricted"].map((v) =>
    rzpCode(v, "card_restricted"),
  ),
  rzpPayer(
    "user_not_registered_for_netbanking",
    "card_restricted",
    "Net banking is not active on this bank account. Activate it with your bank, or use a different payment method.",
  ),
  rzpPayer(
    "joint_account_not_allowed",
    "card_restricted",
    "Automatic payments need a bank account in one name only. Use a different bank account.",
  ),

  // Timeouts, unknown outcomes and Razorpay's own processing: the next attempt can pay.
  // `duplicate_request` keeps its 30-minute wait (`RAZORPAY_REASON_WAIT_MS`).
  ...[
    "payment_timed_out",
    "duplicate_request",
    "mandate_creation_failed",
    "verification_failed",
    "credit_failed",
    "duplicate_rrn_found",
    "deemed_transaction",
    "payment_pending",
    "payment_pending_approval",
    "collect_request_pending",
  ].map((v) => rzpCode(v, "processing_error")),
  rzpCode("capture_failed", "capture_failed"),

  // Ours to fix: the contact data or request we sent, our merchant category, or a
  // collect on our side. `order_already_paid` reaches ops: the order must be read back.
  ...[
    "collect_on_mcc_blocked",
    "mcc_amount_limit_exceeded",
    "mismatch_in_transaction_details",
    "record_not_found",
    "invalid_email",
    "invalid_mobile_number",
    "mobile_number_invalid",
    "invalid_user_details",
    "invalid_device",
    "beneficiary_account_does_not_exist",
    "beneficiary_account_dormant",
    "order_already_paid",
  ].map((v) => rzpCode(v, "gateway_request_rejected")),
];

/**
 * Documented Razorpay reasons that no call of ours can return, with the reason. They get no
 * rule: a rule for a reason that cannot arrive is dead config.
 */
const RZP_NO_CREDIT =
  "cardless EMI and pay-later credit; our orders name one method and never offer credit";
const RZP_REFUND = "refund API: `refund()` reports it as a refusal, never as a payment decline";
export const RAZORPAY_CODES_OUR_CALLS_NEVER_RAISE: Readonly<Record<string, string>> = {
  emi_greater_than_max_amount: "card EMI; our orders never offer EMI",
  emi_plan_unavailable: "card EMI; our orders never offer EMI",
  user_not_eligible: RZP_NO_CREDIT,
  credit_limit_exceeded: RZP_NO_CREDIT,
  credit_limit_expired: RZP_NO_CREDIT,
  credit_limit_inactive: RZP_NO_CREDIT,
  credit_limit_not_approved: RZP_NO_CREDIT,
  credit_not_permitted: RZP_NO_CREDIT,
  duplicate_refund_id: RZP_REFUND,
  refund_limit_crossed: RZP_REFUND,
};

export function normalizeRazorpayDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  const sig = asSignal(raw);
  return withWait(
    evaluate(sig, RAZORPAY_RULES, RAZORPAY_CODE_TABLE),
    RAZORPAY_REASON_WAIT_MS[(sig.code ?? "").trim().toLowerCase()],
  );
}

/** `[reason, codes]` groups → `{ code: reason }`, so a long never-raised list stays readable. */
const neverRaisedBy = (
  groups: ReadonlyArray<readonly [string, readonly string[]]>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(groups.flatMap(([reason, codes]) => codes.map((c) => [c, reason])));

const PAYPAL_OUR_REQUEST =
  "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.";

/** PayPal issues that name a fault in our own request (PAYPAL_ERROR_CODES.md). */
const PAYPAL_OUR_REQUEST_ISSUES = [
  "ACTION_DOES_NOT_MATCH_INTENT",
  "AMOUNT_CANNOT_BE_SPECIFIED",
  "AUTHORIZATION_AMOUNT_EXCEEDED",
  "BILLING_AGREEMENT_ID_MISMATCH",
  "CANCEL_URL_REQUIRED",
  "CANNOT_BE_NEGATIVE",
  "CANNOT_BE_ZERO_OR_NEGATIVE",
  "CURRENCY_MISMATCH",
  "DECIMALS_NOT_SUPPORTED",
  "DECIMAL_PRECISION",
  "EXACTLY_ONE_FIELD_REQUIRED",
  "INCOMPATIBLE_PARAMETER_VALUE",
  "INVALID_ARRAY_LENGTH",
  "INVALID_ARRAY_MAX_ITEMS",
  "INVALID_ARRAY_MIN_ITEMS",
  "INVALID_COUNTRY_CODE",
  "INVALID_CURRENCY_CODE",
  "INVALID_INTEGER_MIN_VALUE",
  "INVALID_PARAMETER_SYNTAX",
  "INVALID_PARAMETER_VALUE",
  "INVALID_RESOURCE_ID",
  "INVALID_STRING_MAX_LENGTH",
  "MALFORMED_REQUEST",
  "MALFORMED_REQUEST_JSON",
  "MAX_CAPTURE_AMOUNT_EXCEEDED",
  "MAX_VALUE_EXCEEDED",
  "MERCHANT_INITIATED_WITH_AUTHENTICATION_RESULTS",
  "MERCHANT_INITIATED_WITH_MULTIPLE_PURCHASE_UNITS",
  "MERCHANT_INITIATED_WITH_SECURITY_CODE",
  "MISMATCHED_VAULT_ID_TO_PAYMENT_SOURCE",
  "MISMATCHED_VAULT_OWNER_ID",
  "MISSING_REQUIRED_PARAMETER",
  "MSP_MISSING_REQUIRED_PARAMETER",
  "MULTI_CURRENCY_CODE",
  "MULTI_CURRENCY_ORDER",
  "NOT_SUPPORTED",
  "ONE_OF_PARAMETERS_REQUIRED",
  "OPERATION_NOT_SUPPORTED",
  "PAYPAL_REQUEST_ID_PREVIOUSLY_USED",
  "PAYPAL_REQUEST_ID_REQUIRED",
  "REQUIRED_PARAMETER_FOR_CUSTOMER_INITIATED_PAYMENT",
  "RESOURCE_NOT_FOUND",
  "RETURN_URL_REQUIRED",
  "UNSUPPORTED_INTENT",
  "UNSUPPORTED_PAYMENT_INSTRUCTION",
  "VAULT_INSTRUCTION_REQUIRED",
] as const;

/** PayPal issues that say a step is already done or still running: read back, never a decline. */
export const PAYPAL_ALREADY_DONE_ISSUES = [
  "AUTHORIZATION_ALREADY_CAPTURED",
  "MAX_CAPTURE_COUNT_EXCEEDED",
  "ORDER_ALREADY_AUTHORIZED",
  "ORDER_ALREADY_CAPTURED",
  "ORDER_COMPLETION_IN_PROGRESS",
  "SETUP_TOKEN_ALREADY_TOKENIZED",
] as const;

export const PAYPAL_RULES: readonly DeclineRule[] = [
  // The billing agreement IS the vaulted PayPal instrument: once cancelled, the stored
  // method can never be charged again. So it is the instrument that is gone, not a
  // lapsed mandate on a healthy one — `payment_method_not_found` marks it invalid, which
  // asks the customer for a new method and parks dunning until they add one.
  {
    id: "paypal.code.agreement_already_cancelled",
    field: "code",
    op: "eq",
    value: "AGREEMENT_ALREADY_CANCELLED",
    code: "payment_method_not_found",
    retriable: false,
    message:
      "The PayPal billing agreement for this payment method is cancelled. Add a new payment method to continue your subscription.",
    exposedToPayer: true,
  },
  // The stored PayPal instrument is gone or unusable: no retry can charge it. Marks the
  // method invalid and parks dunning until the customer adds a new one. Issue names from
  // PayPal's Orders errors reference (read 2026-10-26).
  ...(
    [
      ["BILLING_AGREEMENT_NOT_FOUND", "This PayPal payment method is no longer available."],
      ["TOKEN_ID_NOT_FOUND", "This PayPal payment method is no longer available."],
      ["INVALID_VAULT_ID", "This PayPal payment method is no longer available."],
      ["TOKEN_EXPIRED", "This PayPal payment method is no longer available."],
      ["TOKEN_NOT_FOUND", "This PayPal payment method is no longer available."],
      [
        "PAYER_ACCOUNT_LOCKED_OR_CLOSED",
        "The PayPal account for this payment method is locked or closed.",
      ],
      ["PAYER_ACCOUNT_RESTRICTED", "The PayPal account for this payment method is restricted."],
    ] as const
  ).map(([value, reason]): DeclineRule => ({
    id: `paypal.code.${value.toLowerCase()}`,
    field: "code",
    op: "eq",
    value,
    code: "payment_method_not_found",
    retriable: false,
    message: `${reason} Add a new payment method to continue your subscription.`,
    exposedToPayer: true,
  })),
  // MERCHANT-side: our PayPal account cannot take this payment. The customer's method is
  // fine (retriable stays true, so it is not marked invalid), dunning parks, and
  // `MERCHANT_SIDE_PARK` raises the ops alert.
  ...(
    [
      ["PAYEE_ACCOUNT_RESTRICTED", "gateway_account_unavailable", "is restricted"],
      ["PAYEE_ACCOUNT_LOCKED_OR_CLOSED", "gateway_account_unavailable", "is locked or closed"],
      ["PAYEE_ACCOUNT_INVALID", "gateway_account_unavailable", "is not valid"],
      ["PERMISSION_DENIED", "recurring_not_enabled", "has no permission for this payment"],
      ["PAYEE_NOT_CONSENTED", "recurring_not_enabled", "has no consent for this payment"],
      ["CONSENT_NEEDED", "recurring_not_enabled", "has no consent for this payment"],
      [
        "NOT_ENABLED_FOR_PAYMENT_SOURCE",
        "recurring_not_enabled",
        "is not enabled for this payment source",
      ],
      [
        "NOT_ELIGIBLE_FOR_TOKEN_PROCESSING",
        "recurring_not_enabled",
        "is not enabled for saved PayPal agreements (reference transactions)",
      ],
      ["AUTH_CAPTURE_NOT_ENABLED", "recurring_not_enabled", "cannot authorize and capture later"],
      ["DOMESTIC_TRANSACTION_REQUIRED", "recurring_not_enabled", "accepts only domestic payments"],
      [
        "NOT_ENABLED_FOR_CARD_PROCESSING",
        "recurring_not_enabled",
        "is not enabled for card payments",
      ],
      [
        "PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING",
        "recurring_not_enabled",
        "is not enabled for card payments",
      ],
      [
        "NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE",
        "recurring_not_enabled",
        "is not enabled to save this payment method",
      ],
      [
        "PAYMENT_TYPE_NOT_SUPPORTED_FOR_INTENT",
        "recurring_not_enabled",
        "does not support this payment type",
      ],
      [
        "UNSUPPORTED_INTENT_FOR_PAYMENT_SOURCE",
        "recurring_not_enabled",
        "does not support this payment type",
      ],
    ] as const
  ).map(([value, code, why]): DeclineRule => ({
    id: `paypal.code.${value.toLowerCase()}`,
    field: "code",
    op: "eq",
    value,
    code,
    message: `PayPal refused the payment because the merchant PayPal account ${why}. Nothing is wrong with the customer's payment method.`,
    exposedToPayer: false,
  })),
  // The merchant PayPal account is over its receiving limit. No sentence: a hidden one would
  // hide `gateway_limit_exceeded` on every gateway (`declineHiddenFromPayer`).
  {
    id: "paypal.code.transaction_receiving_limit_exceeded",
    field: "code",
    op: "eq",
    value: "TRANSACTION_RECEIVING_LIMIT_EXCEEDED",
    code: "gateway_limit_exceeded",
  },
  // The merchant's own PayPal fraud settings blocked it: ours to review, not the payer's.
  ...(["PAYEE_BLOCKED_TRANSACTION", "TRANSACTION_BLOCKED_BY_PAYEE"] as const).map(
    (value): DeclineRule => ({
      id: `paypal.code.${value.toLowerCase()}`,
      field: "code",
      op: "eq",
      value,
      code: "gateway_request_rejected",
      retriable: false,
      message:
        "The fraud settings on the merchant PayPal account blocked this payment. Nothing is wrong with the customer's payment method.",
      exposedToPayer: false,
    }),
  ),
  // The payer's own limit, not ours — see the note on the Stripe source-limit rules.
  {
    id: "paypal.code.transaction_limit_exceeded",
    field: "code",
    op: "eq",
    value: "TRANSACTION_LIMIT_EXCEEDED",
    code: "card_declined",
  },
  // We sent PayPal a field it would not accept.
  {
    id: "paypal.code.invalid_string_length",
    field: "code",
    op: "eq",
    value: "INVALID_STRING_LENGTH",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  },
  // ── Issues PayPal returns on a refused order, authorization or capture ──
  ...(
    [
      ["PAYMENT_DENIED", "card_declined"],
      ["PAYMENT_SOURCE_DECLINED_BY_PROCESSOR", "card_declined"],
      ["PAYER_NOT_SUPPORTED_BY_PAYMENT_SOURCE", "card_declined"],
      ["REDIRECT_PAYER_FOR_ALTERNATE_FUNDING", "card_declined"],
      ["AUTHORIZATION_DENIED", "card_declined"],
      ["REAUTHORIZATION_DECLINED_BY_PROCESSOR", "card_declined"],
      ["CARD_DATA_NOT_FOUND", "card_declined"],
      // The buyer did not approve the vault setup before it was consumed.
      ["SETUP_TOKEN_NOT_TOKENIZED", "setup_cancelled"],
      ["REFERENCED_CARD_EXPIRED", "expired_card"],
      ["CONTINGENCY_NOT_SUCCESSFUL", "authentication_required"],
      ["MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED", "retry_too_soon"],
      // The buyer did not approve the order, or left it until it expired.
      ["ORDER_NOT_APPROVED", "payment_abandoned"],
      ["ORDER_EXPIRED", "payment_abandoned"],
      // A hold that ran out or was released before capture. The card is not at fault.
      ["AUTHORIZATION_EXPIRED", "intent_expired"],
      ["AUTHORIZATION_VOIDED", "intent_expired"],
      ["ORDER_COMPLETED_OR_VOIDED", "intent_expired"],
    ] as const
  ).map(([value, code]): DeclineRule => ({
    id: `paypal.code.${value.toLowerCase()}`,
    field: "code",
    op: "eq",
    value,
    code,
  })),
  // This card cannot pay this merchant: only a different card can.
  ...(
    [
      "CARD_BRAND_NOT_SUPPORTED",
      "CARD_TYPE_NOT_SUPPORTED",
      "CARD_COUNTRY_NOT_SUPPORTED",
      "CARD_ISSUER_COUNTRY_NOT_SUPPORTED",
      "CARD_BILLING_ADDRESS_COUNTRY_NOT_SUPPORTED",
      "CURRENCY_NOT_SUPPORTED_FOR_CARD_BRAND",
      "CURRENCY_NOT_SUPPORTED_FOR_CARD_TYPE",
      "CURRENCY_NOT_SUPPORTED_FOR_COUNTRY",
      "PAYMENT_SOURCE_CANNOT_BE_USED",
      "COMPLIANCE_VIOLATION",
    ] as const
  ).map((value): DeclineRule => ({
    id: `paypal.code.${value.toLowerCase()}`,
    field: "code",
    op: "eq",
    value,
    code: "card_restricted",
    retriable: false,
  })),
  // Our PayPal credentials (keys, permissions) or account state: retried, and alerts us.
  ...(
    [
      ["AUTHENTICATION_FAILURE", "gateway_request_rejected"],
      ["NOT_AUTHORIZED", "gateway_request_rejected"],
      ["PERMISSION_NOT_GRANTED", "gateway_request_rejected"],
      ["INVALID_ACCOUNT_STATUS", "gateway_account_unavailable"],
    ] as const
  ).map(([value, code]): DeclineRule => ({
    id: `paypal.code.${value.toLowerCase()}`,
    field: "code",
    op: "eq",
    value,
    code,
    message:
      "PayPal refused the request because of a problem with the merchant PayPal account or its credentials. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  })),
  // Our request was wrong: a field, an id or a combination PayPal does not accept.
  // RESOURCE_NOT_FOUND and INVALID_RESOURCE_ID name an order or capture id of ours, not the
  // payer's method, so they never brand it (a vault token that is gone is TOKEN_NOT_FOUND).
  ...PAYPAL_OUR_REQUEST_ISSUES.map((value): DeclineRule => ({
    id: `paypal.code.${value.toLowerCase()}`,
    field: "code",
    op: "eq",
    value,
    code: "gateway_request_rejected",
    message: PAYPAL_OUR_REQUEST,
    exposedToPayer: false,
  })),
  // A repeat of a step PayPal already did (a raced consume, a setup token already
  // exchanged). Nothing is wrong with the method; the adapter reads the result back.
  ...PAYPAL_ALREADY_DONE_ISSUES.map((value): DeclineRule => ({
    id: `paypal.code.${value.toLowerCase()}`,
    field: "code",
    op: "eq",
    value,
    code: "processing_error",
    retriable: true,
  })),
  // ── `processor_response.payment_advice_code`: the network says stop ──
  // 03 and 21 mean "stop recurring payments" on Visa and Mastercard alike. Before the
  // processor codes: this instruction outranks the issuer's reason.
  ...(["03", "21"] as const).map((value): DeclineRule => ({
    id: `paypal.advice.${value}`,
    field: "recommendation_code",
    op: "eq",
    value,
    code: "network_do_not_retry",
    retriable: false,
    message:
      "Your bank asked us not to attempt this payment again. Use a different payment method, or contact your bank.",
    exposedToPayer: true,
  })),
  // Mastercard advice 01, "new account information available": the card on file is
  // replaced or closed, so only the updated card pays (as Stripe's
  // `new_account_information_available`).
  {
    id: "paypal.advice.01",
    field: "recommendation_code",
    op: "eq",
    value: "01",
    code: "card_restricted",
    retriable: false,
  },
  // ── A refused CARD: `processor_response.response_code`, read as `decline_code` ──
  // PayPal's processor codes (docs/references/PAYPAL_ERROR_CODES.md). Retriable unless the
  // code says the card can never pay.
  ...(
    [
      ["5120", "insufficient_funds"],
      ["5400", "expired_card"],
      ["1380", "expired_card"],
      ["PPEX", "expired_card"],
      ["PPEF", "expired_card"],
      ["9500", "fraudulent"],
      ["9510", "fraudulent"],
      ["9520", "lost_card"],
      ["5150", "pickup_card"],
      ["5140", "payment_method_not_found", false],
      ["PP06", "payment_method_not_found", false],
      ["0390", "payment_method_not_found", false],
      ["1330", "payment_method_not_found", false],
      ["1335", "payment_method_not_found", false],
      ["6300", "payment_method_not_found", false],
      ["5180", "card_restricted", false],
      ["1352", "card_restricted", false],
      ["5930", "card_restricted", false],
      ["5950", "card_restricted", false],
      ["PPFR", "card_restricted", false],
      ["PPFI", "card_restricted", false],
      ["PPAB", "card_restricted", false],
      ["PPCT", "card_restricted", false],
      ["PPCO", "card_restricted", false],
      ["PPMC", "card_restricted", false],
      ["PPRN", "network_do_not_retry", false],
      ["5650", "authentication_required"],
      ["7700", "authentication_required"],
      ["7710", "authentication_required"],
      ["PCNR", "authentication_required"],
      ["PPD3", "authentication_required"],
      ["00N7", "incorrect_cvc"],
      ["1382", "incorrect_cvc"],
      ["5110", "incorrect_cvc"],
      ["PCVV", "incorrect_cvc"],
      ["PPC2", "incorrect_cvc"],
      ["0100", "do_not_honor"],
      ["0500", "do_not_honor"],
      ["0580", "do_not_honor"],
      ["10BR", "do_not_honor"],
      ["5100", "do_not_honor"],
      ["5160", "do_not_honor"],
      ["5210", "do_not_honor"],
      ["5700", "do_not_honor"],
      ["9540", "do_not_honor"],
      ["PPAR", "do_not_honor"],
      ["PPDV", "do_not_honor"],
      ["PPSE", "do_not_honor"],
      ["5170", "card_declined"],
      ["5190", "card_declined"],
      ["PPAD", "card_declined"],
      ["PPAV", "card_declined"],
      ["5200", "retry_too_soon"],
      ["5710", "retry_too_soon"],
      ["9100", "retry_too_soon"],
      ["PPDT", "retry_too_soon"],
      ["PPEL", "retry_too_soon"],
      ["PPNL", "retry_too_soon"],
      ["0880", "processing_error"],
      ["0960", "processing_error"],
      ["5910", "processing_error"],
      ["5920", "processing_error"],
      ["8000", "processing_error"],
      ["8100", "processing_error"],
      ["8110", "processing_error"],
      ["8220", "processing_error"],
      ["9600", "processing_error"],
      ["PPER", "processing_error"],
      ["PPLS", "processing_error"],
      ["PPNT", "processing_error"],
    ] as const
  ).map(([value, code, retriable]: readonly [string, string, boolean?]): DeclineRule => ({
    id: `paypal.processor.${value.toLowerCase()}`,
    field: "decline_code",
    op: "eq",
    value,
    code,
    ...(retriable === undefined ? {} : { retriable }),
  })),
  // Processor codes that blame our request or our merchant setup, never the card.
  ...(
    [
      ["1300", "gateway_error"],
      ["1310", "gateway_error"],
      ["1312", "gateway_error"],
      ["1317", "gateway_error"],
      ["1320", "gateway_error"],
      ["1360", "gateway_error"],
      ["1384", "gateway_error"],
      ["1390", "gateway_error"],
      ["1393", "gateway_error"],
      ["PPFV", "gateway_error"],
      ["PPIF", "gateway_error"],
      ["PPII", "gateway_error"],
      ["PPIM", "gateway_error"],
      ["PPTI", "gateway_error"],
      ["PPVC", "gateway_error"],
      ["PPVE", "gateway_error"],
      ["1340", "gateway_request_rejected"],
      ["1350", "gateway_request_rejected"],
      ["1370", "gateway_request_rejected"],
      ["8020", "gateway_request_rejected"],
      ["8030", "gateway_request_rejected"],
      ["PPAE", "gateway_request_rejected"],
      ["PPAU", "gateway_request_rejected"],
      ["PPCE", "gateway_request_rejected"],
      ["PPCU", "gateway_request_rejected"],
      ["PPDI", "gateway_request_rejected"],
      ["PPMB", "gateway_request_rejected"],
      ["PPNM", "gateway_request_rejected"],
      ["PPRR", "gateway_request_rejected"],
      ["PPTT", "gateway_request_rejected"],
      ["PPUC", "gateway_request_rejected"],
    ] as const
  ).map(([value, code]): DeclineRule => ({
    id: `paypal.processor.${value.toLowerCase()}`,
    field: "decline_code",
    op: "eq",
    value,
    code,
    retriable: true,
    message:
      "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  })),
];

export function normalizePaypalDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  const sig = asSignal(raw);
  const advice = (sig.recommendationCode ?? "").trim();
  const wait =
    sig.cardBrand?.toLowerCase() === "mastercard"
      ? (PAYPAL_MASTERCARD_ADVICE_WAIT_MS[advice] ?? MASTERCARD_ADVICE_WAIT_MS[advice])
      : undefined;
  return withWait(evaluate(sig, PAYPAL_RULES, PAYPAL_CODE_TABLE), wait);
}

/** PayPal's Mastercard advice 02: "Retry the transaction 72 hours later." */
const PAYPAL_MASTERCARD_ADVICE_WAIT_MS: Readonly<Record<string, number>> = {
  "02": 72 * HOUR_MS,
};

/**
 * Documented PayPal issues and processor codes that no call of ours can return, with the reason.
 * They get no rule: a rule for a code that cannot arrive is dead config.
 */
export const PAYPAL_CODES_OUR_CALLS_NEVER_RAISE: Readonly<Record<string, string>> = neverRaisedBy([
  [
    "a payment source or field we never send (we send a vault id, a billing agreement, or an empty PayPal source)",
    [
      "ALIAS_DECLINED_BY_PROCESSOR",
      "APPLE_PAY_AMOUNT_MISMATCH",
      "BANK_NOT_SUPPORTED_FOR_VERIFICATION",
      "BANK_VERIFICATION_REQUIRED",
      "BILLING_ADDRESS_INVALID",
      "BLIK_ONE_CLICK_MISSING_REQUIRED_PARAMETER",
      "CARD_EXPIRATION_YEAR_IS_INVALID",
      "CARD_EXPIRY_REQUIRED",
      "CARD_NUMBER_REQUIRED",
      "COUNTRY_NOT_SUPPORTED_BY_PAYMENT_SOURCE",
      "CREDIT_CARD_NUMBER_IS_INVALID",
      "CRYPTOGRAM_REQUIRED",
      "CURRENCY_NOT_SUPPORTED_FOR_BANK",
      "EMV_DATA_REQUIRED",
      "GOOGLE_PAY_GATEWAY_MERCHANT_ID_MISMATCH",
      "IBAN_COUNTRY_NOT_SUPPORTED",
      "INCOMPATIBLE_ACCOUNT_OWNERSHIP_TYPE",
      "INCOMPATIBLE_PARAMETER_FOR_BILLING_PLAN",
      "INVALID_CARD_NUMBER",
      "INVALID_EXPIRY_DATE",
      "INVALID_GOOGLE_PAY_TOKEN",
      "INVALID_IBAN",
      "INVALID_SECURITY_CODE",
      "INVALID_SECURITY_CODE_LENGTH",
      "MISSING_CRYPTOGRAM",
      "MISSING_PREVIOUS_REFERENCE",
      "NOT_ELIGIBLE_FOR_PAYPAL_TRANSACTION_ID_PROCESSING",
      "NOT_ELIGIBLE_FOR_PNREF_PROCESSING",
      "NOT_ENABLED_FOR_APPLE_PAY",
      "NOT_ENABLED_FOR_BANK_PROCESSING",
      "NOT_ENABLED_FOR_GOOGLE_PAY",
      "ONLY_ONE_BANK_SOURCE_ALLOWED",
      "PARTNER_OR_MERCHANT_RESTRICTED_FOR_COUNTRY",
      "PAYEE_NOT_ENABLED_FOR_BANK_PROCESSING",
      "PAYMENT_SOURCE_INFO_CANNOT_BE_VERIFIED",
      "PAYPAL_TRANSACTION_ID_EXPIRED",
      "PAYPAL_TRANSACTION_ID_NOT_FOUND",
      "PNREF_EXPIRED",
      "PNREF_NOT_FOUND",
      "SETUP_ERROR_FOR_BANK",
      "UNSUPPORTED_AUTHENTICATION_METHODS_FOR_PAYMENT_SOURCE",
    ],
  ],
  [
    "an order endpoint we never call (patch, confirm, track)",
    [
      "AMOUNT_CHANGE_NOT_ALLOWED",
      "AMOUNT_NOT_PATCHABLE",
      "CANNOT_MODIFY_INTENT",
      "CAPTURE_ID_NOT_FOUND",
      "CAPTURE_STATUS_NOT_VALID",
      "DEVICE_DATA_NOT_AVAILABLE",
      "DOMAIN_NOT_REGISTERED",
      "DUPLICATE_SHIPPING_OPTION_ID",
      "FIELD_NOT_PATCHABLE",
      "INVALID_JSON_POINTER_FORMAT",
      "INVALID_PARAMETER",
      "INVALID_PATCH_OPERATION",
      "INVALID_TRACKING_NUMBER",
      "INVOICE_ID_CHANGE_NOT_ALLOWED",
      "ITEM_CATEGORY_NOT_SUPPORTED_BY_PAYMENT_SOURCE",
      "ITEM_SKU_MISMATCH",
      "MAX_TRACKER_UPDATE_COUNT_EXCEEDED",
      "MSP_NOT_SUPPORTED",
      "NOT_PATCHABLE",
      "NO_PAYMENT_SOURCE_PROVIDED",
      "ONE_OF_THE_PARAMETERS_REQUIRED",
      "ONLY_ONE_PAYMENT_SOURCE_ALLOWED",
      "ORDER_ALREADY_COMPLETED",
      "ORDER_CANNOT_BE_CONFIRMED",
      "ORDER_IS_PENDING_APPROVAL",
      "PATCH_PATH_REQUIRED",
      "PATCH_VALUE_REQUIRED",
      "PAYEE_ACCOUNT_NOT_SUPPORTED",
      "PAYEE_ACCOUNT_NOT_VERIFIED",
      "PAYEE_COUNTRY_NOT_SUPPORTED_FOR_PAYMENT_SOURCE",
      "PAYMENT_ALREADY_APPROVED",
      "PUI_DUPLICATE_ORDER",
      "REQUIRED_PARAMETER_FOR_PAYMENT_SOURCE",
      "TESTING_WITH_REAL_WALLET_NOT_ENABLED",
      "TRACKER_ID_NOT_FOUND",
      "UNSUPPORTED_PATCH_PARAMETER_VALUE",
    ],
  ],
  [
    "a field or feature we never send (shipping, items, fees, currency conversion, saved orders)",
    [
      "AMOUNT_MISMATCH",
      "AUTO_CAPTURE_ENABLED",
      "BILLING_AGREEMENTS_CANNOT_BE_USED_FOR_SUBSCRIPTIONS",
      "BILLING_ITEM_AMOUNT_MISMATCH",
      "CARD_PROVISIONING_FORBIDDEN",
      "CITY_REQUIRED",
      "DECLINED_DUE_TO_RELATED_TXN",
      "DELAYED_DISBURSEMENT_NOT_SUPPORTED",
      "DELAYED_DISBURSEMENT_NOT_SUPPORTED_FOR_KYC_INCOMPLETE_PAYEE",
      "DISCOUNT_TOTAL_MISMATCH",
      "DONATION_ITEMS_NOT_SUPPORTED",
      "DUPLICATE_INVOICE_ID",
      "DUPLICATE_REFERENCE_ID",
      "DUPLICATE_TRANSACTION",
      "FX_RATE_CHANGE_DUE_TO_MARKET_EVENT",
      "IDENTIFIER_NOT_FOUND",
      "INELIGIBLE_SHIPPING_OPTION",
      "INVALID_DELIVERY_ESTIMATE",
      "INVALID_FX_RATE_ID",
      "INVALID_INVOICE_ID",
      "INVALID_PAYEE_ACCOUNT",
      "INVALID_PAYEE_PRICING_TIER_ID",
      "INVALID_PAYER_ID",
      "INVALID_PICKUP_ADDRESS",
      "INVALID_PLATFORM_FEES_ACCOUNT",
      "INVALID_PLATFORM_FEES_AMOUNT",
      "INVALID_POSTAL_CODE",
      "INVALID_POSTAL_CODE_LENGTH",
      "INVALID_PREVIOUS_TRANSACTION_REFERENCE",
      "INVALID_SHIPPING_OPTION_ID",
      "INVALID_VAULT_SETUP_TOKEN",
      "ITEM_TOTAL_MISMATCH",
      "ITEM_TOTAL_REQUIRED",
      "KYC_HOLD",
      "LOCALE_NOT_SUPPORTED_BY_PAYMENT_SOURCE",
      "MAX_AUTHORIZATION_COUNT_EXCEEDED",
      "MAX_EXPIRY_TIME_EXCEEDED",
      "MISMATCHED_VAULT_SETUP_TOKEN_TO_PAYMENT_SOURCE",
      "MISSING_ITEM_SHIPPING_OPTIONS",
      "MISSING_PICKUP_ADDRESS",
      "MISSING_REQUIRED_PARAMETER_FOR_BILLING_PLAN",
      "MISSING_SHIPPING_CALL_BACK_CONFIGURATION",
      "MULTIPLE_ITEM_CATEGORIES",
      "MULTIPLE_PURCHASE_UNITS_NOT_SUPPORTED_FOR_PAYMENT_SOURCE",
      "MULTIPLE_SHIPPING_ADDRESS_NOT_SUPPORTED",
      "MULTIPLE_SHIPPING_OPTION_SELECTED",
      "MULTIPLE_SHIPPING_TYPE_NOT_SUPPORTED",
      "ORDER_AUTHORIZATION_IN_PROGRESS",
      "ORDER_CANNOT_BE_SAVED",
      "ORDER_COMPLETE_ON_PAYMENT_APPROVAL",
      "PARTNER_SETTLEMENT_NOT_SUPPORTED_FOR_KYC_INCOMPLETE_PAYEE",
      "PAYEE_FX_RATE_ID_CURRENCY_MISMATCH",
      "PAYEE_FX_RATE_ID_EXPIRED",
      "PAYEE_PRICING_TIER_ID_NOT_ENABLED",
      "PAYMENT_ORIGIN_NOT_ENABLED",
      "PAYMENT_SOURCE_MISMATCH",
      "PAYMENT_SOURCE_NOT_SUPPORTED",
      "PERMISSION_DENIED_FOR_DONATION_ITEMS",
      "PLATFORM_FEES_NOT_SUPPORTED",
      "PLATFORM_FEE_NOT_ENABLED",
      "PLATFORM_FEE_PAYEE_CANNOT_BE_SAME_AS_PAYER",
      "POSTAL_CODE_REQUIRED",
      "PREFERRED_BRAND_NOT_SUPPORTED",
      "PREFERRED_PAYMENT_SOURCE_MISMATCH",
      "PREFERRED_SHIPPING_OPTION_AMOUNT_MISMATCH",
      "PREVIOUS_TRANSACTION_REFERENCE_HAS_CHARGEBACK",
      "PREVIOUS_TRANSACTION_REFERENCE_VOIDED",
      "PROVISION_CARD_UNSUPPORTED_OPERATION",
      "REFERENCE_ID_NOT_FOUND",
      "REFERENCE_ID_REQUIRED",
      "SAVE_ORDER_NOT_SUPPORTED",
      "SHIPPING_ADDRESS_INVALID",
      "SHIPPING_ADDRESS_NOT_ALLOWED_BY_RESIDENCE_COUNTRY",
      "SHIPPING_CALLBACK_CONFIG_NOT_SUPPORTED",
      "SHIPPING_OPTIONS_NOT_SUPPORTED",
      "SHIPPING_OPTION_NOT_SELECTED",
      "SHIPPING_TYPE_NOT_SUPPORTED_FOR_CLIENT",
      "TAX_TOTAL_MISMATCH",
      "TAX_TOTAL_REQUIRED",
      "UNSUPPORTED_INTEGRATION_FOR_BILLING_PLAN",
      "UNSUPPORTED_INTENT_FOR_KYC_INCOMPLETE_PAYEE",
      "UNSUPPORTED_PAYMENT_SOURCE_FOR_SUBSCRIPTIONS",
      "UNSUPPORTED_PROCESSING_INSTRUCTION",
      "UNSUPPORTED_SHIPPING_TYPE",
      "VAULT_INSTRUCTION_DUPLICATED",
      "VAULT_OWNER_ID_NOT_SUPPORTED",
    ],
  ],
  [
    "void and reauthorize: a void answers from a read, and a capture takes the order's own currency",
    [
      "AUTHORIZATION_CURRENCY_MISMATCH",
      "AUTH_CAPTURE_CURRENCY_MISMATCH",
      "AUTH_CURRENCY_MISMATCH",
      "CANNOT_BE_VOIDED",
      "MULTIPLE_AUTHORIZATIONS_FOUND",
      "PREVIOUSLY_CAPTURED",
      "PREVIOUSLY_VOIDED",
      "REAUTHORIZATION_NOT_SUPPORTED",
      "REAUTHORIZATION_NOT_SUPPORTED_FOR_PAYMENT_SOURCE",
      "REAUTHORIZATION_TOO_SOON",
      "UPDATE_AUTHORIZATION_NOT_SUPPORTED",
    ],
  ],
  [
    "refunds: the refusal reaches the operator in PayPal's words, never as a payment decline",
    [
      "CANNOT_REFUND_SELF",
      "CAPTURED_AMOUNT_FULLY_REFUNDED",
      "CAPTURE_FULLY_REFUNDED",
      "DUPLICATE_REFUND",
      "MAX_NUMBER_OF_REFUNDS_EXCEEDED",
      "MAX_PAYEE_AMOUNT_LIMIT_EXCEEDED",
      "MAX_PAYER_AMOUNT_LIMIT_EXCEEDED",
      "MAX_REFUND_LIMIT_EXCEEDED",
      "PARTIAL_REFUND_NOT_ALLOWED",
      "PAYEE_REFUND_AMOUNT_LIMIT_EXCEEDED",
      "PAYER_REFUND_AMOUNT_LIMIT_EXCEEDED",
      "PENDING_CAPTURE",
      "PLATFORM_FEE_EXCEEDED",
      "REFUND_AMOUNT_EXCEEDED",
      "REFUND_AMOUNT_TOO_LOW",
      "REFUND_CAPTURE_CURRENCY_MISMATCH",
      "REFUND_CURRENCY_MISMATCH",
      "REFUND_FAILED_BY_PAYMENT_SOURCE",
      "REFUND_FAILED_INSUFFICIENT_FUNDS",
      "REFUND_FUNDS_NOT_AVAILABLE",
      "REFUND_IS_RESTRICTED",
      "REFUND_NOT_ALLOWED",
      "REFUND_NOT_PERMITTED_DUE_TO_CHARGEBACK",
      "REFUND_NOT_SUPPORTED_FOR_PAYMENT_SOURCE",
      "REFUND_REFUSED_BY_PROCESSOR",
      "REFUND_TIME_EXCEEDED_FOR_PAYMENT_SOURCE",
      "REFUND_TIME_LIMIT_EXCEEDED",
      "REFUND_TRANSACTION_REFUSED",
      "TRANSACTION_DISPUTED",
    ],
  ],
  [
    "a 5xx, 409 or 429: replayed under the same request id, then pending",
    ["INTERNAL_SERVER_ERROR", "PREVIOUS_REQUEST_IN_PROGRESS", "RATE_LIMIT_REACHED"],
  ],
  [
    "card-present, PIN, currency conversion, gaming, refund or bank-authorization only, or deprecated",
    [
      "0800",
      "0890",
      "0R00",
      "5130",
      "5135",
      "5500",
      "5800",
      "5900",
      "7800",
      "7900",
      "8010",
      "9530",
      "PPAG",
      "PPAI",
      "PPAX",
      "PPBG",
      "PPCR",
      "PPDC",
      "PPFE",
      "PPGR",
      "PPH1",
      "PPIT",
      "PPLR",
      "PPMD",
      "PPNC",
      "PPPH",
      "PPPI",
      "PPPM",
      "PPQC",
      "PPRE",
      "PPRF",
      "PPS0",
      "PPS1",
      "PPS2",
      "PPS3",
      "PPS4",
      "PPS5",
      "PPS6",
      "PPSC",
      "PPSD",
      "PPTE",
      "PPTF",
      "PPTR",
      "PPTV",
      "PPUA",
      "PPUE",
      "PPUI",
      "PPUP",
      "PPUR",
      "PPVT",
    ],
  ],
  ["an approval, not a refusal", ["0000", "1000", "7600"]],
]);

/**
 * PayPal advice codes that carry no instruction we act on: the processor code classifies the
 * refusal. (02 and 24–30 set a wait; 01, 03 and 21 are rules.)
 */
export const PAYPAL_ADVICE_CODES_INFORMATIONAL: Readonly<Record<string, string>> = {
  "04": "Mastercard: token requirements not met. The processor code decides.",
  "22": "Mastercard: the merchant does not qualify for the product code. The processor code decides.",
  "40": "Mastercard: a non-reloadable prepaid card. Information only.",
  "43": "Mastercard: a multi-use virtual card number. Information only.",
};

/**
 * GoCardless: a payment event's `details.cause`, or an API error `reason` on create.
 * Branch on the cause, never on `reason_code`, which is scheme-specific.
 */
export const GOCARDLESS_CODE_TABLE: Record<string, string> = {
  insufficient_funds: "insufficient_funds",
  // Bacs ARUDD-0: most often insufficient funds.
  refer_to_payer: "insufficient_funds",
  bank_account_closed: "bank_account_closed",
  closed_debtor_account_number: "bank_account_closed",
  account_blocked_for_any_financial_transaction: "bank_account_closed",
  blocked_account: "bank_account_closed",
  invalid_bank_details: "bank_account_invalid_details",
  account_details_changed: "bank_account_invalid_details",
  direct_debit_not_enabled: "bank_account_invalid_details",
  authorisation_disputed: "debit_not_authorized",
  insufficient_payment_permissions: "debit_not_authorized",
  customer_approval_denied: "debit_not_authorized",
  mandate_cancelled: "revocation_of_authorization",
  mandate_expired: "mandate_expired",
  mandate_suspended_by_payer: "mandate_expired",
  // Create refused: the mandate is cancelled, failed or expired.
  mandate_is_inactive: "mandate_expired",
  payment_violated_mandate_parameters: "mandate_ceiling_exceeded",
  // The payer told their bank to stop this one payment: park this cycle, keep the mandate.
  payment_stopped: "debit_cancelled_by_payer",
  bank_declined_payment: "do_not_honor",
  unsuccessful_direct_debit: "do_not_honor",
  limit_exceeded: "do_not_honor",
  maximum_dd_transaction_amount_exceeded: "do_not_honor",
  maximum_number_of_dd_transactions_exceeded: "try_again_later",
  daily_payment_limit_reached: "try_again_later",
  bank_account_transferred: "try_again_later",
  bank_system_processing_error: "processing_error",
  return_on_odfi_request: "processing_error",
  no_status_update: "processing_error",
  // Sandbox scenario simulator.
  test_failure: "do_not_honor",
  other: "charge_failed",
  // The account cannot take Direct Debits any more (`invalid_state` on a payment create).
  bank_account_disabled: "bank_account_closed",
  // Mandate `blocked` causes: GoCardless will not debit this account.
  mandate_blocked: "bank_account_restricted",
  mandate_blocked_by_gocardless: "bank_account_restricted",
  // Billing request causes, while the payer is in the hosted flow.
  billing_request_flow_exited: "payment_abandoned",
  billing_request_bank_authorisation_expired: "payment_abandoned",
  billing_request_bank_authorisation_denied: "debit_not_authorized",
  billing_request_bank_authorisation_failed: "setup_failed",
  payer_geo_blocked: "setup_failed",
  billing_request_cancelled: "setup_cancelled",
  billing_request_failed: "setup_failed",
};

const GOCARDLESS_OURS =
  "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's bank account.";

export const GOCARDLESS_RULES: readonly DeclineRule[] = [
  // We sent GoCardless a request it would not accept: not the payer's doing.
  {
    id: "gocardless.code.validation_failed",
    field: "code",
    op: "eq",
    value: "validation_failed",
    code: "gateway_request_rejected",
    retriable: false,
    message: GOCARDLESS_OURS,
    exposedToPayer: false,
  },
  {
    id: "gocardless.code.mandate_replaced",
    field: "code",
    op: "eq",
    value: "mandate_replaced",
    code: "mandate_expired",
    retriable: false,
    message:
      "The Direct Debit for this bank account was replaced. Set up the Direct Debit again to continue.",
    exposedToPayer: true,
  },
  // GoCardless asked us to slow down: nothing to do with the bank account. No message: an
  // unexposed one would hide `processing_error` from payers on every gateway.
  {
    id: "gocardless.code.rate_limit_exceeded",
    field: "code",
    op: "eq",
    value: "rate_limit_exceeded",
    code: "processing_error",
    retriable: true,
  },
  // Our access token or its permissions: the account, not the payer.
  ...(
    [
      "access_token_revoked",
      "access_token_not_active",
      "access_token_not_found",
      "unauthorized",
      "forbidden",
      "insufficient_permissions",
      "insufficient_permissions_continue_on_dashboard",
      "missing_authorization_header",
      "invalid_authorization_header",
      "feature_disabled",
    ] as const
  ).map(
    (value) =>
      ({
        id: `gocardless.code.${value}`,
        field: "code",
        op: "eq",
        value,
        code: "gateway_request_rejected",
        message: GOCARDLESS_OURS,
        exposedToPayer: false,
      }) as const,
  ),
  // The mandate we linked, or its customer's data, no longer exists: only a new mandate pays.
  ...(["link_not_found", "resource_not_found", "customer_data_removed"] as const).map(
    (value) =>
      ({
        id: `gocardless.code.${value}`,
        field: "code",
        op: "eq",
        value,
        code: "payment_method_not_found",
        retriable: false,
        message: "The Direct Debit for this bank account no longer exists. Set it up again.",
        exposedToPayer: true,
      }) as const,
  ),
  // Our request's shape, version or transport: the `invalid_api_usage` reasons, named.
  ...(
    [
      "invalid_type",
      "path_not_found",
      "not_acceptable",
      "request_entity_too_large",
      "unsupported_media_type",
      "method_not_allowed",
      "bad_request",
      "idempotency_key_too_long",
      "invalid_document_structure",
      "invalid_content_type",
      "tls_required",
      "missing_version_header",
      "version_not_found",
      "request_body_not_allowed",
    ] as const
  ).map(
    (value) =>
      ({
        id: `gocardless.code.${value}`,
        field: "code",
        op: "eq",
        value,
        code: "gateway_request_rejected",
        message: GOCARDLESS_OURS,
        exposedToPayer: false,
      }) as const,
  ),
  // Any other `invalid_api_usage` reason: GoCardless says "alert your team".
  {
    id: "gocardless.category.invalid_api_usage",
    field: "category",
    op: "eq",
    value: "invalid_api_usage",
    code: "gateway_request_rejected",
    message: GOCARDLESS_OURS,
    exposedToPayer: false,
  },
];

export function normalizeGocardlessDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  return evaluate(asSignal(raw), GOCARDLESS_RULES, GOCARDLESS_CODE_TABLE);
}

const GC_OTHER_CALLS =
  "cancel, retry, refund, list and bank-account calls only; their refusal reaches the operator as an error";
const GC_BY_STATUS =
  "handled before the rules: a 5xx is an unknown outcome, a 409 conflict reads the original";

/** Documented GoCardless causes and API reasons that no call of ours can return, with the reason. */
export const GOCARDLESS_CODES_OUR_CALLS_NEVER_RAISE: Readonly<Record<string, string>> = {
  ...neverRaised(
    GC_OTHER_CALLS,
    `
    cancellation_failed retry_failed disable_failed mandate_not_inactive refund_is_unreachable
    refund_payment_invalid_state total_amount_confirmation_invalid number_of_refunds_exceeded
    available_refund_amount_insufficient bank_account_exists invalid_filters
    payout_items_data_archived customer_bank_account_token_used
    billing_request_must_be_ready_to_fulfil
    `,
  ),
  ...neverRaised(
    GC_BY_STATUS,
    "internal_server_error request_timed_out query_timed_out idempotent_creation_conflict",
  ),
  payment_cancelled:
    "handled before the rules: the merchant cancelled the payment (`debit_cancelled`), no decline",
  instalment_schedule_cancelled: "instalment schedules; we never create them",
  initial_one_off_payment_failed: "an instant first payment with the mandate; we never request one",
  refund_requested: "a chargeback cause, kept as the dispute reason, never a decline",
  refund_failed: "a refund failure; `refund.failed` carries no decline code",
};

/**
 * Braintree: processor response codes (`processorResponse.legacyCode`, 2000–3000), settlement
 * response codes (4001–4026) and gateway rejection reasons (`GatewayRejectionReason` enum)
 * → canonical tokens. Source: Braintree's published processor-response and settlement-response
 * tables. Braintree's own soft/hard label is not used: its "hard" set includes merchant setup
 * errors, and `retriable: false` here marks the INSTRUMENT invalid.
 */
export const BRAINTREE_CODE_TABLE: Record<string, string> = {
  "2000": "do_not_honor",
  "2001": "insufficient_funds",
  "2002": "insufficient_funds",
  "2003": "insufficient_funds",
  "2004": "expired_card",
  "2005": "incorrect_number",
  "2006": "expired_card",
  "2008": "incorrect_number",
  "2009": "incorrect_number",
  "2010": "incorrect_cvc",
  "2011": "card_declined",
  "2012": "lost_card",
  "2013": "stolen_card",
  "2014": "fraudulent",
  "2015": "card_restricted",
  "2016": "retry_too_soon",
  "2017": "revocation_of_authorization",
  "2018": "revocation_of_authorization",
  "2019": "card_declined",
  "2020": "card_declined",
  "2021": "card_declined",
  "2022": "expired_card",
  "2031": "processing_error",
  "2033": "card_declined",
  "2034": "card_declined",
  "2038": "card_declined",
  "2041": "do_not_honor",
  "2044": "do_not_honor",
  "2046": "card_declined",
  "2047": "pickup_card",
  "2053": "stolen_card",
  "2057": "card_restricted",
  "2059": "card_declined",
  "2060": "card_declined",
  "2099": "authentication_required",
  "2101": "authentication_required",
  "2105": "card_declined",
  "2106": "card_declined",
  "2107": "card_restricted",
  // PayPal processor responses where the payer's PayPal account or its funding refused.
  "2074": "card_declined",
  "2076": "card_declined",
  "2077": "card_declined",
  "2082": "card_declined",
  "2083": "card_declined",
  "2084": "card_declined",
  "2086": "card_declined",
  "2096": "card_declined",
  "3000": "processing_error",
  "4001": "card_declined",
  "4005": "card_declined",
  // Gateway rejection reasons (our fraud and verification rules, not the issuer's).
  AVS: "card_declined",
  AVS_AND_CVV: "incorrect_cvc",
  CVV: "incorrect_cvc",
  DUPLICATE: "retry_too_soon",
  EXCESSIVE_RETRY: "retry_too_soon",
  FRAUD: "card_declined",
  RISK_THRESHOLD: "card_declined",
  PAYMENT_METHOD_BLOCKED: "card_restricted",
  THREE_D_SECURE: "authentication_required",
  TOO_MANY_CONFIRMATION_ATTEMPTS: "authentication_required",
};

const BRAINTREE_OUR_SIDE =
  "We could not complete this payment because of a problem with the payment gateway setup. Nothing is wrong with the customer's payment method.";

export const BRAINTREE_RULES: readonly DeclineRule[] = [
  // 2015 "Transaction Not Allowed" (Braintree: Hard): not permitted to this card.
  {
    id: "braintree.code.transaction_not_allowed",
    field: "code",
    op: "eq",
    value: "2015",
    code: "card_restricted",
    retriable: false,
  },
  // The card account is closed or does not exist: only a new card recovers it.
  {
    id: "braintree.code.no_account",
    field: "code",
    op: "eq",
    value: "2007",
    code: "payment_method_not_found",
    retriable: false,
  },
  {
    id: "braintree.code.closed_card",
    field: "code",
    op: "eq",
    value: "2108",
    code: "payment_method_not_found",
    retriable: false,
  },
  {
    id: "braintree.code.payer_account_closed",
    field: "code",
    op: "eq",
    value: "4025",
    code: "payment_method_not_found",
    retriable: false,
  },
  // "Multi-use payment method ID is invalid or could not be found": the vaulted card is
  // gone at Braintree (measured on a deleted card).
  {
    id: "braintree.code.payment_method_not_found",
    field: "code",
    op: "eq",
    value: "91518",
    code: "payment_method_not_found",
    retriable: false,
  },
  // "Error – Do Not Retry, Call Issuer": the network forbids a re-present.
  {
    id: "braintree.code.do_not_retry",
    field: "code",
    op: "eq",
    value: "2043",
    code: "network_do_not_retry",
    retriable: false,
    message:
      "Your bank asked us not to attempt this payment again. Use a different payment method, or contact your bank.",
    exposedToPayer: true,
  },
  // Our 3D Secure policy: the card could shift liability and did not (the adapter's
  // `braintreeThreeDSecureFailure`). The buyer is present and can try again.
  {
    id: "braintree.category.three_d_secure_not_shifted",
    field: "category",
    op: "eq",
    value: "THREE_D_SECURE_NOT_SHIFTED",
    code: "authentication_required",
    retriable: true,
    message: "Your bank did not confirm this card. Try again, or use a different card.",
    exposedToPayer: true,
  },
  // "Merchant account does not support payment instrument" / "Payment instrument type is
  // not accepted by this merchant account": PayPal or Venmo is not on for this merchant
  // account (measured in the sandbox with a Venmo account, 2026-10-28).
  ...(
    [
      ["91577", "instrument_not_supported"],
      ["91517", "instrument_not_accepted"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `braintree.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "gateway_request_rejected",
    retriable: false,
    message: BRAINTREE_OUR_SIDE,
    exposedToPayer: false,
  })),
  // The payer withdrew the PayPal billing agreement, or it is gone: only a new method recovers.
  // https://developer.paypal.com/braintree/articles/control-panel/transactions/declines (read 2026-10-28).
  {
    id: "braintree.code.paypal_authorization_revoked",
    field: "code",
    op: "eq",
    value: "2070",
    code: "revocation_of_authorization",
    retriable: false,
  },
  ...(
    [
      ["2075", "paypal_payer_account_closed"],
      ["2093", "paypal_payment_method_invalid"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `braintree.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "payment_method_not_found",
    retriable: false,
  })),
  // "PayPal pending payments are not supported": PayPal answered pending, which Braintree
  // does not accept. Braintree's table says to contact Braintree (same source, 2026-10-28).
  {
    id: "braintree.code.paypal_pending_not_supported",
    field: "code",
    op: "eq",
    value: "2081",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "PayPal returned this payment as pending. Braintree does not accept pending PayPal payments. Contact Braintree support to find the cause in your PayPal business account.",
    exposedToPayer: false,
  },
  // PayPal business-account and integration refusals: ours to correct in the PayPal or
  // Braintree account, never the payer's (same source, 2026-10-28).
  ...(
    [
      ["2063", "paypal_account_preference"],
      ["2066", "paypal_account_restricted"],
      ["2068", "paypal_account_locked"],
      ["2069", "paypal_duplicate_order_id"],
      ["2071", "paypal_payee_account_invalid"],
      ["2072", "paypal_payee_email_invalid"],
      ["2073", "paypal_validation_error"],
      ["2079", "paypal_merchant_configuration"],
      ["2080", "paypal_invalid_credentials"],
      ["2085", "paypal_payee_blocked"],
      ["2087", "paypal_reference_transactions_disabled"],
      ["2088", "paypal_currency_not_enabled"],
      ["2089", "paypal_payee_permission_denied"],
      ["2091", "paypal_currency_mismatch"],
      ["2094", "paypal_payment_already_completed"],
      ["2100", "paypal_channel_billing_disabled"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `braintree.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "gateway_request_rejected",
    retriable: false,
    message: BRAINTREE_OUR_SIDE,
    exposedToPayer: false,
  })),
  // Merchant-account setup refusals (2023–2030, 2032, 2045, 2048, 2064, gateway rejections).
  ...(
    [
      ["2023", "feature_unsupported"],
      ["2024", "card_type_not_enabled"],
      ["2025", "setup_merchant"],
      ["2026", "invalid_merchant_id"],
      ["2027", "setup_amount"],
      ["2028", "setup_hierarchy"],
      ["2029", "setup_card"],
      ["2030", "setup_terminal"],
      ["2032", "surcharge_not_permitted"],
      ["2045", "invalid_merchant_number"],
      ["2048", "invalid_amount"],
      ["2064", "invalid_currency"],
      ["APPLICATION_INCOMPLETE", "application_incomplete"],
      ["MANUAL_TRANSACTIONS_DISABLED", "manual_transactions_disabled"],
      ["TOKEN_ISSUANCE", "token_issuance"],
      ["UNION_PAY_ENROLLMENT_REQUIRED", "union_pay_enrollment"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `braintree.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "gateway_request_rejected",
    retriable: false,
    message: BRAINTREE_OUR_SIDE,
    exposedToPayer: false,
  })),
  // ── From the documented lists (BRAINTREE_ERROR_CODES.md, captured 2026-11-17) ──
  // The saved method is gone or cannot pay: only a new method recovers.
  ...(
    [
      [
        "91583",
        "paypal_not_vaulted_with_data",
        "This PayPal payment method is no longer available.",
      ],
      [
        "92929",
        "paypal_agreement_id_missing",
        "This PayPal payment method is no longer available.",
      ],
      [
        "92960",
        "paypal_agreement_token_invalid",
        "This PayPal payment method is no longer available.",
      ],
      [
        "92921",
        "paypal_agreement_unreadable",
        "This PayPal payment method is no longer available.",
      ],
      [
        "82957",
        "paypal_payer_account_unusable",
        "The PayPal account for this payment method cannot pay.",
      ],
      [
        "82959",
        "paypal_payer_account_restricted",
        "The PayPal account for this payment method is restricted.",
      ],
      ["93117", "payment_method_unsupported", "This payment method is no longer supported."],
      ["91511", "customer_has_no_card", "The saved payment method is no longer available."],
    ] as const
  ).map(([value, slug, reason]): DeclineRule => ({
    id: `braintree.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "payment_method_not_found",
    retriable: false,
    message: `${reason} Add a new payment method to continue your subscription.`,
    exposedToPayer: true,
  })),
  // A browser nonce used twice or too late: nothing is wrong with the card.
  ...(
    [
      ["91564", "nonce_used"],
      ["91565", "nonce_unknown_or_expired"],
      ["92907", "paypal_nonce_used"],
      ["92908", "paypal_nonce_unknown_or_expired"],
      ["92909", "nonce_locked"],
      ["93107", "payment_method_nonce_used"],
      ["93108", "payment_method_nonce_unknown_or_expired"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `braintree.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "invalid_client_result",
    retriable: true,
    message: "The payment details expired. Enter them again.",
    exposedToPayer: true,
  })),
  ...(
    [
      ["81571", "three_d_secure_failed"],
      ["92911", "paypal_authentication_expired"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `braintree.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "authentication_required",
  })),
  {
    id: "braintree.code.paypal_payer_cannot_pay",
    field: "code",
    op: "eq",
    value: "82956",
    code: "do_not_honor",
  },
  ...(
    [
      ["2050", "invalid_credit_plan"],
      ["2051", "card_does_not_match_method"],
      ["2061", "invalid_transaction_data"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `braintree.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "card_declined",
  })),
  // The authorization is gone at capture: the buyer starts again. The card is not at fault.
  ...(
    [
      ["2036", "authorization_not_found"],
      ["2067", "authorization_expired"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `braintree.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "intent_expired",
  })),
  // Braintree or PayPal could not finish the call: try again later.
  ...(
    [
      ["2078", "invalid_secure_payment_data"],
      ["92910", "paypal_communication_error"],
      ["92916", "paypal_order_error"],
      ["92917", "paypal_agreement_error"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `braintree.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "processing_error",
    retriable: true,
  })),
  ...(
    [
      ["91514", "merchant_account_suspended"],
      ["91538", "merchant_account_suspended_refund"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `braintree.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "gateway_account_unavailable",
    message: BRAINTREE_OUR_SIDE,
    exposedToPayer: false,
  })),
  // Our request or the merchant account setup.
  ...(
    [
      ["2040", "invalid_store"],
      ["2042", "invalid_client_id"],
      ["2055", "invalid_division_number"],
      ["2056", "division_limit_exceeded"],
      ["2058", "securecode_not_enabled"],
      ["2097", "paypal_authorization_amount_limit"],
      ["2098", "paypal_authorization_count_limit"],
      ["4006", "capture_amount_exceeded"],
      ["4018", "paypal_pending_not_supported_at_settlement"],
      ["81509", "card_type_not_accepted"],
      ["81528", "amount_too_large"],
      ["82904", "paypal_not_accepted"],
      ["91508", "payment_method_undetermined"],
      ["91513", "merchant_account_id_invalid"],
      ["91525", "vault_disabled"],
      ["91567", "instrument_type_not_accepted"],
      ["91568", "three_d_secure_token_invalid"],
      ["91570", "three_d_secure_data_mismatch"],
      ["91576", "paypal_not_enabled"],
      ["91584", "three_d_secure_merchant_mismatch"],
      ["91585", "three_d_secure_amount_mismatch"],
      ["91598", "instrument_type_not_accepted_by_account"],
      ["915101", "instrument_type_not_accepted_generic"],
      ["92923", "paypal_merchant_account_id_invalid"],
      ["93122", "us_bank_account_not_accepted"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `braintree.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "gateway_request_rejected",
    message: BRAINTREE_OUR_SIDE,
    exposedToPayer: false,
  })),
  // Braintree refused our API keys or their permissions (HTTP 401/403, or the class).
  {
    id: "braintree.code.api_keys_refused",
    field: "code",
    op: "matches",
    value: "^(AUTHENTICATION|AUTHORIZATION)(:.*)?$",
    code: "gateway_request_rejected",
    message:
      "Braintree refused our API keys or their permissions. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  },
  /**
   * Any other VALIDATION error: Braintree says our request was invalid. Matched on the error
   * class, which the adapter passes only after every code rule and the code table missed.
   */
  {
    id: "braintree.category.validation",
    field: "category",
    op: "eq",
    value: "VALIDATION",
    code: "gateway_request_rejected",
    message: BRAINTREE_OUR_SIDE,
    exposedToPayer: false,
  },
];

export function normalizeBraintreeDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  return evaluate(asSignal(raw), BRAINTREE_RULES, BRAINTREE_CODE_TABLE);
}

/**
 * Documented Braintree codes that no call of ours can return as a payment refusal, with the reason.
 */
export const BRAINTREE_CODES_OUR_CALLS_NEVER_RAISE: Readonly<Record<string, string>> =
  neverRaisedBy([
    ["an approval, not a refusal", ["1000", "1001", "1002", "1003", "1004", "1005"]],
    ["Level II/III data and tax; we never send them", ["2049", "2052", "2062"]],
    ["PIN and card-present only", ["2102", "2103", "2104"]],
    ["bank account verification; ACH is not offered", ["2092"]],
    [
      "refunds, reversals and voids of our own transaction, not a payment refusal",
      ["2037", "2054", "2065", "2090", "2095", "4003", "4004"],
    ],
    ["voice authorization only", ["2039"]],
    ["partial authorization; we never request it", ["2035"]],
    ["a settlement status, not a decline", ["4000", "4002"]],
    [
      "a refund's settlement decline: reaches us as refund.failed",
      ["4019", "4020", "4021", "4022", "4023", "4024", "4026"],
    ],
  ]);

/**
 * ⚠️ `expired_card` keeps Stripe's PRE-EXISTING non-retriable answer, and the divergence
 * from RazorPay is left standing rather than resolved here.
 *
 * `expired_card` is not in `TERMINAL`, so `build()` alone would return `retriable: true` —
 * which is what RazorPay returns today. Stripe's inline switch returned `false`, and
 * `retriable: false` is what `isHardDecline` reads as a BAD INSTRUMENT, so it is what moves
 * dunning onto the backup card. For an expired card that is the better behaviour, which
 * makes RazorPay the one that looks wrong.
 *
 * Not "fixed" by adding `expired_card` to `TERMINAL`, because that set is shared: it would
 * change dunning for live RazorPay subscriptions, which is a decision for whoever owns the
 * ladder and not a side effect of aligning Stripe.
 *
 * ⏰ WHEN that decision is made, the cheapest moment is while no ladder is mid-flight.
 * Measured against the live site 2026-09-04: of 38 active INR subscriptions the dunning
 * positions are 42 `stopped`, 34 `exhausted`, 11 `success` and **zero `in_progress`** — so
 * on the India book, today, changing the terminal set would reclassify nothing in flight. So this preserves today's Stripe
 * behaviour exactly — no regression — and the asymmetry is now WRITTEN DOWN in one place
 * instead of being an accident of two code paths.
 */
const STRIPE_OUR_SIDE =
  "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.";

const stripeCode = (
  value: string,
  code: string,
  extra: Partial<DeclineRule> = {},
): DeclineRule => ({
  id: `stripe.code.${value}`,
  field: "code",
  op: "eq",
  value,
  code,
  ...extra,
});

/**
 * Our request, our account or our keys. Booked as a retriable `gateway_error` — what the
 * adapter's throw path booked before these codes were recognised — so dunning keeps its
 * schedule and the instrument is never branded (user decision 2026-11-17: keep retrying).
 */
const stripeOurSide = (value: string): DeclineRule =>
  stripeCode(value, "gateway_error", {
    retriable: true,
    message: STRIPE_OUR_SIDE,
    exposedToPayer: false,
  });

/** A payer-actionable rule: our sentence, shown to the payer. */
const stripePayer = (value: string, code: string, message: string, retriable?: boolean) =>
  stripeCode(value, code, {
    message,
    exposedToPayer: true,
    ...(retriable === undefined ? {} : { retriable }),
  });

/**
 * Stripe's refusals of `refunds.create` → the operator's reason. `refund()` throws them as
 * `ProviderRefusalError`; the rules below only make the codes recognised.
 */
export const STRIPE_REFUND_REFUSALS: Readonly<Record<string, string>> = {
  charge_already_refunded: "The payment is already refunded at the payment provider.",
  charge_disputed:
    "The customer disputed this payment. The payment provider does not refund a disputed payment. Respond to the dispute.",
  refund_disputed_payment:
    "The customer disputed this payment. The payment provider does not refund a disputed payment. Respond to the dispute.",
};

const BANK_DETAILS_WRONG =
  "The bank account details are not correct. Check the details, or use a different bank account.";
const BANK_RESTRICTED =
  "This bank account cannot be used for this payment. Use a different bank account, or contact your bank.";
const BANK_VERIFY_AGAIN =
  "The amounts or the code do not match the deposit in your bank account. Check the deposit, then try again.";
const POSTAL_CODE_WRONG =
  "The postal code does not match the one your bank has. Check the billing address, then try again.";

export const STRIPE_RULES: readonly DeclineRule[] = [
  /**
   * A DEAD MANDATE IS NOT A SOFT FAILURE, and the table alone could not say so.
   *
   * Both codes already map to `mandate_expired` in `STRIPE_CODE_TABLE`, but a table entry
   * carries no `retriable`, so `build()` derives it from `TERMINAL` — and `mandate_expired`
   * PARKS rather than terminates, so it came back `true`. The Retries screen reads that
   * column and labelled INV-100004 "Soft failure" (measured 2026-09-10), telling an
   * operator a retry might work against a mandate Stripe had just called inactive.
   *
   * Our own pre-flight has always disagreed: `mandateExpiredRefusal` books the identical
   * code with `retriable: false` and a message that says outright "retrying this charge
   * cannot succeed". Same fact, two answers, decided by who noticed it first. These rules
   * make the gateway's answer match ours.
   *
   * `mandate_expired` is in `NOT_THE_INSTRUMENTS_FAULT`, so `isHardDecline` stays false
   * and the customer is not told their card is bad. The method is still marked `invalid`
   * (`isDeadMandateDecline`), with the email asking them to authorize again.
   */
  {
    id: "stripe.code.payment_intent_mandate_invalid",
    field: "code",
    op: "eq",
    value: "payment_intent_mandate_invalid",
    code: "mandate_expired",
    retriable: false,
  },
  /**
   * An Indian Stripe account charging a buyer abroad needs the buyer's name and billing
   * address on the Stripe customer (India-exports rule). Stripe refuses the confirm as an
   * `invalid_request_error` but KEEPS the PaymentIntent, so this was thrown, booked nowhere
   * and reported as an orphaned intent (4 times for one buyer, 2026-11-16).
   *
   * The card is fine and the buyer can clear it: add the details, and the next charge syncs
   * them first (`syncProviderCustomerBeforeCharge`). `retriable` stays undefined (→ true)
   * so `isHardDecline` never marks a working card invalid.
   */
  {
    id: "stripe.code.cross_border_classification_missing_name_and_address",
    field: "code",
    op: "eq",
    value: "cross_border_classification_missing_name_and_address",
    code: "billing_details_required",
    message: "Add your billing name and address. Then try again.",
    exposedToPayer: true,
  },
  {
    id: "stripe.code.india_recurring_payment_mandate_canceled",
    field: "code",
    op: "eq",
    value: "india_recurring_payment_mandate_canceled",
    code: "mandate_expired",
    retriable: false,
  },
  // ── 1 · THE INSTRUMENT DOES NOT EXIST ─────────────────────────────────────────
  // Stripe reports these with a generic code and a SPECIFIC message, so a code-only
  // lookup learns nothing and the charge is retried against a payment method Stripe has
  // just said is not there. `retriable: false` is what `isHardDecline` reads as a bad
  // instrument, which marks the method invalid and moves dunning to the backup card —
  // the right move when the method is gone.
  {
    id: "stripe.message.no_such_paymentmethod",
    field: "message",
    op: "matches",
    value: "No such PaymentMethod",
    code: "payment_method_not_found",
    retriable: false,
    message:
      "The saved payment method is no longer available at the payment provider. Add a payment method again.",
    exposedToPayer: true,
  },
  {
    id: "stripe.message.no_such_payment_method",
    field: "message",
    op: "matches",
    value: "No such payment_method",
    code: "payment_method_not_found",
    retriable: false,
    message:
      "The saved payment method is no longer available at the payment provider. Add a payment method again.",
    exposedToPayer: true,
  },
  {
    id: "stripe.message.no_such_customer",
    field: "message",
    op: "matches",
    value: "No such customer",
    code: "payment_method_not_found",
    retriable: false,
    message:
      "The saved payment method is no longer available at the payment provider. Add a payment method again.",
    exposedToPayer: true,
  },
  {
    id: "stripe.message.does_not_have_a_linked_source",
    field: "message",
    op: "matches",
    value: "does not have a linked source",
    code: "payment_method_not_found",
    retriable: false,
    message:
      "The saved payment method is no longer available at the payment provider. Add a payment method again.",
    exposedToPayer: true,
  },

  // ── 2 · THE CARD NETWORK SAID STOP ────────────────────────────────────────────
  // Beneath the gateway's own code the network answers separately, and these two are
  // instructions rather than descriptions. Networks fine acquirers for re-presenting a
  // debit they were told to stop re-presenting, so this is the one group where retrying
  // costs money directly rather than only wasting an attempt.
  {
    id: "stripe.network.previously_declined_do_not_retry",
    field: "network_message",
    op: "eq",
    value: "previously_declined_do_not_retry",
    code: "network_do_not_retry",
    retriable: false,
    message:
      "Your bank asked us not to attempt this payment again. Use a different payment method, or contact your bank.",
    exposedToPayer: true,
  },
  {
    id: "stripe.network.highest_risk_level",
    field: "network_message",
    op: "eq",
    value: "highest_risk_level",
    code: "network_do_not_retry",
    retriable: false,
    message:
      "Your bank asked us not to attempt this payment again. Use a different payment method, or contact your bank.",
    exposedToPayer: true,
  },
  {
    id: "stripe.advice.03",
    field: "recommendation_code",
    op: "eq",
    value: "03",
    code: "network_do_not_retry",
    retriable: false,
    message:
      "Your bank asked us not to attempt this payment again. Use a different payment method, or contact your bank.",
    exposedToPayer: true,
  },
  // Mastercard MAC 21 "payment cancellation": like 03, never retry; a repeat is fined.
  {
    id: "stripe.advice.21",
    field: "recommendation_code",
    op: "eq",
    value: "21",
    code: "network_do_not_retry",
    retriable: false,
    message:
      "Your bank asked us not to attempt this payment again. Use a different payment method, or contact your bank.",
    exposedToPayer: true,
  },
  // Stripe's own advice code when no network advice code came back.
  {
    id: "stripe.advice.do_not_try_again",
    field: "recommendation_code",
    op: "eq",
    value: "do_not_try_again",
    code: "network_do_not_retry",
    retriable: false,
    message:
      "Your bank asked us not to attempt this payment again. Use a different payment method, or contact your bank.",
    exposedToPayer: true,
  },

  // ── THE INDIA E-MANDATE DEBIT WAS NEVER APPROVED ────────────────────────
  // ⚠️ The only rule keyed on `decline_code`, and it has to be. Stripe's India
  // recurring-payments page lists this one in a DECLINE-code table, not in the
  // error-code table beside it, so a caller that carries it only there
  // (`{ declineCode }`) must still match. It sits ABOVE `stripe.code.card_declined`
  // because on a card decline `code` is the generic one and this is the real reason.
  //
  // "Attempting a subsequent payment when the customer has paused permissions to
  // auto-debit, or doesn't authenticate the payment when it's required returns this
  // code." Both halves, one code, and `afa_not_completed` is right for both rather than
  // a compromise: Stripe spells a DEAD mandate `india_recurring_payment_mandate_canceled`
  // (→ `mandate_expired`), so what is left here is the per-debit approval — which a
  // pause withholds and a missed AFA never gives. Telling that payer to re-register a
  // mandate that is still alive would be the wrong remedy.
  //
  // `retriable` left undefined (→ true). `afa_not_completed` is NOT in
  // `NOT_THE_INSTRUMENTS_FAULT`, so `retriable: false` would read as a BAD INSTRUMENT
  // and brand a working card `invalid` over an approval the payer can still give. The
  // park comes from `classifyDecline`, which is where it belongs.
  {
    id: "stripe.decline_code.transaction_not_approved",
    field: "decline_code",
    op: "eq",
    value: "transaction_not_approved",
    code: "afa_not_completed",
  },

  // ── 3 · MADE INTENTIONAL, NOT ACCIDENTAL ──────────────────────────────────────
  // These five were never in the Stripe table. They resolved correctly only because the
  // raw Stripe code is spelled the same as our canonical one, so the passthrough
  // fallback happened to land on the right value — including `card_declined` and
  // `authentication_required`, the two commonest declines on the platform. Renaming a
  // canonical code would have made them silently retriable. Behaviour unchanged; the
  // reason it works is now written down.
  {
    id: "stripe.code.card_declined",
    field: "code",
    op: "eq",
    value: "card_declined",
    code: "card_declined",
  },
  {
    id: "stripe.code.authentication_required",
    field: "code",
    op: "eq",
    value: "authentication_required",
    code: "authentication_required",
  },
  {
    id: "stripe.code.expired_card",
    field: "code",
    op: "eq",
    value: "expired_card",
    code: "expired_card",
  },
  {
    id: "stripe.code.incorrect_cvc",
    field: "code",
    op: "eq",
    value: "incorrect_cvc",
    code: "incorrect_cvc",
  },
  // Hard, Stripe only (user decision 2026-11-17): in production no card that failed with
  // this ever paid later (0 of 7); later tries only returned a generic `card_declined`.
  {
    id: "stripe.code.incorrect_number",
    field: "code",
    op: "eq",
    value: "incorrect_number",
    code: "incorrect_number",
    retriable: false,
  },
  // Same evidence for `restricted_card` (0 of 4 recovered). `card_restricted` is not in
  // TERMINAL (it also carries limits the payer can lift), so each dead meaning says so here.
  {
    id: "stripe.decline_code.restricted_card",
    field: "decline_code",
    op: "eq",
    value: "restricted_card",
    code: "card_restricted",
    retriable: false,
  },
  // "The card, or account the card is connected to, is invalid." Production: 13 declines on
  // 8 cards, none paid later. Visa 46 / Mastercard MAC 01 behind it.
  ...["invalid_account", "new_account_information_available"].map((value): DeclineRule => ({
    id: `stripe.decline_code.${value}`,
    field: "decline_code",
    op: "eq",
    value,
    code: "card_restricted",
    retriable: false,
  })),
  // The card or bank cannot pay this kind of purchase, currency or recurring payment, or
  // the payment details are invalid ("Retries won't succeed"). Only another method pays.
  ...[
    "card_not_supported",
    "currency_not_supported",
    "recurring_not_supported_by_bank",
    "invalid_payment_information",
    "compliance_violation",
  ].map((value): DeclineRule => ({
    id: `stripe.decline_code.${value}`,
    field: "decline_code",
    op: "eq",
    value,
    code: "card_restricted",
    retriable: false,
  })),
  // Stripe's other spelling of the same refusal, which we did not map at all.
  {
    id: "stripe.code.invalid_cvc",
    field: "code",
    op: "eq",
    value: "invalid_cvc",
    code: "incorrect_cvc",
  },

  // ── 4 · A LIMIT ON THE CUSTOMER'S INSTRUMENT ──────────────────────────────────
  // NOT `gateway_limit_exceeded`: that means a ceiling on OUR account and feeds the
  // merchant-side ops alert. These are the payer's own card limits, so they belong with
  // the card declines and must not page us.
  {
    id: "stripe.code.charge_exceeds_source_limit",
    field: "code",
    op: "eq",
    value: "charge_exceeds_source_limit",
    code: "card_declined",
  },
  {
    id: "stripe.code.charge_exceeds_transaction_limit",
    field: "code",
    op: "eq",
    value: "charge_exceeds_transaction_limit",
    code: "card_declined",
  },

  // ── 5 · WE SENT A REQUEST THE GATEWAY WOULD NOT ACCEPT ────────────────────────
  // Re-presenting an identical malformed request cannot succeed, so every one of these
  // spent dunning attempts against a certainty. `payment_intent_payment_attempt_failed`
  // is #63: the adapter learned it on 2026-09-05 through a hardcoded `err.code ===`
  // check, and this is where that knowledge actually belongs.
  {
    id: "stripe.code.payment_intent_payment_attempt_failed",
    field: "code",
    op: "eq",
    value: "payment_intent_payment_attempt_failed",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  },
  /*
   * ⚠️ `payment_intent_mandate_inactive` WAS HERE AND WAS A PHANTOM. Removed 2026-09-10.
   *
   * No such Stripe code exists — it appears nowhere in the installed SDK, while the real
   * one, `payment_intent_mandate_invalid`, is in `PaymentIntents.d.ts` and
   * `SetupAttempts.d.ts`. It was invented while reading the documented union and never
   * checked against it.
   *
   * Worse than dead weight, because the two disagree about the REMEDY: the phantom said
   * `gateway_request_rejected` (merchant-side park, nobody but us can clear it) while the
   * real code maps to `mandate_expired` in STRIPE_CODE_TABLE (the mandate lapsed, the
   * CUSTOMER re-authorises). Had it ever matched it would have sent the wrong party after
   * the problem.
   *
   * Proven by the production log for INV-100004 (2026-09-10): Stripe answered
   * `"code": "payment_intent_mandate_invalid"` with "Only active mandates can be used with
   * PaymentIntents." — the exact message this rule was invented to catch.
   *
   * This file's own warning, one section up, is the rule it broke: guessing a code creates
   * a mapping that silently never fires, which is worse than the honest fall-through.
   * `payment_intent_mandate_invalid` needs no rule; the table already names it correctly.
   */
  {
    id: "stripe.code.payment_intent_invalid_parameter",
    field: "code",
    op: "eq",
    value: "payment_intent_invalid_parameter",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  },
  {
    id: "stripe.code.payment_intent_unexpected_state",
    field: "code",
    op: "eq",
    value: "payment_intent_unexpected_state",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  },
  {
    id: "stripe.code.payment_method_unexpected_state",
    field: "code",
    op: "eq",
    value: "payment_method_unexpected_state",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  },
  {
    id: "stripe.code.payment_method_not_available",
    field: "code",
    op: "eq",
    value: "payment_method_not_available",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  },
  {
    id: "stripe.code.invalid_request_encoding",
    field: "code",
    op: "eq",
    value: "invalid_request_encoding",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  },
  {
    id: "stripe.code.charge_invalid_parameter",
    field: "code",
    op: "eq",
    value: "charge_invalid_parameter",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  },
  {
    id: "stripe.code.platform_api_key_expired",
    field: "code",
    op: "eq",
    value: "platform_api_key_expired",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  },
  // Stripe reports this as a CATEGORY, and the catch-all below reads it there — but it
  // also appears as a bare code, which the category rule cannot see.
  {
    id: "stripe.code.invalid_request_error",
    field: "code",
    op: "eq",
    value: "invalid_request_error",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  },

  /* ── 5b · EVERY OTHER DOCUMENTED CODE OUR CALLS CAN RAISE (2026-11-17) ──────────
   * Source: docs/references/STRIPE_ERROR_CODES.md. Codes our calls cannot raise are in
   * `STRIPE_CODES_OUR_CALLS_NEVER_RAISE`; test/unit/stripe-error-code-coverage.test.ts
   * keeps the two lists complete and disjoint.
   *
   * `retriable: false` is set only where the instrument itself cannot pay: `isHardDecline`
   * reads it as a bad instrument and marks the method invalid. */

  // Our request, keys or account state: retried as `gateway_error`, never branding the card.
  ...[
    "api_key_expired",
    "secret_key_required",
    "livemode_mismatch",
    "tls_version_unsupported",
    "parameter_invalid_empty",
    "parameter_invalid_integer",
    "parameter_invalid_string_blank",
    "parameter_invalid_string_empty",
    "parameter_missing",
    "parameter_unknown",
    "parameters_exclusive",
    "payment_method_invalid_parameter",
    "payment_method_invalid_parameter_testmode",
    "setup_intent_invalid_parameter",
    "setup_intent_unexpected_state",
    "intent_invalid_state",
    "intent_verification_method_missing",
    "status_transition_invalid",
    "payment_intent_incompatible_payment_method",
    "payment_method_unsupported_type",
    "payment_method_bank_account_already_verified",
    "invalid_characters",
    "invalid_mandate_reference_prefix_format",
    "url_invalid",
    "country_code_invalid",
    "token_already_used",
    // Below Stripe's minimum, above its maximum, or not a valid amount: we billed it.
    "amount_too_small",
    "amount_too_large",
    "invalid_charge_amount",
    // The merchant must detach old methods; the payer cannot.
    "customer_max_payment_methods",
    // Below the message rules on purpose: "No such PaymentMethod" / "No such customer"
    // match there first. What is left is an id we sent that does not exist — our bug.
    "resource_missing",
  ].map(stripeOurSide),

  // Merchant configuration: the account cannot take this payment. `recurring_not_enabled`
  // parks with an ops alert; retriable stays true so the instrument is not branded.
  ...[
    "capability_not_active",
    "testmode_charges_only",
    "sepa_unsupported_account",
    "action_blocked",
    "anomalous_money_movement_request",
  ].map((v) => stripeCode(v, "recurring_not_enabled")),

  // Transient: Stripe says to try again later.
  ...[
    "processing_error",
    "lock_timeout",
    "rate_limit",
    "idempotency_key_in_use",
    "token_in_use",
    "acss_debit_session_incomplete",
    "payment_method_microdeposit_processing_error",
  ].map((v) => stripeCode(v, "processing_error")),

  // The payer must approve or authenticate. Same token as the existing
  // `*_authentication_failure` and `payment_intent_payment_attempt_expired` entries.
  stripePayer(
    "authentication_failure",
    "authentication_required",
    "Your bank could not confirm that you approved this payment. Try again, and complete the check from your bank.",
  ),
  stripePayer(
    "payment_intent_action_required",
    "authentication_required",
    "Your bank must confirm this payment. Try again, and complete the check from your bank.",
  ),
  stripePayer(
    "payment_intent_amount_reconfirmation_required",
    "authentication_required",
    "The payment amount changed. Check the new amount, then try again.",
  ),
  stripePayer(
    "setup_intent_setup_attempt_expired",
    "authentication_required",
    "The time to approve this payment method ended. Try again, and complete the check from your bank.",
  ),

  // The card details are wrong or the card cannot pay. `invalid_number` and
  // `payment_method_restricted` (lost or stolen) can never succeed on this instrument.
  stripePayer(
    "invalid_number",
    "incorrect_number",
    "The card number is not correct. Check the card details, then try again.",
    false,
  ),
  stripePayer(
    "invalid_expiry_month",
    "expired_card",
    "The card expiry date is not correct. Check the card details, then try again.",
  ),
  stripePayer(
    "invalid_expiry_year",
    "expired_card",
    "The card expiry date is not correct. Check the card details, then try again.",
  ),
  stripePayer(
    "expired_payment_method",
    "expired_card",
    "The payment method expired. Use a different payment method.",
  ),
  stripePayer(
    "payment_method_restricted",
    "card_restricted",
    "Your bank does not let this payment method pay. Use a different payment method, or contact your bank.",
    false,
  ),
  // The method is fine for its own currency, so it is not branded invalid.
  stripePayer(
    "payment_method_currency_mismatch",
    "card_restricted",
    "This payment method cannot pay in this currency. Use a different payment method.",
  ),
  stripePayer(
    "setup_attempt_failed",
    "card_declined",
    "We could not save this payment method. Use a different payment method.",
  ),

  // The billing details are wrong or missing. The payer corrects them; the card is fine.
  stripePayer("incorrect_zip", "incorrect_address", POSTAL_CODE_WRONG),
  stripePayer("incorrect_postal_code", "incorrect_address", POSTAL_CODE_WRONG),
  stripePayer("postal_code_invalid", "incorrect_address", POSTAL_CODE_WRONG),
  stripePayer(
    "incorrect_address",
    "incorrect_address",
    "The billing address does not match the one your bank has. Check the billing address, then try again.",
  ),
  stripePayer(
    "payment_method_billing_details_address_missing",
    "billing_details_required",
    "Add your billing address. Then try again.",
  ),
  stripePayer(
    "email_invalid",
    "billing_details_required",
    "The email address is not correct. Check the email address, then try again.",
  ),

  // Bank debits (ACH, SEPA, BECS, Bacs, ACSS). Wrong details and restricted accounts are
  // TERMINAL: only a different account pays.
  stripePayer("account_number_invalid", "bank_account_invalid_details", BANK_DETAILS_WRONG),
  stripePayer("routing_number_invalid", "bank_account_invalid_details", BANK_DETAILS_WRONG),
  stripePayer("clearing_code_unsupported", "bank_account_invalid_details", BANK_DETAILS_WRONG),
  stripePayer(
    "payment_method_microdeposit_failed",
    "bank_account_invalid_details",
    BANK_DETAILS_WRONG,
  ),
  stripePayer(
    "account_holder_name_verification_failed",
    "bank_account_invalid_details",
    "The account holder name does not match the name at your bank. Check the name, or use a different bank account.",
  ),
  stripePayer("bank_account_bad_routing_numbers", "bank_account_restricted", BANK_RESTRICTED),
  stripePayer("bank_account_declined", "bank_account_restricted", BANK_RESTRICTED),
  stripePayer("bank_account_restricted", "bank_account_restricted", BANK_RESTRICTED),
  stripePayer("bank_account_unusable", "bank_account_restricted", BANK_RESTRICTED),
  stripePayer("payment_method_bank_account_blocked", "bank_account_restricted", BANK_RESTRICTED),
  // Micro-deposit checks. A wrong entry can be tried again; a spent or expired check
  // cannot, so those two brand the method.
  stripePayer(
    "payment_method_microdeposit_verification_amounts_invalid",
    "bank_account_not_verified",
    BANK_VERIFY_AGAIN,
  ),
  stripePayer(
    "payment_method_microdeposit_verification_amounts_mismatch",
    "bank_account_not_verified",
    BANK_VERIFY_AGAIN,
  ),
  stripePayer(
    "payment_method_microdeposit_verification_descriptor_code_mismatch",
    "bank_account_not_verified",
    BANK_VERIFY_AGAIN,
  ),
  stripePayer(
    "bank_account_verification_failed",
    "bank_account_not_verified",
    "We could not confirm this bank account. Check the deposit in your bank account, or use a different bank account.",
  ),
  stripePayer(
    "payment_method_microdeposit_verification_attempts_exceeded",
    "bank_account_not_verified",
    "The number of attempts to confirm this bank account is at its limit. Add the bank account again, or use a different one.",
    false,
  ),
  stripePayer(
    "payment_method_microdeposit_verification_timeout",
    "bank_account_not_verified",
    "The time to confirm this bank account ended. Add the bank account again, or use a different one.",
    false,
  ),

  // Manual capture. `consumeIntent` still throws these; the code names the outcome.
  ...[
    "capture_charge_authorization_expired",
    "capture_unauthorized_payment",
    "charge_expired_for_capture",
  ].map((v) => stripeCode(v, "capture_failed")),

  // Refunds: `refund()` reads `STRIPE_REFUND_REFUSALS` for the operator's reason.
  ...Object.entries(STRIPE_REFUND_REFUSALS).map(([v, message]) =>
    stripeCode(v, "gateway_request_rejected", { retriable: false, message, exposedToPayer: false }),
  ),

  // ── 6 · THE CATCH-ALL, AND IT MUST STAY LAST ──────────────────────────────────
  // Anything specific above wins by position; what falls through here is an API-level
  // rejection, which is ours to fix and never the payer's.
  {
    id: "stripe.category.invalid_request_error",
    field: "category",
    op: "eq",
    value: "invalid_request_error",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  },
];

const CONNECT = "Connect platforms and connected accounts; we bill on the merchant's own account";
const PAYOUTS = "payouts, transfers and balance; we never move money out";
const BILLING = "Stripe's invoice, subscription and coupon objects; our engine owns them";
const ORDERS = "Orders, SKUs, inventory and shipping; we never use them";
const TAX = "Stripe Tax and customer tax ids; we never send tax data";
const LEGACY = "legacy Sources, Tokens and Charges; we use PaymentIntents and PaymentMethods";

/**
 * Documented Stripe codes that no call of ours (or webhook about its objects) can return,
 * with the reason. They get no rule: a rule for a code that cannot arrive is dead config.
 */
export const STRIPE_CODES_OUR_CALLS_NEVER_RAISE: Readonly<Record<string, string>> = {
  account_country_invalid_address: CONNECT,
  account_error_country_change_requires_additional_steps: CONNECT,
  account_invalid: CONNECT,
  bank_account_unverified: CONNECT,
  country_unsupported: CONNECT,
  not_allowed_on_standard_account: CONNECT,
  platform_account_required: CONNECT,
  progressive_onboarding_limit_exceeded: CONNECT,
  state_unsupported: CONNECT,

  balance_insufficient: PAYOUTS,
  balance_invalid_parameter: PAYOUTS,
  instant_payouts_config_disabled: PAYOUTS,
  instant_payouts_limit_exceeded: PAYOUTS,
  instant_payouts_unsupported: PAYOUTS,
  invalid_card_type: PAYOUTS,
  payouts_limit_exceeded: PAYOUTS,
  payouts_not_allowed: PAYOUTS,
  transfer_source_balance_parameters_mismatch: PAYOUTS,
  transfers_not_allowed: PAYOUTS,

  cardholder_phone_number_required: "Issuing; we never issue cards",

  terminal_location_country_unsupported: "Terminal; we take no in-person payments",
  terminal_reader_busy: "Terminal; we take no in-person payments",
  terminal_reader_hardware_fault: "Terminal; we take no in-person payments",
  terminal_reader_invalid_location_for_activation: "Terminal; we take no in-person payments",
  terminal_reader_invalid_location_for_payment: "Terminal; we take no in-person payments",
  terminal_reader_offline: "Terminal; we take no in-person payments",
  terminal_reader_timeout: "Terminal; we take no in-person payments",

  forwarding_api_inactive: "Vault and Forward API; we never forward card data",
  forwarding_api_invalid_parameter: "Vault and Forward API; we never forward card data",
  forwarding_api_retryable_upstream_error: "Vault and Forward API; we never forward card data",
  forwarding_api_upstream_connection_error: "Vault and Forward API; we never forward card data",
  forwarding_api_upstream_connection_timeout: "Vault and Forward API; we never forward card data",
  forwarding_api_upstream_error: "Vault and Forward API; we never forward card data",

  coupon_expired: BILLING,
  customer_max_subscriptions: BILLING,
  invoice_no_customer_line_items: BILLING,
  invoice_no_payment_method_types: BILLING,
  invoice_no_subscription_line_items: BILLING,
  invoice_not_editable: BILLING,
  invoice_on_behalf_of_not_editable: BILLING,
  invoice_payment_intent_requires_action: BILLING,
  invoice_upcoming_none: BILLING,
  promotion_code_customer_missing_first_time: BILLING,
  promotion_code_customer_not_first_time: BILLING,
  resource_already_exists: "user-chosen object ids (plans, coupons); we never set an id",

  out_of_inventory: ORDERS,
  product_inactive: ORDERS,
  sku_inactive: ORDERS,
  shipping_address_invalid: ORDERS,
  shipping_calculation_failed: ORDERS,
  taxes_calculation_failed: ORDERS,

  customer_tax_location_invalid: TAX,
  invalid_tax_location: TAX,
  payment_intent_automatic_tax_incomplete: TAX,
  stripe_tax_inactive: TAX,
  tax_id_invalid: TAX,
  tax_id_prohibited: TAX,

  alipay_upgrade_required: LEGACY,
  bitcoin_upgrade_required: LEGACY,
  invalid_source_usage: LEGACY,
  missing: LEGACY,
  bank_account_exists: LEGACY,
  // A PaymentIntent capture answers `payment_intent_unexpected_state` instead.
  charge_already_captured: LEGACY,

  financial_connections_account_inactive:
    "Financial Connections data refresh; we only link the account for a debit",
  financial_connections_no_successful_transaction_refresh:
    "Financial Connections data refresh; we only link the account for a debit",

  payment_intent_konbini_rejected_confirmation_number: "Konbini; we never offer it",
  return_intent_already_processed: "confirming a refund; we never confirm refunds",
};

/**
 * Cashfree. Subscription debits report only free text (`failure_details.failure_reason`,
 * e.g. "DEBIT HAS BEEN FAILED | INSUFFICIENT FUNDS IN CUSTOMER (REMITTER) ACCOUNT"), so
 * most rules match the MESSAGE. API refusals carry `code` and `type` (the category).
 * Source: Cashfree's subscription error-codes page, read 2026-10-24.
 *
 * The table maps a PG payment's `error_details.error_reason` (Cashfree's payment error
 * list, read 2026-10-26). Only unambiguous reasons; the rest keep the retry default.
 */
export const CASHFREE_CODE_TABLE: Record<string, string> = {
  insufficient_funds: "insufficient_funds",
  expired_card: "expired_card",
  card_expired: "expired_card",
  invalid_card_number: "incorrect_number",
  invalid_cardnumber: "incorrect_number",
  invalid_cvv: "incorrect_cvc",
  invalid_card_cvv: "incorrect_cvc",
  invalid_pin: "card_declined",
  invalid_mpin: "card_declined",
  invalid_atmpin: "card_declined",
  pin_try_exceeded: "card_declined",
  auth_declined: "do_not_honor",
  not_honoured: "do_not_honor",
  account_blocked: "do_not_honor",
  restricted_card: "card_restricted",
  inactive_card: "card_restricted",
  lost_card: "lost_card",
  fraud_detected: "fraudulent",
  account_closed: "bank_account_closed",
  account_not_exist: "bank_account_not_found",
  invalid_vpa: "payment_method_not_found",
  expired_vpa: "payment_method_not_found",
  vpa_not_exist: "payment_method_not_found",
  // "Issuer bank or payment service provider declined the transaction": the UPI ID may be fine.
  vpa_resolution_failed: "do_not_honor",
  auth_failure: "authentication_required",
  // Transient faults at the bank, the PSP, NPCI or Cashfree.
  bank_offline: "processing_error",
  issuer_bank_offline: "processing_error",
  bank_server_downtime: "processing_error",
  network_timeout: "processing_error",
  host_timeout: "processing_error",
  issuer_timeout: "processing_error",
  psp_unavailable: "processing_error",
  psp_timeout: "processing_error",
  psp_unresponsive: "processing_error",
  server_error: "processing_error",
  system_error: "processing_error",
  technical_error: "processing_error",
  general_failure: "processing_error",
  service_provider_down: "processing_error",
  unknown_network_error: "processing_error",
  network_error: "processing_error",
};

const CASHFREE_OURS =
  "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.";

const cfMessage = (slug: string, value: string, code: string, extra: Partial<DeclineRule> = {}) =>
  ({
    id: `cashfree.message.${slug}`,
    field: "message",
    op: "contains",
    value,
    code,
    ...extra,
  }) as const;

const cfCode = (value: string, code: string, extra: Partial<DeclineRule> = {}): DeclineRule => ({
  id: `cashfree.code.${value.toLowerCase()}`,
  field: "code",
  op: "eq",
  value,
  code,
  ...extra,
});

const cfPayer = (value: string, code: string, message: string, retriable?: boolean) =>
  cfCode(value, code, {
    message,
    exposedToPayer: true,
    ...(retriable === undefined ? {} : { retriable }),
  });

const CF_MANDATE_GONE =
  "The payment mandate is no longer active. Set up the payment method again to continue your subscription.";
const CF_SEE_BANK =
  "Your bank stopped the payment. Contact your bank to correct the account, or use a different payment method.";

export const CASHFREE_RULES: readonly DeclineRule[] = [
  /**
   * ── A PG PAYMENT'S `error_reason` (§4 of CASHFREE_ERROR_CODES.md) ──────────────
   *
   * First, because the same signal carries `error_description`, whose words would otherwise
   * meet a message rule: `account_closed` reads "blocked by the network" and was booked
   * `do_not_honor`. The reason is the more exact field.
   */
  ...Object.entries(CASHFREE_CODE_TABLE).map(([value, code]) => cfCode(value, code)),
  // Our request, our terminal or our account at the bank: never the payer's instrument.
  ...[
    "invalid_format",
    "encryption_error",
    "credentials_missing",
    "amount_mismatch",
    "currency_mismatch",
    "inactive_terminal",
    "invalid_request_error",
    "invalid_transaction",
    "Iinvalid_bank_id",
    "Invalid_bank_id",
    "invalid_amount",
    "invalid_merchant",
    "invalid_transaction_date",
    "terminal_configuration_error",
    "invalid_currency",
    "minimum_amount_limit",
    "maximum_amount_limit",
    "merchant_transaction_limit",
    "amount_limit_exceed",
    "currency_not_supported",
    "permission_denied",
    "payment_instrument_not_register",
    "account_blocked_merchant",
    "invalid_argument",
    "transaction_details_missing",
    "bad_request",
  ].map((v) => cfCode(v, "gateway_request_rejected")),
  // Gateway, network and bank faults: the next attempt can pay.
  ...[
    "response_error",
    "transaction_timeout",
    "bin_not_allowed",
    "debit_reversal_timeout",
    "sf_not_processed",
    "credit_reversal_timeout",
    "acquirer_bank_offline",
    "external_error",
    "service_forbidden",
    "unknown_error",
    "acquirer_not_participating",
    "invalid_route_service",
    "invalid_response_code",
    "acquirer_error",
    "response_awaited",
    "unknown_system_error",
    "service_unavilable",
    "cutoff_time",
    "bank_decline_throttle",
    "psp_decline_throttle",
    "bank_decline_response_time",
    "PSP_server_downtime",
    "transaction_not_captured",
    "request_not_found",
    "url_not_found",
    "retry_transaction",
    "credit_failed",
    "duplicate_transaction",
    "duplicate_request",
  ].map((v) => cfCode(v, "processing_error")),
  // A plain refusal by the bank or the payer's app.
  ...[
    "transaction_reverted",
    "debit_failed",
    "psp_declined",
    "transaction_failed",
    "issuer_not_found",
    "authorisation_error",
    "no_card_customer",
  ].map((v) => cfCode(v, "card_declined")),
  ...[
    "risk_denied",
    "exceeds_risk",
    "psp_decline_spam",
    "compliance_violation",
    "law_violation",
    "lost_account",
    "account_blocked_customer",
  ].map((v) => cfCode(v, "do_not_honor")),
  // The payer blocked us in their UPI app. Only they can undo it.
  cfPayer("merchant_blocked", "do_not_honor", IN_MERCHANT_BLOCKED),
  // The instrument is blocked, inactive or barred from this payment: another one pays.
  ...[
    "restricted_usage",
    "psp_blocked",
    "psp_unregistered",
    "multiple_names_linked",
    "mobile_number_change",
    "multiple_mobilenumbers_linked",
    "invalid_card_status",
    "account_holder_restricted",
    "restricted_by_bank",
    "account_restricted",
    "account_restriction",
    "unauthorized_user",
    "account_inactive_customer",
  ].map((v) => cfCode(v, "card_restricted")),
  // Not permitted to the cardholder (Visa 57, never resubmit) or a card type this payment
  // cannot take: only another card pays.
  ...[
    "card_type_not_allowed",
    "transaction_not_allowed",
    "not_permitted",
    "card_holder_not_participating",
  ].map((v) => cfCode(v, "card_restricted", { retriable: false })),
  cfPayer(
    "phone_number_not_linked",
    "card_restricted",
    "Your phone number is not registered with your bank. Register it with your bank, or use a different payment method.",
  ),
  // "Customer account is closed".
  cfCode("inactive_account", "bank_account_closed"),
  // The buyer left, cancelled or let the page expire. PG payments are on-session only.
  ...[
    "customer_inactive",
    "customer_cancelled",
    "request_expired",
    "user_dropped",
    "user_cancelled",
    "user_decline",
    "transaction_time_limit",
  ].map((v) => cfCode(v, "payment_abandoned")),
  ...[
    "invalid_otp",
    "authentication_error",
    "authorization_failure",
    "auth_timeout",
    "inactive_pin",
  ].map((v) => cfCode(v, "authentication_required")),
  ...["transaction_pin_limit", "attempts_exceeded"].map((v) =>
    cfPayer(v, "try_again_later", IN_WRONG_CODE_TOO_OFTEN),
  ),
  // The payer's own limits.
  ...["transaction_amount_limit", "debit_amount_limit", "credit_limit", "limit_exceed"].map((v) =>
    cfPayer(v, "insufficient_funds", IN_PAYER_LIMIT),
  ),
  ...[
    "daily_amount_limit",
    "daily_limit_exceed",
    "transaction_count_limit",
    "transaction_frequency_limit",
  ].map((v) => cfPayer(v, "retry_too_soon", IN_DAILY_LIMIT)),
  // "Per transaction limit exceeded as set by the remitter bank": as the message rule says.
  cfCode("transaction_limit_exceed", "mandate_ceiling_exceeded"),
  // Details the payer typed.
  ...["invalid_expiry_date", "invalid_card_expiry", "invalid_expiray_date"].map((v) =>
    cfPayer(v, "expired_card", IN_EXPIRY_WRONG),
  ),
  cfPayer("invalid_card_holder_name", "card_declined", IN_CARD_NAME_WRONG),
  cfCode("no_card_record", "incorrect_number"),
  ...["invalid_account_number", "invalid_account"].map((v) =>
    cfCode(v, "bank_account_invalid_details"),
  ),
  cfPayer("account_number_missing", "bank_account_invalid_details", IN_BANK_DETAILS, true),
  cfPayer(
    "invalid_phone_number",
    "billing_details_required",
    "The phone number is not correct. Check it, then try again.",
  ),

  /**
   * ── A SUBSCRIPTION DEBIT'S `failure_reason` (§5a–5c) ──────────────────────────
   * Free text, so these match words. Order matters where one string holds another.
   */
  cfMessage("insufficient_funds", "insufficient", "insufficient_funds"),
  cfMessage("account_closed", "account closed", "bank_account_closed"),
  cfMessage("account_does_not_exist", "account does not exist", "bank_account_not_found"),
  cfMessage("not_cbs_account", "not a cbs act", "bank_account_invalid_details"),
  /**
   * "Not Arranged For or Exceeds arrangement": an overdraft shortfall, and Cashfree allows
   * re-presenting it (Subscriptions FAQ). Was `debit_not_authorized`, which ended the
   * subscription; insufficient funds since 2026-11-17 (user decision). Two cycles in a row
   * on one mandate park the invoice (`REPEAT_REFUSAL_PARKS_RULES`).
   */
  cfMessage("not_arranged_for", "not arranged for", "insufficient_funds"),
  cfMessage("account_max_debit_limit", "maximum debit limit", "insufficient_funds", {
    message: IN_PAYER_LIMIT,
    exposedToPayer: true,
  }),
  // The payer stopped this one debit at the bank. The mandate stays active.
  cfMessage("stopped_by_drawer", "stopped by drawer", "debit_cancelled_by_payer"),
  cfMessage("item_cancelled", "item cancelled", "debit_cancelled_by_payer"),
  cfMessage(
    "returned_customer_request",
    "returned as per customer request",
    "debit_cancelled_by_payer",
  ),
  // "Further debits are not possible for this bank account": only another account pays.
  ...(
    [
      ["court_order", "stopped under court order"],
      ["account_under_litigation", "account under litigation"],
      ["account_inoperative", "account inoperative"],
      ["dormant_account", "dormant account"],
    ] as const
  ).map(([slug, value]) => cfMessage(slug, value, "bank_account_restricted")),
  cfMessage("no_such_account", "no such account", "bank_account_not_found"),
  ...(
    [
      ["account_holder_expired", "account holder expired"],
      ["customer_insolvent", "customer insolvent"],
    ] as const
  ).map(([slug, value]) => cfMessage(slug, value, "bank_account_closed")),
  cfMessage("account_blocked", "blocked", "do_not_honor"),
  // The payer's own ceiling: the e-mandate limit or the bank's per-debit limit.
  cfMessage("emandate_limit", "e-mandate limit", "mandate_ceiling_exceeded"),
  cfMessage("per_transaction_limit", "per transaction limit exceeded", "mandate_ceiling_exceeded"),
  cfMessage("psp_amount_cap", "beyond psp specified amount cap", "mandate_ceiling_exceeded"),
  cfMessage(
    "mandate_request_limit",
    "mandate request limit has breached",
    "mandate_cycle_limit_exceeded",
  ),
  // Revoked, cancelled, deactivated or unknown: only a new mandate recovers it.
  ...(
    [
      ["mandate_revoked", "mandate has been revoked"],
      ["mandate_cancelled", "mandate cancelled"],
      ["inactive_mandate", "inactive mandate"],
      ["invalid_mandate_info", "invalid mandate info"],
      ["subscription_not_active", "subscription is not active"],
      ["no_details_for_mandate", "no details available for requested mandatereqid"],
      // "The mandate cannot be edited, so the merchant must create a new mandate."
      ["customer_name_mismatch", "customer name mismatch"],
    ] as const
  ).map(([slug, value]) =>
    cfMessage(slug, value, "mandate_expired", {
      retriable: false,
      message: CF_MANDATE_GONE,
      exposedToPayer: true,
    }),
  ),
  cfMessage("invalid_vpa", "invalid virtual address", "payment_method_not_found", {
    retriable: false,
  }),
  cfMessage("suspected_fraud", "suspected fraud", "fraudulent"),
  cfMessage("do_not_honour", "do not honour", "do_not_honor"),
  cfMessage("compliance_violation", "compliance violation", "do_not_honor"),
  // The payer must act at the bank (KYC, documents, Aadhaar); then the next debit pays.
  ...(
    [
      ["refer_to_branch", "customer to refer to the branch"],
      ["kyc_pending", "kyc documents pending"],
      ["documents_pending", "documents pending"],
      ["aadhaar_not_mapped", "aadhaar number not mapped"],
      ["aadhaar_no_mobile", "does not have mobile number registered with uidai"],
      ["small_account", "first transaction to be from base branch"],
    ] as const
  ).map(([slug, value]) =>
    cfMessage(slug, value, "card_restricted", { message: CF_SEE_BANK, exposedToPayer: true }),
  ),
  cfMessage(
    "payer_account_validation",
    "payer account validation failure",
    "bank_account_invalid_details",
    {
      retriable: true,
      message: IN_BANK_DETAILS,
      exposedToPayer: true,
    },
  ),
  // The mandate setup was not finished by the payer.
  ...(
    [
      ["no_action_by_customer", "no action performed by customer"],
      ["collect_expired", "collect expired"],
      ["respauthmandate_expired", "respauthmandate expired"],
    ] as const
  ).map(([slug, value]) => cfMessage(slug, value, "afa_not_completed")),
  ...(
    [
      ["respmandate_declined", "respmandate declined by remitter bank"],
      ["respauthmandate_declined", "respauthmandate declined by psp"],
      ["no_appropriate_response_code", "not able to find any appropriate response code"],
    ] as const
  ).map(([slug, value]) => cfMessage(slug, value, "card_declined")),
  // A debit already made in this cycle: wait for the next window.
  cfMessage("mandate_already_honoured", "mandate is already honoured", "retry_too_soon"),
  // Our request or the mandate data we registered.
  ...(
    [
      ["mandate_signature_tampered", "mandate signature is tampered"],
      ["duplicate_mandate_request", "duplicate mandate request"],
      ["mandate_qr_tampered", "mandate qr tampered"],
      ["invalid_frequency", "invalid frequency"],
      ["invalid_amount", "invalid amount (remitter)"],
      ["reg_id_details_missing", "regiddetails must be present"],
      ["id_name_missing", "id name must be present"],
    ] as const
  ).map(([slug, value]) =>
    cfMessage(slug, value, "gateway_request_rejected", {
      message: CASHFREE_OURS,
      exposedToPayer: false,
    }),
  ),
  // Transient faults at the bank, NPCI or Cashfree. The next attempt can succeed.
  ...(
    [
      ["timeout", "timeout"],
      ["bank_not_available", "bank not available"],
      ["high_response_time", "high response time"],
      ["no_response", "no response received"],
      ["cbs_offline", "cbs offline"],
      ["network_failure_cbs", "network failure (cbs)"],
      ["internal_payment_failed", "internal payment failed"],
      ["previous_request_in_progress", "previous request in progress"],
      ["charge_not_on_time", "charge couldn't happen on time"],
      ["notify_failed", "unable to notify the customer"],
      ["notification_not_sent", "notification couldn't be sent"],
      ["transaction_open_status", "transaction open status"],
      ["invalid_response_code", "invalid response code"],
      ["add_resln_dispatch_failed", "add_resln_dispatch_failed"],
    ] as const
  ).map(([slug, value]) => cfMessage(slug, value, "processing_error")),
  // Controlled-flow refusals: a notice or an execution already in progress.
  {
    id: "cashfree.code.prev_pdn_in_progress",
    field: "code",
    op: "eq",
    value: "prev_pdn_in_progress",
    code: "processing_error",
  },
  {
    id: "cashfree.code.prev_execution_in_progress",
    field: "code",
    op: "eq",
    value: "prev_execution_in_progress",
    code: "processing_error",
  },
  {
    id: "cashfree.category.rate_limit_error",
    field: "category",
    op: "eq",
    value: "rate_limit_error",
    code: "processing_error",
  },
  // Our keys or our request. Never the payer's instrument, so retriable stays the default:
  // `false` would mark a working method invalid.
  ...["authentication_error", "idempotency_error", "validation_error"].map((value) => ({
    id: `cashfree.category.${value}`,
    field: "category" as const,
    op: "eq" as const,
    value,
    code: "gateway_request_rejected",
    message: CASHFREE_OURS,
    exposedToPayer: false,
  })),
  // A product not enabled on our Cashfree account: parks for ops, the method stays valid.
  {
    id: "cashfree.category.feature_not_enabled",
    field: "category",
    op: "eq",
    value: "feature_not_enabled",
    code: "recurring_not_enabled",
  },
  // Catch-all for any other API refusal.
  {
    id: "cashfree.category.invalid_request_error",
    field: "category",
    op: "eq",
    value: "invalid_request_error",
    code: "gateway_request_rejected",
    message: CASHFREE_OURS,
    exposedToPayer: false,
  },
  // "DEBIT HAS BEEN FAILED" with no reason after it. LAST: every other debit text holds it.
  cfMessage("debit_failed", "debit has been failed", "card_declined"),
];

/**
 * Documented Cashfree signals that no call of ours can return, with the reason. They get no
 * rule: a rule for a signal that cannot arrive is dead config.
 */
const CF_TRANSPORT =
  "a 5xx or transport failure: `create()` retries it with the same key, then reads the payment; never booked as a decline";
export const CASHFREE_CODES_OUR_CALLS_NEVER_RAISE: Readonly<Record<string, string>> = {
  invalid_google_pay_user: "Google Pay's own API (§1e); our checkout runs in Cashfree's JS SDK",
  fingerprint_mismatch: "Aadhaar biometric payments; we never offer them",
  api_error: CF_TRANSPORT,
  bad_gateway_error: CF_TRANSPORT,
  api_connection_error: CF_TRANSPORT,
};

/**
 * Refusals that park the invoice when the same mandate also ended its previous cycle with
 * them. Cashfree files "Not Arranged For" as a balance shortfall on one page and as a debit
 * facility the account lacks on another; a second cycle in a row reads as the latter.
 */
export const REPEAT_REFUSAL_PARKS_RULES: ReadonlySet<string> = new Set([
  "cashfree.message.not_arranged_for",
]);

/** Does this stored failure text match one of `REPEAT_REFUSAL_PARKS_RULES`? */
export function parksWhenRepeated(message: string | null | undefined): boolean {
  if (!message) return false;
  for (const id of REPEAT_REFUSAL_PARKS_RULES) {
    const rule = declineRuleById(id);
    if (rule && ruleMatches(rule, { message })) return true;
  }
  return false;
}

export function normalizeCashfreeDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  return evaluate(asSignal(raw), CASHFREE_RULES, CASHFREE_CODE_TABLE);
}

/**
 * Adyen: `refusalReasonCode` (Adyen's refusal-reasons table, 0–50) → canonical tokens. The
 * signal code is the numeric refusal code; API validation errors arrive as `api:<errorCode>`
 * so they never collide with it. Adyen gives retry advice for a handful of codes only.
 */
export const ADYEN_CODE_TABLE: Record<string, string> = {
  "2": "card_declined",
  "3": "card_declined",
  "4": "processing_error",
  "7": "card_declined",
  "8": "incorrect_number",
  "9": "processing_error",
  "10": "card_restricted",
  "11": "authentication_required",
  "12": "insufficient_funds",
  "14": "fraudulent",
  "15": "processing_error",
  "16": "card_declined",
  "17": "card_declined",
  "18": "card_declined",
  "19": "card_declined",
  "20": "card_declined",
  "21": "processing_error",
  "22": "card_declined",
  "23": "card_restricted",
  "24": "incorrect_cvc",
  "25": "card_restricted",
  "27": "card_declined",
  "28": "insufficient_funds",
  "29": "card_declined",
  "31": "fraudulent",
  "32": "card_declined",
  "33": "authentication_required",
  "34": "card_declined",
  "35": "card_declined",
  "36": "authentication_required",
  "37": "card_declined",
  "38": "authentication_required",
  "39": "authentication_required",
  "40": "processing_error",
  "41": "authentication_required",
  "42": "authentication_required",
  // SEPA bank returns, as `sepa:<reason code>` (a `CHARGEBACK` on a SEPA debit). Adyen's SEPA
  // reason-code table: https://docs.adyen.com/risk-management/understanding-disputes/dispute-reason-codes
  "sepa:AC01": "bank_account_invalid_details",
  "sepa:AC04": "bank_account_closed",
  "sepa:AC06": "bank_account_closed",
  "sepa:AC13": "bank_account_invalid_details",
  "sepa:AG01": "debit_not_authorized",
  "sepa:AG02": "processing_error",
  "sepa:AM04": "insufficient_funds",
  "sepa:AM05": "processing_error",
  "sepa:CNOR": "processing_error",
  "sepa:DNOR": "bank_account_invalid_details",
  "sepa:FF01": "processing_error",
  "sepa:MD02": "debit_not_authorized",
  "sepa:MD07": "bank_account_closed",
  // The payer refused the debit after its pre-notification.
  "sepa:MS02": "debit_not_authorized",
  // Replaces AC04, AM04, MD07, RR01–RR04 where data protection forbids them.
  "sepa:MS03": "do_not_honor",
  "sepa:RC01": "bank_account_invalid_details",
  "sepa:RR01": "bank_account_invalid_details",
  "sepa:RR02": "bank_account_invalid_details",
  "sepa:RR04": "do_not_honor",
  // The payer's bank accepts only debits the holder pre-approved.
  "sepa:SL01": "debit_not_authorized",
};

const ADYEN_OUR_SIDE =
  "We could not complete this payment because of a problem with the payment gateway setup. Nothing is wrong with the customer's payment method.";

const ADYEN_METHOD_GONE =
  "The saved payment method is no longer available at the payment provider. Add a payment method again.";

const adyenCode = (slug: string, value: string, code: string, extra: Partial<DeclineRule> = {}) =>
  ({ id: `adyen.code.${slug}`, field: "code", op: "eq", value, code, ...extra }) as const;

export const ADYEN_RULES: readonly DeclineRule[] = [
  // "Card is blocked and unusable": only a new card recovers it.
  adyenCode("blocked_card", "5", "card_restricted", { retriable: false }),
  // "The shopper's bank does not support or does not allow this type of transaction".
  adyenCode("not_supported", "10", "card_restricted", { retriable: false }),
  // "57: Transaction not permitted to issuer/cardholder" (Visa category 1) and its kin.
  adyenCode("transaction_not_permitted", "23", "card_restricted", { retriable: false }),
  adyenCode("expired_card", "6", "expired_card"),
  // The cardholder stopped the recurring payments (network stop orders R0/R1/R3).
  adyenCode("revocation_of_auth", "26", "revocation_of_authorization"),
  // The shopper disabled our stored token.
  adyenCode("token_revoked", "50", "revocation_of_authorization"),
  // Adyen blocked a re-present to avoid scheme retry fees. Adyen says not to work around it.
  adyenCode("excessive_retry_blocked", "46", "network_do_not_retry", {
    retriable: false,
    message:
      "Your bank asked us not to attempt this payment again. Use a different payment method, or contact your bank.",
    exposedToPayer: true,
  }),
  // "PaymentDetail not found": the stored card is gone at Adyen (measured on a deleted token).
  adyenCode("stored_method_not_found", "api:803", "payment_method_not_found", {
    retriable: false,
  }),
  // The stored token, its contract or the network token is gone: only a new method pays.
  ...(
    [
      ["contract_not_found", "api:800"],
      ["contract_invalid", "api:802"],
      ["shopper_has_no_stored_method", "api:803_3"],
      ["stored_detail_not_in_contract", "api:805"],
      ["network_token_not_found", "api:26_006"],
      ["recurring_shopper_lookup_failed", "api:218"],
    ] as const
  ).map(([slug, value]) =>
    adyenCode(slug, value, "payment_method_not_found", {
      retriable: false,
      message: ADYEN_METHOD_GONE,
      exposedToPayer: true,
    }),
  ),
  adyenCode("network_token_suspended", "api:26_002", "card_restricted", { retriable: false }),
  // Card data on the stored token that cannot pay: a number or expiry the issuer rejects.
  adyenCode("invalid_card_number", "api:101", "incorrect_number", { retriable: false }),
  ...(
    [
      ["expiry_date_invalid", "api:129"],
      ["expiry_in_the_past", "api:140"],
      ["expiry_format_invalid", "api:141"],
    ] as const
  ).map(([slug, value]) => adyenCode(slug, value, "expired_card")),
  // A wrong security code: the payer can enter it again.
  ...(
    [
      ["cvc_wrong_length", "api:103"],
      ["cvc_invalid", "api:153"],
    ] as const
  ).map(([slug, value]) => adyenCode(slug, value, "incorrect_cvc")),
  // Over this card type's amount limit: another card can pay.
  adyenCode("card_type_amount_limit", "api:916", "card_declined"),
  // Network token not active yet, detokenization declined, failed or timed out: transient.
  ...(
    [
      ["network_token_not_active", "api:26_005"],
      ["detokenization_declined", "api:26_003"],
      ["detokenization_timeout", "api:26_007"],
      ["detokenization_failed", "api:26_020"],
      ["server_could_not_process", "api:701"],
      ["resource_unavailable", "api:703"],
      ["internal_error", "api:903"],
      ["unable_to_process", "api:904"],
    ] as const
  ).map(([slug, value]) => adyenCode(slug, value, "processing_error", { retriable: true })),
  // The merchant account has no recurring contract enabled.
  adyenCode("recurring_not_enabled", "api:107", "recurring_not_enabled", {
    message: ADYEN_OUR_SIDE,
    exposedToPayer: false,
  }),
  // SEPA ED05 "Settlement failed": an interbank failure at the payer's bank, not the payer's
  // account. Retry. No message: a hidden rule here would hide `processing_error` on every gateway.
  adyenCode("sepa_settlement_failed", "sepa:ED05", "processing_error", { retriable: true }),
  // SEPA returns caused by the creditor data Adyen sends for us (BE05 creditor id, RR03
  // creditor name): not the payer's account.
  ...(
    [
      ["sepa_creditor_id", "sepa:BE05"],
      ["sepa_creditor_name", "sepa:RR03"],
    ] as const
  ).map(([slug, value]) =>
    adyenCode(slug, value, "gateway_request_rejected", {
      message: ADYEN_OUR_SIDE,
      exposedToPayer: false,
    }),
  ),
  // Our request or our merchant setup, never the payer's card (measured: 14_029 is a
  // stored-card charge sent as shopper-present without a CVC; 138 an unsupported currency).
  ...(
    [
      ["cvc_required", "api:14_029"],
      ["currency_not_supported", "api:138"],
      // Our request, our merchant account or its acquirer setup (Adyen's error-codes page).
      ["not_allowed", "api:010"],
      ["invalid_recurring_contract", "api:125"],
      ["invalid_recurring_contract_type", "api:183"],
      ["no_contract_types_left", "api:806"],
      ["shopper_interaction_contract_mismatch", "api:807"],
      ["cvc_required_oneclick", "api:820"],
      ["network_tx_reference_invalid", "api:205"],
      ["shopper_interaction_invalid", "api:217"],
      ["amount_invalid", "api:137"],
      ["amount_not_allowed", "api:166"],
      ["invalid_merchant_account", "api:901"],
      ["payment_details_not_supported", "api:905"],
      ["no_acquirer_for_variant", "api:905_1"],
      ["no_acquirer_for_currency", "api:905_3"],
      ["not_supported_for_country_mcc", "api:907"],
      ["problem_parsing_request", "api:702"],
      ["invalid_request_data", "api:902"],
      ["invalid_request", "api:908"],
      ["link_expiry_too_late", "api:14_0379"],
      ["amount_over_maximum", "api:14_0490"],
    ] as const
  ).map(([slug, value]) =>
    adyenCode(slug, value, "gateway_request_rejected", {
      message: ADYEN_OUR_SIDE,
      exposedToPayer: false,
    }),
  ),
  // Mastercard advice 03 "Do not try again" and 21 "Payment cancellation": a repeat is fined.
  ...(["03", "21"] as const).map((value): DeclineRule => ({
    id: `adyen.advice.${value}`,
    field: "recommendation_code",
    op: "eq",
    value,
    code: "network_do_not_retry",
    retriable: false,
    message:
      "Your bank asked us not to attempt this payment again. Use a different payment method, or contact your bank.",
    exposedToPayer: true,
  })),
];

/** Mastercard Merchant Advice Code from Adyen's `merchantAdviceCode` ("24 : Retry after 1 hour"). */
export function adyenAdviceCode(raw: string | null | undefined): string | null {
  const m = /^\s*(\d{2})\b/.exec(raw ?? "");
  return m ? m[1]! : null;
}

export function normalizeAdyenDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  const sig = asSignal(raw);
  const mac =
    sig.cardBrand?.toLowerCase() === "mastercard"
      ? MASTERCARD_ADVICE_WAIT_MS[(sig.recommendationCode ?? "").trim()]
      : undefined;
  return withWait(networkHardDecline(sig, evaluate(sig, ADYEN_RULES, ADYEN_CODE_TABLE)), mac);
}

/** The network's own code from `refusalReasonRaw` ("46: Closed Account", "R1 : …"), or null. */
export function adyenRawNetworkCode(raw: string | null | undefined): string | null {
  const m = /^\s*([0-9A-Z]{2})\s*(?::|$)/.exec(raw ?? "");
  return m ? m[1]! : null;
}

const ADY_SUCCESS = "refusal code 0 comes only with an Authorised result; Adyen says to ignore it";
const ADY_INVOICE = "open invoice, Klarna, installments and invoicing; we never offer them";
const ADY_TERMINAL = "terminals, POS and virtual card products; we take no in-person payments";
const ADY_PAYOUTS =
  "payouts, push-to-card and currency conversion; we never move money out or convert";
const ADY_GIFT = "gift cards, vouchers, donations and split amounts; we never use them";
const ADY_LINK_ADMIN = "Pay by Link themes, forms, email and QR codes; our links use none of them";
const ADY_WALLET =
  "wallet tokens and local methods (Amazon Pay, Apple Pay, Google Pay, iDEAL, UPI, tax ids); the browser or Adyen's page sends them, never our server";
const ADY_BANK = "raw bank details; the shopper enters them on Adyen's form, never in our request";
const ADY_BROWSER =
  "raised to Drop-in in the browser (card data, 3DS, sessions); our server sends none of it";
const ADY_SESSION_READ =
  "reading a session result; a refusal there is answered as invalid browser data, not a decline";
const ADY_ACCOUNT = "acquirer, account updater and merchant configuration calls we never make";
const ADY_TOKENIZE = "token management calls (provisioning, disabling, naming) we never make";
const ADY_FIELDS = "a field our requests always send in the right shape, or never send";
const ADY_MODIFICATION =
  "capture, refund and cancel only; their refusal reaches the operator as an error, not a decline";
const ADY_RETRIED =
  "handled before classification: retried under the same key, then an unknown outcome";

/**
 * Documented Adyen codes that no call of ours can return, with the reason. Our server calls
 * are `/payments` (stored tokens), `/sessions`, `/paymentLinks`, modifications and reads.
 */
export const ADYEN_CODES_OUR_CALLS_NEVER_RAISE: Readonly<Record<string, string>> = {
  "0": ADY_SUCCESS,
  ...neverRaised(
    ADY_INVOICE,
    `
    113 114 115 116 136 146 152 213 600 601 602 603 604 605 606 607 608 609 690 691 692 693
    694 695 963 964 965 905_5 905_6 14_023 14_024 14_0420 14_0474 14_0416 14_0476 14_0477
    14_0478 14_0479 14_0480 14_0481 14_0424
  `,
    "api:",
  ),
  ...neverRaised(
    ADY_TERMINAL,
    `
    14_022 14_0418 14_0425 14_0426 14_0427 14_0430 14_0431 14_0432 14_0389 14_0475 905_4 910
    957 958 1000 1001 1002
  `,
    "api:",
  ),
  ...neverRaised(
    ADY_PAYOUTS,
    `
    160 14_0396 14_0399 928 929 930 14_0485 14_0486 14_0487
  `,
    "api:",
  ),
  ...neverRaised(
    ADY_GIFT,
    `
    912 919 920 14_0405 14_0406 14_0407 14_0411 14_0419 14_0429 14_0417 14_0421
  `,
    "api:",
  ),
  ...neverRaised(
    ADY_LINK_ADMIN,
    `
    14_0404 14_0428 14_0433 14_0434 14_0435 14_0436 14_0438 14_0439 14_0444 14_0445 14_0446
    14_0449 14_0451 14_0452 14_0453 14_0454 14_0455 14_0456 14_0457 14_0458 14_0459 14_0469
    14_0472
  `,
    "api:",
  ),
  ...neverRaised(
    ADY_WALLET,
    `
    5_601 5_602 5_603 5_604 5_605 5_606 5_607 5_608 5_609 5_610 5_611 5_612 5_613 5_614
    5_615 5_001 5_002 5_003 5_004 5_005 5_006 5_007 5_008 5_202 5_208 5_210 OR_BIBED_11 926
    14_020 143 14_0484 14_0493 14_0488 14_0489 14_0492
  `,
    "api:",
  ),
  ...neverRaised(
    ADY_BANK,
    `
    108 109 110 111 112 126 127 142 161 162 163 165 203 2000 14_031
  `,
    "api:",
  ),
  ...neverRaised(
    ADY_BROWSER,
    `
    102 104 105 106 117 118 119 124 128 131 132 133 134 135 144 145 147 148 149 150 151 170
    171 172 173 174 175 182 190 193 194 921_1 921_2 14_002 14_003 14_004 14_005 14_006
    14_007 14_008 14_010 14_011 14_012 14_013 14_014 14_015 14_016 14_017 14_018 14_019
    14_026 14_027 14_028 14_030 14_032 14_033 14_034 14_035 14_036 14_037 14_0378 14_0380
    14_0381 14_0382 14_0383 14_0384 14_0385 14_0386 14_0387 14_0390 14_0391 14_0392 14_0397
    14_0398 14_0400 14_0401 14_0402 14_0403 14_0408 14_0410 14_0414 14_0415 14_0447 14_0448
    14_0460 14_0461 14_0462 14_0464 14_0465 14_0466 14_0467 14_0470 14_0473 14_0491 14_0494
    15_002 15_003 15_004 15_005 15_006 15_007 15_008 15_009 15_010 15_011 15_012 15_013
    15_014 15_015 15_016 15_017 15_018 15_019 15_020 15_021 15_022 15_023 15_024 15_026
  `,
    "api:",
  ),
  ...neverRaised(
    ADY_ACCOUNT,
    `
    922 923 950 951 952 953 954 955 956 959 960 961 962 966 967 931 195 196 199 155 156
    905_2
  `,
    "api:",
  ),
  ...neverRaised(
    ADY_TOKENIZE,
    `
    26_004 26_008 26_010 6_012 26_017 801 804 184
  `,
    "api:",
  ),
  ...neverRaised(
    ADY_FIELDS,
    `
    000 100 120 121 122 130 139 154 157 158 159 164 180 181 185 186 187 188 189 191 192 198
    200 700 918 924 927 29_001 29_003 29_100 14_0388 14_0393 14_0394 14_0395 14_0412 14_0413
    14_0463 14_0468 14_0471 14_0482
  `,
    "api:",
  ),
  ...neverRaised(
    ADY_MODIFICATION,
    `
    167 168 906
  `,
    "api:",
  ),
  ...neverRaised(
    ADY_RETRIED,
    `
    704 705
  `,
    "api:",
  ),
  ...neverRaised(
    ADY_SESSION_READ,
    `
    14_0422 14_0423 14_0450 14_0483
  `,
    "api:",
  ),
};

/**
 * Checkout.com: `response_code` (20xxx soft, 30xxx hard, 4xxxx risk) → canonical tokens.
 * Source: Checkout.com's published API response codes. 10xxx is approved and never reaches
 * here. Hardness comes from `TERMINAL` and the rules, not from the 20xxx/30xxx split: a
 * 30xxx such as 30021 (total amount limit) can clear later.
 */
export const CHECKOUTCOM_CODE_TABLE: Record<string, string> = {
  "20001": "do_not_honor",
  "20002": "do_not_honor",
  "20005": "do_not_honor",
  "20009": "processing_error",
  "20012": "card_declined",
  "20014": "incorrect_number",
  "20019": "processing_error",
  "20022": "processing_error",
  "20038": "card_declined",
  "20039": "card_declined",
  "20046": "do_not_honor",
  "20051": "insufficient_funds",
  "20052": "card_declined",
  "20053": "card_declined",
  "20054": "expired_card",
  "20055": "card_declined",
  "20057": "card_restricted",
  "20058": "card_declined",
  "20059": "fraudulent",
  "20061": "insufficient_funds",
  "20062": "card_restricted",
  "20063": "card_declined",
  "20064": "card_declined",
  "20065": "insufficient_funds",
  "20066": "card_declined",
  "20067": "pickup_card",
  "20068": "processing_error",
  "20075": "card_declined",
  "20078": "card_declined",
  "20082": "card_declined",
  "20083": "card_declined",
  "20087": "incorrect_cvc",
  "20088": "processing_error",
  "20089": "processing_error",
  "20090": "processing_error",
  "20091": "processing_error",
  "20092": "processing_error",
  "20093": "card_restricted",
  "20094": "retry_too_soon",
  "20096": "processing_error",
  "20098": "processing_error",
  "20099": "processing_error",
  "20103": "card_declined",
  "20104": "processing_error",
  "20105": "processing_error",
  "20108": "card_declined",
  "20124": "card_declined",
  "20150": "card_declined",
  "20151": "authentication_required",
  "20152": "authentication_required",
  "20153": "processing_error",
  "20154": "authentication_required",
  "20155": "authentication_required",
  "20159": "processing_error",
  "20179": "card_declined",
  "20182": "card_declined",
  "20183": "fraudulent",
  "2005C": "card_restricted",
  "2009G": "card_restricted",
  "200N7": "incorrect_cvc",
  "200P1": "insufficient_funds",
  "200P9": "insufficient_funds",
  "200T3": "card_declined",
  "30004": "pickup_card",
  "30007": "pickup_card",
  "30015": "incorrect_number",
  "30021": "insufficient_funds",
  "30022": "insufficient_funds",
  "30033": "expired_card",
  "30034": "fraudulent",
  "30035": "pickup_card",
  "30036": "pickup_card",
  "30037": "pickup_card",
  "30038": "pickup_card",
  "30041": "lost_card",
  "30043": "stolen_card",
  "30044": "card_restricted",
  // Risk engine (client, entity and platform level): a refusal, not a fault of the card.
  "41101": "card_declined",
  "41201": "card_declined",
  "41202": "card_declined",
  "41203": "card_declined",
  "41204": "card_declined",
  "41205": "card_declined",
  "41206": "card_declined",
  "41301": "card_declined",
  "42101": "card_declined",
  "42201": "card_declined",
  "42202": "card_declined",
  "42203": "card_declined",
  "42204": "card_declined",
  "42205": "card_declined",
  "42206": "card_declined",
  "42301": "card_declined",
  "43101": "card_declined",
  "43102": "card_declined",
  "43201": "card_declined",
  "43202": "card_declined",
  "43203": "card_declined",
  "43204": "card_declined",
  "43205": "card_declined",
  "43206": "card_declined",
  "43301": "card_declined",
  "43401": "authentication_required",
  // 20xxx soft declines added from the 2026-11-17 capture (retriable: Checkout.com's soft class).
  "20016": "card_restricted",
  "20017": "card_declined",
  "20018": "card_declined",
  "20031": "card_declined",
  "2006P": "card_declined",
  "200A4": "card_declined",
  "20040": "card_restricted",
  "20072": "card_restricted",
  "20081": "card_restricted",
  "20070": "authentication_required",
  "20015": "processing_error",
  "20020": "processing_error",
  "20028": "processing_error",
  "20118": "processing_error",
  "200A6": "processing_error",
  "200E3": "processing_error",
  "200N0": "processing_error",
  // India e-mandate approval still pending at the issuer: try the debit later.
  "20199": "try_again_later",
  // "Card should be captured": a pickup, so the card is dead.
  "20004": "pickup_card",
};

const CHECKOUTCOM_OUR_SIDE =
  "We could not complete this payment because of a problem with the payment gateway setup. Nothing is wrong with the customer's payment method.";

const CHECKOUTCOM_CARD_GONE =
  "The saved card is no longer available at the payment provider. Add a new card.";

const ckoCode = (slug: string, value: string, code: string, extra: Partial<DeclineRule> = {}) =>
  ({ id: `checkoutcom.code.${slug}`, field: "code", op: "eq", value, code, ...extra }) as const;

const ckoOurSide = (slug: string, value: string, op: DeclineOp = "eq"): DeclineRule => ({
  id: `checkoutcom.code.${slug}`,
  field: "code",
  op,
  value,
  code: "gateway_request_rejected",
  message: CHECKOUTCOM_OUR_SIDE,
  exposedToPayer: false,
});

export const CHECKOUTCOM_RULES: readonly DeclineRule[] = [
  // Not permitted to the cardholder (Visa 57), a function the card does not support, or a
  // card for local use only: a retry never pays, another card does.
  ckoCode("not_permitted_to_cardholder", "20057", "card_restricted", { retriable: false }),
  ckoCode("function_not_supported", "20040", "card_restricted", { retriable: false }),
  ckoCode("local_use_only", "20081", "card_restricted", { retriable: false }),
  // `error_codes` on a refused POST /payments (a 4xx, no payment): string codes, so rules.
  // The stored card, its customer or the token is gone: only a new card pays.
  ...(
    [
      ["card_not_found", "card_not_found"],
      ["source_id_invalid", "source_id_invalid"],
      ["customer_not_found", "customer_not_found"],
      ["token_incorrect", "20114"],
    ] as const
  ).map(([slug, value]) =>
    ckoCode(slug, value, "payment_method_not_found", {
      retriable: false,
      message: CHECKOUTCOM_CARD_GONE,
      exposedToPayer: true,
    }),
  ),
  ckoCode("card_expired", "card_expired", "expired_card"),
  ckoCode("card_disabled", "card_disabled", "card_restricted", { retriable: false }),
  ckoCode("card_authorization_failed", "card_authorization_failed", "card_declined"),
  ckoCode("3ds_payment_required", "3ds_payment_required", "authentication_required"),
  // Scheme velocity or our failed-action quota: wait, then try again.
  ...(
    [
      "amount_limit_exceeded",
      "velocity_amount_limit_exceeded",
      "velocity_count_limit_exceeded",
      "action_failure_limit_exceeded",
    ] as const
  ).map((value) => ckoCode(value, value, "retry_too_soon")),
  // Checkout.com or the issuer network is down, or our API quota is spent: transient.
  ...(
    [
      "processing_error",
      "issuer_network_unavailable",
      "service_unavailable",
      "3ds_malfunction",
      "api_calls_quota_exceeded",
    ] as const
  ).map((value) => ckoCode(value, value, "processing_error", { retriable: true })),
  // A Flow or hosted-page token that expired or was used: the payer enters the card again.
  ...(["token_expired", "token_invalid", "token_used", "token_in_use"] as const).map((value) =>
    ckoCode(`flow_${value}`, value, "invalid_client_result", {
      retriable: true,
      message: "The card details expired. Enter them again.",
      exposedToPayer: true,
    }),
  ),
  // Our request, our account or its processor setup: nothing the payer can change.
  ckoOurSide("currency_not_configured", "^[a-z]{3}_currency_not_configured$", "matches"),
  ckoOurSide("scheme_not_configured", "^[a-z_]+_scheme_not_configured$", "matches"),
  ...(
    [
      "currency_invalid",
      "currency_required",
      "amount_invalid",
      "previous_payment_id_invalid",
      "business_invalid",
      "business_settings_missing",
      "no_authorization_enabled_processors_available",
      "payment_method_not_supported",
      "risk_enabled_required",
      "3ds_not_enabled_for_card",
      "3ds_not_configured",
      "3ds_not_supported",
      "3ds_version_invalid",
      "3ds_version_not_supported",
      "request_invalid",
      "request_json_invalid",
      "parameter_invalid",
      "processing_key_required",
      "processing_value_required",
      "payment_type_invalid",
      "payment_invalid",
      "server_api_not_allowed",
      "source_invalid",
      "source_id_required",
      "source_type_required",
      "payment_source_required",
      "customer_id_invalid",
      "customer_email_invalid",
      "email_invalid",
      "ip_address_invalid",
      "endpoint_invalid",
      "success_url_invalid",
      "fail_url_invalid",
      "metadata_key_invalid",
      "too_many_metadata_items",
      "metadata_key_too_long",
      "metadata_value_too_long",
      "metadata_value_invalid",
      "estimated_authorization_not_supported",
    ] as const
  ).map((value) => ckoOurSide(value, value)),
  // Response codes for the same kind of fault (Checkout.com's response-code table).
  ...(
    [
      ["card_acceptor_contact_acquirer", "20060"],
      ["format_error", "20030"],
      ["invalid_expiry_format", "20100"],
      ["merchant_terminal_limit_exceeded", "20121"],
      ["function_not_supported_by_acquirer", "20156"],
      ["invalid_country_code", "20193"],
      ["unauthorised_access", "200E0"],
      ["signature_verification_failure", "200E2"],
      ["invalid_transaction_date", "200T2"],
      ["sub_merchant_id_missing", "30404"],
      ["invalid_order_description", "30405"],
    ] as const
  ).map(([slug, value]) => ckoOurSide(slug, value)),
  // The stored card or the card account is gone: only a new card recovers it.
  {
    id: "checkoutcom.code.source_id_unknown",
    field: "code",
    op: "eq",
    value: "source_id_unknown",
    code: "payment_method_not_found",
    retriable: false,
  },
  {
    id: "checkoutcom.code.no_card_record",
    field: "code",
    op: "eq",
    value: "20056",
    code: "payment_method_not_found",
    retriable: false,
  },
  {
    id: "checkoutcom.code.token_invalid",
    field: "code",
    op: "eq",
    value: "20101",
    code: "payment_method_not_found",
    retriable: false,
  },
  {
    id: "checkoutcom.code.closed_account",
    field: "code",
    op: "eq",
    value: "30046",
    code: "payment_method_not_found",
    retriable: false,
  },
  // The cardholder stopped this subscription, or all of them, at the issuer.
  {
    id: "checkoutcom.code.revocation_one",
    field: "code",
    op: "eq",
    value: "200R1",
    code: "revocation_of_authorization",
  },
  {
    id: "checkoutcom.code.revocation_all",
    field: "code",
    op: "eq",
    value: "200R3",
    code: "revocation_of_authorization",
  },
  // Merchant-account or request refusals: nothing the payer can change.
  ...(
    [
      ["20003", "invalid_merchant"],
      ["20006", "invalid_request"],
      ["20013", "invalid_amount"],
      ["20033", "previous_payment_invalid"],
      ["20102", "invalid_merchant_id"],
      ["20106", "unsupported_currency"],
      ["20107", "billing_address_missing"],
      ["20112", "secure_code_not_enabled"],
      ["20117", "invalid_api_version"],
      ["20120", "invalid_customer"],
      ["20123", "missing_basic_data"],
      ["20157", "invalid_merchant_config"],
      ["30020", "invalid_amount_value"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `checkoutcom.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "gateway_request_rejected",
    retriable: false,
    message: CHECKOUTCOM_OUR_SIDE,
    exposedToPayer: false,
  })),
];

export function normalizeCheckoutcomDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  const sig = asSignal(raw);
  const mac =
    sig.cardBrand?.toLowerCase() === "mastercard"
      ? MASTERCARD_ADVICE_WAIT_MS[(sig.recommendationCode ?? "").trim()]
      : undefined;
  return withWait(
    networkHardDecline(sig, evaluate(sig, CHECKOUTCOM_RULES, CHECKOUTCOM_CODE_TABLE)),
    mac,
  );
}

const CKO_APPROVED = "10xxx approvals; never a refusal";
const CKO_PAYOUT_REFUND =
  "payouts, card credits and refunds; a refund refusal reaches the operator as its own error";
const CKO_CAPTURE =
  "capture, void and reversal calls only; their refusal reaches the operator as an error";
const CKO_TERMINAL =
  "card-present, ATM, file update and batch codes; we take no in-person payments";
const CKO_TOKENS =
  "raw card fields and card tokens; Flow sends them from the browser, never our server";
const CKO_BANK = "bank account instruments; we take no bank payments on this gateway";
const CKO_PLATFORM = "platform and sub-entity onboarding; we bill on the merchant's own entity";
const CKO_LEGACY = "legacy customer, plan and wallet APIs we never call";
const CKO_NEVER_SENT = "billing descriptor, address and phone fields our requests never send";

/** Documented Checkout.com codes that no call of ours can return, with the reason. */
export const CHECKOUTCOM_CODES_OUR_CALLS_NEVER_RAISE: Readonly<Record<string, string>> = {
  ...neverRaised(
    CKO_APPROVED,
    `
    10000 10008 10010 10011 10076 10077 10081 10100 10200
  `,
  ),
  ...neverRaised(
    CKO_PAYOUT_REFUND,
    `
    50001 50002 50003 50004 50005 50020 50021 50022 50023 50025 50026 50027 50030 50070
    50100 50101 50102 50103 50104 50105 50106 50150 50180 50200 50240 50260 50280 50399
    50401 50402 50403 50404 50405 50406 50407 50408 50409 50410 50441 50451 50452 50453
    50454 50466 50471 50481 50490 50491 50492 50494 50499 50501 50511 50512 50513 50514
    50515 50517 50531 50599 30016 30017 30018 30019 30045
    card_not_eligible_domestic_money_transfer card_not_eligible_cross_border_money_transfer
    card_not_eligible_domestic_non_money_transfer
    card_not_eligible_cross_border_non_money_transfer
    card_not_eligible_domestic_online_gambling
    card_not_eligible_cross_border_online_gambling recipient_account_number_invalid
    recipient_account_number_required recipient_bank_details_invalid
    recipient_bank_not_found recipient_dob_invalid recipient_dob_required
    recipient_last_name_required recipient_zip_invalid recipient_zip_required
    destination_bank_not_found destination_bank_details_invalid
    source_or_destination_required aft_processor_not_matched amount_exceeds_balance 20158
  `,
  ),
  ...neverRaised(
    CKO_CAPTURE,
    `
    30401 30402 30403 capture_value_greater_than_authorized
    capture_value_greater_than_remaining_authorized void_amount_invalid 20109 20110 20111
    200A5 20021 payment_expired
  `,
  ),
  ...neverRaised(
    CKO_TERMINAL,
    `
    20024 20025 20026 20027 20029 20032 20042 20044 20045 20084 20085 20086 20095 20097
    20197 200S4 200T5 20119 20122 20023
  `,
  ),
  ...neverRaised(
    CKO_TOKENS,
    `
    20113 20115 20116 card_number_invalid card_number_required card_expiry_month_invalid
    card_expiry_month_required card_expiry_year_invalid card_expiry_year_required
    expiry_date_format_invalid cvv_invalid card_holder_invalid source_token_invalid
    source_token_required source_token_type_required source_token_type_invalid
    token_required token_type_required token_type_invalid token_data_invalid
    token_data_required metadata_only_supported_for_token_type_card
  `,
  ),
  ...neverRaised(
    CKO_BANK,
    `
    identification_type_invalid issuing_country_invalid date_of_birth_invalid
    country_of_birth_invalid country_required residential_status_invalid
    account_type_invalid account_holder_type_invalid iban_invalid swift_bic_invalid
    first_name_required last_name_required
  `,
  ),
  ...neverRaised(
    CKO_PLATFORM,
    `
    profile_mccs_invalid_for_processing_scope
    principal_address_country_invalid_for_processing_scope
    client_entity_cannot_onboard_subentities <field_name>_required <field_name>_invalid
    sub_entities_count_invalid entity_id_invalid instrument_already_has_customer
  `,
  ),
  ...neverRaised(
    CKO_LEGACY,
    `
    customer_already_exists customer_number_invalid customer_plan_edit_failed
    customer_plan_id_invalid recurring_plan_exists recurring_plan_not_exist
    recurring_plan_removal_failed email_in_use email_required password_invalid
    wallet_id_invalid channel_details_invalid channel_url_missing charge_details_invalid
    source_id_or_email_required source_email_invalid source_email_required
  `,
  ),
  ...neverRaised(
    CKO_NEVER_SENT,
    `
    address_invalid billing_descriptor_city_invalid billing_descriptor_city_required
    billing_descriptor_name_invalid billing_descriptor_name_required city_invalid
    country_address_invalid country_invalid country_phone_code_invalid
    country_phone_code_length_invalid phone_number_invalid phone_number_length_invalid
    zip_invalid
  `,
  ),
};

/**
 * Authorize.net: transaction response reason codes (`errors[].errorCode`, the reason code
 * on a read transaction or a payment-profile check) and API message codes (`E000xx`) →
 * canonical tokens. Source: Authorize.net's published response-code table. Reason 11
 * (duplicate) never reaches here as a decline: the adapter reads the original back.
 */
export const AUTHORIZENET_CODE_TABLE: Record<string, string> = {
  "2": "card_declined",
  // Referral: the issuer wants a voice authorization.
  "3": "card_declined",
  "4": "pickup_card",
  "6": "incorrect_number",
  "37": "incorrect_number",
  "315": "incorrect_number",
  "200": "incorrect_number",
  "7": "expired_card",
  "8": "expired_card",
  "201": "expired_card",
  "316": "expired_card",
  "317": "expired_card",
  "11": "retry_too_soon",
  "318": "retry_too_soon",
  // Address check refused by the merchant's AVS filter.
  "27": "card_declined",
  "127": "card_declined",
  // Card code (CVV) refused, alone or with the address.
  "44": "incorrect_cvc",
  "45": "incorrect_cvc",
  "65": "incorrect_cvc",
  "78": "incorrect_cvc",
  "145": "incorrect_cvc",
  "165": "incorrect_cvc",
  // The merchant's fraud filters, or a manual review that declined.
  "41": "card_declined",
  "141": "card_declined",
  "250": "card_declined",
  "251": "card_declined",
  "254": "card_declined",
  "128": "card_declined",
  "185": "card_declined",
  "191": "card_declined",
  // "An error occurred during processing. Please try again."
  "19": "processing_error",
  "20": "processing_error",
  "21": "processing_error",
  "22": "processing_error",
  "23": "processing_error",
  "25": "processing_error",
  "26": "processing_error",
  "35": "processing_error",
  "36": "processing_error",
  "52": "processing_error",
  "57": "processing_error",
  "58": "processing_error",
  "59": "processing_error",
  "60": "processing_error",
  "61": "processing_error",
  "62": "processing_error",
  "63": "processing_error",
  "120": "processing_error",
  "121": "processing_error",
  "122": "processing_error",
  "152": "processing_error",
  "180": "processing_error",
  "181": "processing_error",
  "192": "processing_error",
  "261": "processing_error",
  // eCheck returns: the NACHA return reason code (`returnedItems[].code`).
  R01: "insufficient_funds",
  R09: "insufficient_funds",
  R02: "bank_account_closed",
  R16: "bank_account_closed",
  R03: "bank_account_invalid_details",
  R04: "bank_account_invalid_details",
  R20: "bank_account_invalid_details",
  R05: "debit_not_authorized",
  R07: "debit_not_authorized",
  R08: "debit_not_authorized",
  R10: "debit_not_authorized",
  R11: "debit_not_authorized",
  R29: "debit_not_authorized",
};

const AUTHORIZENET_OUR_SIDE =
  "We could not complete this payment because of a problem with the payment gateway setup. Nothing is wrong with the customer's payment method.";

/** Authorize.net codes that name our request, our keys or the merchant setup. */
const AUTHORIZENET_OUR_REQUEST_CODES = [
  "18",
  "24",
  "29",
  "30",
  "31",
  "32",
  "34",
  "38",
  "53",
  "66",
  "69",
  "114",
  "131",
  "132",
  "170",
  "171",
  "172",
  "173",
  "174",
  "202",
  "203",
  "204",
  "205",
  "206",
  "207",
  "208",
  "210",
  "212",
  "213",
  "217",
  "221",
  "243",
  "244",
  "245",
  "246",
  "247",
  "265",
  "288",
  "289",
  "325",
  "326",
  "357",
  "2007",
  "E00002",
  "E00003",
  "E00004",
  "E00005",
  "E00006",
  "E00007",
  "E00008",
  "E00009",
  "E00010",
  "E00011",
  "E00013",
  "E00014",
  "E00015",
  "E00016",
  "E00041",
  "E00042",
  "E00045",
  "E00059",
  "E00060",
  "E00066",
  "E00067",
  "E00068",
  "E00071",
  "E00072",
  "E00073",
  "E00075",
  "E00076",
  "E00077",
  "E00088",
  "E00089",
  "E00090",
  "E00091",
  "E00092",
  "E00093",
  "E00094",
  "E00095",
  "E00108",
  "E00109",
  "E00110",
  "E00116",
  "E00117",
  "E00120",
  "E00135",
  "E00136",
  "E00137",
  "E00142",
] as const;

/** Authorize.net codes for an outage or a processor that could not finish. */
const AUTHORIZENET_TRY_AGAIN_CODES = [
  "0",
  "209",
  "214",
  "220",
  "223",
  "224",
  "241",
  "314",
  "328",
  "901",
  "E00001",
  "E00049",
  "E00053",
  "E00104",
  "E00133",
] as const;

export const AUTHORIZENET_RULES: readonly DeclineRule[] = [
  // The customer or payment profile is gone at Authorize.net (measured on a missing profile).
  {
    id: "authorizenet.code.payment_profile_not_found",
    field: "code",
    op: "eq",
    value: "E00040",
    code: "payment_method_not_found",
    retriable: false,
    message:
      "The saved payment method is no longer available at the payment provider. Add a payment method again.",
    exposedToPayer: true,
  },
  // The merchant's Address Verification settings need a field the card form does not collect.
  {
    id: "authorizenet.code.required_fields",
    field: "code",
    op: "eq",
    value: "290",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "Authorize.net needs a field that we did not send. Check the Address Verification Service settings in the Merchant Interface: the card form collects the name and the ZIP code only.",
    exposedToPayer: false,
  },
  // Merchant-account setup and request refusals: not the payer's doing.
  ...(
    [
      ["5", "invalid_amount"],
      ["13", "invalid_credentials"],
      ["17", "card_type_not_accepted"],
      ["28", "card_type_not_enabled"],
      ["33", "field_required"],
      ["39", "invalid_currency"],
      ["42", "missing_required_field"],
      ["43", "processor_setup"],
      ["49", "amount_above_maximum"],
      ["56", "cards_not_accepted"],
      ["67", "transaction_type_not_supported"],
      ["103", "request_not_accepted"],
      ["115", "merchant_inactive"],
      ["123", "permission_missing"],
      ["124", "recurring_not_accepted"],
      ["130", "merchant_closed"],
      ["E00044", "cim_not_enabled"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `authorizenet.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "gateway_request_rejected",
    retriable: false,
    message: AUTHORIZENET_OUR_SIDE,
    exposedToPayer: false,
  })),
  // ── From the documented list (AUTHORIZENET_ERROR_CODES.md, captured 2026-11-17) ──
  // Our request, our keys or the merchant's processor setup (FDC Omaha 202–213 name the
  // merchant, the amount or the transaction type, not the card).
  ...AUTHORIZENET_OUR_REQUEST_CODES.map((value): DeclineRule => ({
    id: `authorizenet.code.${value.toLowerCase()}`,
    field: "code",
    op: "eq",
    value,
    code: "gateway_request_rejected",
    message: AUTHORIZENET_OUR_SIDE,
    exposedToPayer: false,
  })),
  // Authorize.net or its processor could not finish: try again later.
  ...AUTHORIZENET_TRY_AGAIN_CODES.map((value): DeclineRule => ({
    id: `authorizenet.code.${value.toLowerCase()}`,
    field: "code",
    op: "eq",
    value,
    code: "processing_error",
    retriable: true,
  })),
  // The browser's card token is not valid or expired: the buyer enters the details again.
  ...(["E00113", "E00114", "E00115"] as const).map((value): DeclineRule => ({
    id: `authorizenet.code.${value.toLowerCase()}`,
    field: "code",
    op: "eq",
    value,
    code: "invalid_client_result",
    retriable: true,
    message: "The card details expired. Enter them again.",
    exposedToPayer: true,
  })),
  // The customer or payment profile is gone, as E00040.
  ...(["E00098", "E00121"] as const).map((value): DeclineRule => ({
    id: `authorizenet.code.${value.toLowerCase()}`,
    field: "code",
    op: "eq",
    value,
    code: "payment_method_not_found",
    retriable: false,
    message:
      "The saved payment method is no longer available at the payment provider. Add a payment method again.",
    exposedToPayer: true,
  })),
  // eCheck: the routing number, the account number or the name on the account is wrong.
  ...(
    [
      ["9", "invalid_routing_number"],
      ["10", "invalid_account_number"],
      ["101", "account_name_mismatch"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `authorizenet.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "bank_account_invalid_details",
  })),
  ...(
    [
      ["211", "cardholder_not_on_file", "card_declined"],
      ["E00027", "transaction_unsuccessful", "card_declined"],
      ["E00118", "declined_blocked_ip", "card_declined"],
      ["295", "partial_approval_only", "insufficient_funds"],
      ["222", "duplicate_authorization_request", "retry_too_soon"],
      // A capture of a hold that expired: the buyer starts again. The card is not at fault.
      ["237", "referenced_transaction_expired", "intent_expired"],
    ] as const
  ).map(([value, slug, code]): DeclineRule => ({
    id: `authorizenet.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code,
  })),
];

export function normalizeAuthorizenetDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  return evaluate(asSignal(raw), AUTHORIZENET_RULES, AUTHORIZENET_CODE_TABLE);
}

/**
 * Documented Authorize.net codes that no call of ours can return as a refusal, with the reason.
 */
export const AUTHORIZENET_CODES_OUR_CALLS_NEVER_RAISE: Readonly<Record<string, string>> =
  neverRaisedBy([
    [
      "information or an approval, not a refusal",
      ["I00001", "I00003", "I00004", "I99999", "E00078", "1", "229", "307", "2003"],
    ],
    [
      "Automated Recurring Billing subscriptions; our engine owns the subscription",
      [
        "I00002",
        "E00012",
        "E00017",
        "E00018",
        "E00019",
        "E00020",
        "E00021",
        "E00022",
        "E00023",
        "E00024",
        "E00025",
        "E00026",
        "E00028",
        "E00029",
        "E00030",
        "E00031",
        "E00032",
        "E00033",
        "E00034",
        "E00035",
        "E00036",
        "E00037",
        "E00038",
        "E00087",
        "E00105",
        "E00106",
        "E00107",
        "E00111",
        "E00144",
      ],
    ],
    [
      "mobile device registration; we never register devices",
      ["I00005", "I00006", "E00054", "E00055", "E00056", "E00057", "E00058"],
    ],
    [
      "reseller, partner and boarding APIs; we act only as the merchant",
      [
        "I00007",
        "I00008",
        "I00009",
        "I00010",
        "I00011",
        "E00046",
        "E00047",
        "E00048",
        "E00050",
        "E00069",
        "E00070",
        "E00074",
        "E00079",
        "E00080",
        "E00081",
        "E00083",
        "E00084",
        "E00086",
        "E00143",
      ],
    ],
    [
      "Authorize.net invoicing and hosted payment pages; we send our own invoices and use Accept.js",
      [
        "E00119",
        "E00127",
        "E00128",
        "E00129",
        "E00130",
        "E00131",
        "E00132",
        "E00134",
        "E00138",
        "E00140",
        "E00145",
        "E00147",
        "E00148",
        "E00149",
        "E00150",
        "E00151",
      ],
    ],
    [
      "Merchant Interface sign-in, OAuth tokens and signatures; we sign calls with the transaction key",
      [
        "E00064",
        "E00096",
        "E00097",
        "E00122",
        "E00123",
        "E00124",
        "E00125",
        "E00126",
        "E00139",
        "E00146",
        "E00152",
        "E00153",
        "E00154",
        "E00155",
        "E00156",
        "E00157",
        "E00158",
        "E00159",
        "E00160",
        "E00163",
      ],
    ],
    [
      "profiles from a transaction, shipping addresses, reports and array limits of calls we never make",
      [
        "E00043",
        "E00052",
        "E00082",
        "E00085",
        "E00099",
        "E00100",
        "E00101",
        "E00102",
        "E00103",
        "E00112",
        "E00141",
      ],
    ],
    ["a duplicate payment profile: the adapter reads the existing profile back", ["E00039"]],
    [
      "card-present, EMV, swipe and POS devices; we take card-not-present payments only",
      [
        "84",
        "85",
        "87",
        "88",
        "89",
        "90",
        "215",
        "216",
        "218",
        "300",
        "301",
        "302",
        "303",
        "304",
        "305",
        "306",
        "308",
        "309",
        "320",
        "355",
        "356",
        "358",
        "359",
        "360",
        "361",
        "362",
        "363",
        "370",
        "371",
        "375",
        "380",
        "E00061",
      ],
    ],
    [
      "SIM, relay response, WebLink and name-value (x_\u2026) integrations; we use the JSON API with Accept.js",
      [
        "14",
        "40",
        "46",
        "68",
        "70",
        "81",
        "82",
        "83",
        "86",
        "91",
        "92",
        "97",
        "98",
        "99",
        "102",
        "195",
        "262",
        "312",
        "313",
        "331",
        "332",
        "339",
        "341",
        "342",
        "343",
        "344",
        "E00062",
        "E00063",
        "E00065",
      ],
    ],
    [
      "V.me and PayPal through Authorize.net; not offered",
      [
        "330",
        "333",
        "334",
        "340",
        "2000",
        "2001",
        "2002",
        "2004",
        "2005",
        "2006",
        "2008",
        "2009",
        "2100",
        "2101",
        "2102",
        "2103",
        "2104",
        "2105",
        "2106",
        "2107",
        "2108",
        "2109",
      ],
    ],
    [
      "fields we never send (authorization code, driver's license, tax id, duty, freight, tax, surcharge, tip, shipping, line items, auction, split tender, sub-merchant, token requestor, commercial card, 3-D Secure values, check number, wallet cryptograms, currency conversion)",
      [
        "12",
        "71",
        "72",
        "73",
        "74",
        "75",
        "76",
        "77",
        "79",
        "80",
        "93",
        "94",
        "95",
        "96",
        "100",
        "111",
        "112",
        "113",
        "116",
        "117",
        "118",
        "119",
        "125",
        "126",
        "153",
        "154",
        "155",
        "156",
        "182",
        "183",
        "184",
        "186",
        "187",
        "225",
        "226",
        "227",
        "228",
        "230",
        "231",
        "232",
        "233",
        "234",
        "235",
        "236",
        "238",
        "239",
        "240",
        "242",
        "248",
        "270",
        "271",
        "280",
        "281",
        "282",
        "283",
        "284",
        "285",
        "286",
        "287",
        "296",
        "297",
        "298",
        "350",
        "351",
      ],
    ],
    [
      "a refund, void or capture of our own transaction: the adapter reads the transaction, and a refusal reaches the operator",
      [
        "15",
        "16",
        "47",
        "48",
        "50",
        "51",
        "54",
        "55",
        "64",
        "175",
        "219",
        "260",
        "310",
        "311",
        "319",
        "327",
        "2200",
        "E00051",
      ],
    ],
    [
      "held for review (response code 4): pending until the review ends",
      ["104", "105", "106", "107", "108", "109", "110", "193", "252", "253"],
    ],
  ]);

/**
 * Square: `errors[].code` on a payment or a card → canonical tokens. Source: Square's
 * `ErrorCode` reference; GENERIC_DECLINE, CVV_FAILURE, ADDRESS_VERIFICATION_FAILURE,
 * INVALID_CARD_DATA and SOURCE_USED measured on the sandbox (2026-10-25).
 */
export const SQUARE_CODE_TABLE: Record<string, string> = {
  CARD_DECLINED: "card_declined",
  GENERIC_DECLINE: "card_declined",
  CARD_DECLINED_CALL_ISSUER: "do_not_honor",
  CARD_DECLINED_VERIFICATION_REQUIRED: "authentication_required",
  VOICE_FAILURE: "do_not_honor",
  INSUFFICIENT_FUNDS: "insufficient_funds",
  TRANSACTION_LIMIT: "card_restricted",
  CARDHOLDER_INSUFFICIENT_PERMISSIONS: "card_restricted",
  CARD_NOT_SUPPORTED: "card_restricted",
  UNSUPPORTED_CARD_BRAND: "card_restricted",
  CVV_FAILURE: "incorrect_cvc",
  VERIFY_CVV_FAILURE: "incorrect_cvc",
  // The postal code did not match: the buyer can correct it.
  ADDRESS_VERIFICATION_FAILURE: "card_declined",
  VERIFY_AVS_FAILURE: "card_declined",
  INVALID_POSTAL_CODE: "card_declined",
  CARD_EXPIRED: "expired_card",
  EXPIRATION_FAILURE: "expired_card",
  BAD_EXPIRATION: "expired_card",
  INVALID_EXPIRATION: "expired_card",
  INVALID_EXPIRATION_YEAR: "expired_card",
  INVALID_EXPIRATION_DATE: "expired_card",
  PAN_FAILURE: "incorrect_number",
  // "Cannot be validated" / "Generic error - the card data is invalid": not a dead number.
  INVALID_CARD: "card_declined",
  INVALID_CARD_DATA: "card_declined",
  INVALID_ACCOUNT: "incorrect_number",
  ALLOWABLE_PIN_TRIES_EXCEEDED: "card_restricted",
  ACCOUNT_UNUSABLE: "card_declined",
  BUYER_REFUSED_PAYMENT: "card_declined",
  AMOUNT_TOO_HIGH: "card_restricted",
  RATE_LIMITED: "retry_too_soon",
};

const SQUARE_OUR_SIDE =
  "We could not complete this payment because of a problem with the payment gateway setup. Nothing is wrong with the customer's payment method.";

/** Square codes that name a fault in our own request (SQUARE_ERROR_CODES.md). */
const SQUARE_OUR_REQUEST_CODES = [
  "BAD_REQUEST",
  "MISSING_REQUIRED_PARAMETER",
  "INCORRECT_TYPE",
  "INVALID_VALUE",
  "UNKNOWN_QUERY_PARAMETER",
  "UNKNOWN_BODY_PARAMETER",
  "CONFLICTING_PARAMETERS",
  "EXPECTED_JSON_BODY",
  "VALUE_REGEX_MISMATCH",
  "VALUE_TOO_SHORT",
  "VALUE_TOO_LONG",
  "VALUE_TOO_LOW",
  "VALUE_TOO_HIGH",
  "VALUE_EMPTY",
  "ARRAY_LENGTH_TOO_LONG",
  "ARRAY_LENGTH_TOO_SHORT",
  "ARRAY_EMPTY",
  "EXPECTED_BOOLEAN",
  "EXPECTED_INTEGER",
  "EXPECTED_FLOAT",
  "EXPECTED_STRING",
  "EXPECTED_OBJECT",
  "EXPECTED_ARRAY",
  "EXPECTED_MAP",
  "EXPECTED_BASE64_ENCODED_BYTE_ARRAY",
  "INVALID_ARRAY_VALUE",
  "INVALID_ENUM_VALUE",
  "INVALID_CONTENT_TYPE",
  "INVALID_FORM_VALUE",
  "ONE_INSTRUMENT_EXPECTED",
  "NO_FIELDS_SET",
  "TOO_MANY_MAP_ENTRIES",
  "MAP_KEY_LENGTH_TOO_SHORT",
  "MAP_KEY_LENGTH_TOO_LONG",
  "UNEXPECTED_VALUE",
  "METHOD_NOT_ALLOWED",
  "NOT_ACCEPTABLE",
  "GONE",
  "REQUEST_ENTITY_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "UNPROCESSABLE_ENTITY",
  "NOT_IMPLEMENTED",
  "V1_APPLICATION",
  "V1_ACCESS_TOKEN",
  "INVALID_SQUARE_VERSION_FORMAT",
  "API_VERSION_INCOMPATIBLE",
  "UNSUPPORTED_COUNTRY",
  "UNSUPPORTED_CURRENCY",
  "UNSUPPORTED_INSTRUMENT_TYPE",
  "UNSUPPORTED_SOURCE_TYPE",
  "PAYMENT_AMOUNT_MISMATCH",
  "AMOUNT_TOO_LOW",
  "LOCATION_MISMATCH",
  "CARD_MISMATCH",
  // The adapter resends a renewal without the address first (square.ts `charge`).
  "INVALID_EMAIL_ADDRESS",
] as const;

export const SQUARE_RULES: readonly DeclineRule[] = [
  // The card cannot pay here: unsupported brand, region, merchant category or use.
  ...["CARD_NOT_SUPPORTED", "UNSUPPORTED_CARD_BRAND", "CARDHOLDER_INSUFFICIENT_PERMISSIONS"].map(
    (value): DeclineRule => ({
      id: `square.code.${value.toLowerCase()}`,
      field: "code",
      op: "eq",
      value,
      code: "card_restricted",
      retriable: false,
    }),
  ),
  // The saved card is disabled or gone (measured: NOT_FOUND "Did not find matching card").
  {
    id: "square.code.card_not_found",
    field: "code",
    op: "eq",
    value: "NOT_FOUND",
    code: "payment_method_not_found",
    retriable: false,
    message:
      "The saved payment method is no longer available at the payment provider. Add a payment method again.",
    exposedToPayer: true,
  },
  // A browser token used twice or too late: the buyer enters the details again.
  ...(
    [
      ["SOURCE_USED", "source_used"],
      ["SOURCE_EXPIRED", "source_expired"],
      ["CARD_TOKEN_USED", "card_token_used"],
      ["CARD_TOKEN_EXPIRED", "card_token_expired"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `square.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    // Only a browser token can be used up; nothing is wrong with the card.
    code: "processing_error",
    retriable: true,
    message: "The card details expired. Enter them again.",
    exposedToPayer: true,
  })),
  // Merchant-account setup and request refusals: not the payer's doing.
  ...(
    [
      // Synthesized from INVALID_VALUE on amount_money.currency: one currency per location.
      ["CURRENCY_MISMATCH", "currency_mismatch"],
      ["INSUFFICIENT_PERMISSIONS", "insufficient_permissions"],
      ["INVALID_LOCATION", "invalid_location"],
      ["PAYMENT_LIMIT_EXCEEDED", "payment_limit_exceeded"],
      ["CARD_PROCESSING_NOT_ENABLED", "card_processing_not_enabled"],
      ["PAYMENT_SOURCE_NOT_ENABLED_FOR_TARGET", "source_not_enabled"],
      ["MANUALLY_ENTERED_PAYMENT_NOT_SUPPORTED", "manual_entry_not_supported"],
      ["CUSTOMER_NOT_FOUND", "customer_not_found"],
      ["INVALID_FEES", "invalid_fees"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `square.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "gateway_request_rejected",
    retriable: false,
    message: SQUARE_OUR_SIDE,
    exposedToPayer: false,
  })),
  // HTTP 401/403: Square refused our access token, its scopes or the application.
  ...(
    [
      "UNAUTHORIZED",
      "ACCESS_TOKEN_EXPIRED",
      "ACCESS_TOKEN_REVOKED",
      "FORBIDDEN",
      "INSUFFICIENT_SCOPES",
      "CLIENT_DISABLED",
      "APPLICATION_DISABLED",
      "MERCHANT_SUBSCRIPTION_NOT_FOUND",
    ] as const
  ).map((value): DeclineRule => ({
    id: `square.code.${value.toLowerCase()}`,
    field: "code",
    op: "eq",
    value,
    code: "gateway_request_rejected",
    message:
      "Square refused our access to the merchant account. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  })),
  // ── From the documented list (SQUARE_ERROR_CODES.md, captured 2026-11-17) ──
  // Our request: a value, a version or a combination Square does not accept.
  ...SQUARE_OUR_REQUEST_CODES.map((value): DeclineRule => ({
    id: `square.code.${value.toLowerCase()}`,
    field: "code",
    op: "eq",
    value,
    code: "gateway_request_rejected",
    message: SQUARE_OUR_SIDE,
    exposedToPayer: false,
  })),
  // A held payment Square already canceled or let expire: the buyer starts again.
  ...(["DELAYED_TRANSACTION_EXPIRED", "DELAYED_TRANSACTION_CANCELED"] as const).map(
    (value): DeclineRule => ({
      id: `square.code.${value.toLowerCase()}`,
      field: "code",
      op: "eq",
      value,
      code: "intent_expired",
    }),
  ),
  // A held payment already captured or failed: the adapter reads it back.
  ...(["DELAYED_TRANSACTION_CAPTURED", "DELAYED_TRANSACTION_FAILED"] as const).map(
    (value): DeclineRule => ({
      id: `square.code.${value.toLowerCase()}`,
      field: "code",
      op: "eq",
      value,
      code: "processing_error",
      retriable: true,
    }),
  ),
  {
    id: "square.code.card_presence_required",
    field: "code",
    op: "eq",
    value: "CARD_PRESENCE_REQUIRED",
    code: "card_restricted",
    retriable: false,
  },
  // The bank link (ACH through Plaid).
  ...(
    [
      ["PLAID_ERROR_ITEM_LOGIN_REQUIRED", "authentication_required"],
      ["PLAID_ERROR_INSUFFICIENT_CREDENTIALS", "authentication_required"],
      ["PLAID_ERROR_INVALID_ACCESS_TOKEN", "bank_account_invalid_details"],
      ["PLAID_ERROR_ITEM_NOT_SUPPORTED", "bank_account_invalid_details"],
      ["PLAID_ERROR_INVALID_ACCOUNT_ID", "bank_account_not_found"],
      ["PLAID_ERROR_NO_ACCOUNTS", "bank_account_not_found"],
      ["PLAID_ERROR_ITEM_NOT_FOUND", "bank_account_not_found"],
    ] as const
  ).map(([value, code]): DeclineRule => ({
    id: `square.code.${value.toLowerCase()}`,
    field: "code",
    op: "eq",
    value,
    code,
  })),
  ...(["PLAID_ERROR", "PLAID_ERROR_RATE_LIMIT", "PLAID_ERROR_PRODUCT_NOT_READY"] as const).map(
    (value): DeclineRule => ({
      id: `square.code.${value.toLowerCase()}`,
      field: "code",
      op: "eq",
      value,
      code: "processing_error",
      retriable: true,
    }),
  ),
];

export function normalizeSquareDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  return evaluate(asSignal(raw), SQUARE_RULES, SQUARE_CODE_TABLE);
}

/**
 * Documented Square codes that no call of ours can return, with the reason.
 */
export const SQUARE_CODES_OUR_CALLS_NEVER_RAISE: Readonly<Record<string, string>> = neverRaisedBy([
  [
    "an API or feature we never call (subscriptions, loyalty, order returns, search cursors, mobile)",
    [
      "INVALID_TIME",
      "INVALID_TIME_RANGE",
      "INVALID_CURSOR",
      "INVALID_SORT_ORDER",
      "CUSTOMER_MISSING_NAME",
      "CUSTOMER_MISSING_EMAIL",
      "INVALID_PAUSE_LENGTH",
      "INVALID_DATE",
      "UNSUPPORTED_LOYALTY_REWARD_TIER",
      "ORDER_UNPAID_NOT_RETURNABLE",
      "PARTIAL_PAYMENT_DELAY_CAPTURE_NOT_SUPPORTED",
      "SANDBOX_NOT_SUPPORTED",
      "INVALID_PHONE_NUMBER",
      "CHECKOUT_EXPIRED",
      "BAD_CERTIFICATE",
      "APPLE_PAYMENT_PROCESSING_CERTIFICATE_HASH_NOT_FOUND",
    ],
  ],
  [
    "card-present, PIN, EBT or gift card; not offered",
    [
      "APPLE_TTP_PIN_TOKEN",
      "UNSUPPORTED_ENTRY_METHOD",
      "INVALID_ENCRYPTED_CARD",
      "READER_DECLINED",
      "INVALID_PIN",
      "MISSING_PIN",
      "MISSING_ACCOUNT_TYPE",
      "GIFT_CARD_AVAILABLE_AMOUNT",
      "CHIP_INSERTION_REQUIRED",
      "CART_INELIGIBLE_FOR_EBT",
    ],
  ],
  [
    "refunds: the refusal reaches the operator in Square's words",
    [
      "REFUND_AMOUNT_INVALID",
      "REFUND_ALREADY_PENDING",
      "PAYMENT_NOT_REFUNDABLE",
      "PAYMENT_NOT_REFUNDABLE_DUE_TO_DISPUTE",
      "REFUND_ERROR_PAYMENT_NEEDS_COMPLETION",
      "REFUND_DECLINED",
      "INSUFFICIENT_PERMISSIONS_FOR_REFUND",
      "RESERVATION_DECLINED",
    ],
  ],
  [
    "a 408, 409, 429 or 5xx: replayed with the same key, then looked up by reference",
    [
      "INTERNAL_SERVER_ERROR",
      "REQUEST_TIMEOUT",
      "CONFLICT",
      "BAD_GATEWAY",
      "SERVICE_UNAVAILABLE",
      "TEMPORARY_ERROR",
      "GATEWAY_TIMEOUT",
    ],
  ],
  ["the payment the key already made is read back and answered", ["IDEMPOTENCY_KEY_REUSED"]],
]);

/**
 * Mollie: a card payment's `details.failureReason`, a SEPA Direct Debit's
 * `details.bankReasonCode` (the EPC R-transaction reason), or the payment's final status.
 */
export const MOLLIE_CODE_TABLE: Record<string, string> = {
  // Card `failureReason`.
  authentication_abandoned: "authentication_required",
  authentication_failed: "authentication_required",
  authentication_required: "authentication_required",
  authentication_unavailable_acs: "authentication_required",
  card_declined: "card_declined",
  card_expired: "expired_card",
  inactive_card: "card_declined",
  insufficient_funds: "insufficient_funds",
  invalid_cvv: "incorrect_cvc",
  invalid_card_holder_name: "card_declined",
  invalid_card_number: "incorrect_number",
  invalid_card_type: "card_declined",
  possible_fraud: "fraudulent",
  refused_by_issuer: "do_not_honor",
  unknown_reason: "card_declined",
  // SEPA Direct Debit `bankReasonCode`.
  AC01: "bank_account_invalid_details",
  AC04: "bank_account_closed",
  AC06: "bank_account_closed",
  AC13: "bank_account_invalid_details",
  AG01: "bank_account_invalid_details",
  AG02: "processing_error",
  AM04: "insufficient_funds",
  AM05: "processing_error",
  BE05: "processing_error",
  CNOR: "processing_error",
  DNOR: "bank_account_invalid_details",
  FF01: "processing_error",
  MD01: "debit_not_authorized",
  MD02: "debit_not_authorized",
  MD06: "debit_not_authorized",
  MD07: "bank_account_closed",
  MS02: "debit_not_authorized",
  MS03: "do_not_honor",
  RC01: "bank_account_invalid_details",
  RR01: "processing_error",
  RR02: "processing_error",
  RR03: "processing_error",
  RR04: "processing_error",
  SL01: "debit_not_authorized",
  // EPC: the interbank settlement failed, not the payer's account. Retry.
  ED05: "processing_error",
  // A payment with no reason: the payer stopped, or the hosted page timed out. Not a decline.
  canceled: "payment_abandoned",
  expired: "payment_abandoned",
  // Failed with no reason (PayPal, iDEAL, Bancontact and some cards document none).
  failed: "charge_failed",
  // Engine-minted: Mollie refused our capture of an authorization.
  capture_refused: "processing_error",
};

export const MOLLIE_RULES: readonly DeclineRule[] = [
  // Mollie refused our request (a 4xx with no payment): not the payer's doing.
  {
    id: "mollie.code.request_rejected",
    field: "code",
    op: "eq",
    value: "request_rejected",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.",
    exposedToPayer: false,
  },
  // The account cannot debit this mandate type (PayPal without Reference Transactions).
  {
    id: "mollie.code.method_not_recurring",
    field: "code",
    op: "eq",
    value: "method_not_recurring",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "The Mollie account cannot take automatic payments with this payment method. For PayPal, ask PayPal to enable Reference Transactions.",
    exposedToPayer: false,
  },
  // The mandate was revoked or never became valid.
  {
    id: "mollie.code.no_valid_mandate",
    field: "code",
    op: "eq",
    value: "no_valid_mandate",
    code: "mandate_expired",
    retriable: false,
    message:
      "The authorization for automatic payments is no longer valid. Set up the payment method again to continue.",
    exposedToPayer: true,
  },
];

export function normalizeMollieDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  return evaluate(asSignal(raw), MOLLIE_RULES, MOLLIE_CODE_TABLE);
}

/**
 * Documented Mollie codes that no call of ours can return. None: every failure reason, EPC
 * code and failure status is mapped. Point-of-sale `statusReason` codes are not captured as
 * documented codes here (Mollie sends them only for in-person payments, which we never take).
 */
export const MOLLIE_CODES_OUR_CALLS_NEVER_RAISE: Readonly<Record<string, string>> = {};

/**
 * PayU India. Codes are PayU's `error` field (E-codes; the issuer-decline and payment error
 * tables in PayU's error-codes reference, read 2026-10-25). `si_transaction` reports only
 * free text (`field9`), so a few rules match the message.
 */
export const PAYU_CODE_TABLE: Record<string, string> = {
  E348: "card_declined",
  E1903: "card_declined",
  E207: "card_declined",
  E1632: "card_declined",
  E337: "card_declined",
  E909: "card_declined",
  E9246: "card_declined",
  E2102: "card_declined",
  E310: "lost_card",
  E307: "do_not_honor",
  E312: "do_not_honor",
  E4363: "do_not_honor",
  E4147: "do_not_honor",
  E305: "incorrect_number",
  E707: "incorrect_number",
  E313: "incorrect_cvc",
  E311: "expired_card",
  E324: "fraudulent",
  E325: "card_restricted",
  E1642: "card_restricted",
  E1626: "card_restricted",
  E1625: "card_restricted",
  E705: "card_restricted",
  E706: "insufficient_funds",
  E717: "bank_account_closed",
  E345: "processing_error",
  E308: "processing_error",
  E1629: "processing_error",
  E4158: "processing_error",
  E225: "processing_error",
  E500: "processing_error",
  E4279: "processing_error",
  E4272: "processing_error",
  E1601: "authentication_required",
  // UPI Autopay mandate states.
  E4271: "debit_not_authorized",
  E4278: "debit_not_authorized",
  E4111: "mandate_expired",
  E4053: "mandate_expired",
  E4533: "mandate_expired",
  E4115: "mandate_cycle_limit_exceeded",
  E1203: "mandate_ceiling_exceeded",
  // From PayU's published transaction table (docs/references/PAYU_ERROR_CODES.md).
  E4359: "stolen_card",
  E4360: "stolen_card",
  E4004: "fraudulent",
  E4110: "mandate_expired",
  E4114: "mandate_expired",
  E4128: "mandate_expired",
  E4282: "mandate_expired",
  E4276: "mandate_expired",
  E4680: "mandate_expired",
  // Withdrawal stopped: death, insolvency or lunacy of the account holder.
  E4316: "bank_account_closed",
  E4317: "bank_account_closed",
  E4318: "bank_account_closed",
  E4293: "mandate_ceiling_exceeded",
  E4536: "mandate_ceiling_exceeded",
  E4116: "mandate_ceiling_exceeded",
  E4037: "insufficient_funds",
  E4035: "insufficient_funds",
  E1664: "card_restricted",
  E1652: "card_restricted",
  E4348: "card_restricted",
  E4375: "card_restricted",
  E323: "expired_card",
  E1670: "incorrect_cvc",
  E801: "processing_error",
  E802: "processing_error",
  E206: "processing_error",
  E4225: "gateway_request_rejected",
  E1643: "gateway_request_rejected",
};

const PAYU_OURS =
  "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.";
const PAYU_MANDATE_GONE =
  "The payment mandate is no longer active. Set up the payment method again to continue your subscription.";

const payuCode = (value: string, code: string, extra: Partial<DeclineRule> = {}): DeclineRule => ({
  id: `payu.code.${value.toLowerCase()}`,
  field: "code",
  op: "eq",
  value,
  code,
  ...extra,
});

const payuPayer = (value: string, code: string, message: string) =>
  payuCode(value, code, { message, exposedToPayer: true });

const payuOurs = (value: string) =>
  payuCode(value, "gateway_request_rejected", { message: PAYU_OURS, exposedToPayer: false });

export const PAYU_RULES: readonly DeclineRule[] = [
  /**
   * ── PAYU'S DOCUMENTED TRANSACTION CODES (§1.1, 2026-11-17) ─────────────────────
   *
   * Every code has a rule, a table entry or a never-raised entry
   * (`PAYU_CODES_OUR_CALLS_NEVER_RAISE`); payu-error-code-coverage.test.ts holds it. First,
   * because the code is more exact than the `error_Message` words the rules below read.
   * Payment intents send no `enforce_paymethod`, so EMI, wallet and pay-later codes can arrive.
   */
  // Revoked, expired, missing or moved to another account: only a new mandate recovers it.
  // Hard like Razorpay `mandate_not_active` and Cashfree "mandate has been revoked".
  ...[
    "E4110",
    "E4111",
    "E4053",
    "E4533",
    "E4114",
    "E4128",
    "E4282",
    "E4276",
    "E4680",
    "E4125",
    "E4034",
  ].map((v) =>
    payuCode(v, "mandate_expired", {
      retriable: false,
      message: PAYU_MANDATE_GONE,
      exposedToPayer: true,
    }),
  ),
  // Dormant, inoperative, or stopped by a court or attachment order: another account pays.
  ...["E4391", "E4315", "E4326"].map((v) => payuCode(v, "bank_account_restricted")),
  ...["E4340"].map((v) => payuCode(v, "bank_account_not_found")),
  // The UPI handle is not registered: the VPA on file cannot be debited.
  ...["E4166"].map((v) => payuCode(v, "bank_account_invalid_details")),
  // The payer declined this one debit in their app; the mandate stays active.
  ...["E4168"].map((v) => payuCode(v, "debit_cancelled_by_payer")),
  ...["E4108"].map((v) =>
    payuPayer(
      v,
      "debit_cancelled_by_payer",
      "You paused the automatic payments in your UPI app. Resume them, or pay this invoice now.",
    ),
  ),
  ...["E713", "E1208", "E4036", "E1505"].map((v) => payuCode(v, "insufficient_funds")),
  // The payer's own debit limit at the bank.
  ...["E4152", "E4389"].map((v) => payuPayer(v, "insufficient_funds", IN_PAYER_LIMIT)),
  // Daily, count and first-day limits on the payer's account: the next day can pay.
  ...["E1628", "E4369", "E4021", "E4022"].map((v) =>
    payuPayer(v, "retry_too_soon", IN_DAILY_LIMIT),
  ),
  // This cycle's debit is done or running: wait for the next window.
  ...["E4109", "E4683", "E4682"].map((v) => payuCode(v, "retry_too_soon")),
  ...["E2406", "E1627", "E9217", "E708", "E4388", "E1911", "E1661", "E1662"].map((v) =>
    payuPayer(v, "try_again_later", IN_WRONG_CODE_TOO_OFTEN),
  ),
  // The payer did not pass the bank's OTP, PIN, password or 3-D Secure step.
  ...[
    "E306",
    "E1000",
    "E300",
    "E317",
    "E303",
    "E232",
    "E335",
    "E1633",
    "E1663",
    "E340",
    "E4386",
    "E4390",
    "E2404",
    "E1644",
    "E4387",
    "E326",
    "E327",
    "E4148",
    "E710",
    "E1623",
    "E9244",
    "E1645",
    "E210",
    "E213",
    "E202",
    "E917",
    "E1910",
    "E1002",
    "E501",
    "E316",
    "E1302",
    "E4042",
    "E1703",
    "E1604",
    "E1666",
  ].map((v) => payuCode(v, "authentication_required")),
  ...["E4005"].map((v) =>
    payuPayer(
      v,
      "card_restricted",
      "Your UPI PIN is not set. Set it in your UPI app, then try again.",
    ),
  ),
  // A card number that cannot exist, no BIN, or "56 No Card Record": only another card pays.
  ...["E201", "E4934", "E4346"].map((v) => payuCode(v, "incorrect_number")),
  // "Decline - The card type is not accepted by the payment processor".
  payuCode("E902", "card_restricted", { retriable: false }),
  // Not permitted to the cardholder (Visa 57, never resubmit).
  ...["E1642", "E4348"].map((v) => payuCode(v, "card_restricted", { retriable: false })),
  // A wrong name is not a wrong number: soft, payer re-enters it.
  ...["E709"].map((v) => payuPayer(v, "card_declined", IN_CARD_NAME_WRONG)),
  // Address, ZIP, phone or email does not match the issuer's records.
  ...["E304", "E314", "E714", "E332", "E331", "E333", "E339"].map((v) =>
    payuPayer(
      v,
      "incorrect_address",
      "The billing details do not match the details at your bank. Check them, then try again.",
    ),
  ),
  // The buyer cancelled, went back, refreshed or let the page expire. Hosted page only.
  ...[
    "E231",
    "E408",
    "E1611",
    "E1613",
    "E1606",
    "E1610",
    "E1602",
    "E1206",
    "E1300",
    "E1605",
    "E1607",
    "E502",
    "E507",
    "E4103",
    "E4218",
  ].map((v) => payuCode(v, "payment_abandoned")),
  // The payer did not answer the mandate or collect request.
  ...["E4273", "E4283", "E4284", "E4176"].map((v) => payuCode(v, "afa_not_completed")),
  ...["E908", "E903", "E9239", "E9247"].map((v) =>
    payuPayer(
      v,
      "card_not_supported",
      "This card cannot be used for this payment. Use a different card or payment method.",
    ),
  ),
  // The card, account, app or credit line cannot carry this payment: another one pays.
  ...[
    "E4040",
    "E4374",
    "E4010",
    "E4146",
    "E4314",
    "E9252",
    "E1210",
    "E4232",
    "E4313",
    "E4001",
    "E4224",
    "E1609",
    "E4009",
    "E4012",
    "E1603",
    "E2403",
    "E1202",
    "E1624",
    "E4342",
    "E4356",
    "E4094",
    "E4096",
    "E4264",
    "E4265",
    "E4249",
    "E4288",
    "E4383",
    "E910",
    "E1301",
    "E229",
    "E2405",
    "E2401",
    "E2402",
    "E2408",
    "E805",
    "E806",
    "E807",
    "E4312",
    "E1003",
    "E4227",
    "E9221",
  ].map((v) => payuCode(v, "card_restricted")),
  ...["E4149", "E4143"].map((v) => payuPayer(v, "do_not_honor", IN_MERCHANT_BLOCKED)),
  // Refused on risk or compliance grounds.
  // The issuer suspects fraud. E4378 stays a refusal: the risk score is the beneficiary bank's.
  payuCode("E338", "fraudulent"),
  ...["E4378", "E1655", "E4015", "E9232", "E9219"].map((v) => payuCode(v, "do_not_honor")),
  // A plain refusal, including PayU's bare "FAILURE" rows.
  ...[
    "E9240",
    "E9234",
    "E9235",
    "E9233",
    "E223",
    "E343",
    "E4140",
    "E1204",
    "E4803",
    "E344",
    "EX311",
    "E9248",
    "E1640",
    "E9236",
    "E600",
    "E905",
    "E329",
    "E309",
    "E4179",
    "E9218",
    "E9216",
    "E1648",
    "E9202",
    "E9238",
    "E9249",
    "E9230",
    "E719",
    "E336",
    "E4888",
    "E4890",
    "E4891",
    "E4892",
    "E4897",
    "E4900",
    "E4903",
    "E4904",
    "E4907",
    "E4909",
    "E4910",
    "E9206",
    "E9205",
    "E4192",
    "E4124",
  ].map((v) => payuCode(v, "card_declined")),
  // Mandates are not enabled for our account or our acquiring bank.
  ...["E4291", "E4121", "E4382"].map((v) => payuCode(v, "recurring_not_enabled")),
  // Timeouts, downtime and processing faults at the bank, NPCI, the PSP or PayU.
  ...[
    "E1608",
    "E2110",
    "E4385",
    "E4041",
    "E4259",
    "E4044",
    "E4045",
    "E9211",
    "E227",
    "E4188",
    "E4197",
    "E215",
    "E4157",
    "E9208",
    "E1658",
    "E199",
    "E1654",
    "E4183",
    "E4186",
    "E4268",
    "E9220",
    "E4187",
    "E4267",
    "E4184",
    "E9231",
    "E4198",
    "E4153",
    "E4185",
    "E4608",
    "E4196",
    "E4195",
    "E4170",
    "E4167",
    "E4277",
    "E4280",
    "E4274",
    "E4275",
    "E4281",
    "E4294",
    "E4357",
    "E4177",
    "E4526",
    "E9229",
    "E1656",
    "E4219",
    "E4381",
    "E704",
    "E4292",
    "E4202",
    "E4175",
    "E1907",
    "E1905",
    "E1906",
    "E4003",
    "E4141",
    "E4101",
    "E4347",
    "E4002",
    "E9207",
    "E211",
    "E4525",
    "E4247",
    "E4248",
    "E222",
    "E221",
    "E1650",
    "E342",
    "E803",
    "E804",
    "E1639",
    "E1001",
    "E334",
    "E209",
    "E208",
    "E205",
    "E219",
    "E214",
    "E1909",
    "E4178",
    "E1303",
    "E2111",
    "E1400",
    "E4182",
    "E4142",
    "E9223",
    "E4181",
    "E4180",
    "E4013",
    "E4027",
    "E4358",
    "E4353",
    "E4352",
    "E9227",
    "E1636",
    "E1635",
    "E9210",
    "E9213",
    "E9214",
    "E9215",
    "E9212",
    "E4189",
    "E4190",
    "E4191",
    "E4193",
    "E4194",
    "E4212",
    "E4213",
    "E4214",
    "E4269",
    "E4933",
    "E4171",
    "E4172",
    "E4173",
    "E4298",
    "E4299",
    "E4102",
    "E1634",
    "E1651",
    "E1638",
    "E4512",
    "E4333",
    "E1900",
    "E1901",
    "E228",
    "E216",
    "E4931",
    "E601",
    "E1665",
    "E1667",
    "E1668",
    "E4285",
    "E4286",
    "E4258",
    "E4256",
    "E4257",
    "E4254",
    "E4253",
    "E4252",
    "E4251",
    "E4255",
    "E4250",
    "E4039",
    "E4263",
    "E4150",
    "E4020",
    "E4019",
    "E4132",
    "E4221",
    "EA09",
    "EA08",
    "E4367",
    "E1653",
    "E1659",
    "E4935",
  ].map((v) => payuCode(v, "processing_error")),
  // Our request, our account or our acquiring side: never the payer's instrument.
  ...[
    "E1620",
    "E907",
    "E224",
    "E4530",
    "E4531",
    "E4156",
    "E4373",
    "E9209",
    "E1101",
    "E4155",
    "E217",
    "E9226",
    "E4119",
    "E1657",
    "E1631",
    "E1630",
    "E4025",
    "E4024",
    "E4093",
    "E1201",
    "E700",
    "E4649",
    "E4091",
    "E4063",
    "E4106",
    "E4301",
    "E4107",
    "E4201",
    "E4658",
    "E800",
    "E330",
    "E4030",
    "E4028",
    "E4017",
    "E4018",
    "E4032",
    "E4031",
    "E4029",
    "E4136",
    "E4135",
    "E4134",
    "E4026",
    "E4137",
    "E4133",
    "E4117",
    "E4120",
    "E4210",
    "E4211",
    "E4050",
    "E4138",
    "E4052",
    "E4048",
    "E4006",
    "E4008",
    "E4325",
    "E4113",
    "E4242",
    "E4244",
    "E4289",
    "E4095",
    "E4038",
    "E4007",
    "E4130",
    "E4047",
    "E4206",
    "E4207",
    "E4046",
    "E4208",
    "E4209",
    "E4049",
    "E4205",
    "E1700",
    "E226",
    "E4011",
    "E4204",
    "E346",
    "E4666",
    "E4365",
    "E9237",
    "E4220",
    "E4065",
    "E4099",
    "E4066",
    "E4100",
    "E4064",
    "E4098",
    "E4056",
    "E4060",
    "E4059",
    "E4081",
    "E4075",
    "E4086",
    "E4057",
    "E4080",
    "E4058",
    "E4061",
    "E4084",
    "E4062",
    "E4072",
    "E4070",
    "E4071",
    "E4087",
    "E4327",
    "E4328",
    "E4069",
    "E4079",
    "E4054",
    "E4085",
    "E4068",
    "E4067",
    "E4090",
    "E4055",
    "E4082",
    "E4078",
    "E4083",
    "E4329",
    "E4330",
    "E4073",
    "E4074",
    "E4092",
    "E4089",
    "E4088",
    "E4679",
    "E4309",
    "E4532",
    "E4077",
    "E4131",
    "E4127",
    "E4535",
    "E4122",
    "E1020",
    "E1646",
    "E1637",
    "E1647",
    "E2407",
    "E2081",
    "E1702",
    "E4521",
    "E4371",
    "E4332",
    "E4368",
    "E4337",
    "E4336",
    "E2409",
    "E1501",
    "E4076",
    "E4154",
    "E4338",
    "E4339",
    "E4199",
    "E4160",
    "E4164",
    "E4023",
    "E1619",
    "E4174",
    "E4262",
    "E4260",
    "E4261",
    "E4384",
    "E4097",
    "E914",
    "E915",
    "E916",
    "E347",
    "E4159",
    "E712",
    "E2100",
    "E1701",
    "E220",
    "E4161",
    "E4151",
    "E9251",
    "E4016",
    "E4014",
    "E1500",
    "E4392",
    "E4341",
    "E4364",
    "E4222",
    "E4223",
    "E4104",
    "E1902",
    "E4511",
    "E1502",
    "E4319",
    "E4118",
    "E4033",
    "E4343",
    "E4051",
  ].map((v) => payuOurs(v)),
  // The payer's card or bank cannot carry a standing instruction: a different method pays,
  // and the merchant account is fine, so no gateway alert.
  // E755: registration paid but the card cannot carry one. E756: the BIN is not supported
  // for subscriptions ("retry using a new card").
  ...["E755", "E756"].map((v) =>
    payuCode(v, "card_restricted", {
      retriable: false,
      message:
        "This card does not support automatic payments. Use a different card or UPI to set up the payment method.",
      exposedToPayer: true,
    }),
  ),
  // E4290: the payer's bank is not registered for mandates (REMITTER_BANK_NOT_REGISTERED).
  payuCode("E4290", "bank_account_restricted", {
    retriable: false,
    message:
      "Your bank does not support automatic payments. Use a different bank account, UPI ID or card to set up the payment method.",
    exposedToPayer: true,
  }),
  {
    id: "payu.code.e4295",
    field: "code",
    op: "eq",
    value: "E4295",
    code: "payment_method_not_found",
    retriable: false,
  },
  // si_transaction refusals (`field9`).
  ...(
    [
      ["missing_card_token", "missing card token"],
      ["mandate_not_active", "mandate is not active"],
      ["mandate_revoked", "mandate has been revoked"],
      // Measured 2026-10-30: a UPI debit after the mandate was revoked.
      ["mandate_already_revoked", "mandate is already revoked"],
      ["consent_not_active", "not in active state"],
      // Measured 2026-10-30 on a revoked card mandate.
      ["consent_not_enrolled", "not enrolled for si"],
    ] as const
  ).map(
    ([slug, value]) =>
      ({
        id: `payu.message.${slug}`,
        field: "message",
        op: "contains",
        value,
        code: "mandate_expired",
        retriable: false,
        message: PAYU_MANDATE_GONE,
        exposedToPayer: true,
      }) as const,
  ),
  {
    id: "payu.message.entry_not_found",
    field: "message",
    op: "contains",
    value: "entry not found",
    code: "payment_method_not_found",
    retriable: false,
  },
  // pre_debit_SI on UPI (pre_debit_notification_api, read 2026-10-30): one pre-debit and
  // execution cycle per mandate. Ours to resolve (withdraw the open notice, or wait for its
  // debit); never a reason to doubt the payer's mandate.
  ...(["E9254", "E9256"] as const).map(
    (value) =>
      ({
        id: `payu.code.${value.toLowerCase()}`,
        field: "code",
        op: "eq",
        value,
        code: "pre_debit_cycle_open",
        retriable: true,
        message: PAYU_OURS,
        exposedToPayer: false,
      }) as const,
  ),
  // "Predebit for calculated sequence sent during incorrect period": a timing refusal.
  {
    id: "payu.code.e9263",
    field: "code",
    op: "eq",
    value: "E9263",
    code: "pre_debit_not_due", // PRE_DEBIT_NOT_DUE_CODE
    retriable: true,
    message: PAYU_OURS,
    exposedToPayer: false,
  },
  // Our request: a notice over 30 days ahead, or a sequence number we never send.
  {
    id: "payu.code.e9260",
    field: "code",
    op: "eq",
    value: "E9260",
    code: "gateway_request_rejected",
    message: PAYU_OURS,
    exposedToPayer: false,
  },
  {
    id: "payu.message.invalid_mandate_seq_no",
    field: "message",
    op: "contains",
    value: "invalid value for mandateseqno",
    code: "gateway_request_rejected",
    message: PAYU_OURS,
    exposedToPayer: false,
  },
  // The amount differs from the pre-debit notice: our request, not the payer's mandate.
  {
    id: "payu.code.e4112",
    field: "code",
    op: "eq",
    value: "E4112",
    code: "gateway_request_rejected",
    message: PAYU_OURS,
    exposedToPayer: false,
  },
  // The same, by its words. Measured 2026-11-02 (card, UAT): inner `failed`, no payuid, field9
  // "Mandated SI transactions, Recurring amount does not match pre-debit amount, expected: …".
  {
    id: "payu.message.amount_not_pre_debit",
    field: "message",
    op: "contains",
    value: "does not match pre-debit amount",
    code: "gateway_request_rejected",
    message: PAYU_OURS,
    exposedToPayer: false,
  },
  {
    id: "payu.code.e9253",
    field: "code",
    op: "eq",
    value: "E9253",
    code: "gateway_request_rejected",
    message: PAYU_OURS,
    exposedToPayer: false,
  },
  {
    id: "payu.code.e4105",
    field: "code",
    op: "eq",
    value: "E4105",
    code: "gateway_request_rejected",
    message: PAYU_OURS,
    exposedToPayer: false,
  },
  // Our key, salt or request. Never the payer's instrument, so retriable stays the default.
  {
    id: "payu.message.invalid_hash",
    field: "message",
    op: "contains",
    value: "invalid hash",
    code: "gateway_request_rejected",
    message: PAYU_OURS,
    exposedToPayer: false,
  },
  {
    id: "payu.code.e341",
    field: "code",
    op: "eq",
    value: "E341",
    code: "gateway_request_rejected",
    message: PAYU_OURS,
    exposedToPayer: false,
  },
  {
    id: "payu.code.e715",
    field: "code",
    op: "eq",
    value: "E715",
    code: "gateway_request_rejected",
    message: PAYU_OURS,
    exposedToPayer: false,
  },
  {
    id: "payu.code.e504",
    field: "code",
    op: "eq",
    value: "E504",
    code: "gateway_request_rejected",
    message: PAYU_OURS,
    exposedToPayer: false,
  },
  // Documented `status: 0` answers to si_transaction: our request, no transaction made.
  ...(
    [
      ["invalid_country", "contains", "invalid country"],
      ["missing_mandatory_field", "contains", "missing mandatory field"],
      ["invalid_request", "matches", "^invalid request\\.?$"],
      ["merchant_key_empty", "contains", "merchant key is empty"],
      ["auth_payu_id_mandatory", "contains", "authpayuid is mandatory"],
    ] as const
  ).map(
    ([slug, op, value]) =>
      ({
        id: `payu.message.${slug}`,
        field: "message",
        op,
        value,
        code: "gateway_request_rejected",
        message: PAYU_OURS,
        exposedToPayer: false,
      }) as const,
  ),
  // The card consent is not a mandate: nothing to debit.
  {
    id: "payu.message.consent_not_mandated",
    field: "message",
    op: "contains",
    value: "consent is not mandated",
    code: "mandate_expired",
    retriable: false,
    message: PAYU_MANDATE_GONE,
    exposedToPayer: true,
  },
];

/**
 * Documented PayU codes that no call of ours can return, with the reason. They get no rule: a
 * rule for a code that cannot arrive is dead config.
 */
const PAYU_APPROVAL = "an approval or success answer, never a failure's code";
const PAYU_S2S = "the server-to-server and native-OTP flows; we post PayU's hosted page";
const PAYU_REFUND =
  "refund and cancel API: `refund()` reports it as a refusal, not a payment decline";
export const PAYU_CODES_OUR_CALLS_NEVER_RAISE: Readonly<Record<string, string>> = {
  E000: PAYU_APPROVAL,
  E4605: PAYU_APPROVAL,
  E4607: PAYU_APPROVAL,
  E9203: PAYU_APPROVAL,
  E9204: PAYU_APPROVAL,
  E9222: PAYU_APPROVAL,
  E9250: PAYU_APPROVAL,
  E9245: PAYU_APPROVAL,
  E1649: PAYU_APPROVAL,
  E4684: "the VPA check API; we never call it",
  E4685: "the VPA check API; we never call it",
  E1615: PAYU_S2S,
  E1616: PAYU_S2S,
  E1617: PAYU_S2S,
  E1618: PAYU_S2S,
  E1621: PAYU_S2S,
  E1622: PAYU_S2S,
  E1908: PAYU_S2S,
  E2502: PAYU_S2S,
  E2503: PAYU_S2S,
  E2201: "split settlements; we never send `splitRequest`",
  E2202: "split settlements; we never send `splitRequest`",
  E2101: "PayU offers and discounts; we never send an offer",
  E1800: "PayU offers and discounts; we never send an offer",
  E1660: "multi-currency pricing; we never send MCP fields",
  E1669: "multi-currency pricing; we never send MCP fields",
  E4516: PAYU_REFUND,
  E4517: PAYU_REFUND,
  E4519: PAYU_REFUND,
  E4520: PAYU_REFUND,
  E4522: PAYU_REFUND,
  E4527: PAYU_REFUND,
  E4930: PAYU_REFUND,
  E4200: PAYU_REFUND,
  E9241: PAYU_REFUND,
  E9242: PAYU_REFUND,
  E9243: PAYU_REFUND,
  E1641: PAYU_REFUND,
  E9224: "cash withdrawal at an ATM; never an online payment",
  E9225: "cash withdrawal at an ATM; never an online payment",
};

export function normalizePayuDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  return evaluate(asSignal(raw), PAYU_RULES, PAYU_CODE_TABLE);
}

/**
 * CyberSource: REST `errorInformation.reason` / `reason` values (the published enum on
 * `/pts/v2/payments`), Transaction Search `rFlag`s and NACHA return codes on eCheck events →
 * canonical tokens.
 */
export const CYBERSOURCE_CODE_TABLE: Record<string, string> = {
  AVS_FAILED: "card_declined",
  CONTACT_PROCESSOR: "do_not_honor",
  EXPIRED_CARD: "expired_card",
  PROCESSOR_DECLINED: "card_declined",
  INSUFFICIENT_FUND: "insufficient_funds",
  EXCEEDS_CREDIT_LIMIT: "insufficient_funds",
  STOLEN_LOST_CARD: "stolen_card",
  ISSUER_UNAVAILABLE: "processing_error",
  UNAUTHORIZED_CARD: "card_restricted",
  // "For eCheck payment, Customer's account is frozen."
  SUSPENDED_ACCOUNT: "bank_account_restricted",
  ALLOWABLE_PIN_RETRIES_EXCEEDED: "card_restricted",
  CVN_NOT_MATCH: "incorrect_cvc",
  INVALID_CVN: "incorrect_cvc",
  CV_FAILED: "incorrect_cvc",
  INVALID_ACCOUNT: "incorrect_number",
  INVALID_CARD: "incorrect_number",
  INVALID_CARD_TYPE: "card_restricted",
  CARD_TYPE_NOT_ACCEPTED: "card_restricted",
  PAYMENT_REFUSED: "card_declined",
  GENERAL_DECLINE: "card_declined",
  DECLINED_CHECK: "do_not_honor",
  BLACKLISTED_CUSTOMER: "card_declined",
  DECISION_PROFILE_REJECT: "card_declined",
  SCORE_EXCEEDS_THRESHOLD: "card_declined",
  CUSTOMER_WATCHLIST_MATCH: "card_declined",
  ADDRESS_COUNTRY_WATCHLIST_MATCH: "card_declined",
  EMAIL_COUNTRY_WATCHLIST_MATCH: "card_declined",
  IP_COUNTRY_WATCHLIST_MATCH: "card_declined",
  DAGGREJECTED: "card_declined",
  DAGGDENIED: "card_declined",
  DSYSREJECTED: "card_declined",
  PENDING_AUTHENTICATION: "authentication_required",
  CONSUMER_AUTHENTICATION_REQUIRED: "authentication_required",
  CONSUMER_AUTHENTICATION_FAILED: "card_declined",
  PARTIAL_AUTHORIZED: "card_declined",
  PROCESSOR_ERROR: "processing_error",
  PROCESSOR_UNAVAILABLE: "processing_error",
  SYSTEM_ERROR: "processing_error",
  SERVER_TIMEOUT: "processing_error",
  SERVICE_TIMEOUT: "processing_error",
  ACH_VERIFICATION_FAILED: "bank_account_invalid_details",
  // Pinless debit: the card's per-use amount or frequency limit. Another day or card pays.
  DEBIT_CARD_USAGE_LIMIT_EXCEEDED: "insufficient_funds",
  // Transaction Search rFlags. ESYSTEM measured 2026-10-25 (an unconfigured processor).
  DCARDREFUSED: "card_declined",
  DCARDEXPIRED: "expired_card",
  DINVALIDCARD: "incorrect_number",
  DCV: "incorrect_cvc",
  DAVSNO: "card_declined",
  DCALL: "do_not_honor",
  ESYSTEM: "processing_error",
  ETIMEOUT: "processing_error",
  // NACHA return codes on a returned eCheck debit.
  R01: "insufficient_funds",
  R09: "insufficient_funds",
  R02: "bank_account_closed",
  R16: "bank_account_closed",
  R03: "bank_account_not_found",
  R04: "bank_account_invalid_details",
  R20: "bank_account_invalid_details",
  R05: "debit_not_authorized",
  R07: "debit_not_authorized",
  R08: "debit_not_authorized",
  R10: "debit_not_authorized",
  R29: "debit_not_authorized",
};

const CYBERSOURCE_OUR_SIDE =
  "We could not complete this payment because of a problem with the payment gateway setup. Nothing is wrong with the customer's payment method.";

export const CYBERSOURCE_RULES: readonly DeclineRule[] = [
  // The card type is not accepted, or does not match the number: only another card pays.
  ...(["INVALID_CARD_TYPE", "CARD_TYPE_NOT_ACCEPTED"] as const).map((value): DeclineRule => ({
    id: `cybersource.code.${value.toLowerCase()}`,
    field: "code",
    op: "eq",
    value,
    code: "card_restricted",
    retriable: false,
  })),
  // The stored instrument is gone from TMS (an INVALID_DATA charge, then a 404/410 read).
  {
    id: "cybersource.code.payment_instrument_not_found",
    field: "code",
    op: "eq",
    value: "PAYMENT_INSTRUMENT_NOT_FOUND",
    code: "payment_method_not_found",
    retriable: false,
    message:
      "The saved payment method is no longer available at the payment provider. Add a payment method again.",
    exposedToPayer: true,
  },
  // The browser's card token expired (15 minutes) or was altered: INVALID_DATA on tokenInformation.jti.
  {
    id: "cybersource.category.transient_token",
    field: "category",
    op: "contains",
    value: "tokenInformation",
    code: "processing_error",
    retriable: true,
    message: "The card details expired. Enter them again.",
    exposedToPayer: true,
  },
  // Request or merchant-account refusals: nothing the payer can change.
  ...(
    [
      ["MISSING_FIELD", "missing_field"],
      ["INVALID_DATA", "invalid_data"],
      ["INVALID_MERCHANT_CONFIGURATION", "invalid_merchant_configuration"],
      ["INVALID_AMOUNT", "invalid_amount"],
      ["NOT_SUPPORTED", "not_supported"],
      ["INVALID_PAYMENT_ID", "invalid_payment_id"],
      // A 502 SERVER_ERROR, but CyberSource says "do not resend": our merchant setup.
      ["INVALID_OR_MISSING_CONFIG", "invalid_or_missing_config"],
      ["DMISSINGFIELD", "missing_field_flag"],
      ["DINVALIDDATA", "invalid_data_flag"],
    ] as const
  ).map(([value, slug]): DeclineRule => ({
    id: `cybersource.code.${slug}`,
    field: "code",
    op: "eq",
    value,
    code: "gateway_request_rejected",
    retriable: false,
    message: CYBERSOURCE_OUR_SIDE,
    exposedToPayer: false,
  })),
];

export function normalizeCybersourceDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  const sig = asSignal(raw);
  const mac =
    sig.cardBrand?.toLowerCase() === "mastercard"
      ? MASTERCARD_ADVICE_WAIT_MS[(sig.recommendationCode ?? "").trim()]
      : undefined;
  return withWait(
    networkHardDecline(sig, evaluate(sig, CYBERSOURCE_RULES, CYBERSOURCE_CODE_TABLE)),
    mac,
  );
}

const CYB_NO_DECLINE = "no failure: an approval, or a status with no reason";
const CYB_BY_STATUS =
  "handled by the adapter before classification: a repeat reads the original, a timeout or review reads the transaction";
const CYB_MODIFICATION =
  "capture, reversal, void and refund calls only; their refusal reaches the operator as an error";
const CYB_NOT_CALLED =
  "Decision Manager cases, address verification and payer authentication calls we never make";

/** Documented CyberSource reasons that no call of ours can return, with the reason. */
export const CYBERSOURCE_CODES_OUR_CALLS_NEVER_RAISE: Readonly<Record<string, string>> = {
  ...neverRaised(CYB_NO_DECLINE, "N/A"),
  ...neverRaised(CYB_BY_STATUS, "DUPLICATE_REQUEST PROCESSOR_TIMEOUT DECISION_PROFILE_REVIEW"),
  ...neverRaised(
    CYB_MODIFICATION,
    `
    EXCEEDS_AUTH_AMOUNT AUTH_ALREADY_REVERSED TRANSACTION_ALREADY_SETTLED MISSING_AUTH
    TRANSACTION_ALREADY_REVERSED_OR_SETTLED CAPTURE_ALREADY_VOIDED ACCOUNT_NOT_ALLOWED_CREDIT
    NOT_VOIDABLE
    `,
  ),
  ...neverRaised(
    CYB_NOT_CALLED,
    `
    AUTHENTICATION_FAILED DECISION_PROFILE_CHALLENGE APARTMENT_NUMBER_NOT_FOUND
    INSUFFICIENT_ADDRESS_INFORMATION HOUSE_OR_BOX_NUMBER_NOT_FOUND MULTIPLE_ADDRESS_MATCHES
    BOX_NUMBER_NOT_FOUND ROUTE_SERVICE_NOT_FOUND STREET_NAME_NOT_FOUND POSTAL_CODE_NOT_FOUND
    UNVERIFIABLE_ADDRESS MULTIPLE_ADDRESS_MATCHES_INTERNATIONAL ADDRESS_MATCH_NOT_FOUND
    UNSUPPORTED_CHARACTER_SET
    `,
  ),
  BOLETO_DECLINED: "Boleto; we offer no Boleto payments",
};

/**
 * Every built-in rule, in evaluation order per gateway. The overrides table joins on `id`.
 *
 * Declared AFTER the three arrays on purpose: it spreads them at module load, so placing it
 * above any of them throws "Cannot access STRIPE_RULES before initialization" — a temporal
 * dead zone the function helpers below do not hit, because they only read at call time.
 */
/**
 * Every real gateway's decline vocabulary: its code table and its rules. A gateway
 * missing here is a compile error — its declines would otherwise have no catalogue.
 */
export type DeclineGatewayKey = Exclude<ProviderKey, "tmtest">;
export const DECLINE_SETS: Record<
  DeclineGatewayKey,
  { table: Record<string, string>; rules: readonly DeclineRule[] }
> = {
  stripe: { table: STRIPE_CODE_TABLE, rules: STRIPE_RULES },
  paypal: { table: PAYPAL_CODE_TABLE, rules: PAYPAL_RULES },
  razorpay: { table: RAZORPAY_CODE_TABLE, rules: RAZORPAY_RULES },
  gocardless: { table: GOCARDLESS_CODE_TABLE, rules: GOCARDLESS_RULES },
  braintree: { table: BRAINTREE_CODE_TABLE, rules: BRAINTREE_RULES },
  cashfree: { table: CASHFREE_CODE_TABLE, rules: CASHFREE_RULES },
  authorizenet: { table: AUTHORIZENET_CODE_TABLE, rules: AUTHORIZENET_RULES },
  adyen: { table: ADYEN_CODE_TABLE, rules: ADYEN_RULES },
  checkoutcom: { table: CHECKOUTCOM_CODE_TABLE, rules: CHECKOUTCOM_RULES },
  mollie: { table: MOLLIE_CODE_TABLE, rules: MOLLIE_RULES },
  square: { table: SQUARE_CODE_TABLE, rules: SQUARE_RULES },
  payu: { table: PAYU_CODE_TABLE, rules: PAYU_RULES },
  cybersource: { table: CYBERSOURCE_CODE_TABLE, rules: CYBERSOURCE_RULES },
};

export const declineSets = () =>
  Object.entries(DECLINE_SETS) as [DeclineGatewayKey, (typeof DECLINE_SETS)[DeclineGatewayKey]][];

export const ALL_DECLINE_RULES: readonly DeclineRule[] = declineSets().flatMap(([, s]) => s.rules);

export function normalizeStripeDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  const sig = asSignal(raw);
  /**
   * The `expired_card` special case that stood here is GONE, and it was doing damage.
   *
   * It returned a bare `{ code, retriable: false }`, which threw away `ruleId` — so a
   * merchant override on `stripe.code.expired_card` could never be applied, because the
   * module layer keys overrides on the rule id it never received. It also dropped our
   * sentence and its payer-exposure flag.
   *
   * It is unnecessary now: `expired_card` is in TERMINAL, and both `builtInDeclineAnswer`
   * and `build` compute `retriable` from TERMINAL, so the answer is `false` either way.
   * It existed to compensate for a default that no longer exists.
   */
  const mac =
    sig.cardBrand?.toLowerCase() === "mastercard"
      ? MASTERCARD_ADVICE_WAIT_MS[(sig.recommendationCode ?? "").trim()]
      : undefined;
  return withWait(networkHardDecline(sig, evaluate(sig, STRIPE_RULES, STRIPE_CODE_TABLE)), mac);
}

/**
 * Raw network decline codes that forbid resubmitting the same card, per network:
 * Visa Core Rules Table 7-2 Category 1 ("a Merchant must never resubmit"), and the
 * Mastercard codes processors publish as no-retry (04, 14, 15, 41, 43, 54). Stripe
 * passes the raw code as `network_decline_code`; read per brand, because the digits
 * mean different things on each network.
 */
export const VISA_NEVER_RESUBMIT = new Set([
  "04",
  "07",
  "12",
  "14",
  "15",
  "41",
  "43",
  "46",
  "57",
  "R0",
  "R1",
  "R3",
]);
export const MASTERCARD_NEVER_RESUBMIT = new Set(["04", "14", "15", "41", "43", "54"]);

/** Codes that keep their own meaning under a never-resubmit network code; only hardness changes. */
const KEEPS_ITS_MEANING = new Set([
  "network_do_not_retry",
  "incorrect_number",
  "card_restricted",
  "payment_method_not_found",
]);

/**
 * A retriable decline whose raw network code says "never resubmit" becomes hard: a code in
 * `KEEPS_ITS_MEANING` keeps its code and turns `retriable: false` (a table-mapped
 * `card_restricted` with Visa 46 used to stay retriable), any other becomes
 * `network_do_not_retry`.
 */
function networkHardDecline(sig: DeclineSignal, n: NormalizedDecline): NormalizedDecline {
  const raw = (sig.networkMessage ?? "").trim().toUpperCase();
  const brand = sig.cardBrand?.toLowerCase();
  const hard =
    (brand === "visa" && VISA_NEVER_RESUBMIT.has(raw)) ||
    (brand === "mastercard" && MASTERCARD_NEVER_RESUBMIT.has(raw));
  if (!hard || !n.retriable) return n;
  if (KEEPS_ITS_MEANING.has(n.code)) return { ...n, retriable: false };
  return {
    code: "network_do_not_retry",
    retriable: false,
    message:
      "Your bank asked us not to attempt this payment again. Use a different payment method, or contact your bank.",
    exposedToPayer: true,
  };
}

/**
 * A stored failure code → its namespaced id, trying the LEGACY TABLES first.
 *
 * `resolveErrorId` alone knows our canonical vocabulary. This knows the raw provider
 * spellings too, which matters because the column holds them: `payment_intent_mandate_invalid`
 * (30 rows), `BAD_REQUEST_ERROR` (1), `payment_intent_payment_attempt_failed` (389) all
 * reached storage through the passthrough before rules existed, and an imported book
 * stores its source `error_code` verbatim. Mapping them through the same tables the
 * normaliser uses is what lets one query span both books.
 *
 * Lives here rather than in `platform/error-taxonomy` because the tables live here, and
 * `providers/` may not be imported the other way round.
 */
export function resolveStoredErrorId(code: string | null | undefined): ResolvedErrorId {
  const direct = resolveErrorId(code);
  if (direct.known || !code) return direct;
  /**
   * The RULES first, then the legacy tables. A raw code that a rule matches exactly is not
   * in the tables at all — that is what promoting it to a rule means — and consulting only
   * the tables left `payment_intent_payment_attempt_failed` (389 rows, and the code behind
   * #63) unresolved while the engine had known it for a day.
   */
  const lower = code.toLowerCase();
  const upper = code.toUpperCase();
  const byRule = ALL_DECLINE_RULES.find(
    (r) =>
      r.op === "eq" &&
      (r.field === "code" || r.field === "decline_code") &&
      (r.value === code || r.value.toLowerCase() === lower || r.value.toUpperCase() === upper),
  );
  const mapped =
    byRule?.code ??
    STRIPE_CODE_TABLE[code] ??
    STRIPE_CODE_TABLE[lower] ??
    RAZORPAY_CODE_TABLE[code] ??
    RAZORPAY_CODE_TABLE[upper] ??
    PAYPAL_CODE_TABLE[code] ??
    PAYPAL_CODE_TABLE[upper] ??
    BRAINTREE_CODE_TABLE[code] ??
    BRAINTREE_CODE_TABLE[upper] ??
    CHECKOUTCOM_CODE_TABLE[upper] ??
    PAYU_CODE_TABLE[upper];
  if (!mapped) return direct;
  // Keep the code the caller stored; only the id comes from the canonical form, or the
  // answer would silently rename a row that was never rewritten.
  return { ...resolveErrorId(mapped), code };
}

const RESPONSE_CODE_PATHS: readonly (readonly (string | number)[])[] = [
  ["error", "decline_code"], // Stripe: the issuer's reason
  ["error", "reason"], // Razorpay
  ["error_reason"], // Razorpay payment read
  ["purchase_units", 0, "payments", "captures", 0, "processor_response", "response_code"], // PayPal
  ["processor_response", "response_code"], // PayPal capture read
  ["details", 0, "issue"], // PayPal
  ["refusalReasonCode"], // Adyen
  ["response_code"], // Checkout.com
  ["errorInformation", "reason"], // CyberSource
  ["transactionResponse", "errors", 0, "errorCode"], // Authorize.net
  ["errors", 0, "code"], // Square
  ["error", "code"],
  ["error_code"],
];

/**
 * The gateway's own refusal code in a logged response body, for operators. Best effort over
 * the shapes our adapters read; null when none is there.
 */
export function gatewayCodeInResponse(body: unknown): string | null {
  for (const path of RESPONSE_CODE_PATHS) {
    let v: unknown = body;
    for (const k of path) v = v != null && typeof v === "object" ? (v as never)[k] : undefined;
    if ((typeof v === "string" && v.trim()) || typeof v === "number") return String(v).trim();
  }
  return null;
}
