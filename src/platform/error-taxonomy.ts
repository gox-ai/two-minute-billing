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

  // — standing authority to debit —
  mandate_expired: "mandate",
  mandate_cycle_limit_exceeded: "mandate",
  mandate_ceiling_exceeded: "mandate",
  mandate_spent: "mandate",
  mandate_pending: "mandate",
  debit_not_authorized: "transaction_authorization",

  // — a person had to prove who they were —
  authentication_required: "identity_verification",
  afa_not_completed: "identity_verification",

  // — the merchant's own configuration —
  recurring_not_enabled: "merchant_account",

  // — our side of the wire, or theirs —
  processing_error: "technical",
  gateway_request_rejected: "technical",
  gateway_error: "technical",

  // — the fallback, and it is deliberately last —
  charge_failed: "general",
};

/**
 * Reasons the ENGINE raised. None of these came from a provider, and reading one as a
 * decline is how a subscription with no card on file looks like a customer whose card
 * was refused.
 */
const BILLING_FAMILY: Record<string, BillingErrorFamily> = {
  no_payment_method: "collection",
  gateway_account_unavailable: "collection",

  late_failure: "settlement",
  reconciled_failed: "settlement",
  reversal: "settlement",
  authorization_unappliable: "settlement",
  debit_cancelled: "settlement",

  refund_failed: "refund",
  refund_failed_at_gateway: "refund",
  provider_unresolved: "refund",

  intent_expired: "intent",
  intent_create_failed: "intent",
  capture_failed: "intent",
};

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
