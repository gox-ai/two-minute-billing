/**
 * What a buyer reads when a payment gateway refuses, fails or errors.
 *
 * Every error a gateway returns is shown in our own UI, even when the gateway's form
 * shows it too. A message left to the gateway's form is a message some buyers never see.
 * The gateway's own words are kept whole; a fallback is used only when it gave none.
 *
 * Pure: no DOM and no SDK, so the root unit suite can pin each mapping.
 */

/**
 * The message a payment surface shows when a step is refused. `reason` is the engine's or
 * the gateway's own sentence, kept whole.
 */
export function refusalMessage(failed: string, reason: string, nextStep: string): string {
  const said = reason.trim();
  const sentence = /[.!?]$/.test(said) ? said : `${said}.`;
  // A reason that already carries its next step keeps it: never two next steps.
  const stepped = /\b(try again|contact|do not pay)\b/i.test(sentence);
  // Our own fault (the engine's sentence): never send the buyer to a different method.
  const next = OUR_FAULT.test(sentence) ? "Try again in a few minutes." : nextStep;
  const step = next && !stepped ? ` ${next}` : "";
  // The engine's messages often already open with "We could not …": do not say it twice.
  return /^We could not /.test(sentence) ? `${sentence}${step}` : `${failed} ${sentence}${step}`;
}

/** The engine's sentence for a failure on our side (`PAYER_SAFE_INTERNAL_FAILURE`). */
const OUR_FAULT = /Your payment method is fine\./;

/** "Contact <business>." with the name when the page has it. */
export const contactBusiness = (name?: string | null) =>
  `Contact ${name?.trim() || "the business"}.`;

/** One lead for each outcome, on every gateway. */
const LEAD = {
  setup: "We could not save your payment method.",
  payment: "We could not take your payment.",
} as const;

