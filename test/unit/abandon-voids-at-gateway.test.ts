import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CANCEL THE DEBIT WHERE THE GATEWAY LETS US — after asking, never before.
 *
 * Releasing our hold was always local-only, so for up to 72 hours the buyer could still
 * authenticate the original and be charged on top of whatever they paid in the portal.
 * Stripe can genuinely cancel a `requires_action` PaymentIntent, which removes that risk
 * entirely; RazorPay cannot (`intentVoid: false`), and neither can Stripe inside an India
 * e-mandate's 26-hour pre-debit window, which Stripe's own docs say "can't be cancelled".
 *
 * The order is the rule: ask the gateway, and only a debit it still reports as unsettled
 * may be cancelled. A succeeded or failed debit never reaches the void at all.
 *
 * Source-level assertions: the function needs a database, an adapter and a live gateway,
 * so what is pinned here is the SHAPE that makes it safe. `verify:stale-pending` exercises
 * the behaviour against real Postgres.
 */
const SWEEP = readFileSync(
  resolve(__dirname, "../../src/modules/payments/stale-pending.ts"),
  "utf8",
);

/** The abandon function only — so a match from the automatic sweep cannot satisfy these. */
const ABANDON = (() => {
  const at = SWEEP.indexOf("export async function abandonAuthenticationPendingDebit");
  expect(at).toBeGreaterThan(-1);
  return SWEEP.slice(at);
})();

describe("abandoning cancels at the gateway, but only after asking", () => {
  it("asks before it cancels — the status read comes first", () => {
    // If the void ever moved above the read we could cancel a debit that had landed.
    const read = ABANDON.indexOf("fetchChargeStatus");
    const cancel = ABANDON.indexOf("voidIntent(");
    expect(read).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(read);
  });

  it("never reaches the void for a debit that already succeeded or failed", () => {
    // Both terminal branches return before the cancel.
    const settled = ABANDON.indexOf('return { outcome: "settled" }');
    const cancel = ABANDON.indexOf("voidIntent(");
    expect(settled).toBeGreaterThan(-1);
    expect(settled).toBeLessThan(cancel);
  });

  it("only cancels where the gateway advertises it", () => {
    // RazorPay declares intentVoid: false; guarding on the capability rather than a
    // gateway name means a fourth adapter is covered the day it arrives.
    expect(ABANDON).toContain("adapter.capabilities?.intentVoid");
  });

  it("records only an OBSERVED cancel", () => {
    // Not "we tried", not "the gateway supports it" — the warning shown to the buyer
    // depends on this being the truth.
    expect(ABANDON).toContain("voidedAtGateway = res.voided === true");
  });

  it("handles the race: authenticated between the read and the cancel", () => {
    // Stripe refuses with "not in a cancelable state". Treating that as a void would tell
    // a buyer who has just paid that nothing happened, and abandon a settled debit.
    const at = ABANDON.indexOf("voidIntent(");
    const branch = ABANDON.slice(at, at + 2600);
    expect(branch).toContain("fetchChargeStatus");
    expect(branch).toContain('recheck?.status === "succeeded"');
    expect(branch).toContain('return { outcome: "settled" }');
  });

  it("releases the invoice even when the gateway will not cancel", () => {
    // Best-effort by construction: the buyer must not stay blocked because a cancel
    // failed. The catch logs and falls through to the local release.
    const at = ABANDON.indexOf("voidIntent(");
    const branch = ABANDON.slice(at, at + 2600);
    expect(branch).toContain("afa_abandon_void_failed");
    expect(ABANDON).toContain('return { outcome: "released", voidedAtGateway }');
  });

  it("reports the result to the caller, so the warning can be conditional", () => {
    expect(ABANDON).toContain('outcome: "released"; voidedAtGateway: boolean');
  });
});
