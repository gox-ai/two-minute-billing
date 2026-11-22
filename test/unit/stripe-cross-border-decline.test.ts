import { describe, it, expect } from "vitest";
import Stripe from "stripe";
import { normalizeStripeDecline, payerDeclineMessage } from "@/providers/decline-codes";
import { isHardDecline } from "@/modules/invoicing/collection";
import { StripeProvider } from "@/providers/stripe";
import { resolveErrorId } from "@/platform/error-taxonomy";

const CODE = "cross_border_classification_missing_name_and_address";

/** Stripe's own refusal: the confirm is refused, the PaymentIntent it created is kept. */
function refusal() {
  return new Stripe.errors.StripeInvalidRequestError({
    type: "invalid_request_error",
    code: CODE,
    message: "As per Indian regulations, export transactions require a customer name and address.",
    payment_intent: { id: "pi_XXXXXXXXXXXXXXXXXXXXXX01" } as Stripe.PaymentIntent,
  });
}

describe("India exports: a charge without the buyer's name and address", () => {
  it("is a decline the buyer can clear, not a bad card", () => {
    const f = normalizeStripeDecline(CODE);
    expect(f.code).toBe("billing_details_required");
    expect(f.ruleId).toBe(`stripe.code.${CODE}`);
    expect(isHardDecline({ status: "failed", failure: { ...f, code: f.code! } })).toBe(false);
    expect(resolveErrorId(f.code).known).toBe(true);
    expect(payerDeclineMessage({ ...f }, "fallback")).toBe(
      "Add your billing name and address. Then try again.",
    );
  });

  it("is booked with the PaymentIntent Stripe kept, instead of thrown", async () => {
    const stripe = new StripeProvider("sk_test_x");
    (stripe as unknown as { stripe: unknown }).stripe = {
      paymentIntents: {
        create: async () => {
          throw refusal();
        },
      },
    };
    const r = await stripe.charge({
      amountMinor: 1500n,
      currency: "USD",
      customer: { providerKey: "stripe", providerCustomerId: "cus_XXXXXXXXXXXX01" },
      paymentMethod: { providerKey: "stripe", providerPaymentMethodId: "pm_XXXXXXXXXXXX01" },
      idempotencyKey: "test-cross-border",
      ownershipRef: "sub_XXXXXXXXXXXX01",
      description: "Reactivation",
    } as Parameters<StripeProvider["charge"]>[0]);
    expect(r.status).toBe("failed");
    expect(r.providerChargeId).toBe("pi_XXXXXXXXXXXXXXXXXXXXXX01");
    expect(r.failure?.code).toBe("billing_details_required");
  });
});
