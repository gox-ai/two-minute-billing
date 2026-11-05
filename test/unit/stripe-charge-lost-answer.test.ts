import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { StripeProvider, isLostStripeAnswer } from "@/providers/stripe";
import { ProviderIndeterminateError, strandedObjectId, type ChargeInput } from "@/providers/types";

// A charge whose answer is lost must be pending, never a retriable failure: the next
// attempt uses a new key and would charge the payer twice.

function providerThrowing(err: unknown) {
  const p = new StripeProvider("sk_test_unit", "whsec_unit");
  (p as unknown as { stripe: unknown }).stripe = {
    paymentIntents: {
      create: async () => {
        throw err;
      },
    },
  };
  return p;
}

const input = {
  amountMinor: 1500n,
  currency: "USD",
  customer: { providerCustomerId: "cus_XXXXXXXXXXXX01" },
  paymentMethod: { providerPaymentMethodId: "pm_XXXXXXXXXXXX01" },
  idempotencyKey: "inv_test_attempt_1_pm_test",
  ownershipRef: "inv_test",
  description: "Subscription charge",
} as unknown as ChargeInput;

type RawError = ConstructorParameters<typeof Stripe.errors.StripeError>[0];
const raw = (type: string, statusCode?: number, pi?: string): RawError =>
  ({
    type,
    message: `${type} test`,
    ...(statusCode ? { statusCode } : {}),
    ...(pi ? { payment_intent: { id: pi } } : {}),
  }) as unknown as RawError;

describe("Stripe charge: a lost answer is indeterminate", () => {
  const lost: [string, unknown][] = [
    ["connection error", new Stripe.errors.StripeConnectionError(raw("api_connection_error"))],
    ["5xx api error", new Stripe.errors.StripeAPIError(raw("api_error", 500))],
    ["429 rate limit", new Stripe.errors.StripeRateLimitError(raw("rate_limit_error", 429))],
    ["409 idempotency", new Stripe.errors.StripeIdempotencyError(raw("idempotency_error", 409))],
  ];

  for (const [name, err] of lost) {
    it(`${name} → ProviderIndeterminateError`, async () => {
      expect(isLostStripeAnswer(err)).toBe(true);
      await expect(providerThrowing(err).charge(input)).rejects.toBeInstanceOf(
        ProviderIndeterminateError,
      );
    });
  }

  it("keeps the PaymentIntent Stripe kept, so the sweep can read it", async () => {
    const err = new Stripe.errors.StripeAPIError(raw("api_error", 502, "pi_XXXXXXXXXXXX01"));
    const thrown = await providerThrowing(err)
      .charge(input)
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ProviderIndeterminateError);
    expect(strandedObjectId(thrown)).toBe("pi_XXXXXXXXXXXX01");
  });

  it("a refusal (400) and an auth error stay what they were", () => {
    expect(
      isLostStripeAnswer(
        new Stripe.errors.StripeInvalidRequestError(raw("invalid_request_error", 400)),
      ),
    ).toBe(false);
    expect(
      isLostStripeAnswer(
        new Stripe.errors.StripeAuthenticationError(raw("authentication_error", 401)),
      ),
    ).toBe(false);
    expect(isLostStripeAnswer(new Error("our bug"))).toBe(false);
  });
});
