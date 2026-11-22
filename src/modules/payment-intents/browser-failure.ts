import {
  CARD_NOT_ACCEPTED_CODE,
  declineLabel,
  isStripeCardNotAccepted,
  operatorFailureText,
  normalizeAdyenDecline,
  normalizeAuthorizenetDecline,
  normalizeBraintreeDecline,
  normalizeCashfreeDecline,
  normalizeCheckoutcomDecline,
  normalizeCybersourceDecline,
  normalizeGocardlessDecline,
  normalizeMollieDecline,
  normalizePaypalDecline,
  normalizePayuDecline,
  normalizeRazorpayDecline,
  normalizeSquareDecline,
  normalizeStripeDecline,
  type DeclineSignal,
  type NormalizedDecline,
} from "@/providers/decline-codes";

/** The gateway signal a storefront report carries (`dashboard/lib/buyer-error-report.ts`). */
export interface BrowserGatewaySignal {
  type?: string | null;
  code?: string | null;
  decline_code?: string | null;
  param?: string | null;
  message?: string | null;
}

/** A report worth booking: the gateway answered with something, and not a field error. */
export function hasGatewaySignal(s: BrowserGatewaySignal & { field_error?: boolean }): boolean {
  return !s.field_error && !!(s.type || s.code || s.decline_code || s.message);
}

/** The adapter's own normaliser per gateway: a browser refusal reads as its webhook would. */
const NORMALIZERS: Record<string, (raw: DeclineSignal) => NormalizedDecline> = {
  stripe: normalizeStripeDecline,
  razorpay: normalizeRazorpayDecline,
  paypal: normalizePaypalDecline,
  braintree: normalizeBraintreeDecline,
  adyen: normalizeAdyenDecline,
  checkoutcom: normalizeCheckoutcomDecline,
  square: normalizeSquareDecline,
  cybersource: normalizeCybersourceDecline,
  authorizenet: normalizeAuthorizenetDecline,
  cashfree: normalizeCashfreeDecline,
  payu: normalizePayuDecline,
  mollie: normalizeMollieDecline,
  gocardless: normalizeGocardlessDecline,
};

/**
 * Our canonical code for a refusal the browser saw, read by the gateway's own normaliser
 * from its most specific code (decline code, then code, then type). No code, or a gateway
 * with no normaliser: the gateway refused the setup or the payment.
 */
export function browserFailureCode(
  gateway: string,
  s: BrowserGatewaySignal,
  purpose: "setup" | "payment",
): string {
  const fallback = purpose === "setup" ? "setup_failed" : "authorization_failed";
  if (gateway === "stripe" && isStripeCardNotAccepted(s)) return CARD_NOT_ACCEPTED_CODE;
  const normalize = NORMALIZERS[gateway];
  const code = s.decline_code || s.code || (gateway === "stripe" ? null : s.type);
  if (!normalize || !code) return fallback;
  const n = normalize({ code, declineCode: s.decline_code ?? null, message: s.message ?? null });
  // A code the normaliser does not know (an SDK error name like `DropinError`) comes back
  // `charge_failed`: the fallback names it, and the gateway's code stays in the request log.
  const known =
    n.code !== "charge_failed" && (!!n.ruleId || n.code !== code || declineLabel(n.code) != null);
  return known && n.code ? n.code : fallback;
}

/** Ends the attempt's error text when the customer's browser reported the refusal. */
export const BROWSER_REPORTED = "Reported by the customer's browser.";

export type BrowserFailureOutcome =
  | "booked"
  | "not_found"
  | "not_owned"
  | "wrong_gateway"
  | "closed"
  | "named_reason";

export interface BrowserFailureOwner {
  /** The session's customer. */
  customerId: string | null;
  /** Intents the session itself began (checkout). */
  intentPublicIds?: readonly (string | null)[];
}

const CLOSED_INTENT = new Set(["consumed", "expired", "voided"]);
const OPEN_ATTEMPT = new Set(["inited", "requires_action", "authorized"]);

/**
 * May a browser report write on this intent's attempt? Only the session's own intent, on the
 * gateway the report names, with an open attempt, and never over a reason a webhook or our
 * server wrote (an earlier browser report may be replaced). `booked` = yes.
 */
export function browserFailureVerdict(input: {
  intent: { publicId: string; customerId: string | null; status: string } | null;
  owner: BrowserFailureOwner;
  intentGateway: string | null;
  reportGateway: string;
  attempt: { status: string; errorCode: string | null; errorText: string | null } | null;
}): BrowserFailureOutcome {
  const { intent, owner, attempt } = input;
  if (!intent) return "not_found";
  const owned =
    (owner.customerId != null && intent.customerId === owner.customerId) ||
    (owner.intentPublicIds ?? []).includes(intent.publicId);
  if (!owned) return "not_owned";
  if (CLOSED_INTENT.has(intent.status)) return "closed";
  if (input.intentGateway !== input.reportGateway) return "wrong_gateway";
  if (!attempt || !OPEN_ATTEMPT.has(attempt.status)) return "closed";
  if (attempt.errorCode && !attempt.errorText?.endsWith(BROWSER_REPORTED)) return "named_reason";
  return "booked";
}

/** The operator text booked on the attempt: the gateway's words, marked as the browser's. */
export function browserOperatorText(code: string, gatewayMessage: string | null): string {
  return `${operatorFailureText({ code, message: gatewayMessage })} ${BROWSER_REPORTED}`;
}
