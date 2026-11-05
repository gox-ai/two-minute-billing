/**
 * Stripe pay-now: a buyer who picks the method in Elements can pay with a method that
 * cannot be held (a bank debit, a redirect method). Cards keep authorize-then-capture.
 *
 * Regresses if: the pay-now create goes back to manual capture for every method (bank
 * methods vanish from Elements); a server-side confirm loses manual capture; consume
 * fails on money Stripe already captured; the probe or the webhook cannot tell a capture
 * at confirm from one of ours.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  StripeProvider,
  fetchedStatusFromStripe,
  stripeCapturedOnConfirm,
  STRIPE_CAPTURE_KEY,
  STRIPE_CAPTURE_ON_CONFIRM,
  STRIPE_API_VERSION,
} from "@/providers/stripe";

type Calls = Array<{ op: string; args: unknown[] }>;

function provider(fake: unknown): StripeProvider {
  const p = new StripeProvider("sk_test_unit", "whsec_unit");
  (p as unknown as { stripe: unknown }).stripe = fake;
  return p;
}

function fakeStripe(ops: Record<string, (...args: unknown[]) => unknown>): {
  fake: unknown;
  calls: Calls;
} {
  const calls: Calls = [];
  const rec =
    (op: string) =>
    async (...args: unknown[]) => {
      calls.push({ op, args });
      const fn = ops[op];
      if (!fn) throw new Error(`fakeStripe: unexpected call to ${op}`);
      return fn(...args);
    };
  return {
    fake: {
      paymentIntents: {
        create: rec("create"),
        capture: rec("capture"),
        retrieve: rec("retrieve"),
      },
    },
    calls,
  };
}

const customer = { providerKey: "stripe" as const, providerCustomerId: "cus_1" };
const unexpectedState = () => {
  const e = new Error(
    "This PaymentIntent could not be captured because it has already been captured.",
  );
  Object.assign(e, { code: "payment_intent_unexpected_state", statusCode: 400 });
  throw e;
};
/** A PaymentIntent as `retrieve(…, { expand: ["latest_charge"] })` returns it. */
const pi = (status: string, used: string, extra: Record<string, unknown> = {}) => ({
  id: "pi_1",
  object: "payment_intent",
  status,
  amount: 5000,
  currency: "eur",
  capture_method: "automatic",
  payment_method_options: { [used]: {}, card: { capture_method: "manual" } },
  latest_charge: { id: "ch_1", payment_method_details: { type: used } },
  ...extra,
});

describe("createIntent(payment)", () => {
  it("captures at confirm when the buyer picks the method, with cards kept manual", async () => {
    const { fake, calls } = fakeStripe({
      create: () => ({ id: "pi_1", status: "requires_payment_method", client_secret: "cs" }),
    });
    await provider(fake).createIntent({
      purpose: "payment",
      amountMinor: 5000n,
      currency: "EUR",
      customer,
      idempotencyKey: "ik",
      ownershipRef: "pi_ours",
      captureOnConfirm: true,
    });
    const params = calls[0]!.args[0] as Record<string, unknown>;
    expect(params.capture_method).toBe("automatic");
    expect(params.payment_method_options).toEqual({
      card: { capture_method: "manual" },
      link: { capture_method: "manual" },
    });
    expect((params.metadata as Record<string, string>)[STRIPE_CAPTURE_KEY]).toBe(
      STRIPE_CAPTURE_ON_CONFIRM,
    );
  });

  it("keeps manual capture when the engine does not ask (no invoice yet)", async () => {
    const { fake, calls } = fakeStripe({
      create: () => ({ id: "pi_1", status: "requires_payment_method", client_secret: "cs" }),
    });
    await provider(fake).createIntent({
      purpose: "payment",
      amountMinor: 5000n,
      currency: "EUR",
      customer,
      idempotencyKey: "ik",
    });
    const params = calls[0]!.args[0] as Record<string, unknown>;
    expect(params.capture_method).toBe("manual");
    expect(params.automatic_payment_methods).toBeUndefined();
  });

  it("a server-side confirm with no return URL disallows redirect methods", async () => {
    const { fake, calls } = fakeStripe({
      create: () => ({ id: "pi_1", status: "requires_capture" }),
    });
    await provider(fake).createIntent({
      purpose: "payment",
      amountMinor: 5000n,
      currency: "EUR",
      customer,
      idempotencyKey: "ik",
      paymentMethod: { providerPaymentMethodId: "pm_1" } as never,
    });
    const params = calls[0]!.args[0] as Record<string, unknown>;
    expect(params.automatic_payment_methods).toEqual({ enabled: true, allow_redirects: "never" });
    expect(params.return_url).toBeUndefined();
  });

  it("keeps manual capture, and no marker, on a server-side confirm", async () => {
    const { fake, calls } = fakeStripe({
      create: () => ({ id: "pi_1", status: "requires_capture" }),
    });
    await provider(fake).createIntent({
      purpose: "payment",
      amountMinor: 5000n,
      currency: "EUR",
      customer,
      idempotencyKey: "ik",
      ownershipRef: "pi_ours",
      paymentMethod: { providerPaymentMethodId: "pm_1" } as never,
    });
    const params = calls[0]!.args[0] as Record<string, unknown>;
    expect(params.capture_method).toBe("manual");
    expect(params.payment_method_options).toBeUndefined();
    expect((params.metadata as Record<string, string>)[STRIPE_CAPTURE_KEY]).toBeUndefined();
  });
});

