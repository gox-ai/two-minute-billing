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

import { resolveErrorId, type ResolvedErrorId } from "@/platform/error-taxonomy";
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
  "debit_not_authorized",
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
  // The MERCHANT's configuration refuses the transaction type, not the card — same shape
  // as RazorPay's `recurring_not_enabled`, which the policy parks for a human to fix.
  transaction_not_allowed: "recurring_not_enabled",
  card_not_supported: "recurring_not_enabled",
  currency_not_supported: "recurring_not_enabled",
  payment_method_unactivated: "recurring_not_enabled",

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
    retriable: rule.retriable ?? !TERMINAL.has(rule.code.toLowerCase()),
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

/** Our token for "the cardholder must authenticate this payment" (3DS, AFA). */
export const AUTHENTICATION_REQUIRED_CODE = "authentication_required";

/** The payer's sentence when the failure was ours. Gives them nothing to do, because there is nothing. */
export const PAYER_SAFE_INTERNAL_FAILURE =
  "We could not complete the payment because of a problem on our side. Your payment method is fine. We are examining the problem.";

/** The payer's sentence when the business chose not to show the reason. Blames nobody. */
export const PAYER_REASON_WITHHELD = "We could not complete the payment.";

/**
 * The decline sentence a PAYER may read, after the business's override.
 *
 * `exposedToPayer` is present only when a merchant override set it (adapters never do), so
 * absent means the built-in answer: `declineHiddenFromPayer`. An explicit `true` shows the
 * message even for a code we would hide; an explicit `false` withholds it — with our
 * "problem on our side" copy when the code is one of ours, a neutral sentence otherwise.
 */
export function payerDeclineMessage(
  failure: { code?: string | null; message?: string | null; exposedToPayer?: boolean },
  fallback: string,
): string {
  const internal = declineHiddenFromPayer(failure.code);
  const shown = failure.exposedToPayer ?? !internal;
  if (shown) return failure.message ?? fallback;
  return internal ? PAYER_SAFE_INTERNAL_FAILURE : PAYER_REASON_WITHHELD;
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
  const canonical = mapped ?? code;
  return { code: canonical, retriable: !TERMINAL.has(canonical.toLowerCase()) };
}

export const RAZORPAY_RULES: readonly DeclineRule[] = [
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
  {
    id: "razorpay.code.transaction_not_permitted_to_cardholder",
    field: "code",
    op: "eq",
    value: "Transaction not permitted to issuer/cardholder",
    code: "card_restricted",
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
];

export function normalizeRazorpayDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  const sig = asSignal(raw);
  return withWait(
    evaluate(sig, RAZORPAY_RULES, RAZORPAY_CODE_TABLE),
    RAZORPAY_REASON_WAIT_MS[(sig.code ?? "").trim().toLowerCase()],
  );
}

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
];

export function normalizePaypalDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  return evaluate(asSignal(raw), PAYPAL_RULES, PAYPAL_CODE_TABLE);
}

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
  payment_stopped: "do_not_honor",
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
};

export const GOCARDLESS_RULES: readonly DeclineRule[] = [
  // We sent GoCardless a request it would not accept: not the payer's doing.
  {
    id: "gocardless.code.validation_failed",
    field: "code",
    op: "eq",
    value: "validation_failed",
    code: "gateway_request_rejected",
    retriable: false,
    message:
      "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's bank account.",
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
];

export function normalizeGocardlessDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  return evaluate(asSignal(raw), GOCARDLESS_RULES, GOCARDLESS_CODE_TABLE);
}

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
];

