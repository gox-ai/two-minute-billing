import { describe, expect, it } from "vitest";
import { normalizeRazorpayDecline } from "@/providers/decline-codes";
import { classifyDecline, retryNotBefore } from "@/modules/subscriptions/decline-policy";
import { isHardDecline } from "@/modules/invoicing/collection";
import { planFailureRearm } from "@/modules/subscriptions/dunning-schedule";

/**
 * WHEN THE NETWORK NAMES A WAIT, THE SCHEDULE HONOURS IT.
 *
 * RazorPay's e-mandate error page (captured 2026-09-10 as
 * `docs/references/RAZORPAY_EMANDATE_ERROR_CODES.md`): `already_declined` — "NPCI blocks
 * retry attempts to avoid duplicate requests", recommended action "Retry after 24 hours".
 * Unmapped it took the liberal `retry` default and re-presented on the merchant's own
 * schedule, whose first offset is often the next midnight — inside a window the network
 * had already closed, so the attempt was spent on a guaranteed refusal.
 */
const H = 60 * 60 * 1000;
const NOW = new Date("2026-09-10T00:00:00Z");
const BASE = {
  autoCollectOn: true,
  retriable: true,
  retryDays: [1, 3, 5, 7],
  now: NOW,
  mode: "smart" as const,
  skipRetriesForHardFailures: false,
  dunningApplies: true,
  periodEndsAt: new Date("2026-10-10T00:00:00Z"),
  dueDate: NOW,
  mandateRail: "card",
  newAttemptCount: 1,
  dunningStatus: "in_progress",
  currentNextAttemptAt: null,
};

describe("already_declined carries the bank's own 24-hour wait", () => {
  it("normalises through the shape the adapter actually passes", () => {
    // `declineFailure` hands `normalizeRazorpayDecline` a plain string — `error.reason ??
    // error.code` — so a rule keyed on `code` is what fires. Asserting the STRING form is
    // the point: a rule matched only by an object shape that never arrives is a dead rule.
    const n = normalizeRazorpayDecline("already_declined");
    expect(n.code).toBe("retry_too_soon");
    expect(n.ruleId).toBe("razorpay.code.already_declined");
    // Timing, not the instrument: it must stay retriable and must not brand the card.
    expect(n.retriable).toBe(true);
    expect(classifyDecline(n.code)).toBe("retry");
    expect(
      isHardDecline({ status: "failed", failure: { code: n.code, retriable: n.retriable } }),
    ).toBe(false);
  });

  it("pushes a retry that would land inside the closed window out to its end", () => {
    const p = planFailureRearm({ ...BASE, declineCode: "retry_too_soon" });
    expect(p.action).toBe("retry");
    expect((p as { nextAttempt: Date }).nextAttempt).toEqual(retryNotBefore("retry_too_soon", NOW));
    expect((p as { nextAttempt: Date }).nextAttempt.getTime()).toBe(NOW.getTime() + 24 * H);
  });

  it("leaves a retry that is ALREADY past the window exactly where the merchant put it", () => {
    // Only ever later, never earlier. The merchant's schedule still owns the timing
    // whenever it does not conflict with what the network said.
    const late = planFailureRearm({
      ...BASE,
      declineCode: "retry_too_soon",
      retryDays: [3, 5, 7],
    });
    const plain = planFailureRearm({
      ...BASE,
      declineCode: "insufficient_funds",
      retryDays: [3, 5, 7],
    });
    expect(late).toEqual(plain);
  });

  it("does not touch a code the network said nothing about", () => {
    expect(retryNotBefore("insufficient_funds", NOW)).toBeNull();
    expect(retryNotBefore(null, NOW)).toBeNull();
    expect(planFailureRearm({ ...BASE, declineCode: "insufficient_funds" })).toEqual(
      planFailureRearm({ ...BASE, declineCode: undefined }),
    );
  });

  it("never converts a retry into an exhaustion", () => {
    // The floor moves an attempt; only `scheduleTail` ends dunning, and it still decides
    // that against the business's dunning period. A period ending sooner than the floor
    // keeps its "one last attempt on the deadline" — deliberately, because losing the
    // final attempt entirely is worse than one that the window may still refuse.
    const p = planFailureRearm({
      ...BASE,
      declineCode: "retry_too_soon",
      periodEndsAt: new Date(NOW.getTime() + 2 * H),
    });
    expect(p).toEqual({ action: "retry", nextAttempt: new Date(NOW.getTime() + 2 * H) });
  });
});
