/**
 * Stripe: was money actually HELD (#30), and is this gateway object OURS (#31).
 *
 * Both defects share a shape: the adapter was answering a question it had never
 * asked the gateway, and the engine had no way to tell an unknown from a "no".
 *
 *  - #30 — `voidIntent` booked a `payment_reversal` for every void it made,
 *    including a void of an intent the buyer had abandoned before authorizing.
 *    63 of the 102 intent reversals in the dev database are that shape (measured
 *    2026-09-03): a release of money the bank never took.
 *  - #31 — a shared gateway account serves several products, so "another
 *    product's charge" and "our capture we failed to attribute" produced the
 *    SAME log line. The second could therefore never be alerted on.
 *
 * These are unit tests with an injected Stripe client rather than integration
 * tests, for the reason `mandate.test.ts` gives: the failure modes here are
 * silent, they only show up as money booked wrong weeks later, and none of them
 * needs a network to prove. The ORDERING test in particular cannot be written
 * any other way — it asserts that the adapter reads the PaymentIntent BEFORE it
 * cancels it, which is invisible to any test that only inspects the result.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  StripeProvider,
  stripeHeldFromPreCancel,
  stripeOwnershipOf,
  STRIPE_API_VERSION,
} from "@/providers/stripe";

// ── Test seam ────────────────────────────────────────────────────────────────
// `StripeProvider` builds its own `Stripe` client in the constructor (it owns the
// instrumentation that makes Stripe calls log like every other adapter), so the
// only seam is to replace that client on the instance. Stated plainly rather than
// hidden behind a helper: this bypasses `instrumentStripeClient`, which is exactly
// what a unit test wants and exactly what an integration test must not do.
type Calls = Array<{ op: string; args: unknown[] }>;

function providerWithFakeStripe(fake: unknown): StripeProvider {
  const p = new StripeProvider("sk_test_unit", "whsec_unit");
  (p as unknown as { stripe: unknown }).stripe = fake;
  return p;
}

/** A Stripe double that records the ORDER of the calls made against it. */
function fakeStripe(opts: {
  retrieveIntent?: () => Record<string, unknown>;
  cancelIntent?: () => Record<string, unknown>;
  cancelSetupIntent?: () => Record<string, unknown>;
  createIntent?: () => Record<string, unknown>;
  createSetupIntent?: () => Record<string, unknown>;
  createRefund?: () => Record<string, unknown>;
}): { fake: unknown; calls: Calls } {
  const calls: Calls = [];
  const rec =
    (op: string, fn?: () => Record<string, unknown>) =>
    async (...args: unknown[]) => {
      calls.push({ op, args });
      if (!fn) throw new Error(`fakeStripe: unexpected call to ${op}`);
      return fn();
    };
  const fake = {
    paymentIntents: {
      retrieve: rec("paymentIntents.retrieve", opts.retrieveIntent),
      cancel: rec("paymentIntents.cancel", opts.cancelIntent),
      create: rec("paymentIntents.create", opts.createIntent),
    },
    setupIntents: {
      cancel: rec("setupIntents.cancel", opts.cancelSetupIntent),
      create: rec("setupIntents.create", opts.createSetupIntent),
    },
    refunds: { create: rec("refunds.create", opts.createRefund) },
  };
  return { fake, calls };
}

// ── #30: the `held` discriminator ────────────────────────────────────────────

describe("#30 — held: the pre-cancel PaymentIntent status is the only thing that answers it", () => {
  it("requires_capture is a real hold", () => {
    expect(stripeHeldFromPreCancel("requires_capture", 2000)).toBe(true);
  });

  it("a positive amount_capturable is a real hold even on a status we do not recognise", () => {
    // Belt and braces: Stripe's docs make `amount_capturable` the money-side fact
    // ("the remaining amount_capturable is automatically refunded"), so a future
    // status name must not be able to hide a hold.
    expect(stripeHeldFromPreCancel("some_status_this_sdk_has_never_seen", 2000)).toBe(true);
  });

  it("requires_action / requires_payment_method / requires_confirmation hold nothing", () => {
    // This is defect #21's whole population: an abandoned checkout. Booking a
    // payment_reversal for one of these invents a release the bank never made.
    expect(stripeHeldFromPreCancel("requires_action", 0)).toBe(false);
    expect(stripeHeldFromPreCancel("requires_payment_method", 0)).toBe(false);
    expect(stripeHeldFromPreCancel("requires_confirmation", 0)).toBe(false);
  });

  it("processing and canceled answer undefined, NOT false", () => {
    // `processing` is an async rail with money in flight — we genuinely cannot say.
    // `canceled` means someone got there first, so the pre-cancel state is gone.
    // `undefined` keeps the caller's previous behaviour; `false` would silently
    // stop booking reversals that are real.
    expect(stripeHeldFromPreCancel("processing", 0)).toBeUndefined();
    expect(stripeHeldFromPreCancel("canceled", 0)).toBeUndefined();
  });

  it("an unrecognised status with nothing capturable answers undefined, not false", () => {
    expect(stripeHeldFromPreCancel("some_status_this_sdk_has_never_seen", 0)).toBeUndefined();
  });
});

