/**
 * #63's OTHER HALF — `createIntent` must BOOK a rejected attempt, not throw it.
 *
 * Production, 2026-09-06 14:34 IST: a dashboard Collect now on invoice 65978 failed with
 * Stripe's `payment_intent_payment_attempt_failed` ("The parameter `mandate` is not
 * provided or invalid"). `charge()` had been taught to book that outcome two days earlier;
 * `createIntent` still rethrew it, so nothing was recorded — no intent, no attempt
 * (`payment_attempts.payment_intent_id` is NOT NULL, so the attempt had nowhere to live),
 * no transaction. The failure existed only in `gateway_request_logs`, and the Stripe
 * PaymentIntent it left behind tripped `orphaned_gateway_intents` on every retry.
 */
import { describe, it, expect } from "vitest";
import Stripe from "stripe";
import { StripeProvider } from "@/providers/stripe";

function providerThatFailsWith(err: unknown): StripeProvider {
  const p = new StripeProvider("sk_test_unit", "whsec_unit");
  (p as unknown as { stripe: unknown }).stripe = {
    paymentIntents: {
      create: () => {
        throw err;
      },
    },
  };
  return p;
}

const INPUT = {
  purpose: "payment" as const,
  currency: "INR",
  amountMinor: 5_241_464n,
  customer: { providerKey: "stripe" as const, providerCustomerId: "cus_unit" },
  idempotencyKey: "pi_create_unit_a1",
  session: "off_session" as const,
};

/** Stripe's SDK error, carrying the PaymentIntent it created before the attempt failed. */
function attemptFailed(): Stripe.errors.StripeInvalidRequestError {
  return new Stripe.errors.StripeInvalidRequestError({
    type: "invalid_request_error",
    code: "payment_intent_payment_attempt_failed",
    message: "The payment failed: The parameter `mandate` is not provided or invalid.",
    // The object Stripe leaves behind — the orphan the sweep later finds.
    payment_intent: { id: "pi_unit_orphan", status: "requires_payment_method" },
  } as never);
}

/** The renewal shape: an off-session debit against a vaulted card. */
const CHARGE_INPUT = {
  currency: "INR",
  amountMinor: 5_241_464n,
  customer: { providerKey: "stripe" as const, providerCustomerId: "cus_unit" },
  paymentMethod: {
    providerKey: "stripe" as const,
    providerPaymentMethodId: "pm_unit",
    display: { type: "card" as const },
  },
  idempotencyKey: "chg_unit_a1",
};

describe("stripe charge: the refused request keeps the intent Stripe kept", () => {
  /**
   * The THIRD place this same failure had to be taught, found from production on
   * 2026-09-07: an orphan created at 00:00:03 — the billing clock, not a human — that no
   * transaction could be tied to. #63 taught `charge()` to BOOK the refusal, and it did;
   * it just booked `providerChargeId: ""` while `err.payment_intent.id` sat unread beside
   * it. That id becomes `transactions.id_at_gateway`, so without it the renewal's failure
   * and the object armed at Stripe were two facts with nothing joining them, and
   * `orphaned_gateway_intents` was the only surface naming the intent at all.
   *
   * The card-decline branch two lines away had always read it. This one had not.
   */
  it("carries the stranded PaymentIntent id as the charge id", async () => {
    const res = await providerThatFailsWith(attemptFailed()).charge(CHARGE_INPUT);
    expect(res.status).toBe("failed");
    expect(res.providerChargeId).toBe("pi_unit_orphan");
    expect(res.failure?.code).toBe("mandate_missing");
  });

  it("keeps the GENERIC code for a rejection that is not about a mandate", async () => {
    // The classifier reads prose, so it has to stay narrow: every other inline-confirm
    // failure shares the same Stripe code and must not be relabelled as a missing mandate,
    // or `collectInvoice` would stamp an instrument that is perfectly well authorised.
    const other = new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      code: "payment_intent_payment_attempt_failed",
      message: "The payment failed: the payment method type is not activated.",
      payment_intent: { id: "pi_unit_other", status: "requires_payment_method" },
    } as never);
    const res = await providerThatFailsWith(other).charge(CHARGE_INPUT);
    expect(res.failure?.code).toBe("gateway_request_rejected");
    expect(res.providerChargeId).toBe("pi_unit_other");
  });

  it("still answers with an empty id when Stripe kept nothing", async () => {
    // No `payment_intent` on the error — there is genuinely no object to name, and
    // inventing one would be worse than admitting none.
    const bare = new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      code: "payment_intent_payment_attempt_failed",
      message: "The payment failed.",
    } as never);
    const res = await providerThatFailsWith(bare).charge(CHARGE_INPUT);
    expect(res.providerChargeId).toBe("");
    expect(res.failure?.code).toBe("gateway_request_rejected");
  });
});

describe("stripe createIntent: an attempt that failed at the API is still an attempt", () => {
  it("BOOKS payment_intent_payment_attempt_failed instead of throwing", async () => {
    const ref = await providerThatFailsWith(attemptFailed()).createIntent(INPUT);
    // `mandate_missing`, not the generic code: this fixture's message IS Stripe's
    // missing-mandate prose, and the adapter now names that failure specifically because
    // its remedy is specific (the customer must authorise again) and the collection path
    // records the answer so the next debit never reaches the gateway.
    expect(ref.failure?.code).toBe("mandate_missing");
    // Non-retriable on purpose: re-presenting an identical malformed request cannot
    // succeed, so dunning must surface it rather than hammer it.
    expect(ref.failure?.retriable).toBe(false);
    expect(ref.failure?.message).toContain("mandate");
  });

  it("reports the intent Stripe actually left behind, never a state we invented", async () => {
    const ref = await providerThatFailsWith(attemptFailed()).createIntent(INPUT);
    // `requires_payment_method` ⇒ `inited`, the same mapping the card-error branch uses.
    expect(ref.intentId).toBe("pi_unit_orphan");
    expect(ref.status).toBe("inited");
  });

  it("STILL THROWS every other invalid_request_error", async () => {
    // Deliberately narrow: those are our bugs, and a decline-shaped result would bury
    // them — which is exactly what happened to the missing `mandate` while this path
    // was silent.
    const other = new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      code: "parameter_unknown",
      message: "Received unknown parameter: nope",
    } as never);
    await expect(providerThatFailsWith(other).createIntent(INPUT)).rejects.toThrow(
      /unknown parameter/i,
    );
  });
});
