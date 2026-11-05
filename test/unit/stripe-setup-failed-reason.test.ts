/**
 * A Stripe setup refusal keeps its reason.
 *
 * The buyer's browser confirms a SetupIntent with Stripe directly, so the refusal reaches us
 * only as `setup_intent.setup_failed`. The adapter dropped `last_setup_error`, and the attempt
 * was stored as a bare `setup_failed` with no hint that the security code was wrong.
 */
import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { StripeProvider, STRIPE_API_VERSION } from "@/providers/stripe";

const SECRET = "whsec_unit_test";
const stripe = new StripeProvider("sk_test_unit", SECRET);

const deliver = (type: string, object: Record<string, unknown>) => {
  const body = JSON.stringify({
    id: `evt_${type}`,
    object: "event",
    api_version: STRIPE_API_VERSION,
    created: 1790000000,
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

describe("stripe setup_intent.setup_failed", () => {
  it("carries the normalized decline, the gateway's code and its message", async () => {
    // The shape Stripe sent on a live wrong-CVC refusal.
    const [ev] = await deliver("setup_intent.setup_failed", {
      object: "setup_intent",
      id: "seti_unit_cvc",
      status: "requires_payment_method",
      metadata: {},
      created: 1790000000,
      last_setup_error: {
        type: "card_error",
        code: "invalid_cvc",
        decline_code: "invalid_cvc",
        message: "Your card's security code is invalid.",
      },
    });
    expect(ev?.type).toBe("intent.setup_failed");
    expect(ev?.providerIntentId).toBe("seti_unit_cvc");
    expect(ev?.failureCode).toBe("incorrect_cvc");
    expect(ev?.providerFailureCode).toBe("invalid_cvc");
    expect(ev?.failureMessage).toBe("Your card's security code is invalid.");
  });

  it("carries no failure fields when Stripe gives no error", async () => {
    const [ev] = await deliver("setup_intent.setup_failed", {
      object: "setup_intent",
      id: "seti_unit_bare",
      status: "requires_payment_method",
      metadata: {},
      created: 1790000000,
    });
    expect(ev?.failureCode).toBeUndefined();
    expect(ev?.failureMessage).toBeUndefined();
  });

  it("leaves other intent events without failure fields", async () => {
    const [ev] = await deliver("setup_intent.succeeded", {
      object: "setup_intent",
      id: "seti_unit_ok",
      status: "succeeded",
      payment_method: "pm_unit",
      metadata: {},
      created: 1790000000,
    });
    expect(ev?.failureCode).toBeUndefined();
    expect(ev?.providerPaymentMethodId).toBe("pm_unit");
  });
});
