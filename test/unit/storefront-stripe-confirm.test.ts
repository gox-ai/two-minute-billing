import { describe, expect, it } from "vitest";
// Relative, not `@/…`: the root `@/` alias points at src/.
import { confirmStripeIntent, type StripeConfirmClient } from "../../dashboard/lib/stripe-confirm";

type Err = { type?: string; code?: string; decline_code?: string; message?: string };

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
    it(`${purpose}: a decline reads as our sentence for its code, never Stripe's words`, async () => {
      const out = await confirmStripeIntent(
        stub({
          error: {
            type: "card_error",
            code: "card_declined",
            decline_code: "insufficient_funds",
            message: "Your card has insufficient funds.",
          },
        }),
        {},
        purpose,
        "cs",
      );
      expect(out).toEqual({
        ok: false,
        error: `${failed[purpose]} Your bank declined the payment because the account does not have sufficient money. Add money to the account, or use a different payment method.`,
      });
    });
    it(`${purpose}: a failed 3DS check asks for the bank's check again`, async () => {
      const out = await confirmStripeIntent(
        stub({
          error: {
            type: "invalid_request_error",
            code: `${purpose === "setup" ? "setup" : "payment"}_intent_authentication_failure`,
            message:
              "We are unable to authenticate your payment method. Please choose a different payment method and try again.",
          },
        }),
        {},
        purpose,
        "cs",
      );
      expect(out).toEqual({
        ok: false,
        error: `${failed[purpose]} Your bank must confirm this payment. Try again, and complete the check from your bank.`,
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
    it(`${purpose}: an error with no known code still has a message, not Stripe's`, async () => {
      const out = await confirmStripeIntent(
        stub({ error: { type: "api_error", message: "An unknown error occurred." } }),
        {},
        purpose,
        "cs",
      );
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.startsWith(failed[purpose])).toBe(true);
        expect(out.error).not.toContain("An unknown error occurred.");
      }
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

describe("a setup that also charges leads with the payment", () => {
  it("a decline at checkout's Subscribe and pay says the payment failed, not the save", async () => {
    const out = await confirmStripeIntent(
      stub({
        error: { type: "card_error", code: "card_declined", message: "Your card was declined." },
      }),
      {},
      "setup",
      "cs",
      undefined,
      "We could not take your payment.",
    );
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error.startsWith("We could not take your payment. ")).toBe(true);
  });
});
