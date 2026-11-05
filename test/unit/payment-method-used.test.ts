import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { StripeProvider, stripeMethodUsed } from "@/providers/stripe";
import { razorpayMethodUsed } from "@/providers/razorpay";
import { methodTypeOf, toMethodType } from "@/modules/payments/method-type";
import type { ChargeInput } from "@/providers/types";

// `payments.method_type` records what paid. A wrong mapping mislabels every renewal.

describe("methodTypeOf", () => {
  it("the gateway's answer wins over the saved method", () => {
    expect(methodTypeOf({ methodUsed: "upi" }, { type: "card" })).toBe("upi");
  });
  it("no answer → the saved method's type", () => {
    expect(methodTypeOf({}, { type: "sepa_debit" })).toBe("sepa_debit");
    expect(methodTypeOf(null, null)).toBeNull();
  });
  it("an answer outside the vocabulary is unknown, not the saved type", () => {
    expect(methodTypeOf({ methodUsed: "ideal" }, { type: "card" })).toBeNull();
  });
  it("wallet names and the legacy ACH type map onto the vocabulary", () => {
    expect(toMethodType("apple_pay")).toBe("card");
    expect(toMethodType("google_pay")).toBe("card");
    expect(toMethodType("cash_app_pay")).toBe("wallet");
    expect(toMethodType("ach_debit")).toBe("us_bank_account");
    expect(toMethodType("afterpay")).toBeNull();
  });
});

function stripeAnswering(pi: Partial<Stripe.PaymentIntent>) {
  const p = new StripeProvider("sk_test_unit", "whsec_unit");
  (p as unknown as { stripe: unknown }).stripe = {
    paymentIntents: { create: async () => ({ id: "pi_XXXXXXXXXXXX01", ...pi }) },
  };
  return p;
}

const input = {
  amountMinor: 1500n,
  currency: "EUR",
  customer: { providerCustomerId: "cus_XXXXXXXXXXXX01" },
  paymentMethod: { providerPaymentMethodId: "pm_XXXXXXXXXXXX01", display: { type: "card" } },
  idempotencyKey: "inv_test_attempt_1_pm_test",
  ownershipRef: "inv_test",
  description: "Subscription charge",
} as unknown as ChargeInput;

describe("Stripe charge(): methodUsed", () => {
  it("reads the expanded charge's payment_method_details.type", async () => {
    const r = await stripeAnswering({
      status: "processing",
      latest_charge: { payment_method_details: { type: "sepa_debit" } } as Stripe.Charge,
    }).charge(input);
    expect(r.methodUsed).toBe("sepa_debit");
  });
  it("keeps the device wallet of a card charge", async () => {
    const r = await stripeAnswering({
      status: "succeeded",
      latest_charge: {
        payment_method_details: { type: "card", card: { wallet: { type: "apple_pay" } } },
      } as unknown as Stripe.Charge,
    }).charge(input);
    expect(r.methodUsed).toBe("apple_pay");
  });
  it("falls back to the only allowed type, and maps Stripe's names", () => {
    const only = (types: string[]) =>
      stripeMethodUsed({ latest_charge: null, payment_method: null, payment_method_types: types });
    expect(only(["us_bank_account"])).toBe("us_bank_account");
    expect(only(["nz_bank_account"])).toBe("nz_becs_debit");
    expect(only(["card", "link"])).toBeUndefined();
    expect(only(["klarna"])).toBeUndefined();
  });
});

describe("RazorPay payment.method", () => {
  it("maps the payment entity's method onto our vocabulary", () => {
    expect(razorpayMethodUsed("card").methodUsed).toBe("card");
    expect(razorpayMethodUsed("upi").methodUsed).toBe("upi");
    expect(razorpayMethodUsed("emandate").methodUsed).toBe("bank_transfer");
    expect(razorpayMethodUsed("nach").methodUsed).toBe("bank_transfer");
    expect(razorpayMethodUsed("emi").methodUsed).toBeUndefined();
    expect(razorpayMethodUsed(undefined).methodUsed).toBeUndefined();
  });
});