describe("consumeIntent(payment)", () => {
  it("captures a held card exactly as before, with no extra read", async () => {
    const { fake, calls } = fakeStripe({
      capture: () => ({ id: "pi_1", status: "succeeded" }),
    });
    const r = await provider(fake).consumeIntent({
      intentId: "pi_1",
      idempotencyKey: "k",
      purpose: "payment",
      amountMinor: 5000n,
    });
    expect(r.purpose === "payment" && r.charge.status).toBe("succeeded");
    expect(calls.map((c) => c.op)).toEqual(["capture"]);
  });

  it("books a bank method Stripe captured at confirm", async () => {
    const { fake, calls } = fakeStripe({
      capture: unexpectedState,
      retrieve: () => pi("succeeded", "ideal"),
    });
    const r = await provider(fake).consumeIntent({
      intentId: "pi_1",
      idempotencyKey: "k",
      purpose: "payment",
      amountMinor: 5000n,
    });
    expect(r.purpose === "payment" && r.charge).toMatchObject({
      status: "succeeded",
      providerChargeId: "pi_1",
    });
    expect(calls.map((c) => c.op)).toEqual(["capture", "retrieve"]);
    expect(calls[1]!.args[1]).toEqual({ expand: ["latest_charge"] });
  });

  it("books a debit still in flight as pending", async () => {
    const { fake } = fakeStripe({
      capture: unexpectedState,
      retrieve: () => pi("processing", "sepa_debit"),
    });
    const r = await provider(fake).consumeIntent({
      intentId: "pi_1",
      idempotencyKey: "k",
      purpose: "payment",
      amountMinor: 5000n,
    });
    expect(r.purpose === "payment" && r.charge.status).toBe("pending");
  });

  it("refuses an amount that is not the one Stripe captured", async () => {
    const { fake } = fakeStripe({
      capture: unexpectedState,
      retrieve: () => pi("succeeded", "ideal"),
    });
    await expect(
      provider(fake).consumeIntent({
        intentId: "pi_1",
        idempotencyKey: "k",
        purpose: "payment",
        amountMinor: 4000n,
      }),
    ).rejects.toThrow(/captured 5000/);
  });

  it("rethrows the refusal for a card someone else captured", async () => {
    const { fake } = fakeStripe({
      capture: unexpectedState,
      retrieve: () => pi("succeeded", "card"),
    });
    await expect(
      provider(fake).consumeIntent({ intentId: "pi_1", idempotencyKey: "k", purpose: "payment" }),
    ).rejects.toThrow(/already been captured/);
  });
});

