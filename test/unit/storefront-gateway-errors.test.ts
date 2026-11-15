import { describe, expect, it } from "vitest";
// Relative, not `@/…`: the root `@/` alias points at src/.
import {
  acceptFailure,
  adyenError,
  adyenNoResult,
  braintreeFailure,
  cashfreeFailure,
  checkoutcomFailure,
  contactBusiness,
  errorText,
  gatewayFailure,
  microformFailure,
  refusalMessage,
  squareThrown,
  squareTokenFailure,
} from "../../dashboard/lib/gateway-errors";
import { PAYER_SAFE_INTERNAL_FAILURE } from "@/providers/decline-codes";

/** Every message a buyer reads is a sentence, never empty. */
const sentence = (s: string | null) => {
  expect(s).toBeTruthy();
  expect(s!).toMatch(/[.!?]$/);
};

describe("refusalMessage and gatewayFailure keep the gateway's words whole", () => {
  it("adds the failed step and the next step around the reason", () => {
    expect(
      refusalMessage("We could not save your card.", "Your card was declined", "Try again."),
    ).toBe("We could not save your card. Your card was declined. Try again.");
  });
  it("does not say 'We could not' twice", () => {
    expect(
      refusalMessage("We could not save your card.", "We could not reach the bank.", "Try again."),
    ).toBe("We could not reach the bank. Try again.");
  });
  it("keeps a next step the reason already carries, and adds no second one", () => {
    expect(
      refusalMessage(
        "We could not save your card.",
        "We could not save your payment method. The card was declined. Try again, or use a different payment method.",
        "Select Save card to try again.",
      ),
    ).toBe(
      "We could not save your payment method. The card was declined. Try again, or use a different payment method.",
    );
  });
  it("a failure on our side never sends the buyer to a different payment method", () => {
    const m = refusalMessage(
      "We could not take your payment.",
      PAYER_SAFE_INTERNAL_FAILURE,
      "Select Pay to try again, or use a different payment method.",
    );
    expect(m).toBe(`${PAYER_SAFE_INTERNAL_FAILURE} Try again in a few minutes.`);
    expect(m.match(/We could not/g)).toHaveLength(1);
  });
  it("reads a string, an Error or a gateway object", () => {
    expect(errorText("Declined")).toBe("Declined");
    expect(errorText(new Error("Network error"))).toBe("Network error");
    expect(errorText({ message: "Do not honor" })).toBe("Do not honor");
    expect(errorText({})).toBeNull();
    expect(errorText(undefined)).toBeNull();
  });
  it("falls back to a full sentence when the gateway says nothing", () => {
    expect(gatewayFailure("We could not pay.", undefined, "Try again.")).toBe(
      "We could not pay. Try again.",
    );
  });
});

