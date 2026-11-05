import { describe, it, expect } from "vitest";
// Relative, not `@/…`: this lives in the dashboard app and the root `@/` alias points
// at src/ (same reasoning as `storefront-return-params.test.ts`).
import { gatewayObjectUrl } from "../../dashboard/components/gateways/gateway-meta";

describe("gatewayObjectUrl", () => {
  it("puts Stripe's mode in the path — a test charge must not open a live URL", () => {
    expect(gatewayObjectUrl("stripe", "pi_1XXXXXXXXXXXXXXXXXXXXXXX", "live")).toBe(
      "https://dashboard.stripe.com/payments/pi_1XXXXXXXXXXXXXXXXXXXXXXX",
    );
    expect(gatewayObjectUrl("stripe", "pi_1XXXXXXXXXXXXXXXXXXXXXXX", "test")).toBe(
      "https://dashboard.stripe.com/test/payments/pi_1XXXXXXXXXXXXXXXXXXXXXXX",
    );
  });

  it("routes a Stripe charge to the same page as an intent", () => {
    expect(gatewayObjectUrl("stripe", "ch_3abc", "test")).toBe(
      "https://dashboard.stripe.com/test/payments/ch_3abc",
    );
  });

  it("links Razorpay payments, which carry no mode segment", () => {
    expect(gatewayObjectUrl("razorpay", "pay_XXXXXXXXXXXXXX", "test")).toBe(
      "https://dashboard.razorpay.com/app/payments/pay_XXXXXXXXXXXXXX",
    );
  });

  it("links a PayPal CAPTURE id, per host, and never an order id", () => {
    // 17 chars = a transaction/capture id; 19 = an order id, which opens nothing.
    expect(gatewayObjectUrl("paypal", "1J375643164236418", "live")).toBe(
      "https://www.paypal.com/activity/payment/1J375643164236418",
    );
    expect(gatewayObjectUrl("paypal", "1J375643164236418", "test")).toBe(
      "https://www.sandbox.paypal.com/activity/payment/1J375643164236418",
    );
    expect(gatewayObjectUrl("paypal", "5O190127TN364715TXY", "live")).toBeNull();
  });

  it("returns null where no dashboard page exists, rather than a link to a 404", () => {
    // Stripe reaches a refund through its payment's timeline; there is no /refunds page.
    expect(gatewayObjectUrl("stripe", "re_3abc", "test")).toBeNull();
    expect(gatewayObjectUrl("stripe", "seti_3abc", "test")).toBeNull();
    expect(gatewayObjectUrl("razorpay", "rfnd_abc", "test")).toBeNull();
    expect(gatewayObjectUrl("tmtest", "tmch_abc", "test")).toBeNull();
    expect(gatewayObjectUrl("offline_check", "CHQ-4471", "test")).toBeNull();
    expect(gatewayObjectUrl(null, "cb_123", "test")).toBeNull();
    expect(gatewayObjectUrl("stripe", null, "test")).toBeNull();
    expect(gatewayObjectUrl("stripe", "   ", "test")).toBeNull();
  });
});
