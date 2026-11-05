import { describe, expect, it } from "vitest";
import { normalizeStripeDecline } from "@/providers/decline-codes";
import { classifyDecline } from "@/modules/subscriptions/decline-policy";
import { credentialsChanged } from "@/modules/payment-methods/credentials";

describe("network do-not-retry signals", () => {
  it("maps Stripe's stop/revocation codes to terminate and do_not_try_again to no-retry", () => {
    for (const c of ["stop_payment_order", "revocation_of_all_authorizations"])
      expect(classifyDecline(normalizeStripeDecline(c).code)).toBe("terminate");
    expect(normalizeStripeDecline("do_not_try_again").code).toBe("network_do_not_retry");
    for (const c of ["invalid_account", "restricted_card", "new_account_information_available"])
      expect(normalizeStripeDecline(c).code).toBe("card_restricted");
    for (const c of [
      "not_permitted",
      "service_not_allowed",
      "security_violation",
      "no_action_taken",
    ])
      expect(normalizeStripeDecline(c).code).toBe("card_declined");
  });

  it("treats Mastercard MAC 21 and Stripe's do_not_try_again advice like MAC 03", () => {
    for (const advice of ["03", "21", "do_not_try_again"]) {
      const n = normalizeStripeDecline({ code: "card_declined", recommendationCode: advice });
      expect(n.code, advice).toBe("network_do_not_retry");
      expect(n.retriable).toBe(false);
    }
  });

  it("a Visa Category 1 raw code stops a retriable-looking decline", () => {
    const n = normalizeStripeDecline({
      code: "card_declined",
      networkMessage: "57",
      cardBrand: "visa",
    });
    expect(n.code).toBe("network_do_not_retry");
    expect(n.retriable).toBe(false);
  });

  it("a Mastercard no-retry raw code does too", () => {
    expect(
      normalizeStripeDecline({
        code: "do_not_honor",
        networkMessage: "04",
        cardBrand: "mastercard",
      }).code,
    ).toBe("network_do_not_retry");
  });

  it("leaves retryable network codes, other brands, and already-final declines alone", () => {
    expect(
      normalizeStripeDecline({
        code: "insufficient_funds",
        networkMessage: "51",
        cardBrand: "visa",
      }).code,
    ).toBe("insufficient_funds");
    expect(
      normalizeStripeDecline({ code: "card_declined", networkMessage: "14", cardBrand: "amex" })
        .code,
    ).toBe("card_declined");
    expect(
      normalizeStripeDecline({ code: "lost_card", networkMessage: "41", cardBrand: "visa" }).code,
    ).toBe("lost_card");
    expect(
      normalizeStripeDecline({ code: "incorrect_number", networkMessage: "14", cardBrand: "visa" })
        .code,
    ).toBe("incorrect_number");
  });
});

describe("credentialsChanged", () => {
  const card = { last4: "4242", expMonth: 12, expYear: 2027 };
  it("sees a new expiry or number", () => {
    expect(credentialsChanged(card, { expYear: 2030 })).toBe(true);
    expect(credentialsChanged(card, { last4: "0005" })).toBe(true);
  });
  it("ignores an identical or silent read", () => {
    expect(credentialsChanged(card, { ...card })).toBe(false);
    expect(credentialsChanged(card, {})).toBe(false);
    expect(credentialsChanged(card, { expMonth: null })).toBe(false);
  });
});
