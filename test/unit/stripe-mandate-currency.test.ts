import { describe, it, expect } from "vitest";
import { normalizeStripeDecline } from "@/providers/decline-codes";
import {
  MANDATE_CURRENCY_CODE,
  mandateCurrencyDiffers,
  mandateCurrencyRefusal,
} from "@/modules/payment-methods/mandate-currency";
import { isDeadMandateDecline } from "@/modules/invoicing/collection";

describe("a Stripe card mandate debits only in its own currency", () => {
  const indiaCard = { providerKey: "stripe", type: "card", mandateCurrency: "INR" };

  it("a USD debit on an INR mandate is refused before Stripe is asked", () => {
    expect(mandateCurrencyDiffers(indiaCard, "USD")).toBe(true);
    expect(mandateCurrencyRefusal(indiaCard, "USD")?.failure?.code).toBe(MANDATE_CURRENCY_CODE);
    expect(mandateCurrencyDiffers(indiaCard, "INR")).toBe(false);
  });

  it("a card with no mandate is never refused for currency", () => {
    expect(mandateCurrencyDiffers({ ...indiaCard, mandateCurrency: null }, "USD")).toBe(false);
  });

  it("Stripe's refusal books as a currency mismatch, which never kills the card", () => {
    // Text of the production refusal, 2026-11-25.
    const n = normalizeStripeDecline({
      code: "payment_intent_mandate_invalid",
      category: "invalid_request_error",
      message:
        "This mandate can only be used for a payment in `inr` currency. You attempted a payment in `usd` currency.",
    });
    expect(n.code).toBe(MANDATE_CURRENCY_CODE);
    expect(n.retriable).toBe(false);
    expect(
      isDeadMandateDecline(
        { status: "failed", failure: { code: n.code } },
        { mandateExpiresAt: null },
      ),
    ).toBe(false);
  });

  it("the same code without that text is still a dead mandate", () => {
    const n = normalizeStripeDecline({
      code: "payment_intent_mandate_invalid",
      category: "invalid_request_error",
      message: "Only active mandates can be used with PaymentIntents.",
    });
    expect(n.code).toBe("mandate_expired");
  });
});
