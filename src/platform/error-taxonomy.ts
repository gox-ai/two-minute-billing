/**
 * WHAT A FAILURE WAS, on one axis.
 *
 * `payments.failure_code` and `transactions.error_code` are the columns every failure
 * lands in, and today they hold at least three different vocabularies at once: our
 * canonical decline codes (`insufficient_funds`), engine-minted reasons no gateway ever
 * said (`no_payment_method`, 4,680 rows — the single commonest value), and raw provider
 * codes that reached the passthrough (`BAD_REQUEST_ERROR`, `payment_intent_mandate_invalid`).
 * An imported book adds a fourth, because the importer stores the source's own
 * `error_code` verbatim.
 *
 * So "how many mandate failures last month" is not answerable from that column. This file
 * is the answer: every code the system can produce maps to a NAMESPACED id, and history
 * becomes queryable on one axis without rewriting a single stored row.
 *
 * TWO NAMESPACES, and the split is the point:
 *
 *   gateway.<family>.<code>   a provider refused it. Eleven fixed families, which is what
 *                             makes an imported book line up with ours.
 *   billing.<family>.<code>   WE stopped it, and no gateway was involved. Today these are
 *                             indistinguishable from a decline, which is how "we never had
 *                             a card" reads as "the card was refused".
 *
 * ⚠️ THE STORED VALUE DOES NOT CHANGE. `failure_code` is public API (`subscription-routes`,
 * `customer-portal-routes`), it is named by 588 literals across 61 files, and ~22,000 rows
 * carry it. The id is DERIVED from the code, never a replacement for it — which is why this
 * ships without a migration or a deploy window.
 */

/** The eleven families. Ours slot into them; we do not invent a twelfth. */
export type GatewayErrorFamily =
  | "transaction_processing"
  | "payment_method"
  | "bank_account"
  | "technical"
  | "merchant_account"
  | "transaction_authorization"
  | "dispute"
  | "mandate"
  | "identity_verification"
  | "token"
  | "general";

/** Ours, for a refusal the engine itself raised. Named for WHERE it was raised. */
export type BillingErrorFamily = "collection" | "settlement" | "refund" | "intent";

export type ErrorFamily = GatewayErrorFamily | BillingErrorFamily;
export type ErrorNamespace = "gateway" | "billing";

/**
 * Every canonical decline code → its family.
 *
 * A code sits in the family its concept belongs to, so an imported book and ours aggregate
 * together. Where no family names the concept outright — the India mandate rail, mostly —
 * we still pick the nearest rather than inventing a twelfth; `mandate_ceiling_exceeded` is
 * a mandate fact either way.
 */
