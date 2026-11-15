// No imports on purpose: pure, so the root unit suite can pin it.

/**
 * Our short reading of a failure code we know, for an operator. It sits ABOVE the gateway's
 * own text, which is always shown whole: a gateway sentence is written for a developer.
 * A code that is not here gets no reading, never a guess.
 */
const READING: Record<string, string> = {
  card_declined: "Card declined.",
  do_not_honor: "Card declined by the bank.",
  generic_decline: "Card declined.",
  insufficient_funds: "Not enough money in the account.",
  expired_card: "Card expired.",
  incorrect_cvc: "Security code not correct.",
  incorrect_number: "Card number not correct.",
  authentication_required: "The customer must authenticate the payment.",
  stolen_card: "Card blocked by the bank.",
  fraudulent: "Payment blocked as possible fraud.",
  payment_method_not_found: "The gateway no longer has this payment method.",
  mandate_expired: "The mandate is not active.",
  processing_error: "The gateway could not process the payment.",
  gateway_error: "The gateway had an error.",
  gateway_account_unavailable: "No gateway account is available for this payment.",
  no_payment_method: "The customer has no payment method.",
  card_limit_exceeded: "The amount is more than the card limit of the business.",
};

const plain = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** The reading for `code`, or null when we have none or the gateway's text already says it. */
export function declineReading(
  code: string | null | undefined,
  gatewayText?: string | null,
): string | null {
  const reading = code ? READING[code.toLowerCase()] : undefined;
  if (!reading) return null;
  return gatewayText && plain(gatewayText) === plain(reading) ? null : reading;
}

/** Engine status words that are not plain English, as an operator reads them. The API value stays. */
export const INTENT_STATUS_WORD: Record<string, string> = {
  inited: "open",
  consumed: "used",
};
