/**
 * The Stripe-Signature timestamp window. Regresses if an SDK upgrade changes its default
 * tolerance, or if a stale delivery signed with the main secret is retried against the next
 * secret and refused for the wrong reason.
 */
import { describe, it, expect } from "vitest";
import Stripe from "stripe";
import { StripeProvider, STRIPE_API_VERSION, STRIPE_WEBHOOK_TOLERANCE_S } from "@/providers/stripe";

const SECRET = "whsec_unit_freshness";
const NEXT = "whsec_unit_freshness_next";
const body = JSON.stringify({
  id: "evt_XXXXXXXXXXXX01",
  object: "event",
  type: "customer.created",
  api_version: STRIPE_API_VERSION,
  created: Math.floor(Date.now() / 1000),
  data: { object: { id: "cus_XXXXXXXXXXXX01", object: "customer" } },
});

const nowS = () => Math.floor(Date.now() / 1000);
const deliver = (p: StripeProvider, timestamp: number, secret = SECRET) =>
  p.normalizeWebhook({
    payload: Buffer.from(body),
    headers: {
      "stripe-signature": Stripe.webhooks.generateTestHeaderString({
        payload: body,
        secret,
        timestamp,
      }),
    },
  });

describe("Stripe webhook freshness", () => {
  const p = new StripeProvider("sk_test_unit", SECRET, undefined, NEXT);

  it("holds the window at 300 s", () => {
    expect(STRIPE_WEBHOOK_TOLERANCE_S).toBe(300);
  });

  it("accepts a fresh delivery under either secret", async () => {
    await expect(deliver(p, nowS())).resolves.toBeDefined();
    await expect(deliver(p, nowS() - STRIPE_WEBHOOK_TOLERANCE_S + 30, NEXT)).resolves.toBeDefined();
  });

  it("refuses a stale delivery with a valid signature, and says why", async () => {
    await expect(deliver(p, nowS() - STRIPE_WEBHOOK_TOLERANCE_S - 30)).rejects.toThrow(/tolerance/);
    await expect(deliver(p, nowS() - STRIPE_WEBHOOK_TOLERANCE_S - 30, NEXT)).rejects.toThrow(
      /tolerance/,
    );
  });

  it("refuses a bad signature as before", async () => {
    await expect(deliver(p, nowS(), "whsec_not_ours")).rejects.toThrow(/No signatures found/);
  });

  // Only Stripe can sign a future time, and a captured request only ages.
  it("sets no future limit", async () => {
    await expect(deliver(p, nowS() + 3600)).resolves.toBeDefined();
  });
});