const GATEWAY_FAMILY: Record<string, GatewayErrorFamily> = {
  // — the card itself —
  expired_card: "payment_method",
  card_restricted: "payment_method",
  incorrect_cvc: "payment_method",
  incorrect_number: "payment_method",
  // The billing address or postal code does not match the issuer's record.
  incorrect_address: "payment_method",
  stolen_card: "payment_method",
  lost_card: "payment_method",
  pickup_card: "payment_method",
  // The cardholder stopped or revoked the payment (Stripe's stop/revocation codes).
  revocation_of_authorization: "transaction_authorization",
  payment_method_not_found: "payment_method",

  // — the issuer's answer to this charge —
  card_declined: "transaction_processing",
  insufficient_funds: "transaction_processing",
  do_not_honor: "transaction_processing",
  fraudulent: "transaction_processing",
  gateway_limit_exceeded: "transaction_processing",
  // The CARD NETWORK's instruction, not the issuer's reason. Kept in the same family as
  // the decline it accompanies, because that is what it qualifies.
  network_do_not_retry: "transaction_processing",
  // Also the network's instruction rather than the issuer's reason, and its sibling above
  // is why it sits here: `network_do_not_retry` says never, this one says not yet.
  retry_too_soon: "transaction_processing",
  // NPCI's rail rules, applied before the debit is sent (`representment.ts`).
  network_retry_limit: "transaction_processing",
  network_retry_too_soon: "transaction_processing",
  // The gateway said "not yet" under a valid pre-debit notice.
  pre_debit_not_due: "transaction_processing",
  // The gateway still holds another notice for this mandate (PayU UPI's one open cycle).
  pre_debit_cycle_open: "transaction_processing",

  // — the bank rail —
  bank_account_closed: "bank_account",
  bank_account_invalid_details: "bank_account",
  bank_account_not_found: "bank_account",
  // The account exists but this rail may not debit it.
  bank_account_restricted: "bank_account",
  // Micro-deposit or other account check not completed.
  bank_account_not_verified: "bank_account",

  // — standing authority to debit —
  mandate_expired: "mandate",
  mandate_cycle_limit_exceeded: "mandate",
  mandate_ceiling_exceeded: "mandate",
  mandate_spent: "mandate",
  mandate_pending: "mandate",
  debit_not_authorized: "transaction_authorization",

  // — a person had to prove who they were —
  authentication_required: "identity_verification",
  // The buyer must add their billing name and address (India exports).
  billing_details_required: "identity_verification",
  afa_not_completed: "identity_verification",

  // — the merchant's own configuration —
  recurring_not_enabled: "merchant_account",

  // — our side of the wire, or theirs —
  processing_error: "technical",
  gateway_request_rejected: "technical",
  gateway_error: "technical",

  // A currency the gateway account cannot take, refused before the bank is asked.
  currency_not_supported: "merchant_account",
  // The card type is not accepted on this rail.
  card_not_supported: "payment_method",
  // The gateway said "not now": a daily or per-account debit limit, or a transient refusal.
  try_again_later: "transaction_processing",
  // A capture of an authorized hold that the gateway refused.
  capture_refused: "transaction_processing",
  // The payer left or cancelled the gateway's authorization page.
  setup_cancelled: "transaction_authorization",
  // Its payment-time sibling: the payer left a hosted checkout or mandate page, or it
  // expired. Not a decline; no dunning effect (`decline-policy.ts` NO_DUNNING_EFFECT).
  payment_abandoned: "transaction_authorization",
  // The payer stopped ONE mandate debit at their bank; the mandate stays active.
  debit_cancelled_by_payer: "transaction_authorization",
  // The gateway could not create the order behind a charge.
  order_failed: "technical",
  // The browser's result could not be read or did not match the intent.
  invalid_client_result: "technical",

  // — the fallback, and it is deliberately last —
  charge_failed: "general",
  // Refusals with no reason given: an authorization, a card save, an asynchronous debit,
  // and a gateway that reports only its status word ("failed").
  authorization_failed: "general",
  setup_failed: "general",
  async_failed: "general",
  failed: "general",
};

/**
 * Reasons the ENGINE raised. None of these came from a provider, and reading one as a
 * decline is how a subscription with no card on file looks like a customer whose card
 * was refused.
 */
const BILLING_FAMILY: Record<string, BillingErrorFamily> = {
  no_payment_method: "collection",
  gateway_account_unavailable: "collection",
  // Our own pre-flight refusals: the gateway was never asked.
  mandate_missing: "collection",
  mandate_paused: "collection",
  mandate_currency_mismatch: "collection",
  card_limit_exceeded: "collection",
  // Hard-declined method held: not charged until it is updated or another is added.
  payment_method_unusable: "collection",
  // Our attempt caps: per invoice, and per card across invoices (`representment.ts`).
  invoice_attempt_limit: "collection",
  card_attempt_limit: "collection",

  late_failure: "settlement",
  reconciled_failed: "settlement",
  reversal: "settlement",
  authorization_unappliable: "settlement",
  debit_cancelled: "settlement",
  late_capture_excess: "settlement",
  unmatched_gateway_capture: "settlement",

  refund_failed: "refund",
  refund_failed_at_gateway: "refund",
  provider_unresolved: "refund",
  refund_refused: "refund",
  refund_not_created: "refund",

  intent_expired: "intent",
  intent_create_failed: "intent",
  capture_failed: "intent",
  intent_voided: "intent",
};

