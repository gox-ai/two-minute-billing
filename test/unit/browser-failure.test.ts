import { describe, expect, it } from "vitest";
import {
  BROWSER_REPORTED,
  browserFailureCode,
  browserFailureVerdict,
  browserOperatorText,
  hasGatewaySignal,
} from "@/modules/payment-intents/browser-failure";
import { buyerTextLeaks } from "@/modules/ops/buyer-error-leak";
import { CARD_NOT_ACCEPTED, RETRY_IN_FORM } from "@/providers/payer-wording";
// Relative: the root `@/` alias points at src/.
import { stripeClientFailure, stripeClientReason } from "../../dashboard/lib/gateway-errors";

/** Stripe.js's 400 on confirmSetup for an India-issued American Express (2026-11-17). */
const AMEX = {
  type: "invalid_request_error",
  param: "card",
  message: "American Express cards issued in India aren't supported for businesses in India.",
};

describe("a card the business cannot accept (Stripe param card, no code)", () => {
  it("the buyer reads our sentence, not Stripe's", () => {
    expect(stripeClientReason(AMEX)).toBe(CARD_NOT_ACCEPTED);
    const shown = stripeClientFailure(
      "We could not save your payment method.",
      AMEX,
      RETRY_IN_FORM,
    );
    expect(shown).toContain(CARD_NOT_ACCEPTED);
    expect(shown).not.toContain("American Express");
    expect(buyerTextLeaks(shown)).toBe(false);
  });
  it("the operator reads card_restricted and Stripe's words, marked as the browser's", () => {
    const code = browserFailureCode("stripe", AMEX, "setup");
    expect(code).toBe("card_restricted");
    expect(browserOperatorText(code, AMEX.message)).toBe(`${AMEX.message} ${BROWSER_REPORTED}`);
  });
  it("a code, or another param, is not this case", () => {
    expect(browserFailureCode("stripe", { ...AMEX, code: "card_declined" }, "setup")).toBe(
      "card_declined",
    );
    expect(browserFailureCode("stripe", { ...AMEX, param: "amount" }, "setup")).toBe(
      "setup_failed",
    );
  });
});

/** One representative browser refusal per gateway → the booked code. */
const PER_GATEWAY: Array<[string, Record<string, string>, "setup" | "payment", string]> = [
  [
    "stripe",
    { type: "card_error", code: "card_declined", decline_code: "insufficient_funds" },
    "payment",
    "insufficient_funds",
  ],
  [
    "stripe",
    { type: "invalid_request_error", code: "setup_intent_authentication_failure" },
    "setup",
    "authentication_required",
  ],
  [
    "razorpay",
    { code: "BAD_REQUEST_ERROR", decline_code: "payment_failed" },
    "payment",
    "card_declined",
  ],
  // Drop-in's own error names are not decline codes: the fallback names them.
  [
    "braintree",
    { code: "DropinError", message: "No payment method is available." },
    "setup",
    "setup_failed",
  ],
  ["braintree", { code: "2015" }, "payment", "card_restricted"],
  ["adyen", { code: "Refused" }, "payment", "authorization_failed"],
  ["checkoutcom", { code: "20051" }, "payment", "insufficient_funds"],
  ["square", { code: "Error", decline_code: "CARD_DECLINED" }, "setup", "card_declined"],
  ["cybersource", { code: "CREATE_TOKEN_TIMEOUT" }, "setup", "setup_failed"],
  ["authorizenet", { type: "Error", code: "E_WC_21" }, "setup", "setup_failed"],
  ["cashfree", { code: "AUTHENTICATION_FAILED" }, "payment", "authorization_failed"],
  // Redirect gateways: no browser-side refusal today, their normaliser still applies.
  ["paypal", { code: "INSTRUMENT_DECLINED" }, "payment", "card_declined"],
  ["payu", { code: "E308" }, "payment", "processing_error"],
  ["mollie", { code: "card_declined" }, "payment", "card_declined"],
  ["gocardless", { code: "insufficient_funds" }, "payment", "insufficient_funds"],
  ["tmtest", { code: "card_declined" }, "setup", "setup_failed"],
];

describe("browserFailureCode per gateway", () => {
  for (const [gateway, signal, purpose, code] of PER_GATEWAY)
    it(`${gateway} ${JSON.stringify(signal)} → ${code}`, () => {
      expect(browserFailureCode(gateway, signal, purpose)).toBe(code);
      // The gateway's own words are the operator text, marked as the browser's.
      const said = signal.message ?? null;
      const text = browserOperatorText(code, said);
      expect(text.endsWith(BROWSER_REPORTED)).toBe(true);
      if (said) expect(text.startsWith(said)).toBe(true);
    });
});

describe("browserFailureVerdict", () => {
  const intent = { publicId: "pi_XXXXXXXXXXXX01", customerId: "cus-a", status: "inited" };
  const open = { status: "inited", errorCode: null, errorText: null };
  const base = {
    intent,
    owner: { customerId: "cus-a" },
    intentGateway: "stripe",
    reportGateway: "stripe",
    attempt: open,
  };
  it("books the session's own open attempt", () => {
    expect(browserFailureVerdict(base)).toBe("booked");
    expect(
      browserFailureVerdict({
        ...base,
        owner: { customerId: null, intentPublicIds: [null, intent.publicId] },
      }),
    ).toBe("booked");
  });
  it("refuses another customer's intent and an unknown one", () => {
    expect(browserFailureVerdict({ ...base, owner: { customerId: "cus-b" } })).toBe("not_owned");
    expect(browserFailureVerdict({ ...base, owner: { customerId: null } })).toBe("not_owned");
    expect(browserFailureVerdict({ ...base, intent: null })).toBe("not_found");
  });
  it("refuses a closed intent or attempt, and another gateway", () => {
    expect(browserFailureVerdict({ ...base, intent: { ...intent, status: "consumed" } })).toBe(
      "closed",
    );
    expect(browserFailureVerdict({ ...base, attempt: { ...open, status: "failed" } })).toBe(
      "closed",
    );
    expect(browserFailureVerdict({ ...base, reportGateway: "razorpay" })).toBe("wrong_gateway");
  });
  it("never replaces a named reason; replaces an earlier browser report", () => {
    expect(
      browserFailureVerdict({
        ...base,
        attempt: { ...open, errorCode: "card_declined", errorText: "Your card was declined." },
      }),
    ).toBe("named_reason");
    expect(
      browserFailureVerdict({
        ...base,
        attempt: {
          ...open,
          errorCode: "setup_failed",
          errorText: browserOperatorText("setup_failed", "Earlier."),
        },
      }),
    ).toBe("booked");
  });
});

describe("hasGatewaySignal", () => {
  it("a field error is not booked, nor a report with no gateway signal", () => {
    expect(hasGatewaySignal({ type: "validation_error", field_error: true })).toBe(false);
    expect(hasGatewaySignal({})).toBe(false);
    expect(hasGatewaySignal(AMEX)).toBe(true);
  });
});