describe("stripeCapturedOnConfirm / fetchedStatusFromStripe", () => {
  it("tells a capture at confirm from one of ours by the method the buyer used", () => {
    expect(stripeCapturedOnConfirm(pi("succeeded", "ideal") as never)).toBe(true);
    expect(stripeCapturedOnConfirm(pi("succeeded", "card") as never)).toBe(false);
    expect(stripeCapturedOnConfirm(pi("requires_capture", "card") as never)).toBe(false);
    // A legacy intent: manual at the top level, nothing per method.
    expect(
      stripeCapturedOnConfirm(
        pi("succeeded", "card", { capture_method: "manual", payment_method_options: {} }) as never,
      ),
    ).toBe(false);
  });

  it("does not guess when the method is unreadable and an override exists", () => {
    expect(
      stripeCapturedOnConfirm(pi("succeeded", "ideal", { latest_charge: "ch_1" }) as never),
    ).toBe(false);
  });

  it("maps statuses, and only a capture at confirm makes `processing` consumed", () => {
    expect(fetchedStatusFromStripe("requires_payment_method", false)).toBe("inited");
    expect(fetchedStatusFromStripe("requires_action", false)).toBe("requires_action");
    expect(fetchedStatusFromStripe("requires_capture", false)).toBe("authorized");
    expect(fetchedStatusFromStripe("succeeded", false)).toBe("consumed");
    expect(fetchedStatusFromStripe("processing", true)).toBe("consumed");
    expect(fetchedStatusFromStripe("processing", false)).toBe("unknown");
    expect(fetchedStatusFromStripe("canceled", false)).toBe("voided");
  });
});

describe("fetchIntent", () => {
  it("reports a capture at confirm", async () => {
    const { fake } = fakeStripe({ retrieve: () => pi("succeeded", "bancontact") });
    const f = await provider(fake).fetchIntent({ intentId: "pi_1", purpose: "payment" });
    expect(f).toMatchObject({
      status: "consumed",
      capturedOnConfirm: true,
      providerChargeId: "pi_1",
      amountMinor: 5000n,
      currency: "EUR",
    });
  });

  it("reports a held card as authorized", async () => {
    const { fake } = fakeStripe({ retrieve: () => pi("requires_capture", "card") });
    const f = await provider(fake).fetchIntent({ intentId: "pi_1" });
    expect(f.status).toBe("authorized");
    expect(f.capturedOnConfirm).toBeUndefined();
  });

  it("answers unknown for a missing intent or a non-PaymentIntent id", async () => {
    const { fake, calls } = fakeStripe({
      retrieve: () => {
        throw Object.assign(new Error("No such payment_intent"), { code: "resource_missing" });
      },
    });
    expect((await provider(fake).fetchIntent({ intentId: "pi_gone" })).status).toBe("unknown");
    expect((await provider(fake).fetchIntent({ intentId: "seti_1" })).status).toBe("unknown");
    expect(calls).toHaveLength(1);
  });
});

describe("normalizeWebhook — a pay-now intent captured at confirm", () => {
  const SECRET = "whsec_unit_test";
  const stripe = new StripeProvider("sk_test_unit", SECRET);
  const deliver = (type: string, object: Record<string, unknown>) => {
    const body = JSON.stringify({
      id: "evt_1",
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
  const marked = {
    object: "payment_intent",
    id: "pi_1",
    metadata: { tmbilling_ref: "pi_ours", [STRIPE_CAPTURE_KEY]: STRIPE_CAPTURE_ON_CONFIRM },
    created: 1780000000,
  };

  it("succeeded: the intent is authorized first, then the charge", async () => {
    const evs = await deliver("payment_intent.succeeded", { ...marked, status: "succeeded" });
    expect(evs.map((e) => e.type)).toEqual(["intent.authorized", "charge.succeeded"]);
    expect(evs[0]).toMatchObject({
      providerIntentId: "pi_1",
      providerChargeId: "pi_1",
      captureState: "succeeded",
      ownership: "ours",
    });
  });

  it("processing: the intent is authorized with the debit in flight", async () => {
    const evs = await deliver("payment_intent.processing", { ...marked, status: "processing" });
    expect(evs.map((e) => e.type)).toEqual(["intent.authorized"]);
    expect(evs[0]!.captureState).toBe("processing");
  });

  it("an unmarked intent (a renewal) keeps its single charge.succeeded", async () => {
    const evs = await deliver("payment_intent.succeeded", {
      ...marked,
      metadata: { tmbilling_ref: "txn_1" },
      status: "succeeded",
    });
    expect(evs.map((e) => e.type)).toEqual(["charge.succeeded"]);
    expect(evs[0]!.captureState).toBeUndefined();
  });

  it("an unmarked processing intent stays unknown", async () => {
    const evs = await deliver("payment_intent.processing", {
      ...marked,
      metadata: {},
      status: "processing",
    });
    expect(evs.map((e) => e.type)).toEqual(["unknown"]);
  });
});