/**
 * Failure codes the engine and adapters book as literals, outside any rule or table. The
 * unit test and `verify:decline-overrides` prove each resolves `known`. Add a code here when
 * you add a literal.
 */
export const ENGINE_BOOKED_CODES: readonly string[] = [
  "charge_failed",
  "async_failed",
  "authorization_failed",
  "setup_failed",
  "setup_cancelled",
  "capture_refused",
  "capture_failed",
  "try_again_later",
  "failed",
  "order_failed",
  "currency_not_supported",
  "card_not_supported",
  "invalid_client_result",
  "gateway_error",
  "gateway_request_rejected",
  "gateway_account_unavailable",
  "no_payment_method",
  "mandate_missing",
  "mandate_expired",
  "mandate_pending",
  "mandate_spent",
  "mandate_paused",
  "mandate_currency_mismatch",
  "mandate_ceiling_exceeded",
  "card_limit_exceeded",
  "payment_method_unusable",
  "invoice_attempt_limit",
  "card_attempt_limit",
  "payment_abandoned",
  "debit_cancelled_by_payer",
  "debit_cancelled",
  "intent_expired",
  "intent_voided",
  "late_failure",
  "late_capture_excess",
  "unmatched_gateway_capture",
  "refund_refused",
  "refund_not_created",
];

export interface ResolvedErrorId {
  /** `gateway.transaction_processing.insufficient_funds` */
  id: string;
  namespace: ErrorNamespace;
  family: ErrorFamily;
  /** The stored code this was derived from, unchanged. */
  code: string;
  /**
   * False when nothing in the taxonomy named this code — an imported book's own spelling,
   * or a provider code that reached the passthrough. It still gets an id, so a query can
   * count it; `known: false` is what tells you the count is a bucket, not a fact.
   */
  known: boolean;
}

/**
 * A stored failure code → its namespaced id.
 *
 * An unrecognised code answers `gateway.general.unknown` rather than throwing: this runs
 * over a column that already contains a decade of other people's vocabulary, and a
 * reporting call that dies on one imported row is worse than a bucket.
 */
export function resolveErrorId(code: string | null | undefined): ResolvedErrorId {
  if (!code)
    return {
      id: "gateway.general.unknown",
      namespace: "gateway",
      family: "general",
      code: "",
      known: false,
    };
  const key = code.toLowerCase();
  const billing = BILLING_FAMILY[key];
  if (billing)
    return {
      id: `billing.${billing}.${key}`,
      namespace: "billing",
      family: billing,
      code,
      known: true,
    };
  const gateway = GATEWAY_FAMILY[key];
  if (gateway)
    return {
      id: `gateway.${gateway}.${key}`,
      namespace: "gateway",
      family: gateway,
      code,
      known: true,
    };
  return {
    id: "gateway.general.unknown",
    namespace: "gateway",
    family: "general",
    code,
    known: false,
  };
}

/** Just the id, for the common case. */
export const errorIdFor = (code: string | null | undefined): string => resolveErrorId(code).id;

/** Every code the taxonomy names — the gate reads this to prove nothing was left out. */
export function taxonomyCodes(): {
  code: string;
  namespace: ErrorNamespace;
  family: ErrorFamily;
}[] {
  return [
    ...Object.entries(BILLING_FAMILY).map(([code, family]) => ({
      code,
      namespace: "billing" as const,
      family,
    })),
    ...Object.entries(GATEWAY_FAMILY).map(([code, family]) => ({
      code,
      namespace: "gateway" as const,
      family,
    })),
  ];
}
