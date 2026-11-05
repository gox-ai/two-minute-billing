import { describe, expect, it } from "vitest";
import { planFailureRearm } from "@/modules/subscriptions/dunning-schedule";
import { normalizeRazorpayDecline, normalizeStripeDecline } from "@/providers/decline-codes";
import { isHardDecline } from "@/modules/invoicing/collection";

/**
 * A DISPOSITION OUTRANKS A SCHEDULE.
 *
 * INV-100004, production 2026-09-10. Stripe refused the renewal with
 * `payment_intent_mandate_invalid` — the mandate is inactive — which normalises to
 * `mandate_expired` and parks. But the invoice was already `in_progress` with a retry
 * armed for the next midnight, so `planFailureRearm` returned `paused` and exited BEFORE
 * reading the decline code. The verdict was computed, written onto the transaction, and
 * then ignored: the invoice kept its schedule and would have re-presented a dead mandate
 * nightly until dunning exhausted and the final action cancelled a subscription whose
 * customer only ever needed to re-authorise.
 *
 * The guard itself is right — a manual "Collect now" must not shove the retry clock
 * around (M12) — but it conflated "do not move the schedule" with "do not change the
 * disposition".
 */
const BASE = {
  autoCollectOn: true,
  retriable: true,
  retryDays: [1, 3, 5, 7],
  now: new Date("2026-09-10T01:54:59+05:30"),
  mode: "smart" as const,
  skipRetriesForHardFailures: false,
  dunningApplies: true,
  periodEndsAt: new Date("2026-10-10T00:00:00+05:30"),
  dueDate: new Date("2026-09-10T00:00:00+05:30"),
  mandateRail: "card",
  /** A manual attempt holds the counter still (M12), so the real case arrives as 0. */
  newAttemptCount: 0,
};
const scheduled = {
  dunningStatus: "in_progress",
  currentNextAttemptAt: new Date("2026-09-11T00:00:00+05:30"),
};

