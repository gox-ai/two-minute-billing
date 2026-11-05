import { describe, it, expect } from "vitest";
import { RAIL_TTL_HOURS, DEFAULT_RAIL_TTL_HOURS } from "@/modules/payment-intents/ttl";

/**
 * An intent TTL says "is this authorization still live". Ours must never be the SHORTER
 * clock — expiring something the gateway still considers live turns a customer doing
 * everything right into a dead intent, and on this rail there is no event to tell anyone.
 */
describe("bank-debit intent TTLs outlive the rail's own verification", () => {
  /** Stripe: microdeposits land in 2–3 BUSINESS days; the customer gets 10 days to verify. */
  const ACH_VERIFICATION_DAYS = 10;

  it("ACH outlives microdeposit verification, which the 72h default did not", () => {
    // A setup started on a Thursday has its deposits arrive the following week. At 72
    // hours the intent was voided on Sunday — before there was anything to verify, and
    // with no signal at all, because Stripe sends NOTHING when microdeposits land.
    expect(RAIL_TTL_HOURS.us_bank_account).toBeGreaterThanOrEqual(ACH_VERIFICATION_DAYS * 24);
    expect(RAIL_TTL_HOURS.us_bank_account).toBeGreaterThan(DEFAULT_RAIL_TTL_HOURS);
  });

  it("both new rails are characterised, so neither falls to the default", () => {
    // Falling through is the bug this file exists for: `us_bank_account` was absent and
    // inherited 72h silently. Absence is not a neutral state here.
    expect(RAIL_TTL_HOURS.us_bank_account).toBeDefined();
    expect(RAIL_TTL_HOURS.sepa_debit).toBeDefined();
  });

  it("SEPA is deliberately shorter than ACH — its mandate is accepted inline", () => {
    // No out-of-band verification to wait for, so it carries the same 7 days as the other
    // bank-debit rails rather than ACH's microdeposit allowance.
    expect(RAIL_TTL_HOURS.sepa_debit).toBeLessThan(RAIL_TTL_HOURS.us_bank_account!);
    expect(RAIL_TTL_HOURS.sepa_debit).toBeGreaterThan(DEFAULT_RAIL_TTL_HOURS);
  });
});
