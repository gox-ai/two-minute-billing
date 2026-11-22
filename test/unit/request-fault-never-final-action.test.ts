import { describe, expect, it } from "vitest";
import { planFailureRearm } from "@/modules/subscriptions/dunning-schedule";
import { ALL_DECLINE_RULES, isOurRequestFault } from "@/providers/decline-codes";
import { parkedOnOurRequest } from "@/modules/invoicing/request-fault-park";

// A customer is never cancelled over our own setup: a refused request of ours parks for ops.
describe("our refused request never ends in a final action", () => {
  const base = {
    dunningStatus: "in_progress",
    currentNextAttemptAt: null,
    autoCollectOn: true,
    retriable: true,
    retryDays: [1, 3, 5],
    now: new Date("2026-08-06T00:00:00Z"),
    dueDate: new Date("2026-08-01T00:00:00Z"),
    declineCode: "gateway_request_rejected",
  };

  it.each(["fixed", "smart"] as const)("%s mode: retries while the schedule lasts", (mode) => {
    expect(planFailureRearm({ ...base, mode, newAttemptCount: 1, requestFault: true }).action).toBe(
      "retry",
    );
  });

  it.each(["fixed", "smart"] as const)("%s mode: parks where it would exhaust", (mode) => {
    const spent = { ...base, mode, newAttemptCount: 4 };
    expect(planFailureRearm(spent).action).toBe("exhausted");
    expect(planFailureRearm({ ...spent, requestFault: true }).action).toBe("parked");
  });

  it("a dunning period that has ended parks too", () => {
    const plan = planFailureRearm({
      ...base,
      mode: "fixed",
      newAttemptCount: 1,
      periodEndsAt: new Date("2026-08-05T00:00:00Z"),
      requestFault: true,
    });
    expect(plan.action).toBe("parked");
  });
});

describe("isOurRequestFault", () => {
  const ruleText = ALL_DECLINE_RULES.find((r) => r.code === "gateway_error" && r.message)!;

  it("knows a refused request and a rule-matched gateway_error", () => {
    expect(isOurRequestFault({ code: "gateway_request_rejected" })).toBe(true);
    expect(isOurRequestFault({ code: "gateway_error", ruleId: ruleText.id })).toBe(true);
    expect(isOurRequestFault({ code: "gateway_error", message: ruleText.message })).toBe(true);
  });

  it("leaves a bare gateway_error and a real decline alone", () => {
    expect(isOurRequestFault({ code: "gateway_error", message: "TypeError: x" })).toBe(false);
    expect(isOurRequestFault({ code: "insufficient_funds" })).toBe(false);
    expect(isOurRequestFault({ code: null })).toBe(false);
  });
});

describe("parkedOnOurRequest: no final action and no payer mail while parked on our fault", () => {
  const parked = { status: "payment_due", dunningStatus: "parked" };
  const ours = { code: "gateway_request_rejected", message: null };

  it("holds a park whose newest refusal is our request", () => {
    expect(parkedOnOurRequest(parked, ours)).toBe(true);
  });

  it("lets the normal rules run once collection runs again", () => {
    // Retrying, paid, or parked for a reason the payer can clear.
    expect(parkedOnOurRequest({ ...parked, dunningStatus: "in_progress" }, ours)).toBe(false);
    expect(parkedOnOurRequest({ ...parked, status: "paid" }, ours)).toBe(false);
    expect(parkedOnOurRequest(parked, { code: "expired_card", message: null })).toBe(false);
    expect(parkedOnOurRequest(parked, null)).toBe(false);
  });
});
