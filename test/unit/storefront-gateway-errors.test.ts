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
  razorpayClientReason,
  refusalMessage,
  squareThrown,
  squareTokenFailure,
} from "../../dashboard/lib/gateway-errors";
import { PAYER_SAFE_INTERNAL_FAILURE } from "@/providers/decline-codes";
import { signalFor } from "../../dashboard/lib/buyer-error-report";

/** Every message a buyer reads is a sentence, never empty. */
const sentence = (s: string | null) => {
  expect(s).toBeTruthy();
  expect(s!).toMatch(/[.!?]$/);
};

describe("refusalMessage and gatewayFailure frame a reason", () => {
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

describe("each gateway's error reads as our words, never the gateway's", () => {
  it("Braintree: a requestPaymentMethod rejection shows our lead and next step only", () => {
    const m = braintreeFailure("payment", {
      name: "DropinError",
      message: "No payment method is available.",
    });
    expect(m).toBe(
      "We could not take your payment. Correct the details or use a different payment method. Then try again.",
    );
    sentence(braintreeFailure("setup", undefined));
  });

  it("Adyen: an error never shows Adyen's text; only CANCEL is silent", () => {
    const m = adyenError({ name: "NETWORK_ERROR", message: "Payment refused" }, "pay", "payment");
    expect(m).not.toContain("Payment refused");
    sentence(m);
    expect(adyenError({ name: "ERROR", message: "Invalid clientKey" }, "open", "setup")).toBe(
      "We could not open the card form. Try again.",
    );
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

  it("Checkout.com: Flow's onError text is not shown", () => {
    const m = checkoutcomFailure("payment", {
      type: "Request Failed",
      message: "Payment declined",
    });
    expect(m).not.toContain("Payment declined");
    sentence(m);
    sentence(checkoutcomFailure("setup", null));
  });

  it("Square: field errors are shown; other error text and a thrown error are not", () => {
    const m = squareTokenFailure({
      status: "Invalid",
      errors: [
        { field: "cardNumber", type: "VALIDATION_ERROR", message: "Card number is not valid" },
        { field: "cvv", type: "VALIDATION_ERROR", message: "CVV is not valid" },
        { type: "UNAUTHORIZED", message: "Application ID is not valid" },
      ],
    });
    expect(m).toContain("Card number is not valid.");
    expect(m).toContain("CVV is not valid.");
    expect(m).not.toContain("Application ID");
    expect(squareTokenFailure({ status: "Error", errors: [{ message: "Rate limited" }] })).toBe(
      "We could not save your payment method. Try again, or use a different method.",
    );
    sentence(squareTokenFailure(undefined));
    expect(squareTokenFailure({ status: "Cancel" })).toBeNull();
    expect(squareThrown(new Error("Verification failed"))).not.toContain("Verification failed");
  });

  it("CyberSource: each field's detail is shown under our label; the top message is not", () => {
    const m = microformFailure({
      message: "CREATE_TOKEN_VALIDATION_SERVERSIDE",
      details: [{ location: "number", message: "Validation error" }, { location: "securityCode" }],
    });
    expect(m).not.toContain("CREATE_TOKEN");
    expect(m).toContain("Card number: Validation error.");
    expect(m).toContain("Security code: This value is not correct.");
    sentence(microformFailure({ message: "Invalid capture context" }));
    expect(microformFailure({ message: "Invalid capture context" })).not.toContain("capture");
  });

  it("Authorize.net: a response's message texts are never shown", () => {
    const m = acceptFailure(
      {
        messages: {
          resultCode: "Error",
          message: [
            {
              code: "E_WC_21",
              text: "User authentication failed due to invalid authentication values.",
            },
          ],
        },
      },
      false,
    );
    expect(m).toBe(
      "We could not read the card details. Try again. If the problem continues, contact the business.",
    );
    expect(acceptFailure(undefined, true)).toContain("bank account");
  });

  it("Cashfree: one message, true for a close and a decline, with no Cashfree text", () => {
    const m =
      "We could not take your payment. The payment did not finish. Try again, or use a different payment method.";
    expect(
      cashfreeFailure("order", { code: "payment_failed", message: "Transaction declined by bank" }),
    ).toBe(m);
    expect(cashfreeFailure("order", { message: "Payment cancelled by user." })).toBe(m);
    expect(cashfreeFailure("order", undefined)).toBe(m);
    // The portal wraps it in its own lead: not said twice.
    expect(
      refusalMessage("We could not take your payment.", cashfreeFailure("order", {}), ""),
    ).not.toMatch(/We could not take your payment\. We could not/);
    expect(cashfreeFailure("subscription", { message: "order_token expired" })).not.toContain(
      "order_token",
    );
  });

  it("RazorPay: a refusal in the sheet reads as our sentence for its reason", () => {
    const insufficient = razorpayClientReason({
      code: "BAD_REQUEST_ERROR",
      reason: "insufficient_funds",
      description: "Payment failed due to insufficient balance",
    });
    expect(insufficient).not.toContain("Payment failed due to");
    expect(insufficient).toMatch(/^Your bank declined the payment/);
    expect(
      razorpayClientReason({
        code: "GATEWAY_ERROR",
        reason: "payment_failed",
        description: "Your payment didn't go through due to a temporary issue.",
      }),
    ).toBe("Your bank declined the payment. Contact your bank, or use a different payment method.");
    // Nothing to say about a cancelled or unknown refusal: a neutral sentence, never the description.
    expect(razorpayClientReason({ reason: "payment_cancelled", description: "Cancelled" })).toBe(
      "The authorization did not finish.",
    );
    expect(razorpayClientReason(undefined)).toBe("The authorization did not finish.");
  });

  it("RazorPay: the refusal's source and step ride on the noted signal", () => {
    const text = razorpayClientReason({
      code: "BAD_REQUEST_ERROR",
      reason: "payment_failed",
      description: "d",
      source: "bank",
      step: "payment_authorization",
    });
    expect(signalFor(text)).toMatchObject({
      gateway: "razorpay",
      type: "bank",
      param: "payment_authorization",
      declineCode: "payment_failed",
    });
  });
});