describe("a park-worthy decline parks even when a retry is already armed", () => {
  it("parks the exact production case instead of keeping the schedule", () => {
    expect(planFailureRearm({ ...BASE, ...scheduled, declineCode: "mandate_expired" })).toEqual({
      action: "parked",
    });
  });

  it("holds for every code the policy parks, not just this one", () => {
    // Any failure landing while a retry was armed used to have its classification
    // discarded — this was never specific to mandates.
    for (const code of ["expired_card", "incorrect_cvc", "recurring_not_enabled", "stolen_card"])
      expect(planFailureRearm({ ...BASE, ...scheduled, declineCode: code }).action, code).toBe(
        "parked",
      );
  });

  it("terminates when the policy terminates", () => {
    // Fraud and a withdrawn authorisation must escape the schedule guard too.
    for (const code of ["fraudulent", "debit_not_authorized"])
      expect(planFailureRearm({ ...BASE, ...scheduled, declineCode: code }).action, code).toBe(
        "exhausted",
      );
  });

  it("still leaves a RETRIABLE decline's schedule exactly where it was", () => {
    // The M12 guarantee: nothing here may move an interval. A soft decline arriving while
    // a retry is armed must not re-plan it, or a manual attempt spends a scheduled one.
    const p = planFailureRearm({ ...BASE, ...scheduled, declineCode: "insufficient_funds" });
    expect(p).toEqual({ action: "paused", until: scheduled.currentNextAttemptAt });
  });

  it("a generic refusal with retries left keeps the armed schedule", () => {
    const p = planFailureRearm({ ...BASE, ...scheduled, declineCode: "do_not_honor" });
    expect(p).toEqual({ action: "paused", until: scheduled.currentNextAttemptAt });
  });

  it("does not disturb a merchant's explicit halt", () => {
    // `stopped` is a decision someone made, not a schedule, and is checked first.
    expect(
      planFailureRearm({
        ...BASE,
        declineCode: "mandate_expired",
        dunningStatus: "stopped",
        currentNextAttemptAt: null,
      }).action,
    ).toBe("stopped");
  });

  it("a dead mandate is a HARD failure, without branding the card", () => {
    // Second defect on the same invoice: the Retries screen read `retriable` and showed
    // "Soft failure" for mandate_expired, telling an operator a retry might work against
    // a mandate Stripe had just called inactive. The table could not say otherwise —
    // `build()` derives retriable from TERMINAL, and this code PARKS rather than
    // terminates — while our own `mandateExpiredRefusal` had always booked it false.
    for (const [gw, code] of [
      ["stripe", "payment_intent_mandate_invalid"],
      ["stripe", "india_recurring_payment_mandate_canceled"],
      ["razorpay", "mandate_not_active"],
    ] as const) {
      const n =
        gw === "stripe" ? normalizeStripeDecline({ code }) : normalizeRazorpayDecline({ code });
      expect(n.code, code).toBe("mandate_expired");
      expect(n.retriable, code).toBe(false);
      // …and non-retriable must NOT mean "bad instrument": the authorisation lapsed on
      // the bank's own end date, so the card stays chargeable once re-authorised.
      expect(
        isHardDecline({ status: "failed", failure: { code: n.code, retriable: n.retriable } }),
        code,
      ).toBe(false);
    }
  });

  it("closes the FIXED-mode twin: a carve-out code escapes the guard there too", () => {
    // The smart-mode hoist left fixed mode's own park route (`PARK_EVEN_IN_FIXED_MODE`)
    // BELOW the schedule guard, so it was reachable only when no retry happened to be
    // armed. Same defect. `mandate_expired` — INV-100004's code — is in that set.
    const FIXED = {
      ...BASE,
      ...scheduled,
      mode: "fixed" as const,
      retriable: false,
      skipRetriesForHardFailures: true,
      declineCode: "mandate_expired",
    };
    // With a dunning period the carve-out hands off to the business's own deadline:
    // nothing retried during the window, ONE attempt on the deadline, then the final
    // action. Not `paused`, which is what it used to answer.
    expect(planFailureRearm(FIXED)).toEqual({
      action: "retry",
      nextAttempt: BASE.periodEndsAt,
    });
    // With no period there is no deadline to honour, so it parks.
    expect(planFailureRearm({ ...FIXED, periodEndsAt: null }).action).toBe("parked");
  });

  it("does NOT extend that bypass to an ordinary hard decline in fixed mode", () => {
    // The toggle's promise — it is scoped to hard declines and still cancels them — and
    // its TIMING both stay exactly as they were. `stolen_card` is in no carve-out.
    const p = planFailureRearm({
      ...BASE,
      ...scheduled,
      mode: "fixed",
      retriable: false,
      skipRetriesForHardFailures: true,
      declineCode: "stolen_card",
    });
    expect(p).toEqual({ action: "paused", until: scheduled.currentNextAttemptAt });
  });

  it("does not fire when the merchant switched hardness OFF", () => {
    // Hardness off means the schedule applies to every decline, so there is no
    // exhaustion to rescue the invoice from and the armed retry must stand.
    expect(
      planFailureRearm({
        ...BASE,
        ...scheduled,
        mode: "fixed",
        retriable: false,
        skipRetriesForHardFailures: false,
        declineCode: "mandate_expired",
      }),
    ).toEqual({ action: "paused", until: scheduled.currentNextAttemptAt });
  });

  it("leaves FIXED mode to its own rules", () => {
    // Fixed mode parks only via `scheduleApplies` + PARK_EVEN_IN_FIXED_MODE. Hoisting the
    // smart verdict over that broke five verify:dunning-smart expectations, because it
    // parked ordinary hard declines the toggle deliberately still cancels.
    const p = planFailureRearm({
      ...BASE,
      ...scheduled,
      mode: "fixed",
      declineCode: "mandate_expired",
    });
    expect(p).toEqual({ action: "paused", until: scheduled.currentNextAttemptAt });
  });
});