export function normalizeBraintreeDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  return evaluate(asSignal(raw), BRAINTREE_RULES, BRAINTREE_CODE_TABLE);
}

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
  {
    id: "stripe.code.incorrect_number",
    field: "code",
    op: "eq",
    value: "incorrect_number",
    code: "incorrect_number",
  },
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

  /**
   * ⚠️ `rate_limit`, `lock_timeout`, `could_not_process` and
   * `generic_could_not_process` are RETRIABLE here, though they are commonly filed as
   * hard declines. All four are transient infrastructure — a rate limit is the
   * definition of "try again shortly" — and a decline table inherited wholesale is how
   * hardness becomes folklore. Hardness is a policy we set, not a list we copy.
   *
   * `resource_missing` and `missing` are deliberately NOT listed either: they can mean
   * a vanished payment method (hard) or a mistyped parameter (our bug), and the message
   * rules above already catch the instrument case with far better precision.
   */

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
  vpa_resolution_failed: "payment_method_not_found",
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

export const CASHFREE_RULES: readonly DeclineRule[] = [
  cfMessage("insufficient_funds", "insufficient", "insufficient_funds"),
  cfMessage("account_closed", "account closed", "bank_account_closed"),
  cfMessage("account_does_not_exist", "account does not exist", "bank_account_not_found"),
  cfMessage("not_cbs_account", "not a cbs act", "bank_account_invalid_details"),
  cfMessage("not_arranged_for", "not arranged for", "debit_not_authorized"),
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
  // Revoked, cancelled or deactivated: only a new mandate recovers it.
  ...(
    [
      ["mandate_revoked", "mandate has been revoked"],
      ["mandate_cancelled", "mandate cancelled"],
      ["inactive_mandate", "inactive mandate"],
      ["invalid_mandate_info", "invalid mandate info"],
    ] as const
  ).map(([slug, value]) =>
    cfMessage(slug, value, "mandate_expired", {
      retriable: false,
      message:
        "The payment mandate is no longer active. Set up the payment method again to continue your subscription.",
      exposedToPayer: true,
    }),
  ),
  cfMessage("invalid_vpa", "invalid virtual address", "payment_method_not_found", {
    retriable: false,
  }),
  cfMessage("suspected_fraud", "suspected fraud", "fraudulent"),
  cfMessage("do_not_honour", "do not honour", "do_not_honor"),
  cfMessage("compliance_violation", "compliance violation", "do_not_honor"),
  // Transient faults at the bank, NPCI or Cashfree. The next attempt can succeed.
  ...(
    [
      ["timeout", "timeout"],
      ["bank_not_available", "bank not available"],
      ["high_response_time", "high response time"],
      ["no_response", "no response received"],
      ["cbs_offline", "cbs offline"],
      ["internal_payment_failed", "internal payment failed"],
      ["previous_request_in_progress", "previous request in progress"],
      ["charge_not_on_time", "charge couldn't happen on time"],
      ["notify_failed", "unable to notify the customer"],
      ["notification_not_sent", "notification couldn't be sent"],
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
  {
    id: "cashfree.category.authentication_error",
    field: "category",
    op: "eq",
    value: "authentication_error",
    code: "gateway_request_rejected",
    message: CASHFREE_OURS,
    exposedToPayer: false,
  },
  {
    id: "cashfree.category.idempotency_error",
    field: "category",
    op: "eq",
    value: "idempotency_error",
    code: "gateway_request_rejected",
    message: CASHFREE_OURS,
    exposedToPayer: false,
  },
  // Catch-all for any other API refusal. Keep it LAST.
  {
    id: "cashfree.category.invalid_request_error",
    field: "category",
    op: "eq",
    value: "invalid_request_error",
    code: "gateway_request_rejected",
    message: CASHFREE_OURS,
    exposedToPayer: false,
  },
];

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
  "sepa:ED05": "insufficient_funds",
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

const adyenCode = (slug: string, value: string, code: string, extra: Partial<DeclineRule> = {}) =>
  ({ id: `adyen.code.${slug}`, field: "code", op: "eq", value, code, ...extra }) as const;

export const ADYEN_RULES: readonly DeclineRule[] = [
  // "Card is blocked and unusable": only a new card recovers it.
  adyenCode("blocked_card", "5", "card_restricted", { retriable: false }),
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
    ] as const
  ).map(([slug, value]) =>
    adyenCode(slug, value, "gateway_request_rejected", {
      message: ADYEN_OUR_SIDE,
      exposedToPayer: false,
    }),
  ),
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
  return withWait(evaluate(sig, ADYEN_RULES, ADYEN_CODE_TABLE), mac);
}

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
};