describe("#30 — voidIntent reads the intent BEFORE cancelling it", () => {
  it("reports held:true for a hold, and retrieves before it cancels", async () => {
    // The load-bearing assertion of this whole file. Stripe's cancel RESPONSE is
    // the POST-cancel object: their own reference example shows
    // `"status": "canceled", "amount_capturable": 0`. So reading the answer off the
    // cancel result reads the answer to our own call and can only ever say "nothing
    // was held" — which is defect #21 restated, not fixed.
    const { fake, calls } = fakeStripe({
      retrieveIntent: () => ({
        id: "pi_held",
        status: "requires_capture",
        amount_capturable: 2000,
      }),
      cancelIntent: () => ({ id: "pi_held", status: "canceled", amount_capturable: 0 }),
    });
    const res = await providerWithFakeStripe(fake).voidIntent({
      intentId: "pi_held",
      idempotencyKey: "void_1",
    });
    expect(res).toMatchObject({ voided: true, providerTransactionId: "pi_held", held: true });
    expect(calls.map((c) => c.op)).toEqual(["paymentIntents.retrieve", "paymentIntents.cancel"]);
  });

  it("reports held:false for an abandoned checkout", async () => {
    const { fake } = fakeStripe({
      retrieveIntent: () => ({
        id: "pi_abandoned",
        status: "requires_payment_method",
        amount_capturable: 0,
      }),
      cancelIntent: () => ({ id: "pi_abandoned", status: "canceled", amount_capturable: 0 }),
    });
    const res = await providerWithFakeStripe(fake).voidIntent({
      intentId: "pi_abandoned",
      idempotencyKey: "void_2",
    });
    expect(res.voided).toBe(true);
    expect(res.held).toBe(false);
  });

  it("a SetupIntent void is held:false with certainty — a SetupIntent has no amount", async () => {
    const { fake, calls } = fakeStripe({
      cancelSetupIntent: () => ({ id: "seti_1", status: "canceled" }),
    });
    const res = await providerWithFakeStripe(fake).voidIntent({
      intentId: "seti_1",
      idempotencyKey: "void_3",
    });
    expect(res.held).toBe(false);
    // And it costs no extra round-trip: there is nothing to read.
    expect(calls.map((c) => c.op)).toEqual(["setupIntents.cancel"]);
  });

  it("a failed pre-read leaves held undefined and still cancels", async () => {
    // The retrieve is diagnostic, not permission. If it fails we must not refuse to
    // release a hold — we just cannot describe it.
    const calls: Calls = [];
    const fake = {
      paymentIntents: {
        retrieve: async () => {
          calls.push({ op: "paymentIntents.retrieve", args: [] });
          throw new Error("network");
        },
        cancel: async () => {
          calls.push({ op: "paymentIntents.cancel", args: [] });
          return { id: "pi_x", status: "canceled" };
        },
      },
    };
    const res = await providerWithFakeStripe(fake).voidIntent({
      intentId: "pi_x",
      idempotencyKey: "void_4",
    });
    expect(res.voided).toBe(true);
    expect(res.held).toBeUndefined();
    expect(calls.map((c) => c.op)).toEqual(["paymentIntents.retrieve", "paymentIntents.cancel"]);
  });
});

// ── #31: outbound tagging ────────────────────────────────────────────────────

