/**
 * The storefront's own payer sentences for a gateway's client-side failure: the leads, the
 * next steps and the reasons that replace a gateway's text. One copy, read by the storefront
 * (`dashboard/lib/gateway-errors.ts`) and by the leak check (`modules/ops/buyer-error-leak.ts`),
 * so a sentence added here is never reported as a leak.
 *
 * Relative imports only: the dashboard compiles this file too.
 */

/** One lead for each outcome, on every gateway. */
export const PAYER_LEAD = {
  setup: "We could not save your payment method.",
  payment: "We could not take your payment.",
  confirm: "We could not confirm your payment.",
  readCard: "We could not read the card details.",
  readBank: "We could not read the bank account details.",
} as const;

/** The next step after a refusal inside a gateway's form, which stays open for a retry. */
export const RETRY_IN_FORM =
  "Correct the details or use a different payment method. Then try again.";

/** Next steps the storefront adds after a lead and a reason. */
export const PAYER_NEXT_STEP = {
  ourFault: "Try again in a few minutes.",
  retry: "Try again.",
  otherMethod: "Try again, or use a different method.",
  otherPaymentMethod: "Try again, or use a different payment method.",
  otherCard: "Try again, or use a different card.",
  correctCard: "Correct the card details or use a different card. Then try again.",
  correctThem: "Correct them and try again.",
  reloadPage: "Reload the page. Then try again.",
  reloadDialog: "Close this dialog and reload the page. Then try again.",
} as const;

/**
 * A card the business cannot accept: the gateway refused the request for the card itself
 * (Stripe: an India-issued American Express for a business in India). Not a bank decline.
 */
export const CARD_NOT_ACCEPTED = "This card cannot be used for this payment. Use a different card.";

/** Reasons the storefront gives in place of a gateway's own text. */
export const PAYER_CLIENT_REASON = {
  authorizationUnfinished: "The authorization did not finish.",
  paymentUnfinished: "The payment did not finish.",
  requestUnfinished: "The request did not finish.",
  refused: "The payment was refused.",
  cancelled: "The payment was cancelled.",
  providerError: "The payment provider reported an error.",
  providerUnfinished: "The payment provider did not finish the payment.",
  unsupportedProvider: "This page does not support this payment provider.",
  fieldNotCorrect: "This value is not correct",
} as const;

/**
 * What a payer reads instead of a refusal written for an operator. The payer reads only our
 * words (user decision 2026-11-17): never an id, a parameter name or an API instruction.
 */
export const BUYER_GENERIC_REFUSAL =
  "We could not complete this request. Try again. If the problem continues, contact the business.";

/** A field reason that names an operator value, shown under its field instead. */
export const BUYER_GENERIC_FIELD_REASON = "This value is not correct.";

/**
 * Refusals the storefront matches on text. They pass unchanged, so its handling stays:
 * coupon-box `/^No such coupon/`, checkout-flow `NOT_YET_APPROVED` and the agreed-amount
 * check, payment-return `NOT_YET_CONFIRMED`.
 */
export const CODE_MATCHED: readonly RegExp[] = [
  /^No such coupon\b/,
  /^Complete the (payment step|authentication) first/,
  /^The amount changed after you agreed/,
  /did not tell us yet that this payment is complete/,
];

/**
 * Sentences the storefront writes inline at a payment call site. A new sentence there that
 * is not a "We could not …" lead goes here too, or ops is told it leaked.
 */
export const PAYER_INLINE_TEXTS: readonly string[] = [
  "It is possible that the payment is complete. Do not pay again.",
  "The payment provider did not send the next step.",
  "We cannot confirm this payment method here yet. Add a card instead.",
  "Correct the highlighted fields.",
  "Start again.",
  "If you approved it, it will show here soon.",
];

/** Every fixed sentence above, for the leak check. */
export const PAYER_CLIENT_TEXTS: readonly string[] = [
  ...Object.values(PAYER_LEAD),
  RETRY_IN_FORM,
  ...Object.values(PAYER_NEXT_STEP),
  ...Object.values(PAYER_CLIENT_REASON),
  CARD_NOT_ACCEPTED,
  BUYER_GENERIC_REFUSAL,
  BUYER_GENERIC_FIELD_REASON,
  ...PAYER_INLINE_TEXTS,
];
