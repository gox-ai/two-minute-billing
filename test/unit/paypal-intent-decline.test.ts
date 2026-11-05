/**
 * #63 for PayPal — a processor decline is not our configuration fault.
 *
 * `charge()` posts to the same `/v2/checkout/orders` with the same `payment_source` and
 * already books a non-2xx through `chargeFailure`. `createIntent` threw instead, so the
 * caller's backstop (13152c64) recorded a refused instrument as `gateway_request_rejected`
 * — "not the customer's card" — the inverse of what happened.
 *
 * No id is asserted here on purpose: PayPal's error envelope carries no resource id, and
 * their Orders-API error reference documents no create that errors and still leaves an
 * order behind (checked 2026-09-07). RazorPay's does — see the sibling test.
 */
import { describe, it, expect } from "vitest";
import { PayPalProvider } from "@/providers/paypal";

function providerAnswering(status: number, json: unknown): PayPalProvider {
  const p = new PayPalProvider({
    clientId: "unit",
    clientSecret: "unit",
    apiBase: "https://api.invalid",
  });
  (p as unknown as { api: unknown }).api = async () => ({ status, json });
  return p;
}

const INPUT = {
  purpose: "payment" as const,
  currency: "USD",
  amountMinor: 5_000n,
  customer: { providerKey: "paypal" as const, providerCustomerId: "cus_unit" },
  idempotencyKey: "pi_create_pi_unit_a1",
  session: "on_session" as const,
};

describe("paypal createIntent: a decline the classifier knows comes back as data", () => {
  it("BOOKS INSTRUMENT_DECLINED instead of throwing it as our fault", async () => {
    const declined = {
      name: "UNPROCESSABLE_ENTITY",
      details: [{ issue: "INSTRUMENT_DECLINED", description: "The instrument was declined." }],
      debug_id: "unit",
    };
    const ref = await providerAnswering(422, declined).createIntent(INPUT);
    // The same verdict `charge()` reaches on the identical response — not
    // `gateway_request_rejected`, which blames us for the customer's card.
    expect(ref.failure?.code).toBe("card_declined");
    expect(ref.status).toBe("inited");
  });

  it("keeps the 5xx-is-retriable rule the shared classifier already applies", async () => {
    const flaky = { name: "INTERNAL_SERVICE_ERROR", debug_id: "unit" };
    const ref = await providerAnswering(500, flaky).createIntent(INPUT);
    expect(ref.failure?.retriable).toBe(true);
  });

  it("STILL THROWS an issue the tables do not know", async () => {
    // Unrecognised means unclassified, which most often means ours — and a
    // decline-shaped result would bury it.
    const ourBug = {
      name: "INVALID_REQUEST",
      details: [{ issue: "MALFORMED_REQUEST_JSON", description: "nope" }],
    };
    await expect(providerAnswering(400, ourBug).createIntent(INPUT)).rejects.toThrow(
      /PayPal payment intent failed/i,
    );
  });
});
