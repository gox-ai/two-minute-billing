/**
 * #33 / #34 / #35 — the event types each adapter DROPS.
 *
 * Every adapter's `normalizeWebhook` holds a local `const map`, and an event absent
 * from it normalizes to `unknown`. The row is still persisted (`handleProviderEvent`
 * inserts before it dispatches), so nothing is literally lost — but an `unknown` row
 * carries no name, reaches no handler and is invisible to anyone filtering the
 * Gateway Webhooks inspector by type. For money moving AGAINST us that is the same
 * outcome as no record at all.
 *
 * These cases drive the REAL adapters through their REAL signature verification, with
 * payload shapes taken from `docs/references/{STRIPE,RAZORPAY}_WEBHOOK.md`. A
 * hand-written normalizer could agree with a bug; the signed path cannot pass on a
 * payload production would have rejected.
 *
 * ⚠️ PayPal is deliberately absent: `src/providers/paypal.ts` is owned by another
 * session in this wave. Its map entries and the two branches it needs are handed back
 * in the report rather than applied here.
 *
 * Mutation targets are marked ⚠️ — reverting the named change must turn THAT case red
 * while its siblings stay green.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { StripeProvider, STRIPE_API_VERSION } from "@/providers/stripe";
import { RazorpayProvider } from "@/providers/razorpay";

// ── Stripe ───────────────────────────────────────────────────────────────────

const STRIPE_SECRET = "whsec_unit_test";
const stripe = new StripeProvider("sk_test_unit", STRIPE_SECRET);

/** Stripe's scheme: `t=<unix seconds>,v1=<hex hmac of "t.payload">`, 5-minute tolerance. */
const stripeDeliver = (
  type: string,
  object: Record<string, unknown>,
  eventCreated = 1790000000,
) => {
  const body = JSON.stringify({
    id: `evt_${type}`,
    object: "event",
    api_version: STRIPE_API_VERSION,
    created: eventCreated,
    type,
    data: { object },
  });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", STRIPE_SECRET).update(`${t}.${body}`).digest("hex");
  return stripe.normalizeWebhook({
    payload: body,
    headers: { "stripe-signature": `t=${t},v1=${v1}` },
  });
};