/** The words an error carries: a string, an `Error`, or a gateway object with `message`. */
export function errorText(e: unknown): string | null {
  if (typeof e === "string") return e.trim() || null;
  if (e && typeof e === "object") {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  return null;
}

/** `failed`, then the gateway's words when it gave any, then the next step. Never empty. */
export function gatewayFailure(failed: string, said: unknown, nextStep: string): string {
  const reason = errorText(said);
  return reason ? refusalMessage(failed, reason, nextStep) : `${failed} ${nextStep}`;
}

/** The next step after a refusal inside a gateway's form, which stays open for a retry. */
export const RETRY_IN_FORM =
  "Correct the details or use a different payment method. Then try again.";

/** Join several gateway messages into one text, or null when there are none. */
function joined(parts: Array<string | null | undefined>): string | null {
  const said = parts.map((p) => p?.trim()).filter((p): p is string => !!p);
  if (said.length === 0) return null;
  return said.map((s) => (/[.!?]$/.test(s) ? s : `${s}.`)).join(" ");
}

// ── Braintree Drop-in ─────────────────────────────────────────────────────────

/** `requestPaymentMethod` rejected: a field error, a failed 3D Secure check, no method selected. */
export function braintreeFailure(purpose: "setup" | "payment", error: unknown): string {
  return gatewayFailure(LEAD[purpose], error, RETRY_IN_FORM);
}

// ── Adyen Drop-in ─────────────────────────────────────────────────────────────

/**
 * Adyen's `onError`. `CANCEL` is the buyer closing a step inside Drop-in (a wallet sheet):
 * Drop-in stays open and nothing failed, so there is nothing to show.
 */
export function adyenError(
  error: unknown,
  stage: "open" | "pay",
  purpose: "setup" | "payment",
): string | null {
  if ((error as { name?: unknown } | null)?.name === "CANCEL") return null;
  if (stage === "open")
    return gatewayFailure(
      `We could not open the ${purpose === "setup" ? "card" : "payment"} form.`,
      error,
      "Try again.",
    );
  return gatewayFailure(LEAD[purpose], error, RETRY_IN_FORM);
}

const ADYEN_RESULT: Record<string, string> = {
  Refused: "The payment was refused.",
  Cancelled: "The payment was cancelled.",
  Error: "The payment provider reported an error.",
};

/** A finished Adyen session with no `sessionResult` for the engine to read. */
export function adyenNoResult(resultCode: string | undefined, purpose: "setup" | "payment") {
  return gatewayFailure(
    LEAD[purpose],
    // An unknown result code is for the log, not the buyer.
    resultCode
      ? (ADYEN_RESULT[resultCode] ?? "The payment provider did not finish the payment.")
      : null,
    `Try again, or use a different ${purpose === "setup" ? "card" : "payment method"}.`,
  );
}

// ── Checkout.com Flow ─────────────────────────────────────────────────────────

/** Flow's `onError(component, error)`: a decline, a failed 3DS check, a request error. */
export function checkoutcomFailure(purpose: "setup" | "payment", error: unknown): string {
  return gatewayFailure(
    LEAD[purpose],
    error,
    purpose === "setup"
      ? "Correct the card details or use a different card. Then try again."
      : RETRY_IN_FORM,
  );
}

// ── Square Web Payments ───────────────────────────────────────────────────────

export interface SquareTokenResult {
  status?: string;
  token?: string;
  errors?: Array<{ field?: string; type?: string; message?: string }>;
}

/**
 * A tokenize result that is not `OK`. Null for `Cancel` only: the buyer closed a wallet
 * sheet, the dialog stays open and nothing failed. Field errors are shown too, even though
 * the card fields mark them.
 */
export function squareTokenFailure(
  result: SquareTokenResult | undefined,
  purpose: "setup" | "payment" = "setup",
): string | null {
  if (result?.status === "Cancel") return null;
  return gatewayFailure(
    LEAD[purpose],
    joined((result?.errors ?? []).map((e) => e.message)),
    "Try again, or use a different method.",
  );
}

/** `tokenize` threw (a buyer verification that failed, a network error). */
export function squareThrown(error: unknown, purpose: "setup" | "payment" = "setup"): string {
  return gatewayFailure(LEAD[purpose], error, "Try again, or use a different method.");
}

// ── CyberSource Microform ─────────────────────────────────────────────────────

const MICROFORM_FIELD: Record<string, string> = {
  number: "Card number",
  securityCode: "Security code",
  expirationMonth: "Expiration month",
  expirationYear: "Expiration year",
};

/** `createToken`'s error: a message and, for a validation error, one entry per field. */
export function microformFailure(
  err: { message?: string; details?: Array<{ location?: string; message?: string }> } | null,
): string {
  const fields = (err?.details ?? []).map((d) => {
    const label = d.location ? (MICROFORM_FIELD[d.location] ?? d.location) : null;
    const said = d.message?.trim() || "This value is not correct";
    return label ? `${label}: ${said}` : said;
  });
  return gatewayFailure(
    "We could not read the card details.",
    joined([err?.message, ...fields]),
    "Correct them and try again.",
  );
}

// ── Authorize.net Accept Hosted (AcceptUI) ────────────────────────────────────

export interface AcceptResponse {
  opaqueData?: { dataDescriptor?: string; dataValue?: string };
  messages?: { resultCode?: string; message?: Array<{ code?: string; text?: string }> };
  customerInformation?: { firstName?: string; lastName?: string };
}

/** A response that carries no nonce: the gateway's message texts, kept whole. */
export function acceptFailure(
  res: AcceptResponse | null | undefined,
  bank: boolean,
  businessName?: string | null,
): string {
  return gatewayFailure(
    bank ? "We could not read the bank account details." : "We could not read the card details.",
    joined((res?.messages?.message ?? []).map((m) => m.text)),
    `Try again. If the problem continues, ${contactBusiness(businessName).replace(/^C/, "c")}`,
  );
}

// ── Cashfree ──────────────────────────────────────────────────────────────────

/**
 * Cashfree's modal answers `error` both when the buyer closes it and when a payment
 * fails, and gives no field that tells the two apart. So the order's message is worded to
 * be true for both, with Cashfree's own words as the reason when it gave any: a decline is
 * never taken for a close, and a close does not read as a decline. It opens "We could not",
 * so `refusalMessage` adds no second lead.
 */
export function cashfreeFailure(
  kind: "order" | "subscription",
  error: unknown,
  businessName?: string | null,
): string {
  if (kind === "subscription")
    return gatewayFailure(
      "We could not open the mandate form.",
      error,
      `Try again. If the problem continues, ${contactBusiness(businessName).replace(/^C/, "c")}`,
    );
  return refusalMessage(
    "We could not take your payment.",
    errorText(error) ?? "The payment did not finish",
    "Try again, or use a different payment method.",
  );
}