const CHECKOUTCOM_OUR_SIDE =
  "We could not complete this payment because of a problem with the payment gateway setup. Nothing is wrong with the customer's payment method.";

export const CHECKOUTCOM_RULES: readonly DeclineRule[] = [
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
];

export function normalizeAuthorizenetDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  return evaluate(asSignal(raw), AUTHORIZENET_RULES, AUTHORIZENET_CODE_TABLE);
}

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
  INVALID_CARD: "incorrect_number",
  INVALID_CARD_DATA: "incorrect_number",
  INVALID_ACCOUNT: "incorrect_number",
  ALLOWABLE_PIN_TRIES_EXCEEDED: "card_restricted",
  ACCOUNT_UNUSABLE: "card_declined",
  BUYER_REFUSED_PAYMENT: "card_declined",
  AMOUNT_TOO_HIGH: "card_restricted",
  RATE_LIMITED: "retry_too_soon",
};

const SQUARE_OUR_SIDE =
  "We could not complete this payment because of a problem with the payment gateway setup. Nothing is wrong with the customer's payment method.";

export const SQUARE_RULES: readonly DeclineRule[] = [
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
];

export function normalizeSquareDecline(
  raw: string | DeclineSignal | undefined | null,
): NormalizedDecline {
  return evaluate(asSignal(raw), SQUARE_RULES, SQUARE_CODE_TABLE);
}

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
  // A payment with no reason: the payer stopped, or the hosted page timed out.
  canceled: "do_not_honor",
  expired: "do_not_honor",
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
  E4290: "recurring_not_enabled",
};

const PAYU_OURS =
  "We could not complete this payment because of a problem on our side. Nothing is wrong with the customer's payment method.";
const PAYU_MANDATE_GONE =
  "The payment mandate is no longer active. Set up the payment method again to continue your subscription.";

export const PAYU_RULES: readonly DeclineRule[] = [
  // Registration paid but the card cannot carry a standing instruction.
  {
    id: "payu.code.e755",
    field: "code",
    op: "eq",
    value: "E755",
    code: "recurring_not_enabled",
    retriable: false,
    message:
      "This card does not support automatic payments. Use a different card or UPI to set up the payment method.",
    exposedToPayer: true,
  },
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
];

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
  SUSPENDED_ACCOUNT: "card_restricted",
  ALLOWABLE_PIN_RETRIES_EXCEEDED: "card_restricted",
  CVN_NOT_MATCH: "incorrect_cvc",
  INVALID_CVN: "incorrect_cvc",
  CV_FAILED: "incorrect_cvc",
  INVALID_ACCOUNT: "incorrect_number",
  INVALID_CARD: "incorrect_number",
  INVALID_CARD_TYPE: "incorrect_number",
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

/** Canonical tokens that already stop re-presenting the card; left as they are. */
const ALREADY_NO_RETRY = new Set([
  "network_do_not_retry",
  "incorrect_number",
  "card_restricted",
  "payment_method_not_found",
]);

/**
 * A retriable-looking decline whose raw network code says "never resubmit" becomes
 * `network_do_not_retry`. A code that already stops retries keeps its own meaning.
 */
function networkHardDecline(sig: DeclineSignal, n: NormalizedDecline): NormalizedDecline {
  const raw = (sig.networkMessage ?? "").trim().toUpperCase();
  const brand = sig.cardBrand?.toLowerCase();
  const hard =
    (brand === "visa" && VISA_NEVER_RESUBMIT.has(raw)) ||
    (brand === "mastercard" && MASTERCARD_NEVER_RESUBMIT.has(raw));
  if (!hard || !n.retriable || ALREADY_NO_RETRY.has(n.code)) return n;
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