describe("#35 tier 2 — Stripe charge states we never learn", () => {
  it("charge.pending is money in flight, and says so instead of `unknown`", async () => {
    // ⚠️ MUTATION TARGET: remove `"charge.pending": "charge.pending"` from the map.
    // A delayed rail (ACH, a bank debit) creates a PENDING charge; the only other
    // notice is the synchronous call, and a webhook-first flow has none.
    const [ev] = await stripeDeliver("charge.pending", {
      object: "charge",
      id: "ch_pending_1",
      payment_intent: "pi_pending_1",
      metadata: { tmbilling_ref: "collect_invoice_INV-9" },
      created: 1780000000,
    });
    expect(ev?.type).toBe("charge.pending");
    // Correlated on the intent id, which is what `transactions.id_at_gateway` holds.
    expect(ev?.providerChargeId).toBe("pi_pending_1");
    expect(ev?.ownership).toBe("ours");
  });

  it("charge.pending is NOT charge.succeeded — nothing has settled", async () => {
    // ⚠️ MUTATION TARGET: map `charge.pending` to `charge.succeeded`. That would send
    // it to `reconcileChargeSucceeded`, which settles the transaction and its invoice
    // for money the bank has not moved — the same class of bug as RazorPay's
    // `payment.authorized` once being `charge.succeeded`.
    const [ev] = await stripeDeliver("charge.pending", {
      object: "charge",
      id: "ch_pending_2",
      payment_intent: "pi_pending_2",
      created: 1780000000,
    });
    expect(ev?.type).not.toBe("charge.succeeded");
  });

  it("charge.updated is named rather than dropped — 4,830 delivered and unmapped", async () => {
    // ⚠️ MUTATION TARGET: remove `"charge.updated": "charge.updated"`.
    // Stripe: "Occurs whenever a charge description or metadata is updated, or upon an
    // asynchronous capture." The second half is a money event, and the object carries
    // `balance_transaction` — the handle #18's fee hangs off.
    const [ev] = await stripeDeliver("charge.updated", {
      object: "charge",
      id: "ch_upd_1",
      payment_intent: "pi_upd_1",
      balance_transaction: "txn_1",
      created: 1780000000,
    });
    expect(ev?.type).toBe("charge.updated");
    expect(ev?.providerChargeId).toBe("pi_upd_1");
  });

  it("charge.updated must never be a settlement term", async () => {
    // ⚠️ MUTATION TARGET: map it to `charge.succeeded`. It fires on a bare METADATA
    // edit, so that would settle a transaction because somebody retitled a charge in
    // the Stripe dashboard.
    const [ev] = await stripeDeliver("charge.updated", {
      object: "charge",
      id: "ch_upd_2",
      payment_intent: "pi_upd_2",
      created: 1780000000,
    });
    expect(["charge.succeeded", "charge.failed", "charge.refunded"]).not.toContain(ev?.type);
  });

  it("refund.created — a refund raised by a human in the Stripe dashboard", async () => {
    // ⚠️ MUTATION TARGET: remove `"refund.created": "refund.pending"`.
    // Stripe's own `charge.refunded` doc says "Listen to `refund.created` for
    // information about the refund". Until it processes we hear nothing at all.
    const [ev] = await stripeDeliver("refund.created", {
      object: "refund",
      id: "re_1",
      payment_intent: "pi_ref_1",
      charge: "ch_ref_1",
      amount: 2500,
      status: "pending",
      created: 1780000000,
    });
    expect(ev?.type).toBe("refund.pending");
    expect(ev?.providerRefundId).toBe("re_1");
    // For the inspector's Transaction column; the engine correlates refunds on the
    // refund id, never on this.
    expect(ev?.providerChargeId).toBe("pi_ref_1");
    expect(ev?.amountRefundedMinor).toBe(2500n);
  });

  it("refund.created that has not landed must not be charge.refunded", async () => {
    // ⚠️ MUTATION TARGET: book every `refund.created`. A refund that then failed would
    // leave a booking for money that never left.
    const [ev] = await stripeDeliver("refund.created", {
      object: "refund",
      id: "re_2",
      payment_intent: "pi_ref_2",
      amount: 100,
      status: "pending",
      created: 1780000000,
    });
    expect(ev?.type).not.toBe("charge.refunded");
  });

  it("refund.updated: succeeded books by refund id, a routine update is discarded", async () => {
    // A succeeded Refund is the version-independent signal that the money left; the
    // engine books it per refund id, so the `charge.refunded` for it cannot double it.
    const [landed] = await stripeDeliver("refund.updated", {
      object: "refund",
      id: "re_3",
      payment_intent: "pi_ref_3",
      amount: 700,
      status: "succeeded",
      created: 1780000000,
    });
    expect(landed?.type).toBe("charge.refunded");
    expect(landed?.refunds).toEqual([
      { providerRefundId: "re_3", amountMinor: 700n, status: "succeeded" },
    ]);
    const [routine] = await stripeDeliver("refund.updated", {
      object: "refund",
      id: "re_3b",
      payment_intent: "pi_ref_3",
      amount: 700,
      status: "pending",
      created: 1780000000,
    });
    expect(routine?.type).toBe("unknown");
  });

  it("refund.failed still reaches the reversal path", async () => {
    // Regression guard: the shared refund branch must keep answering for the event
    // that reverses a booked refund.
    const [ev] = await stripeDeliver("refund.failed", {
      object: "refund",
      id: "re_4",
      payment_intent: "pi_ref_4",
      status: "failed",
      failure_reason: "expired_or_canceled_card",
      created: 1780000000,
    });
    expect(ev?.type).toBe("refund.failed");
    expect(ev?.providerRefundId).toBe("re_4");
    expect(ev?.providerFailureCode).toBe("expired_or_canceled_card");
  });
});

