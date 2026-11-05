/**
 * RazorPay reports a mandate's captured auth amount (`setupAuthCharge`) so the engine can
 * refund it — and never an invoice payment, whatever id the vault is handed.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { RazorpayProvider } from "@/providers/razorpay";

const BASE = "https://api.razorpay.test/v1";
const CUST = "cust_XXXXXXXXXXXX01";
const TOKEN = "token_XXXXXXXXXXXX01";

type Answer = { status?: number; json: unknown };
function stubFetch(routes: Record<string, Answer>) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string }) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url);
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.replace(BASE, "")}`;
    seen.push(key);
    const hit = routes[key];
    if (!hit) throw new Error(`unstubbed gateway call: ${key}`);
    return new Response(JSON.stringify(hit.json), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return seen;
}

const rzp = () => new RazorpayProvider({ keyId: "rzp_test_x", keySecret: "s", apiBase: BASE });
const token = { id: TOKEN, method: "card", recurring: true, card: { last4: "4366" } };
const payment = (over: Record<string, unknown>) => ({
  id: "pay_XXXXXXXXXXXX01",
  status: "captured",
  captured: true,
  amount: 100,
  amount_refunded: 0,
  currency: "INR",
  token_id: TOKEN,
  customer_id: CUST,
  order_id: "order_XXXXXXXXXXXX01",
  ...over,
});
const mandateOrder = { id: "order_XXXXXXXXXXXX01", amount: 100, token: { max_amount: 50000 } };

function routes(
  pay: Record<string, unknown>,
  order: unknown = mandateOrder,
): Record<string, Answer> {
  return {
    "GET /payments/pay_XXXXXXXXXXXX01": { json: pay },
    "GET /orders/order_XXXXXXXXXXXX01": { json: order },
    [`GET /customers/${CUST}/tokens/${TOKEN}`]: { json: token },
  };
}
const vault = () =>
  rzp().vaultPaymentMethod({
    customer: { providerKey: "razorpay", providerCustomerId: CUST },
    token: "pay_XXXXXXXXXXXX01",
  });

afterEach(() => vi.unstubAllGlobals());

describe("RazorPay setup auth charge", () => {
  it("reports a captured auth on a mandate order", async () => {
    stubFetch(routes(payment({})));
    const ref = await vault();
    expect(ref.setupAuthCharge).toEqual({
      providerChargeId: "pay_XXXXXXXXXXXX01",
      amountMinor: 100n,
      currency: "INR",
    });
  });

  it("reports an authorized one too: the order auto-captures and the job waits", async () => {
    stubFetch(routes(payment({ status: "authorized", captured: false })));
    expect((await vault()).setupAuthCharge?.amountMinor).toBe(100n);
  });

  it("never reports an invoice payment, even one that minted a token", async () => {
    stubFetch(
      routes(payment({ amount: 50000 }), { id: "order_XXXXXXXXXXXX01", amount: 50000, token: {} }),
    );
    expect((await vault()).setupAuthCharge).toBeUndefined();
  });

  it("never reports a ₹1 payment on an order with no mandate", async () => {
    stubFetch(routes(payment({}), { id: "order_XXXXXXXXXXXX01", amount: 100 }));
    expect((await vault()).setupAuthCharge).toBeUndefined();
  });

  it("knows a UPI mandate order by our tag, since its fetch omits the token block", async () => {
    stubFetch(
      routes(payment({ method: "upi" }), {
        id: "order_XXXXXXXXXXXX01",
        amount: 100,
        notes: { tmbilling_ref: "pi_XXXXXXXXXXXX01", tmbilling_setup: "1" },
      }),
    );
    expect((await vault()).setupAuthCharge?.amountMinor).toBe(100n);
  });

  it("reports nothing once the auth is fully refunded", async () => {
    stubFetch(routes(payment({ status: "refunded", amount_refunded: 100 })));
    expect((await vault()).setupAuthCharge).toBeUndefined();
  });

  it("fails the vault when the mandate order cannot be read, rather than keep the rupee", async () => {
    const r = routes(payment({}));
    r["GET /orders/order_XXXXXXXXXXXX01"] = { status: 500, json: {} };
    stubFetch(r);
    await expect(vault()).rejects.toThrow();
  });

  it("reports it on the setup-intent consume, whose order is known to be a setup", async () => {
    // An untagged UPI order from before the tag: the consume still knows it.
    stubFetch({
      ...routes(payment({ method: "upi" }), { id: "order_XXXXXXXXXXXX01", amount: 100 }),
      "GET /orders/order_XXXXXXXXXXXX01/payments": { json: { items: [payment({})] } },
    });
    const out = await rzp().consumeIntent({
      intentId: "order_XXXXXXXXXXXX01",
      purpose: "setup",
    } as Parameters<RazorpayProvider["consumeIntent"]>[0]);
    expect(out.purpose).toBe("setup");
    const pm = (out as { paymentMethod?: { setupAuthCharge?: { amountMinor: bigint } } })
      .paymentMethod;
    expect(pm?.setupAuthCharge?.amountMinor).toBe(100n);
  });
});
