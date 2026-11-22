import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const recorded: string[] = [];
vi.mock("@/modules/ops/buyer-rejections", () => {
  const seen = new WeakSet<object>();
  return {
    buyerRejectionRecorded: (req: object) => seen.has(req),
    recordBuyerRejection: (req: object, message: string) => {
      seen.add(req);
      recorded.push(message);
    },
  };
});

const {
  BUYER_GENERIC_FIELD_REASON,
  BUYER_GENERIC_REFUSAL,
  buyerErrorTextHook,
  isOperatorText,
  payerSafeEnvelope,
} = await import("@/api/buyer-error-text");

describe("operator text never reaches a payer", () => {
  it.each([
    "Unknown parameter: foo",
    'state_code takes the code, not the name. Use "KA" for Karnataka',
    "No such payment intent: pi_XXXXXXXXXXXX01",
    "The parameter `mandate` is not provided or invalid",
    "reactivate_from needs reactivate: true",
  ])("withholds %j", (m) => {
    expect(isOperatorText(m)).toBe(true);
  });

  // The storefront branches on these words; the net must not replace them.
  it.each([
    "No such coupon: summer_sale",
    "Complete the payment step first.",
    "Complete the authentication first",
    "The amount changed after you agreed. Read the new amount and select the box again.",
    "Your bank did not tell us yet that this payment is complete. If you completed it, wait.",
  ])("keeps code-matched %j", (m) => {
    expect(isOperatorText(m)).toBe(false);
  });

  // Our own payer sentences pass unchanged.
  it.each([
    "Your payment is already in progress. Wait a moment. Then refresh the page.",
    "Add a payment method. Then try again.",
    "We could not find that payment method. Select a different one, or add one.",
    'The coupon "summer_sale" is in USD, but this checkout bills in INR. You cannot use it here.',
    "We could not confirm that payment method with Razorpay. The approval may have expired, or it was not completed. Try to add it again.",
    "We could not find this payment method setup. Start again to add your payment method.",
    "We could not find this payment. Start the payment again.",
    "Select the box to accept the terms.",
    "Enter your email address.",
    "Enter your tax ID.",
    "Enter a shipping address.",
    "Enter a PO number.",
    "We could not archive this address. A live subscription ships to it. Change the shipping address of the subscription first.",
  ])("keeps our sentence %j", (m) => {
    expect(isOperatorText(m)).toBe(false);
  });

  it("reads quoted text as the payer's own input", () => {
    expect(isOperatorText('"john_doe@x" is not a valid email address')).toBe(false);
  });

  it("replaces the message and each operator field reason; keeps type, code and param", () => {
    const safe = payerSafeEnvelope({
      error: {
        type: "invalid_request_error",
        code: "bad_state",
        param: "address",
        message: "address.state_code: state_code takes the code",
        details: { address: ["state_code takes the code", '"ZZ" is not a valid state code'] },
      },
    });
    expect(safe?.error).toEqual({
      type: "invalid_request_error",
      code: "bad_state",
      param: "address",
      message: BUYER_GENERIC_REFUSAL,
      details: { address: [BUYER_GENERIC_FIELD_REASON, '"ZZ" is not a valid state code'] },
    });
    expect(
      payerSafeEnvelope({ error: { message: "Select the box to accept the terms." } }),
    ).toBeNull();
  });
});

describe("buyerErrorTextHook on a live route", () => {
  afterEach(() => {
    recorded.length = 0;
  });

  const app = async (buyer: boolean) => {
    const a = Fastify();
    a.addHook("onRequest", async (req) => {
      if (buyer) (req as { portalSession?: unknown }).portalSession = { customerId: "c" };
    });
    a.addHook("preSerialization", buyerErrorTextHook);
    a.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) =>
      reply.code(err.statusCode ?? 500).send({ error: { type: "x", message: err.message } }),
    );
    a.get("/sent", (_req, reply) =>
      reply.code(400).send({ error: { type: "x", message: "No such price: price_0abcDEF123456" } }),
    );
    a.get("/thrown", () => {
      throw Object.assign(new Error("Unknown parameter: foo"), { statusCode: 400 });
    });
    a.get("/ours", (_req, reply) =>
      reply
        .code(400)
        .send({ error: { type: "x", message: "Add a payment method. Then try again." } }),
    );
    a.get("/server", (_req, reply) =>
      reply.code(500).send({ error: { type: "api_error", message: "price_cache_miss" } }),
    );
    return a;
  };

  it("withholds operator text from a buyer session, on a send and on a throw", async () => {
    const a = await app(true);
    for (const url of ["/sent", "/thrown"]) {
      const res = await a.inject({ url });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe(BUYER_GENERIC_REFUSAL);
    }
    expect(recorded).toEqual(["No such price: price_0abcDEF123456", "Unknown parameter: foo"]);
  });

  it("leaves our sentences, 5xx answers and non-buyer callers alone", async () => {
    const buyer = await app(true);
    expect((await buyer.inject({ url: "/ours" })).json().error.message).toBe(
      "Add a payment method. Then try again.",
    );
    expect((await buyer.inject({ url: "/server" })).json().error.message).toBe("price_cache_miss");
    const operator = await app(false);
    expect((await operator.inject({ url: "/sent" })).json().error.message).toBe(
      "No such price: price_0abcDEF123456",
    );
    expect(recorded).toEqual([]);
  });
});