describe("#35 tier 1 — Stripe is withholding OUR funds", () => {
  it("reserve.hold.created is named, with the amount withheld", async () => {
    // ⚠️ MUTATION TARGET: remove the `reserve.hold.*` map entries. A reserve hold
    // changes what actually settles into the bank and nothing here read it.
    const [ev] = await stripeDeliver("reserve.hold.created", {
      object: "reserve.hold",
      id: "rsvh_1",
      amount: 500000,
      currency: "usd",
      status: "active",
      created: 1780000000,
    });
    expect(ev?.type).toBe("reserve.hold.updated");
    expect(ev?.settlementId).toBe("rsvh_1");
    expect(ev?.settlementAmountMinor).toBe(500000n);
    expect(ev?.settlementCurrency).toBe("USD");
  });

  it("reserve.hold.updated shares the term — one hold, many transitions", async () => {
    const [ev] = await stripeDeliver("reserve.hold.updated", {
      object: "reserve.hold",
      id: "rsvh_2",
      amount: 250000,
      currency: "usd",
      status: "released",
      created: 1780000000,
    });
    expect(ev?.type).toBe("reserve.hold.updated");
    expect(ev?.settlementStatus).toBe("released");
  });

  it("a reserve-hold id is NEVER reported as a charge id", async () => {
    // ⚠️ MUTATION TARGET: delete the `reserve.hold.updated` branch and let it fall
    // through to the generic charge return. That return sets
    // `providerChargeId: obj.payment_intent ?? obj.id`, so a `rsvh_…` would be
    // handed to `resolveTransactionByCharge` and the inspector would link the hold to
    // whatever transaction happened to share the id space.
    const [ev] = await stripeDeliver("reserve.hold.created", {
      object: "reserve.hold",
      id: "rsvh_3",
      amount: 100,
      currency: "usd",
      created: 1780000000,
    });
    expect(ev?.providerChargeId).toBeUndefined();
  });
});

describe("#35 tier 3 — Stripe instruments dying under us", () => {
  it("payment_method.detached carries the payment-method id", async () => {
    // ⚠️ MUTATION TARGET: delete the `payment_method.detached` branch.
    //
    // PRE-EXISTING DEFECT, found writing this file: `payment_method.detached` was in
    // the map but had NO branch, so it fell through to the generic charge return —
    // which sets `providerChargeId` and never `providerPaymentMethodId`. The inbound
    // dispatcher guards on `ev.type === "payment_method.detached" &&
    // ev.providerPaymentMethodId`, so every Stripe detach has been landing `ignored`
    // and no instrument was ever marked invalid from one.
    const [ev] = await stripeDeliver("payment_method.detached", {
      object: "payment_method",
      id: "pm_det_1",
      created: 1780000000,
    });
    expect(ev?.type).toBe("payment_method.detached");
    expect(ev?.providerPaymentMethodId).toBe("pm_det_1");
    // And it is not a charge, so it must not claim to be one.
    expect(ev?.providerChargeId).toBeUndefined();
  });

  it("customer.source.deleted is a detach on the legacy Card/Source rail", async () => {
    // ⚠️ MUTATION TARGET: remove `"customer.source.deleted": "payment_method.detached"`.
    // 515 `customer.source.created` have arrived on this account, so these objects
    // exist here; a deleted one is an instrument we would keep charging.
    const [ev] = await stripeDeliver("customer.source.deleted", {
      object: "card",
      id: "card_del_1",
      customer: "cus_1",
      created: 1780000000,
    });
    expect(ev?.type).toBe("payment_method.detached");
    expect(ev?.providerPaymentMethodId).toBe("card_del_1");
  });

  it("payment_method.attached stays UNMAPPED, deliberately", async () => {
    // Not an oversight — a decision, pinned so nobody "fixes" it.
    //
    // The only existing kind it could route to is `payment_method.updated`, whose
    // handler marks the instrument `valid` again ("a reissued card supersedes an
    // expiring one"). An attach event for a method we had already marked `invalid`
    // after a hard decline would therefore resurrect it into collection on no
    // evidence that it works. A wrong state is worse than an unnamed row.
    const [ev] = await stripeDeliver("payment_method.attached", {
      object: "payment_method",
      id: "pm_att_1",
      customer: "cus_2",
      created: 1780000000,
    });
    expect(ev?.type).toBe("unknown");
  });
});

