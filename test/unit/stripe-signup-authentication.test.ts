/**
 * A signup charge on a card whose issuer demands 3DS on every payment.
 *
 * `charge()` confirms off-session, so Stripe refuses with `authentication_required`. When the
 * buyer is on the page (`initiator.by: customer`) that refusal must come back as
 * `requires_action`, so the engine opens the on-session challenge, and the refused intent is
 * cancelled. Every other caller (renewals, dunning) keeps the plain decline.
 */
import { describe, it, expect } from "vitest";
import Stripe from "stripe";
import { StripeProvider } from "@/providers/stripe";
import type { ChargeInput } from "@/providers/types";

function harness(err: unknown, cancel: (id: string) => unknown = () => ({})) {
  const created: Record<string, unknown>[] = [];
  const cancelled: string[] = [];
  const p = new StripeProvider("sk_test_unit", "whsec_unit");
  (p as unknown as { stripe: unknown }).stripe = {
    paymentIntents: {
      create: (params: Record<string, unknown>) => {
        created.push(params);
        throw err;
      },
      cancel: (id: string) => {
        cancelled.push(id);
        return cancel(id);
      },
    },
  };
  return { p, created, cancelled };
}

function cardError(code: string): Stripe.errors.StripeCardError {
  return new Stripe.errors.StripeCardError({
    type: "card_error",
    code,
    decline_code: code,
    message: "This payment requires authentication.",
    payment_intent: { id: "pi_unit_refused", status: "requires_payment_method" },
  } as never);
}

const INPUT: ChargeInput = {
  currency: "USD",
  amountMinor: 2900n,
  customer: { providerKey: "stripe", providerCustomerId: "cus_unit" },
  paymentMethod: {
    providerKey: "stripe",
    providerPaymentMethodId: "pm_unit",
    display: { type: "card" },
  },
  idempotencyKey: "sub_unit_first_charge_pm_unit",
  mandateReference: "mandate_unit",
};

describe("stripe charge: authentication_required with the buyer present", () => {
  it("returns requires_action and cancels the refused intent", async () => {
    const h = harness(cardError("authentication_required"));
    const res = await h.p.charge({ ...INPUT, initiator: { by: "customer", recurring: true } });
    expect(res.status).toBe("requires_action");
    expect(res.providerChargeId).toBe("pi_unit_refused");
    expect(res.nextAction?.data.approvalRequired).toBe(true);
    expect(h.cancelled).toEqual(["pi_unit_refused"]);
  });

  it("still confirms off-session with the mandate, so a 3DS-at-setup card is not asked twice", async () => {
    const h = harness(cardError("authentication_required"));
    await h.p.charge({ ...INPUT, initiator: { by: "customer", recurring: true } });
    expect(h.created[0]).toMatchObject({
      off_session: true,
      confirm: true,
      mandate: "mandate_unit",
    });
  });

  it("asks the buyer even when the cancel fails", async () => {
    const h = harness(cardError("authentication_required"), () => {
      throw new Error("network");
    });
    const res = await h.p.charge({ ...INPUT, initiator: { by: "customer", recurring: true } });
    expect(res.status).toBe("requires_action");
  });

  it("keeps a renewal's decline: by merchant", async () => {
    const h = harness(cardError("authentication_required"));
    const res = await h.p.charge({ ...INPUT, initiator: { by: "merchant", recurring: true } });
    expect(res.status).toBe("failed");
    expect(res.failure?.code).toBe("authentication_required");
    expect(h.cancelled).toEqual([]);
  });

  it("keeps the decline when the initiator is unknown", async () => {
    const h = harness(cardError("authentication_required"));
    const res = await h.p.charge(INPUT);
    expect(res.status).toBe("failed");
    expect(h.cancelled).toEqual([]);
  });

  it("keeps any other decline with the buyer present", async () => {
    const h = harness(cardError("insufficient_funds"));
    const res = await h.p.charge({ ...INPUT, initiator: { by: "customer", recurring: true } });
    expect(res.status).toBe("failed");
    expect(h.cancelled).toEqual([]);
  });
});
