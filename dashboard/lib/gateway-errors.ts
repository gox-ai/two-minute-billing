import {
  isStripeCardNotAccepted,
  normalizeRazorpayDecline,
  normalizeStripeDecline,
  payerDeclineMessage,
  PAYER_REASON_WITHHELD,
  type NormalizedDecline,
} from "../../src/providers/decline-codes";
import {
  CARD_NOT_ACCEPTED,
  PAYER_CLIENT_REASON,
  PAYER_LEAD,
  PAYER_NEXT_STEP,
  RETRY_IN_FORM,
} from "../../src/providers/payer-wording";
import { noteGatewaySignal, type GatewaySignal } from "./buyer-error-report";

export { NOT_YET_APPROVED_TEXT } from "../../src/providers/payer-wording";

export { RETRY_IN_FORM };

/**
 * What a buyer reads when a payment gateway refuses, fails or errors.
 *
 * Every error a gateway returns is shown in our own UI, even when the gateway's form
 * shows it too. A message left to the gateway's form is a message some buyers never see.
 * The buyer reads only OUR words: a decline gets our sentence for its code, any other
 * failure our lead and next step. A gateway's text survives only as a field instruction
 * its SDK marks as one ("Card number is not valid").
 *
 * No DOM and no SDK, so the root unit suite can pin each mapping. Each helper notes the
 * gateway's raw signal beside the text it builds (`noteGatewaySignal`), for the error report.
 */

/**
 * The message a payment surface shows when a step is refused. `reason` is the engine's or
 * the gateway's own sentence, kept whole.
 */
export function refusalMessage(failed: string, reason: string, nextStep: string): string {
  const said = reason.trim();
  const sentence = /[.!?]$/.test(said) ? said : `${said}.`;
  // A reason that already carries its next step keeps it: never two next steps.
  const stepped = /\b(try again|contact|do not pay|use a different|refresh the page)\b/i.test(
    sentence,
  );
  // Our own fault (the engine's sentence): never send the buyer to a different method.
  const next = OUR_FAULT.test(sentence) ? PAYER_NEXT_STEP.ourFault : nextStep;
  const step = next && !stepped ? ` ${next}` : "";
  // The engine's messages often already open with "We could not …": do not say it twice.
  return /^We could not /.test(sentence) ? `${sentence}${step}` : `${failed} ${sentence}${step}`;
}

/** The engine's sentence for a failure on our side (`PAYER_SAFE_INTERNAL_FAILURE`). */
const OUR_FAULT = /Your payment method is fine\./;

/** "Contact <business>." with the name when the page has it. */
export const contactBusiness = (name?: string | null) =>
  `Contact ${name?.trim() || "the business"}.`;

/**
 * Our payer sentence for a normalized decline, or null when we have no reason to give.
 * No business override reaches the browser: a rule's own payer sentence, else ours for the
 * code (a rule's operator-only text is never shown).
 */
function payerReason(decline: NormalizedDecline): string | null {
  const said = payerDeclineMessage(
    decline.exposedToPayer
      ? { code: decline.code, message: decline.message, exposedToPayer: true }
      : { code: decline.code },
    PAYER_REASON_WITHHELD,
  );
  return said === PAYER_REASON_WITHHELD ? null : said;
}

/** One lead for each outcome, on every gateway. */
const LEAD = { setup: PAYER_LEAD.setup, payment: PAYER_LEAD.payment } as const;

