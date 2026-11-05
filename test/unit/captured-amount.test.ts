/**
 * `capturedAmountMinor` on `charge.succeeded`, for the adapters whose offline suite lives
 * here rather than in a `scripts/verify-<gateway>.ts` (Stripe, RazorPay, PayPal, tmtest).
 * Absent means unknown: a hold or an amount-less payload must leave it unset.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { StripeProvider, STRIPE_API_VERSION, stripeCapturedAmount } from "@/providers/stripe";
import { RazorpayProvider } from "@/providers/razorpay";
import { paypalCapturedAmount } from "@/providers/paypal";
import { TmtestProvider } from "@/providers/tmtest";
import { signTmtest } from "@/providers/tmtest/signing";
import { storefrontOrigins } from "@/modules/gateway/service";

describe("Stripe", () => {
  const SECRET = "whsec_unit_captured";
  const stripe = new StripeProvider("sk_test_unit", SECRET);
  const deliver = (type: string, object: Record<string, unknown>) => {
    const body = JSON.stringify({
      id: `evt_${type}`,
      object: "event",
      created: 1790000000,
      // At our pinned version, so the adapter reads the payload rather than fetching it.
      api_version: STRIPE_API_VERSION,
      type,
      data: { object },
    });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
    return stripe.normalizeWebhook({
      payload: body,
      headers: { "stripe-signature": `t=${t},v1=${v1}` },
    });
  };

  it("payment_intent.succeeded carries amount_received", async () => {
    const [ev] = await deliver("payment_intent.succeeded", {
      object: "payment_intent",
      id: "pi_XXXXXXXXXXXX01",
      amount: 2500,
      amount_received: 2500,
    });
    expect(ev!.type).toBe("charge.succeeded");
    expect(ev!.capturedAmountMinor).toBe(2500n);
  });

  it("a captured Charge carries amount_captured (charge.succeeded and charge.captured)", async () => {
    const charge = {
      object: "charge",
      id: "ch_XXXXXXXXXXXX01",
      payment_intent: "pi_XXXXXXXXXXXX01",
      amount: 2500,
      amount_captured: 1800,
      captured: true,
    };
    expect((await deliver("charge.succeeded", charge))[0]!.capturedAmountMinor).toBe(1800n);
    expect((await deliver("charge.captured", charge))[0]!.capturedAmountMinor).toBe(1800n);
  });

  it("an uncaptured Charge (manual capture) leaves it unset", async () => {
    const [ev] = await deliver("charge.succeeded", {
      object: "charge",
      id: "ch_XXXXXXXXXXXX02",
      amount: 2500,
      amount_captured: 0,
      captured: false,
    });
    expect(ev!.type).toBe("charge.succeeded");
    expect(ev!.capturedAmountMinor).toBeUndefined();
  });

  it("is never set on a non-success event", async () => {
    const [ev] = await deliver("payment_intent.payment_failed", {
      object: "payment_intent",
      id: "pi_XXXXXXXXXXXX03",
      amount_received: 0,
    });
    expect(ev!.capturedAmountMinor).toBeUndefined();
    expect(stripeCapturedAmount({ object: "refund" })).toBeUndefined();
  });
});

describe("RazorPay", () => {
  const SECRET = "test-webhook-secret";
  const razorpay = new RazorpayProvider({
    keyId: "rzp_test_x",
    keySecret: "secret",
    apiBase: "https://api.razorpay.test/v1",
    webhookSecret: SECRET,
  });
  const deliver = (event: string, payment: Record<string, unknown>) => {
    const body = JSON.stringify({
      entity: "event",
      event,
      created_at: 1786681800,
      payload: { payment: { entity: payment } },
    });
    return razorpay.normalizeWebhook({
      payload: body,
      headers: { "x-razorpay-signature": createHmac("sha256", SECRET).update(body).digest("hex") },
    });
  };
  const payment = {
    id: "pay_XXXXXXXXXXXX01",
    order_id: "order_XXXXXXXXXXXX01",
    amount: 49900,
    currency: "INR",
    status: "captured",
    captured: true,
  };

  it("payment.captured and order.paid carry the payment's amount", async () => {
    for (const name of ["payment.captured", "order.paid"]) {
      const [ev] = await deliver(name, payment);
      expect(ev!.type).toBe("charge.succeeded");
      expect(ev!.capturedAmountMinor).toBe(49900n);
    }
  });

  it("a payment not marked captured leaves it unset", async () => {
    const [ev] = await deliver("order.paid", { ...payment, status: "authorized", captured: false });
    expect(ev!.capturedAmountMinor).toBeUndefined();
  });

  it("a failure never carries it", async () => {
    const [ev] = await deliver("payment.failed", { ...payment, status: "failed", captured: false });
    expect(ev!.type).toBe("charge.failed");
    expect(ev!.capturedAmountMinor).toBeUndefined();
  });
});

describe("PayPal", () => {
  it("a v2 capture carries amount.value in minor units", () => {
    expect(
      paypalCapturedAmount("PAYMENT.CAPTURE.COMPLETED", {
        amount: { value: "12.34", currency_code: "USD" },
      }),
    ).toBe(1234n);
    expect(
      paypalCapturedAmount("PAYMENT.CAPTURE.COMPLETED", {
        amount: { value: "1500", currency_code: "JPY" },
      }),
    ).toBe(1500n);
  });

  it("a v1 sale carries amount.total", () => {
    expect(
      paypalCapturedAmount("PAYMENT.SALE.COMPLETED", {
        amount: { total: "9.99", currency: "EUR" },
      }),
    ).toBe(999n);
  });

  it("an order sums its COMPLETED captures, and only in one currency", () => {
    const order = (captures: unknown[]) => ({ purchase_units: [{ payments: { captures } }] });
    const cap = (value: string, status = "COMPLETED", currency_code = "USD") => ({
      status,
      amount: { value, currency_code },
    });
    expect(
      paypalCapturedAmount("CHECKOUT.ORDER.COMPLETED", order([cap("10.00"), cap("2.50")])),
    ).toBe(1250n);
    expect(
      paypalCapturedAmount(
        "CHECKOUT.ORDER.COMPLETED",
        order([cap("10.00"), cap("5.00", "PENDING")]),
      ),
    ).toBe(1000n);
    expect(
      paypalCapturedAmount(
        "CHECKOUT.ORDER.COMPLETED",
        order([cap("10.00"), cap("5.00", "COMPLETED", "EUR")]),
      ),
    ).toBeUndefined();
    expect(
      paypalCapturedAmount("CHECKOUT.ORDER.COMPLETED", { purchase_units: [] }),
    ).toBeUndefined();
  });

  it("leaves it unset without an amount", () => {
    expect(paypalCapturedAmount("PAYMENT.CAPTURE.COMPLETED", {})).toBeUndefined();
  });
});

describe("tmtest", () => {
  const deliver = (type: string, data: Record<string, unknown>) => {
    const evt = { id: `evt_tmtest_${type}`, type, occurred_at: "2026-10-25T10:00:00Z", data };
    return new TmtestProvider("biz_unit").normalizeWebhook({
      payload: JSON.stringify(evt),
      headers: { "x-tmtest-signature": signTmtest(evt) },
    });
  };

  it("charge.succeeded carries amount_minor", async () => {
    const [ev] = await deliver("charge.succeeded", {
      charge_id: "ch_tm_1",
      amount_minor: 2500,
      currency: "USD",
    });
    expect(ev!.capturedAmountMinor).toBe(2500n);
  });

  it("is unset when the payload has no amount, and on a failure", async () => {
    expect(
      (await deliver("charge.succeeded", { charge_id: "ch_tm_2" }))[0]!.capturedAmountMinor,
    ).toBeUndefined();
    expect(
      (await deliver("charge.failed", { charge_id: "ch_tm_3", amount_minor: 2500 }))[0]!
        .capturedAmountMinor,
    ).toBeUndefined();
  });
});

describe("storefrontOrigins (the Allowed origins health check's input)", () => {
  it("is the origin of PORTAL_BASE_URL, path and trailing slash dropped", () => {
    expect(storefrontOrigins("https://portal.example.com/")).toEqual([
      "https://portal.example.com",
    ]);
    expect(storefrontOrigins("http://localhost:4100/portal")).toEqual(["http://localhost:4100"]);
  });

  it("is empty when unset or not a URL", () => {
    expect(storefrontOrigins("")).toEqual([]);
    expect(storefrontOrigins("not a url")).toEqual([]);
  });
});
