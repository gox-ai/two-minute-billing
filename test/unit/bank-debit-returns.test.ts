import { describe, it, expect } from "vitest";
import { normalizeStripeDecline } from "@/providers/decline-codes";
import { PARK, TERMINATE } from "@/modules/subscriptions/decline-policy";

/**
 * A direct debit does not decline at the till — it is RETURNED, up to five business days
 * later, with a code saying the account is closed, absent or wrong. Before the ACH/SEPA
 * rails shipped there was nothing to classify, so every one of these fell to the liberal
 * retry default: a dunning ladder against an account that cannot pay, at a gateway failure
 * fee per attempt.
 */
describe("ACH/SEPA returns are terminal and park", () => {
  const cases: Array<[string, string]> = [
    ["account_closed", "bank_account_closed"],
    ["account_frozen", "bank_account_closed"],
    ["no_account", "bank_account_not_found"],
    ["invalid_account_number", "bank_account_invalid_details"],
  ];

  for (const [stripeCode, token] of cases) {
    it(`${stripeCode} → ${token}, never retried, parks rather than cancels`, () => {
      const v = normalizeStripeDecline(stripeCode);
      expect(v.code).toBe(token);
      // Terminal: no retry can reach an account that is gone.
      expect(v.retriable).toBe(false);
      // …but PARKED, not terminated. A new instrument recovers it, so the subscription
      // must survive. Terminal WITHOUT this exhausts dunning on the first attempt in
      // fixed mode — the silent-revenue-loss shape `mandate_expired` documents.
      expect(PARK.has(token)).toBe(true);
      expect(TERMINATE.has(token)).toBe(false);
    });
  }

  it("debit_not_authorized TERMINATES — a retry is a second unauthorised debit", () => {
    const v = normalizeStripeDecline("debit_not_authorized");
    expect(v.code).toBe("debit_not_authorized");
    expect(v.retriable).toBe(false);
    // On SEPA the payer has 13 months to dispute an unauthorised debit; charging again
    // is how one dispute becomes two.
    expect(TERMINATE.has("debit_not_authorized")).toBe(true);
  });

  it("insufficient_funds stays RETRYABLE — the account exists and can be funded", () => {
    // The one bank-debit failure that is genuinely transient. Classifying it with the
    // others would abandon a payer who is merely short today.
    const v = normalizeStripeDecline("insufficient_funds");
    expect(v.retriable).toBe(true);
    expect(TERMINATE.has(v.code)).toBe(false);
  });
});