describe("#31 — every money object we create carries metadata.tmbilling_ref", () => {
  const customer = { providerKey: "stripe" as const, providerCustomerId: "cus_1" };

  /**
   * `return_url` is only legal on a create that CONFIRMS.
   *
   * Stripe: *"The parameter `return_url` cannot be passed when creating a PaymentIntent
   * unless `confirm` is set to true."* Observed on the portal's "Pay now" button
   * 2026-09-05 — the create 400'd outright, so the button did nothing at all rather than
   * degrading. The gate used to be `input.returnUrl` alone, which reads as harmless
   * forwarding but is wrong precisely on the unconfirmed branch: there is no confirm to
   * redirect from, and the buyer completes in-page (`redirect: 'if_required'`).
   *
   * Asserted from both sides, because a one-sided version would pass if the parameter
   * were simply deleted — and the confirming branch genuinely needs it for 3DS.
   */
  it("omits return_url when it does NOT confirm — Stripe rejects the combination", async () => {
    const { fake, calls } = fakeStripe({
      createIntent: () => ({ id: "pi_nc", status: "requires_payment_method" }),
    });
    await providerWithFakeStripe(fake).createIntent({
      purpose: "payment",
      amountMinor: 1_773_611n,
      currency: "INR",
      customer,
      idempotencyKey: "ik_noconfirm",
      returnUrl: "https://portal.example.com/portal",
      // NO paymentMethod → the adapter does not confirm → the buyer picks a card in
      // Elements and confirms client-side.
    });
    const params = calls[0]!.args[0] as Record<string, unknown>;
    expect(params.confirm, "must not confirm without an instrument").toBeUndefined();
    expect(params.return_url, "return_url must be absent on an unconfirmed create").toBeUndefined();
  });

  it("…and KEEPS return_url when it does confirm, which is when 3DS needs it", async () => {
    const { fake, calls } = fakeStripe({
      createIntent: () => ({ id: "pi_c", status: "requires_capture" }),
    });
    await providerWithFakeStripe(fake).createIntent({
      purpose: "payment",
      amountMinor: 1_773_611n,
      currency: "INR",
      customer,
      idempotencyKey: "ik_confirm",
      returnUrl: "https://portal.example.com/portal",
      paymentMethod: { providerPaymentMethodId: "pm_x" } as never,
    });
    const params = calls[0]!.args[0] as Record<string, unknown>;
    expect(params.confirm).toBe(true);
    expect(params.return_url).toBe("https://portal.example.com/portal");
  });

  it("createIntent(payment) stamps the ownershipRef the engine supplied", async () => {
    const { fake, calls } = fakeStripe({
      createIntent: () => ({ id: "pi_1", status: "requires_capture" }),
    });
    await providerWithFakeStripe(fake).createIntent({
      purpose: "payment",
      amountMinor: 2000n,
      currency: "INR",
      customer,
      idempotencyKey: "ik_1",
      ownershipRef: "pi_ours_abc",
    });
    const params = calls[0]!.args[0] as { metadata?: Record<string, string> };
    expect(params.metadata?.tmbilling_ref).toBe("pi_ours_abc");
  });

  it("createIntent(payment) preserves caller metadata alongside the ref", async () => {
    const { fake, calls } = fakeStripe({
      createIntent: () => ({ id: "pi_2", status: "requires_capture" }),
    });
    await providerWithFakeStripe(fake).createIntent({
      purpose: "payment",
      amountMinor: 2000n,
      currency: "INR",
      customer,
      idempotencyKey: "ik_2",
      ownershipRef: "pi_ours_def",
      metadata: { invoice: "inv_9" },
    });
    const params = calls[0]!.args[0] as { metadata?: Record<string, string> };
    expect(params.metadata).toMatchObject({ invoice: "inv_9", tmbilling_ref: "pi_ours_def" });
  });

  it("createIntent(setup) stamps the ref on the SetupIntent too", async () => {
    const { fake, calls } = fakeStripe({
      createSetupIntent: () => ({ id: "seti_2", client_secret: "seti_2_secret_x" }),
    });
    await providerWithFakeStripe(fake).createIntent({
      purpose: "setup",
      currency: "INR",
      customer,
      idempotencyKey: "ik_3",
      ownershipRef: "seti_ours_ghi",
    });
    const params = calls[0]!.args[0] as { metadata?: Record<string, string> };
    expect(params.metadata?.tmbilling_ref).toBe("seti_ours_ghi");
  });

  it("charge() — the off-session renewal path — is tagged, with no ownershipRef on its input", async () => {
    // `ChargeInput` carries no `ownershipRef` (checked against providers/types.ts
    // 2026-09-04), and this is the path EVERY renewal takes. Leaving it untagged
    // would make our own renewals read `foreign` on the inbound side — the exact
    // false negative #31 exists to remove. The idempotency key is the only id of
    // ours the input carries, and the contract already calls it "1:1 with a
    // tmbilling payment attempt".
    const { fake, calls } = fakeStripe({
      createIntent: () => ({ id: "pi_3", status: "succeeded" }),
    });
    await providerWithFakeStripe(fake).charge({
      amountMinor: 2000n,
      currency: "INR",
      customer,
      paymentMethod: {
        providerKey: "stripe",
        providerPaymentMethodId: "pm_1",
        display: { type: "card" },
      },
      idempotencyKey: "sub_sub_1_first_charge_pm_1",
    });
    const params = calls[0]!.args[0] as { metadata?: Record<string, string> };
    expect(params.metadata?.tmbilling_ref).toBe("sub_sub_1_first_charge_pm_1");
  });

  it("refund() is tagged, so a refund.failed webhook can be attributed", async () => {
    const { fake, calls } = fakeStripe({
      createRefund: () => ({ id: "re_1", status: "succeeded" }),
    });
    await providerWithFakeStripe(fake).refund({
      providerChargeId: "pi_3",
      idempotencyKey: "precharge_refund_pi_3",
    });
    const params = calls[0]!.args[0] as { metadata?: Record<string, string> };
    expect(params.metadata?.tmbilling_ref).toBe("precharge_refund_pi_3");
  });
});

