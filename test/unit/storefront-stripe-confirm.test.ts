import { describe, expect, it } from "vitest";
// Relative, not `@/…`: the root `@/` alias points at src/.
import { confirmStripeIntent, type StripeConfirmClient } from "../../dashboard/lib/stripe-confirm";

type Err = { type?: string; code?: string; message?: string };

/** A Stripe.js stub: `confirm` answers `first`; a retrieve answers `retrieved`. */
function stub(first: { intent?: { status: string } | null; error?: Err }, retrieved?: string) {
  const setup = (status: string) => ({ status, payment_method: "pm_test_1" });
  const payment = (status: string) => ({ id: "pi_test_1", status });
  const client: StripeConfirmClient<object> = {
    confirmSetup: async () => ({
      setupIntent: first.intent ? setup(first.intent.status) : null,
      ...(first.error ? { error: first.error } : {}),
    }),
    retrieveSetupIntent: async () => ({ setupIntent: retrieved ? setup(retrieved) : null }),
    confirmPayment: async () => ({
      paymentIntent: first.intent ? payment(first.intent.status) : null,
      ...(first.error ? { error: first.error } : {}),
    }),
    retrievePaymentIntent: async () => ({ paymentIntent: retrieved ? payment(retrieved) : null }),
  };
  return client;
}

const purposes = ["setup", "payment"] as const;
/** What failed, then Stripe's words, then the next step: never Stripe's text alone. */
const failed = {
  setup: "We could not save your payment method.",
  payment: "We could not confirm your payment.",
};
const next = "Correct the details or use a different payment method. Then try again.";

describe("every Stripe confirm failure carries a message the dialog shows", () => {
  for (const purpose of purposes) {
    it(`${purpose}: a decline (card_error) is returned with Stripe's words`, async () => {
      const out = await confirmStripeIntent(
        stub({ error: { type: "card_error", message: "Your card was declined." } }),
        {},
        purpose,
        "cs",
      );
      expect(out).toEqual({
        ok: false,
        error: `${failed[purpose]} Your card was declined. ${next}`,
      });
    });
    it(`${purpose}: a field validation error is returned too, not left to the Element`, async () => {
      const out = await confirmStripeIntent(
        stub({ error: { type: "validation_error", message: "Your card number is incomplete." } }),
        {},
        purpose,
        "cs",
      );
      expect(out).toEqual({
        ok: false,
        error: `${failed[purpose]} Your card number is incomplete. ${next}`,
      });
    });
    it(`${purpose}: an api_error is returned`, async () => {
      const out = await confirmStripeIntent(
        stub({ error: { type: "api_error", message: "An unknown error occurred." } }),
        {},
        purpose,
        "cs",
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toContain("An unknown error occurred.");
    });
    it(`${purpose}: no error but no authorized intent still has a message`, async () => {
      const out = await confirmStripeIntent(
        stub({ intent: { status: "requires_payment_method" } }),
        {},
        purpose,
        "cs",
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toBe(`${failed[purpose]} ${next}`);
    });
    it(`${purpose}: an empty Stripe message falls back to ours`, async () => {
      const out = await confirmStripeIntent(
        stub({ error: { type: "card_error", message: "  " } }),
        {},
        purpose,
        "cs",
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toBe(`${failed[purpose]} ${next}`);
    });
  }

  it("a second click on a confirmed intent recovers it (not a failure)", async () => {
    const setup = await confirmStripeIntent(
      stub({ error: { code: "setup_intent_unexpected_state", message: "x" } }, "succeeded"),
      {},
      "setup",
      "cs",
    );
    expect(setup).toEqual({ ok: true, pending: false, providerToken: "pm_test_1" });
    const pay = await confirmStripeIntent(
      stub(
        { error: { code: "payment_intent_unexpected_state", message: "x" } },
        "requires_capture",
      ),
      {},
      "payment",
      "cs",
    );
    expect(pay).toEqual({ ok: true, pending: false, providerToken: "pi_test_1" });
  });

  it("a recovery that finds no confirmed intent still reports a message", async () => {
    const out = await confirmStripeIntent(
      stub({ error: { code: "payment_intent_unexpected_state", message: "x" } }, "canceled"),
      {},
      "payment",
      "cs",
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.length).toBeGreaterThan(0);
  });

  it("a bank debit in processing is pending, not a failure", async () => {
    const out = await confirmStripeIntent(
      stub({ intent: { status: "processing" } }),
      {},
      "payment",
      "cs",
    );
    expect(out).toEqual({ ok: true, pending: true, providerToken: "pi_test_1" });
  });
});
