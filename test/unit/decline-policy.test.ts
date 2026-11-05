import { describe, it, expect } from "vitest";
import {
  classifyDecline,
  PARK,
  PARK_EVEN_IN_FIXED_MODE,
  MERCHANT_SIDE_PARK,
  RETRY_THEN_PARK,
} from "@/modules/subscriptions/decline-policy";
import {
  resolveDunningConfig,
  dunningAppliesTo,
  parkedDunningDeadline,
  DUNNING_RETRY_DAYS,
  PARKED_GRACE_DAYS,
} from "@/modules/subscriptions/dunning-schedule";

/**
 * Decision (the user, 2026-09-04): EVERY park gets a dunning deadline. The allowlist
 * this block used to assert against — `PARKED_WITH_DEADLINE` — is gone, because an
 * allowlist is the wrong shape: it reached 4 of `PARK`'s 13 codes and `expired_card`
 * was not one of them, so the textbook dunning case parked forever. What survives from
 * the 2026-09-01 decision is the deadline MATH (the grace fallback, the explicit-period
 * override, the dunning switch), which is unchanged and still asserted below.
 */
describe("mandate refusals get a dunning deadline (2026-09-01 decision)", () => {
  const MANDATE_CODES = ["mandate_expired", "mandate_ceiling_exceeded", "mandate_spent"] as const;

  it.each(MANDATE_CODES)("%s still PARKS — never retries, never terminates", (code) => {
    expect(classifyDecline(code)).toBe("park");
  });

  it.each(MANDATE_CODES)(
    "%s still parks even in FIXED mode (unchanged by this decision)",
    (code) => {
      expect(PARK_EVEN_IN_FIXED_MODE.has(code)).toBe(true);
    },
  );

  /**
   * ⚠️ A SHAPE guard, not the behaviour proof. `parkedDunningDeadline` never consulted
   * the decline code — the removed allowlist gated the CALL, inside
   * `sweepExpiredParkedDunning` — so this loop would have passed before 2026-09-04 too.
   * It only holds `PARK`'s membership still and asserts the math is code-agnostic.
   * The assertion that actually observes a park exhausting is DB-backed and lives in
   * `scripts/verify-dunning-smart.ts`; that is the one to watch go red.
   */
  it("the deadline math is code-agnostic across every park code", () => {
    expect(PARK.size).toBeGreaterThanOrEqual(13); // vacuity guard
    const cfg = resolveDunningConfig(null);
    const anchor = new Date("2026-09-01T00:00:00Z");
    for (const code of PARK) {
      expect(classifyDecline(code)).toBe("park");
      expect(parkedDunningDeadline(cfg, anchor).getTime()).toBeGreaterThan(anchor.getTime());
    }
  });

  it("the previously-exempt card declines are the regression this closes", () => {
    // Each of these parked FOREVER before 2026-09-04. `expired_card` is the one that
    // makes the bug obvious: an expired card is what dunning is FOR.
    for (const code of ["expired_card", "incorrect_cvc"]) {
      expect(PARK.has(code)).toBe(true);
    }
  });

  it("generic refusals retry first instead of parking on the first decline", () => {
    for (const code of RETRY_THEN_PARK) {
      expect(PARK.has(code)).toBe(false);
      expect(classifyDecline(code)).toBe("retry");
    }
    expect([...RETRY_THEN_PARK].sort()).toEqual(["card_declined", "do_not_honor"]);
  });

  it("MERCHANT-side parks now get a deadline too — the guard is an ALERT, not an exemption", () => {
    // The user's 2026-09-04 call: our own gateway misconfiguration must not buy an
    // invoice immortality. What protects the blameless payer is that a merchant-side
    // park raises an ops alert long before the window shuts.
    for (const code of MERCHANT_SIDE_PARK) expect(PARK.has(code)).toBe(true);
    expect(MERCHANT_SIDE_PARK.has("recurring_not_enabled")).toBe(true);
    expect(MERCHANT_SIDE_PARK.has("gateway_limit_exceeded")).toBe(true);
    // Rail-side, not ours to fix and not the payer's to clear — deliberately excluded,
    // so the alert keeps meaning "someone must go and change our configuration".
    expect(MERCHANT_SIDE_PARK.has("mandate_cycle_limit_exceeded")).toBe(false);
    expect(PARK.has("mandate_cycle_limit_exceeded")).toBe(true);
  });

  it.each(MANDATE_CODES)(
    "%s: a business with NO dunning_period_days configured still gets a real deadline " +
      "(the null-period fallback, PARKED_GRACE_DAYS — same as afa_not_completed)",
    (code) => {
      // `code` itself does not flow into `parkedDunningDeadline` — the function is
      // decline-code-agnostic, and since 2026-09-04 nothing gates the call either.
      // This traces the SAME codepath `sweepExpiredParkedDunning` takes once parked.
      expect(classifyDecline(code)).toBe("park");
      const cfg = resolveDunningConfig(null); // enabled: true, dunningPeriodDays: null (default)
      expect(cfg.enabled).toBe(true);
      expect(cfg.dunningPeriodDays).toBeNull();
      const dueDate = new Date("2026-09-01T00:00:00Z");
      const deadline = parkedDunningDeadline(cfg, dueDate);
      // NOT a no-op: `parkedDunningDeadline` never returns null. With no configured
      // period it falls back to `PARKED_GRACE_DAYS`, so a deadline with no period does
      // not become "cancel now" and does not become "never" either.
      const expected = new Date(dueDate);
      expected.setUTCDate(expected.getUTCDate() + PARKED_GRACE_DAYS);
      expect(deadline.getTime()).toBe(expected.getTime());
      expect(deadline.getTime()).toBeGreaterThan(dueDate.getTime());
    },
  );

  /**
   * The regression guard for the 2026-09-01 correction. The fallback USED to be the
   * retry schedule's last offset — day 7 of [1,3,5,7] — which gave a customer one week
   * to complete a bank-side re-authorisation before their subscription was cancelled,
   * on every business that has never opened the Dunning settings form. The two clocks
   * measure different things (four failed charge attempts vs zero), so this asserts
   * they are not the same number rather than just asserting the new one.
   */
  it("the parked fallback is NOT the retry schedule's tail", () => {
    const cfg = resolveDunningConfig(null);
    const retryTail = DUNNING_RETRY_DAYS[DUNNING_RETRY_DAYS.length - 1]!;
    expect(PARKED_GRACE_DAYS).not.toBe(retryTail);
    expect(PARKED_GRACE_DAYS).toBeGreaterThan(retryTail);
    const anchor = new Date("2026-09-01T00:00:00Z");
    const tail = new Date(anchor);
    tail.setUTCDate(tail.getUTCDate() + retryTail);
    expect(parkedDunningDeadline(cfg, anchor).getTime()).toBeGreaterThan(tail.getTime());
  });

  /**
   * An explicit period still wins in BOTH directions — including one SHORTER than the
   * grace default. It is the merchant's own answer to how long an unpaid invoice stays
   * open, and a park sits inside that window rather than beside it.
   */
  it("an explicit dunning_period_days overrides the grace default, both ways", () => {
    const anchor = new Date("2026-09-01T00:00:00Z");
    const at = (days: number) => {
      const d = new Date(anchor);
      d.setUTCDate(d.getUTCDate() + days);
      return d.getTime();
    };
    const short = resolveDunningConfig({ dunningConfig: { dunning_period_days: 3 } });
    expect(short.dunningPeriodDays).toBe(3);
    expect(parkedDunningDeadline(short, anchor).getTime()).toBe(at(3));
    const long = resolveDunningConfig({ dunningConfig: { dunning_period_days: 90 } });
    expect(parkedDunningDeadline(long, anchor).getTime()).toBe(at(90));
  });

  it("the true no-op is the business's dunning switch, not the period", () => {
    // `sweepExpiredParkedDunning` gates on `dunningAppliesTo` BEFORE ever calling
    // `parkedDunningDeadline` — a business with dunning switched off must never get a
    // cancellation through this side door, for any of the three new codes, regardless of
    // `dunningPeriodDays`.
    const off = resolveDunningConfig({ dunningConfig: { enabled: false } });
    expect(off.dunningPeriodDays).toBeNull();
    expect(dunningAppliesTo(off, { hasSubscription: true, subscriptionStatus: "active" })).toBe(
      false,
    );
    // Enabled, still no period configured: applies (the real no-op path is `enabled`,
    // not `dunningPeriodDays`).
    const on = resolveDunningConfig(null);
    expect(dunningAppliesTo(on, { hasSubscription: true, subscriptionStatus: "active" })).toBe(
      true,
    );
  });
});