// ── #31: inbound classification ──────────────────────────────────────────────

describe("#31 — stripeOwnershipOf is a three-way answer, and unknown is first-class", () => {
  it("reads our ref off the object", () => {
    expect(
      stripeOwnershipOf({
        object: "charge",
        metadata: { tmbilling_ref: "pay_1" },
        created: 1780000000,
      }),
    ).toMatchObject({ ownership: "ours", ownershipRef: "pay_1" });
  });

  it("calls a tagged KIND with empty metadata foreign", () => {
    const r = stripeOwnershipOf({ object: "charge", metadata: {}, created: 1780000000 });
    expect(r.ownership).toBe("foreign");
    expect(r.ownershipRef).toBeUndefined();
  });

  it("an object kind we do NOT tag is unknown, never foreign", () => {
    // A PaymentMethod confirmed through Elements is created by STRIPE, not by us,
    // so there is no create call to stamp — calling its detach `foreign` would be
    // a lie about our own instrument.
    expect(
      stripeOwnershipOf({ object: "payment_method", metadata: {}, created: 1780000000 }).ownership,
    ).toBe("unknown");
  });

  it("an object with no metadata field at all is unknown", () => {
    // Stripe Mandates carry no metadata. Silence is not a "no".
    expect(stripeOwnershipOf({ object: "mandate", created: 1780000000 }).ownership).toBe("unknown");
  });

  it("converts Stripe's `created` from SECONDS to a Date", () => {
    const r = stripeOwnershipOf({ object: "charge", metadata: {}, created: 1780000000 });
    expect(r.providerObjectCreatedAt?.getTime()).toBe(1_780_000_000_000);
  });

  it("omits providerObjectCreatedAt when the object has no `created`", () => {
    expect(stripeOwnershipOf({ object: "mandate" }).providerObjectCreatedAt).toBeUndefined();
  });
});