/** A string field of a gateway's error object, or null. */
function field(e: unknown, key: string): string | null {
  const v = e && typeof e === "object" ? (e as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" && v ? v : null;
}

/** The signal of an error object a gateway SDK threw: its code or name, and its words. */
function thrownSignal(gateway: string, e: unknown): GatewaySignal {
  return {
    gateway,
    type: field(e, "type"),
    // Microform names it `reason`, Drop-in errors `name`.
    code: field(e, "code") ?? field(e, "reason") ?? field(e, "name"),
    message: errorText(e),
  };
}

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

/** Join several gateway messages into one text, or null when there are none. */
function joined(parts: Array<string | null | undefined>): string | null {
  const said = parts.map((p) => p?.trim()).filter((p): p is string => !!p);
  if (said.length === 0) return null;
  return said.map((s) => (/[.!?]$/.test(s) ? s : `${s}.`)).join(" ");
}

// ── Stripe.js ─────────────────────────────────────────────────────────────────

export interface StripeClientError {
  type?: string;
  code?: string;
  decline_code?: string;
  /** The request field Stripe refused, e.g. `card`. */
  param?: string;
  message?: string;
}

/**
 * Stripe.js's error on confirm. A decline reads as OUR payer sentence for its code, never
 * Stripe's text. A field error from the Element ("Your card number is incomplete.") is a
 * form instruction and is kept.
 */
export function stripeClientReason(error: StripeClientError | null | undefined): string | null {
  if (!error) return null;
  if (error.type === "validation_error") return errorText(error);
  // Refused for the card itself (an India-issued American Express): another card works.
  if (isStripeCardNotAccepted(error)) return CARD_NOT_ACCEPTED;
  // Decline code first, as the Stripe adapter reads it. No category: Stripe.js types a
  // failed 3DS check `invalid_request_error`, which the rules read as our own fault.
  // No reason to give: the caller's lead says what failed.
  return payerReason(
    normalizeStripeDecline({
      code: error.decline_code || error.code || null,
      declineCode: error.decline_code ?? null,
      message: error.message ?? null,
    }),
  );
}

/** A failed Stripe.js confirm: the lead, our reason, then the next step. */
export function stripeClientFailure(
  failed: string,
  error: StripeClientError | null | undefined,
  nextStep: string,
): string {
  return noteGatewaySignal(gatewayFailure(failed, stripeClientReason(error), nextStep), {
    gateway: "stripe",
    type: error?.type ?? null,
    code: error?.code ?? null,
    declineCode: error?.decline_code ?? null,
    param: error?.param ?? null,
    message: error?.message ?? null,
    fieldError: error?.type === "validation_error",
  });
}

// ── RazorPay Checkout ─────────────────────────────────────────────────────────

/** The `error` of RazorPay's `payment.failed` event. */
export interface RazorpayClientError {
  code?: string;
  reason?: string;
  description?: string;
  /** Who refused: `customer`, `bank`, `business`, `gateway`. */
  source?: string;
  /** Where in the payment it failed, e.g. `payment_authentication`. */
  step?: string;
}

/**
 * A refusal inside RazorPay's sheet: our sentence for its reason, never RazorPay's
 * description. The specific `reason` first, as the adapter reads it.
 */
export function razorpayClientReason(error: RazorpayClientError | null | undefined): string {
  const code = error?.reason || error?.code;
  return noteGatewaySignal(
    (code && payerReason(normalizeRazorpayDecline(code))) ||
      PAYER_CLIENT_REASON.authorizationUnfinished,
    {
      gateway: "razorpay",
      type: error?.source ?? null,
      param: error?.step ?? null,
      code: error?.code ?? null,
      declineCode: error?.reason ?? null,
      message: error?.description ?? null,
    },
  );
}

// ── Braintree Drop-in ─────────────────────────────────────────────────────────

/**
 * `requestPaymentMethod` rejected: a field error, a failed 3D Secure check, no method
 * selected. Drop-in marks the fields itself, so its text is not repeated.
 */
export function braintreeFailure(purpose: "setup" | "payment", error: unknown): string {
  return noteGatewaySignal(`${LEAD[purpose]} ${RETRY_IN_FORM}`, thrownSignal("braintree", error));
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
  const text =
    stage === "open"
      ? `We could not open the ${purpose === "setup" ? "card" : "payment"} form. ${PAYER_NEXT_STEP.retry}`
      : `${LEAD[purpose]} ${RETRY_IN_FORM}`;
  return noteGatewaySignal(text, thrownSignal("adyen", error));
}

const ADYEN_RESULT: Record<string, string> = {
  Refused: PAYER_CLIENT_REASON.refused,
  Cancelled: PAYER_CLIENT_REASON.cancelled,
  Error: PAYER_CLIENT_REASON.providerError,
};

/** A finished Adyen session with no `sessionResult` for the engine to read. */
export function adyenNoResult(resultCode: string | undefined, purpose: "setup" | "payment") {
  const text = gatewayFailure(
    LEAD[purpose],
    // An unknown result code is for the log, not the buyer.
    resultCode ? (ADYEN_RESULT[resultCode] ?? PAYER_CLIENT_REASON.providerUnfinished) : null,
    purpose === "setup" ? PAYER_NEXT_STEP.otherCard : PAYER_NEXT_STEP.otherPaymentMethod,
  );
  return noteGatewaySignal(text, { gateway: "adyen", code: resultCode ?? null });
}

// ── Checkout.com Flow ─────────────────────────────────────────────────────────

/** Flow's `onError(component, error)`: a decline, a failed 3DS check, a request error. */
export function checkoutcomFailure(purpose: "setup" | "payment", error: unknown): string {
  return noteGatewaySignal(
    `${LEAD[purpose]} ${purpose === "setup" ? PAYER_NEXT_STEP.correctCard : RETRY_IN_FORM}`,
    thrownSignal("checkoutcom", error),
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
 * sheet, the dialog stays open and nothing failed. Field errors (`VALIDATION_ERROR`) are
 * shown too, even though the card fields mark them; any other error text is not.
 */
export function squareTokenFailure(
  result: SquareTokenResult | undefined,
  purpose: "setup" | "payment" = "setup",
): string | null {
  if (result?.status === "Cancel") return null;
  const fields = (result?.errors ?? []).filter((e) => e.type === "VALIDATION_ERROR");
  return noteGatewaySignal(
    gatewayFailure(
      LEAD[purpose],
      joined(fields.map((e) => e.message)),
      PAYER_NEXT_STEP.otherMethod,
    ),
    {
      gateway: "square",
      type: result?.errors?.[0]?.type ?? null,
      code: result?.status ?? null,
      // The error that is not a field's: what the normaliser reads.
      declineCode: result?.errors?.find((e) => e.type !== "VALIDATION_ERROR")?.type ?? null,
      message: joined((result?.errors ?? []).map((e) => e.message)),
      fieldError: fields.length > 0,
    },
  );
}

/** `tokenize` threw (a buyer verification that failed, a network error). */
export function squareThrown(error: unknown, purpose: "setup" | "payment" = "setup"): string {
  return noteGatewaySignal(
    `${LEAD[purpose]} ${PAYER_NEXT_STEP.otherMethod}`,
    thrownSignal("square", error),
  );
}

// ── CyberSource Microform ─────────────────────────────────────────────────────

const MICROFORM_FIELD: Record<string, string> = {
  number: "Card number",
  securityCode: "Security code",
  expirationMonth: "Expiration month",
  expirationYear: "Expiration year",
};

/**
 * `createToken`'s error: a message and, for a validation error, one entry per field. Only
 * the field entries are shown, under our labels.
 */
export function microformFailure(
  err: { message?: string; details?: Array<{ location?: string; message?: string }> } | null,
): string {
  const fields = (err?.details ?? []).map((d) => {
    const label = d.location ? (MICROFORM_FIELD[d.location] ?? d.location) : null;
    const said = d.message?.trim() || PAYER_CLIENT_REASON.fieldNotCorrect;
    return label ? `${label}: ${said}` : said;
  });
  return noteGatewaySignal(
    gatewayFailure(PAYER_LEAD.readCard, joined(fields), PAYER_NEXT_STEP.correctThem),
    { ...thrownSignal("cybersource", err), fieldError: fields.length > 0 },
  );
}

// ── Authorize.net Accept Hosted (AcceptUI) ────────────────────────────────────

export interface AcceptResponse {
  opaqueData?: { dataDescriptor?: string; dataValue?: string };
  messages?: { resultCode?: string; message?: Array<{ code?: string; text?: string }> };
  customerInformation?: { firstName?: string; lastName?: string };
}

/**
 * A response that carries no nonce. AcceptUI checks the fields before it answers, so what
 * comes back is mostly about the merchant's setup (E_WC_21): its text is never shown.
 */
export function acceptFailure(
  res: AcceptResponse | null | undefined,
  bank: boolean,
  businessName?: string | null,
): string {
  const lead = bank ? PAYER_LEAD.readBank : PAYER_LEAD.readCard;
  const said = res?.messages?.message?.[0];
  return noteGatewaySignal(
    `${lead} ${PAYER_NEXT_STEP.retry} If the problem continues, ${contactBusiness(businessName).replace(/^C/, "c")}`,
    {
      gateway: "authorizenet",
      type: res?.messages?.resultCode ?? null,
      code: said?.code ?? null,
      message: said?.text ?? null,
    },
  );
}

// ── Cashfree ──────────────────────────────────────────────────────────────────

/**
 * Cashfree's modal answers `error` both when the buyer closes it and when a payment
 * fails, and gives no field that tells the two apart. So the message is worded to be true
 * for both: a decline is never taken for a close, and a close does not read as a decline.
 * It opens "We could not", so `refusalMessage` adds no second lead.
 */
export function cashfreeFailure(
  kind: "order" | "subscription",
  error: unknown,
  businessName?: string | null,
): string {
  const text =
    kind === "subscription"
      ? `We could not open the mandate form. ${PAYER_NEXT_STEP.retry} If the problem continues, ${contactBusiness(businessName).replace(/^C/, "c")}`
      : `${PAYER_LEAD.payment} ${PAYER_CLIENT_REASON.paymentUnfinished} ${PAYER_NEXT_STEP.otherPaymentMethod}`;
  return noteGatewaySignal(text, thrownSignal("cashfree", error));
}
