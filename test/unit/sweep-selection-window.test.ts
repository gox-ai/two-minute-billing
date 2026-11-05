import { describe, expect, it } from "vitest";
import { SWEEP_SELECTION_GRACE_HOURS, RAIL_GRACE_HOURS } from "@/modules/payments/stale-pending";

/**
 * THE SWEEP MUST SELECT A ROW BEFORE ITS OWN WINDOW CLOSES.
 *
 * `stale-pending` picks candidates on one age floor, then drops those not yet due for
 * their own rail. Selection is the irreversible half: a row the query never returned
 * cannot be rescued by any later `continue`.
 *
 * Production 2026-09-12, INV-100002: a RazorPay CARD
 * debit sitting at "Amount yet to be authenticated by the bank". Its effective grace was 15 minutes
 * while the selection floor was `min(72, 72, …rails)` = 24 HOURS, because one of the
 * windows was left out of that Math.min. The feature it starved has since been removed
 * for unrelated reasons, but the trap is a property of this query and outlives it.
 */
describe("the selection floor bounds every effective grace", () => {
  it("is no larger than ANY rail's grace", () => {
    // Asserted against the table rather than a number, so adding a shorter-lived rail
    // fails here instead of silently starving it. A row must be SELECTED before its own
    // window closes: selection is the irreversible half, since a row the query never
    // returned cannot be rescued by the per-rail `continue` that follows.
    for (const [rail, hours] of Object.entries(RAIL_GRACE_HOURS))
      expect(SWEEP_SELECTION_GRACE_HOURS, rail).toBeLessThanOrEqual(hours);
  });

  it("equals the shortest window in the table", () => {
    // Not tautological: it is the min of the rails PLUS the default and abandon clocks,
    // so this pins that none of those has slipped below a rail without being included.
    expect(SWEEP_SELECTION_GRACE_HOURS).toBe(Math.min(...Object.values(RAIL_GRACE_HOURS)));
  });

  it("is positive — a zero floor would select every in-flight row on every sweep", () => {
    expect(SWEEP_SELECTION_GRACE_HOURS).toBeGreaterThan(0);
  });
});