describe("each gateway's error maps to a message the dialog or caller shows", () => {
  it("Braintree: a requestPaymentMethod rejection keeps Drop-in's message", () => {
    const m = braintreeFailure("payment", {
      name: "DropinError",
      message: "No payment method is available.",
    });
    expect(m).toContain("No payment method is available.");
    sentence(m);
    sentence(braintreeFailure("setup", undefined));
  });

  it("Adyen: an error keeps Adyen's message; only CANCEL is silent", () => {
    const m = adyenError({ name: "NETWORK_ERROR", message: "Payment refused" }, "pay", "payment");
    expect(m).toContain("Payment refused");
    sentence(m);
    sentence(adyenError({ name: "ERROR" }, "open", "setup"));
    expect(adyenError({ name: "CANCEL", message: "closed" }, "pay", "payment")).toBeNull();
  });
  it("Adyen: a finished session with no result never shows a raw result code", () => {
    expect(adyenNoResult("Refused", "payment")).toContain("refused");
    sentence(adyenNoResult(undefined, "setup"));
    expect(adyenNoResult("RedirectShopper", "payment")).toBe(
      "We could not take your payment. The payment provider did not finish the payment. Try again, or use a different payment method.",
    );
  });
  it("one lead for each outcome on every gateway", () => {
    const pay = "We could not take your payment.";
    const save = "We could not save your payment method.";
    for (const m of [
      braintreeFailure("payment", "x"),
      adyenError("x", "pay", "payment")!,
      checkoutcomFailure("payment", "x"),
      squareThrown("x", "payment"),
    ])
      expect(m.startsWith(pay)).toBe(true);
    for (const m of [
      braintreeFailure("setup", "x"),
      adyenError("x", "pay", "setup")!,
      checkoutcomFailure("setup", "x"),
      squareThrown("x"),
    ])
      expect(m.startsWith(save)).toBe(true);
  });
  it("names the business when the page has its name", () => {
    expect(contactBusiness("Halyard Analytics")).toBe("Contact Halyard Analytics.");
    expect(contactBusiness("")).toBe("Contact the business.");
    expect(acceptFailure(undefined, false, "Halyard Analytics")).toMatch(
      /contact Halyard Analytics\.$/,
    );
  });

  it("Checkout.com: Flow's onError message is kept", () => {
    const m = checkoutcomFailure("payment", {
      type: "Request Failed",
      message: "Payment declined",
    });
    expect(m).toContain("Payment declined");
    sentence(m);
    sentence(checkoutcomFailure("setup", null));
  });

  it("Square: field errors are shown too; only a closed wallet sheet is silent", () => {
    const m = squareTokenFailure({
      status: "Invalid",
      errors: [
        { field: "cardNumber", type: "VALIDATION_ERROR", message: "Card number is not valid" },
        { field: "cvv", type: "VALIDATION_ERROR", message: "CVV is not valid" },
      ],
    });
    expect(m).toContain("Card number is not valid.");
    expect(m).toContain("CVV is not valid.");
    sentence(squareTokenFailure({ status: "Error" }));
    sentence(squareTokenFailure(undefined));
    expect(squareTokenFailure({ status: "Cancel" })).toBeNull();
    expect(squareThrown(new Error("Verification failed"))).toContain("Verification failed");
  });

  it("CyberSource: the message and each field's detail are kept", () => {
    const m = microformFailure({
      message: "One or more fields failed validation",
      details: [{ location: "number", message: "Validation error" }, { location: "securityCode" }],
    });
    expect(m).toContain("One or more fields failed validation.");
    expect(m).toContain("Card number: Validation error.");
    expect(m).toContain("Security code: This value is not correct.");
    sentence(microformFailure(null));
  });

  it("Authorize.net: the response's message texts are kept", () => {
    const m = acceptFailure(
      {
        messages: {
          resultCode: "Error",
          message: [{ code: "E_WC_05", text: "Please provide valid credit card number." }],
        },
      },
      false,
    );
    expect(m).toContain("Please provide valid credit card number.");
    sentence(acceptFailure(undefined, true));
    expect(acceptFailure(undefined, true)).toContain("bank account");
  });

  it("Cashfree: a modal error reads true for a close and a decline, reason before next step", () => {
    const lead = "We could not take your payment.";
    const next = "Try again, or use a different payment method.";
    expect(
      cashfreeFailure("order", { code: "payment_failed", message: "Transaction declined by bank" }),
    ).toBe(`${lead} Transaction declined by bank. ${next}`);
    expect(cashfreeFailure("order", { message: "Payment cancelled by user." })).toBe(
      `${lead} Payment cancelled by user. ${next}`,
    );
    expect(cashfreeFailure("order", {})).toBe(`${lead} The payment did not finish. ${next}`);
    expect(cashfreeFailure("order", undefined)).toBe(`${lead} The payment did not finish. ${next}`);
    // The portal wraps it in its own lead: not said twice.
    expect(
      refusalMessage("We could not take your payment.", cashfreeFailure("order", {}), ""),
    ).not.toMatch(/We could not take your payment\. We could not/);
    sentence(cashfreeFailure("subscription", {}));
  });
});
