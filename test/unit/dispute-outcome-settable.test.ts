import { describe, it, expect } from "vitest";
import { disputeOutcomeSettableByOperator } from "@/modules/disputes/service";

/**
 * `outcome_settable_by_operator` is what the dashboard reads to show "Mark as won / lost". It
 * must match what `recordDisputeOutcome` accepts, or the drawer offers a button the route 400s.
 */
const row = (providerKey: string, source: string, status: string) => ({
  providerKey,
  source,
  status,
});

describe("disputeOutcomeSettableByOperator", () => {
  it("is true on an open dispute of a gateway that never sends a final state", () => {
    expect(disputeOutcomeSettableByOperator(row("mollie", "gateway", "needs_response"))).toBe(true);
    expect(disputeOutcomeSettableByOperator(row("mollie", "gateway", "under_review"))).toBe(true);
  });

  it("is false on a gateway that sends the outcome", () => {
    expect(disputeOutcomeSettableByOperator(row("stripe", "gateway", "needs_response"))).toBe(
      false,
    );
    expect(disputeOutcomeSettableByOperator(row("tmtest", "gateway", "under_review"))).toBe(false);
  });

  it("is true on an open hand-recorded dispute, whatever the gateway", () => {
    expect(disputeOutcomeSettableByOperator(row("tmtest", "operator", "under_review"))).toBe(true);
  });

  it("is false once the dispute is closed", () => {
    for (const status of ["won", "lost", "closed"]) {
      expect(disputeOutcomeSettableByOperator(row("mollie", "gateway", status))).toBe(false);
      expect(disputeOutcomeSettableByOperator(row("tmtest", "operator", status))).toBe(false);
    }
  });
});
