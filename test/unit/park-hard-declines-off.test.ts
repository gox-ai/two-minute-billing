import { describe, expect, it } from "vitest";
import {
  PARKED_GRACE_DAYS,
  addUtcDays,
  parkedDunningDeadline,
  planFailureRearm,
  resolveDunningConfig,
} from "@/modules/subscriptions/dunning-schedule";

// Parking off (the default): a decline that would have parked retries on the schedule.
const due = new Date("2026-09-25T18:30:00Z");
const BASE = {
  dunningStatus: "in_progress",
  currentNextAttemptAt: null,
  autoCollectOn: true,
  retriable: false,
  retryDays: [1, 3, 5],
  now: due,
  mode: "smart" as const,
  dunningApplies: true,
  periodEndsAt: addUtcDays(due, 10),
  dueDate: due,
  newAttemptCount: 1,
  parkHardDeclines: false,
};

describe("park_hard_declines off", () => {
  it("defaults off; only an explicit true turns it on", () => {
    expect(resolveDunningConfig({ dunningConfig: { mode: "smart" } }).parkHardDeclines).toBe(false);
    expect(resolveDunningConfig(null).parkHardDeclines).toBe(false);
    expect(
      resolveDunningConfig({ dunningConfig: { park_hard_declines: true } }).parkHardDeclines,
    ).toBe(true);
  });

  it("retries a park-class decline on the schedule instead of parking", () => {
    for (const code of ["incorrect_number", "authentication_required", "card_restricted"])
      expect(planFailureRearm({ ...BASE, declineCode: code }), code).toEqual({
        action: "retry",
        nextAttempt: addUtcDays(due, 1),
      });
  });

  it("keeps an armed retry rather than moving it", () => {
    const armed = addUtcDays(due, 3);
    expect(
      planFailureRearm({
        ...BASE,
        now: addUtcDays(due, 1),
        currentNextAttemptAt: armed,
        declineCode: "authentication_required",
      }),
    ).toEqual({ action: "paused", until: armed });
  });

  it("a generic decline past the 4th attempt retries to the deadline, then exhausts", () => {
    const at = addUtcDays(due, 5);
    expect(
      planFailureRearm({ ...BASE, now: at, newAttemptCount: 4, declineCode: "card_declined" }),
    ).toEqual({ action: "retry", nextAttempt: BASE.periodEndsAt });
    expect(
      planFailureRearm({
        ...BASE,
        now: addUtcDays(due, 11),
        newAttemptCount: 5,
        declineCode: "card_declined",
      }).action,
    ).toBe("exhausted");
  });

  it("still ends dunning at once for fraud or a revoked authorisation", () => {
    for (const code of ["fraudulent", "revocation_of_authorization", "debit_not_authorized"])
      expect(planFailureRearm({ ...BASE, declineCode: code }).action, code).toBe("exhausted");
  });

  it("holds a lost, stolen or seized card for a new one — never retried, never cancelled", () => {
    const armed = { now: addUtcDays(due, 1), currentNextAttemptAt: addUtcDays(due, 3) };
    for (const code of ["lost_card", "stolen_card", "pickup_card"])
      for (const extra of [{}, { periodEndsAt: null }, armed, { parkHardDeclines: true }])
        expect(planFailureRearm({ ...BASE, ...extra, declineCode: code }), code).toEqual({
          action: "parked",
        });
  });

  it("a held card gets the same deadline as any park: the 30-day window with no period", () => {
    const cfg = resolveDunningConfig({ dunningConfig: { mode: "smart" } });
    expect(parkedDunningDeadline(cfg, due)).toEqual(addUtcDays(due, PARKED_GRACE_DAYS));
  });

  it("fixed mode is unchanged: a seized card still ends dunning", () => {
    expect(
      planFailureRearm({ ...BASE, mode: "fixed", periodEndsAt: null, declineCode: "pickup_card" })
        .action,
    ).toBe("exhausted");
  });

  it("with no period, a card keeps the 30-day window a park would have had", () => {
    const spent = addUtcDays(due, 5);
    expect(
      planFailureRearm({
        ...BASE,
        periodEndsAt: null,
        now: spent,
        newAttemptCount: 4,
        declineCode: "expired_card",
      }),
    ).toEqual({ action: "retry", nextAttempt: addUtcDays(due, PARKED_GRACE_DAYS) });
  });

  it("with no period, a mandate rail gets no attempt past its capped schedule", () => {
    expect(
      planFailureRearm({
        ...BASE,
        periodEndsAt: null,
        mandateRail: "upi",
        now: addUtcDays(due, 5),
        newAttemptCount: 4,
        declineCode: "mandate_expired",
      }).action,
    ).toBe("exhausted");
  });

  it("fixed mode retries its carve-out codes instead of parking them", () => {
    expect(
      planFailureRearm({ ...BASE, mode: "fixed", declineCode: "mandate_ceiling_exceeded" }),
    ).toEqual({ action: "retry", nextAttempt: addUtcDays(due, 1) });
    // An ordinary hard decline in fixed mode is unchanged: it still ends dunning.
    expect(
      planFailureRearm({ ...BASE, mode: "fixed", periodEndsAt: null, declineCode: "expired_card" })
        .action,
    ).toBe("exhausted");
  });

  it("parks as before when turned on", () => {
    expect(
      planFailureRearm({ ...BASE, parkHardDeclines: true, declineCode: "incorrect_number" }),
    ).toEqual({ action: "parked" });
  });
});

describe("NACH 3-day re-presentation gap", () => {
  it("floors a NACH/e-mandate retry at 3 days after the return", () => {
    for (const rail of ["nach", "emandate"])
      expect(
        planFailureRearm({
          ...BASE,
          mandateRail: rail,
          retriable: true,
          declineCode: "insufficient_funds",
        }),
        rail,
      ).toEqual({ action: "retry", nextAttempt: addUtcDays(due, 3) });
  });

  it("leaves cards and UPI on the schedule", () => {
    for (const rail of [null, "upi", "card"])
      expect(
        planFailureRearm({
          ...BASE,
          mandateRail: rail,
          retriable: true,
          declineCode: "insufficient_funds",
        }),
        String(rail),
      ).toEqual({ action: "retry", nextAttempt: addUtcDays(due, 1) });
  });

  it("a floor past the period end lands on the deadline, which the presentment check refuses", () => {
    expect(
      planFailureRearm({
        ...BASE,
        mandateRail: "nach",
        retriable: true,
        periodEndsAt: addUtcDays(due, 2),
        declineCode: "insufficient_funds",
      }),
    ).toEqual({ action: "retry", nextAttempt: addUtcDays(due, 2) });
  });
});
