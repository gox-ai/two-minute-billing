/**
 * Checkout.com buyer-present failures: a decline in the Flow card form, a refused card check
 * and a lapsed or cancelled payment reach the open attempt, matched on the stored intent id
 * first and on our reference after. Ids are fakes.
 */
import { describe, expect, it } from "vitest";
import {
  CHECKOUTCOM_WEBHOOK_EVENTS,
  CheckoutcomProvider,
  checkoutcomFlowIntentOf,
  normalizeCheckoutcomEvent,
} from "@/providers/checkoutcom";

const REF = "pi_XXXXXXXXXXXX01";
const map = (type: string, data: Record<string, unknown>) =>
  normalizeCheckoutcomEvent(
    { id: "evt_x", type, created_on: "2026-11-17T10:00:00Z", data },
    "evt_x",
    null,
  )[0]!;

const flowPayment = (kind: "intent" | "setup", over: Record<string, unknown> = {}) => ({
  id: "pay_XXXXXXXXXXXXXXXXXXXXXX01",
  amount: kind === "intent" ? 1500 : 0,
  currency: "USD",
  customer: { id: "cus_XXXXXXXXXXXXXXXXXXXXXX01" },
  metadata: {
    tmbilling_ref: REF,
    tmbilling_kind: kind,
    cko_payment_session_id: "ps_XXXXXXXXXXXXXXXXXXXXXX01",
  },
  ...over,
});

/** The intent id `createIntent` stores for a Flow session, from a stubbed session create. */
async function storedFlowIntentId(purpose: "payment" | "setup"): Promise<string> {
  const p = new CheckoutcomProvider({
    secretKey: "sk_sbox_unit",
    publicKey: "pk_sbox_unit",
    processingChannelId: "pc_unit",
    apiPrefix: "abcd1234",
    defaultCountry: "US",
    entityId: "ent_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    livemode: false,
    webhookSecret: "unit",
  });
  const stub = p as unknown as { call: unknown; billingCountry: unknown };
  stub.billingCountry = async () => "US";
  stub.call = async () => ({
    status: 201,
    body: { id: "ps_XXXXXXXXXXXXXXXXXXXXXX01" },
    errorCodes: [],
  });
  const ref = await p.createIntent({
    purpose,
    currency: "USD",
    amountMinor: purpose === "payment" ? 1500n : 0n,
    customer: { providerKey: "checkoutcom", providerCustomerId: "cus_XXXXXXXXXXXXXXXXXXXXXX01" },
    idempotencyKey: "pi_create_unit_a1",
    ownershipRef: REF,
    returnUrl: "https://shop.example.com/return",
    session: "on_session",
  });
  return ref.intentId;
}

describe("a decline in the Flow card form reaches the open attempt", () => {
  it("payment_declined names the stored Flow intent, our ref and the decline", async () => {
    const ev = map("payment_declined", flowPayment("intent", { response_code: "20051" }));
    expect(ev).toMatchObject({
      type: "charge.failed",
      providerChargeId: "pay_XXXXXXXXXXXXXXXXXXXXXX01",
      providerIntentId: await storedFlowIntentId("payment"),
      ownership: "ours",
      ownershipRef: REF,
      failureCode: "insufficient_funds",
      providerFailureCode: "20051",
    });
    expect(ev.lateReversal).toBeUndefined();
  });

  it("card_verification_declined on a card save names the stored setup intent", async () => {
    const ev = map("card_verification_declined", flowPayment("setup", { response_code: "20054" }));
    expect(ev).toMatchObject({
      type: "charge.failed",
      providerIntentId: await storedFlowIntentId("setup"),
      failureCode: "expired_card",
    });
  });

  it("a payment with no session falls back to the pay id (a stored-card hold)", () => {
    const ev = map("payment_declined", {
      id: "pay_XXXXXXXXXXXXXXXXXXXXXX02",
      response_code: "20051",
      metadata: { tmbilling_ref: REF, tmbilling_kind: "intent" },
    });
    expect(ev.providerIntentId).toBeUndefined();
    expect(ev.providerChargeId).toBe("pay_XXXXXXXXXXXXXXXXXXXXXX02");
  });

  it("a hosted page payment names the hosted intent", () => {
    const ev = map("payment_declined", {
      id: "pay_XXXXXXXXXXXXXXXXXXXXXX03",
      reference: `th-${REF}`,
      response_code: "20005",
      metadata: { tmbilling_ref: REF, tmbilling_kind: "intent" },
    });
    expect(ev.providerIntentId).toBe(`ckoh_th-${REF}`);
  });
});

describe("a lapsed or cancelled payment is not a decline", () => {
  it.each(["payment_expired", "payment_canceled"])(
    "%s on a Flow payment → payment_abandoned",
    (t) => {
      const ev = map(t, flowPayment("intent"));
      expect(ev).toMatchObject({
        type: "charge.failed",
        failureCode: "payment_abandoned",
        failureRetriable: true,
        ownershipRef: REF,
      });
    },
  );

  it("an expired renewal that waited for 3D Secure is authentication_required", () => {
    const ev = map("payment_expired", {
      id: "pay_XXXXXXXXXXXXXXXXXXXXXX04",
      metadata: { tmbilling_ref: "pay_XXXXXXXXXXXX01", tmbilling_kind: "charge" },
    });
    expect(ev).toMatchObject({ type: "charge.failed", failureCode: "authentication_required" });
  });

  it("a payment with no kind of ours is not acted on", () => {
    expect(map("payment_canceled", { id: "pay_XXXXXXXXXXXXXXXXXXXXXX05" }).type).toBe("unknown");
  });
});

describe("the workflow subscribes to the new events", () => {
  it.each(["card_verification_declined", "payment_expired", "payment_canceled"])("%s", (e) => {
    expect(CHECKOUTCOM_WEBHOOK_EVENTS.gateway).toContain(e);
  });

  it("no Flow id is rebuilt without a session or a ref", () => {
    expect(
      checkoutcomFlowIntentOf({ currency: "USD", metadata: { tmbilling_kind: "setup" } }),
    ).toBeUndefined();
  });
});