describe("#31 — normalizeWebhook carries ownership through every event shape", () => {
  const SECRET = "whsec_unit_test";
  const stripe = new StripeProvider("sk_test_unit", SECRET);
  // Stripe's scheme: `t=<unix seconds>,v1=<hex hmac-sha256 of "t.payload">`, and
  // constructEvent enforces a 5-minute tolerance on `t` — so it must be NOW.
  const deliver = (type: string, object: Record<string, unknown>, eventCreated = 1790000000) => {
    const body = JSON.stringify({
      id: `evt_${type}`,
      object: "event",
      api_version: STRIPE_API_VERSION,
      created: eventCreated,
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

  it("charge.succeeded from our own charge is `ours`", async () => {
    const [ev] = await deliver("charge.succeeded", {
      object: "charge",
      id: "ch_1",
      payment_intent: "pi_1",
      metadata: { tmbilling_ref: "sub_x_first_charge_pm_1" },
      created: 1780000000,
    });
    expect(ev?.ownership).toBe("ours");
    expect(ev?.ownershipRef).toBe("sub_x_first_charge_pm_1");
  });

  it("charge.succeeded for a sibling product on the same account is `foreign`", async () => {
    const [ev] = await deliver("charge.succeeded", {
      object: "charge",
      id: "ch_2",
      payment_intent: "pi_2",
      metadata: {},
      created: 1780000000,
    });
    expect(ev?.ownership).toBe("foreign");
  });

  it("reports the OBJECT's created, not the event's", async () => {
    // The whole reason `providerObjectCreatedAt` exists: a capture that fires today
    // can belong to an intent created weeks before tagging shipped, and reading the
    // event time would mark that historical object foreign on no evidence at all.
    const [ev] = await deliver(
      "charge.succeeded",
      { object: "charge", id: "ch_3", payment_intent: "pi_3", metadata: {}, created: 1700000000 },
      1790000000,
    );
    expect(ev?.providerObjectCreatedAt?.getTime()).toBe(1_700_000_000_000);
    expect(ev?.occurredAt.getTime()).toBe(1_790_000_000_000);
  });

  it("carries ownership on the intent-lifecycle branch", async () => {
    const [ev] = await deliver("payment_intent.amount_capturable_updated", {
      object: "payment_intent",
      id: "pi_4",
      metadata: { tmbilling_ref: "pi_ours_4" },
      created: 1780000001,
    });
    expect(ev?.type).toBe("intent.authorized");
    expect(ev?.ownership).toBe("ours");
    expect(ev?.providerObjectCreatedAt?.getTime()).toBe(1_780_000_001_000);
  });

  it("carries ownership on the dispute branch", async () => {
    const [ev] = await deliver("charge.dispute.created", {
      object: "dispute",
      id: "dp_1",
      payment_intent: "pi_5",
      metadata: { tmbilling_ref: "pay_5" },
      created: 1780000002,
    });
    expect(ev?.type).toBe("dispute.created");
    expect(ev?.ownership).toBe("ours");
  });

  it("carries ownership on the refund-failed branch", async () => {
    const [ev] = await deliver("refund.failed", {
      object: "refund",
      id: "re_2",
      payment_intent: "pi_6",
      status: "failed",
      metadata: { tmbilling_ref: "precharge_refund_pi_6" },
      created: 1780000003,
    });
    expect(ev?.type).toBe("refund.failed");
    expect(ev?.ownership).toBe("ours");
    expect(ev?.ownershipRef).toBe("precharge_refund_pi_6");
  });

  it("carries ownership on the payout branch", async () => {
    const [ev] = await deliver("payout.paid", {
      object: "payout",
      id: "po_1",
      amount: 100,
      currency: "inr",
      metadata: {},
      created: 1780000004,
    });
    expect(ev?.type).toBe("settlement.processed");
    // A payout is Stripe's own object, never one we create — so `unknown`, and
    // certainly not `foreign`: nothing about a remittance is another product's.
    expect(ev?.ownership).toBe("unknown");
  });

  it("carries ownership on the mandate branch, where there is no metadata to read", async () => {
    const [ev] = await deliver("mandate.updated", {
      object: "mandate",
      id: "mandate_1",
      status: "active",
      payment_method: "pm_9",
      type: "multi_use",
    });
    expect(ev?.type).toBe("payment_method.mandate_updated");
    expect(ev?.ownership).toBe("unknown");
  });

  it("carries ownership on the charge.expired branch", async () => {
    const [ev] = await deliver("charge.expired", {
      object: "charge",
      id: "ch_9",
      payment_intent: "pi_9",
      metadata: { tmbilling_ref: "pi_ours_9" },
      created: 1780000005,
    });
    expect(ev?.type).toBe("intent.voided");
    expect(ev?.ownership).toBe("ours");
  });

  it("carries ownership on the requires_action branch", async () => {
    const [ev] = await deliver("payment_intent.requires_action", {
      object: "payment_intent",
      id: "pi_10",
      next_action: { type: "redirect_to_url" },
      metadata: { tmbilling_ref: "pi_ours_10" },
      created: 1780000006,
    });
    expect(ev?.type).toBe("intent.requires_action");
    expect(ev?.ownership).toBe("ours");
  });

  it("carries ownership on the card-updater branch", async () => {
    const [ev] = await deliver("payment_method.automatically_updated", {
      object: "payment_method",
      id: "pm_11",
      card: { brand: "visa", last4: "4242" },
      metadata: {},
      created: 1780000007,
    });
    expect(ev?.type).toBe("payment_method.updated");
    expect(ev?.ownership).toBe("unknown");
  });

  it("carries ownership on the fraud-warning branch", async () => {
    const [ev] = await deliver("radar.early_fraud_warning.created", {
      object: "radar.early_fraud_warning",
      id: "issfr_1",
      charge: "ch_12",
      created: 1780000008,
    });
    expect(ev?.type).toBe("fraud_warning.created");
    expect(ev?.ownership).toBe("unknown");
  });

  it("carries ownership on charge.refunded", async () => {
    const [ev] = await deliver("charge.refunded", {
      object: "charge",
      id: "ch_13",
      payment_intent: "pi_13",
      amount_refunded: 500,
      refunds: { data: [{ id: "re_13" }] },
      metadata: { tmbilling_ref: "pay_13" },
      created: 1780000009,
    });
    expect(ev?.type).toBe("charge.refunded");
    expect(ev?.ownership).toBe("ours");
  });
});