// ── RazorPay ─────────────────────────────────────────────────────────────────

const RZP_SECRET = "test-webhook-secret";
const razorpay = () =>
  new RazorpayProvider({
    keyId: "rzp_test_x",
    keySecret: "secret",
    apiBase: "https://api.razorpay.test/v1",
    webhookSecret: RZP_SECRET,
  });

const rzpDeliver = (event: Record<string, unknown>) => {
  const body = JSON.stringify(event);
  return razorpay().normalizeWebhook({
    payload: body,
    headers: {
      "x-razorpay-signature": createHmac("sha256", RZP_SECRET).update(body).digest("hex"),
    },
  });
};

const EPOCH_SEC = 1786681800;

describe("#35 tier 2 — RazorPay refund.created", () => {
  it("a refund raised in RazorPay's dashboard is visible at BIRTH, not at processed", async () => {
    // ⚠️ MUTATION TARGET: remove `"refund.created": "refund.pending"`.
    // ⚠️ REGISTRATION: this name is mapped but NOT yet subscribed — RazorPay validates
    // its event list as a whole, so it goes in only once the probe has cleared it
    // individually. Mapping an event the account does not deliver is harmless (the
    // same standing decision as `token.resumed`).
    const [ev] = await rzpDeliver({
      id: "evt_rc_1",
      event: "refund.created",
      created_at: EPOCH_SEC,
      payload: {
        refund: {
          entity: {
            id: "rfnd_1",
            payment_id: "pay_1",
            amount: 22184,
            status: "created",
            created_at: EPOCH_SEC,
          },
        },
        payment: { entity: { id: "pay_1", order_id: "order_1", created_at: EPOCH_SEC } },
      },
    });
    expect(ev?.type).toBe("refund.pending");
    expect(ev?.providerRefundId).toBe("rfnd_1");
    expect(ev?.providerChargeId).toBe("pay_1");
    expect(ev?.amountRefundedMinor).toBe(22184n);
  });

  it("refund.created must not be charge.refunded — nothing has left yet", async () => {
    // ⚠️ MUTATION TARGET: map it to `charge.refunded`. `refund.processed` already
    // books the refund, so this would double-book it AND book it before RazorPay had
    // issued anything.
    const [ev] = await rzpDeliver({
      id: "evt_rc_2",
      event: "refund.created",
      created_at: EPOCH_SEC,
      payload: { refund: { entity: { id: "rfnd_2", payment_id: "pay_2", amount: 100 } } },
    });
    expect(ev?.type).not.toBe("charge.refunded");
  });

  it("refund.failed still correlates on the REFUND id", async () => {
    // Regression guard: `refund.pending` shares that branch, and the branch is what
    // makes `reverseFailedRefund` reachable at all (it returns early without a
    // `providerRefundId`).
    const [ev] = await rzpDeliver({
      id: "evt_rf_1",
      event: "refund.failed",
      created_at: EPOCH_SEC,
      payload: {
        refund: {
          entity: {
            id: "rfnd_3",
            payment_id: "pay_3",
            amount: 500,
            status: "failed",
            error_reason: "refund_failed_at_bank",
          },
        },
      },
    });
    expect(ev?.type).toBe("refund.failed");
    expect(ev?.providerRefundId).toBe("rfnd_3");
    expect(ev?.providerFailureCode).toBe("refund_failed_at_bank");
  });
});
