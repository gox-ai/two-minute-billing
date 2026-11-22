/**
 * A Stripe decline that arrives by webhook is classified on the same signal as one that
 * arrives in the API answer: decline code, network codes, advice codes and card brand.
 */
import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { StripeProvider, STRIPE_API_VERSION } from "@/providers/stripe";

const SECRET = "whsec_unit_test";
const stripe = new StripeProvider("sk_test_unit", SECRET);

const deliver = (type: string, object: Record<string, unknown>) => {
  const body = JSON.stringify({
    id: `evt_${type}_${String(object.id)}`,
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

const pi = (id: string, lastPaymentError: Record<string, unknown>) => ({
  object: "payment_intent",
  id,
  status: "requires_payment_method",
  metadata: {},
  created: 1790000000,
  last_payment_error: lastPaymentError,
});

const charge = (id: string, extra: Record<string, unknown>) => ({
  object: "charge",
  id,
  payment_intent: `pi_${id.slice(3)}`,
  status: "failed",
  metadata: {},
  created: 1790000000,
  ...extra,
});

describe("stripe charge.failed webhook: full decline signal", () => {
  it("an India debit not approved maps from decline_code, not the generic code", async () => {
    const [ev] = await deliver(
      "payment_intent.payment_failed",
      pi("pi_unit_afa", {
        type: "card_error",
        code: "card_declined",
        decline_code: "transaction_not_approved",
        message: "Your card was declined.",
      }),
    );
    expect(ev?.type).toBe("charge.failed");
    expect(ev?.failureCode).toBe("afa_not_completed");
    expect(ev?.providerFailureCode).toBe("transaction_not_approved");
  });

  it("network advice 03 on the payment error stops retries", async () => {
    const [ev] = await deliver(
      "payment_intent.payment_failed",
      pi("pi_unit_advice", {
        type: "card_error",
        code: "card_declined",
        decline_code: "generic_decline",
        network_advice_code: "03",
      }),
    );
    expect(ev?.failureCode).toBe("network_do_not_retry");
    expect(ev?.failureRetriable).toBe(false);
  });

  it("a Charge prefers the issuer's reason over the generic card_declined", async () => {
    const [ev] = await deliver(
      "charge.failed",
      charge("ch_unit_funds", {
        failure_code: "card_declined",
        failure_message: "Your card has insufficient funds.",
        outcome: { type: "issuer_declined", reason: "insufficient_funds" },
      }),
    );
    expect(ev?.failureCode).toBe("insufficient_funds");
    expect(ev?.providerFailureCode).toBe("insufficient_funds");
    expect(ev?.failureMessage).toBe("Your card has insufficient funds.");
  });

  it("a Charge with a Visa never-resubmit network code is a hard decline", async () => {
    const [ev] = await deliver(
      "charge.failed",
      charge("ch_unit_visa", {
        failure_code: "card_declined",
        outcome: { type: "issuer_declined", reason: "generic_decline", network_decline_code: "14" },
        payment_method_details: { type: "card", card: { brand: "visa" } },
      }),
    );
    expect(ev?.failureCode).toBe("network_do_not_retry");
    expect(ev?.failureRetriable).toBe(false);
  });

  it("a Stripe-blocked Charge keeps its own failure code", async () => {
    const [ev] = await deliver(
      "charge.failed",
      charge("ch_unit_radar", {
        failure_code: "card_declined",
        outcome: { type: "blocked", reason: "highest_risk_level" },
      }),
    );
    expect(ev?.providerFailureCode).toBe("card_declined");
    expect(ev?.failureCode).toBe("network_do_not_retry");
  });
});
