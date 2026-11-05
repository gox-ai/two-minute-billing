import { describe, it, expect } from "vitest";
import {
  nextRetryAt,
  planFailureRearm,
  DUNNING_RETRY_DAYS,
  MAX_ATTEMPTS,
  resolveDunningConfig,
  dunningAppliesTo,
  dunningPeriodEndsAt,
  DEFAULT_DUNNING_CONFIG,
} from "@/modules/subscriptions/dunning-schedule";

const base = new Date("2026-01-01T00:00:00Z");
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

describe("dunning schedule", () => {
  it("retry days are 1,3,5,7 and MAX_ATTEMPTS = retries + 1", () => {
    expect(DUNNING_RETRY_DAYS).toEqual([1, 3, 5, 7]);
    expect(MAX_ATTEMPTS).toBe(5);
  });
  it("schedules each retry at the right day offset", () => {
    // after attempt N (1-based), next retry uses the Nth offset
    expect(daysBetween(base, nextRetryAt(1, base)!)).toBe(1);
    expect(daysBetween(base, nextRetryAt(2, base)!)).toBe(3);
    expect(daysBetween(base, nextRetryAt(3, base)!)).toBe(5);
    expect(daysBetween(base, nextRetryAt(4, base)!)).toBe(7);
  });
  it("returns null once retries are exhausted", () => {
    expect(nextRetryAt(5, base)).toBeNull(); // after the 4 retries (attempt 5 = last)
    expect(nextRetryAt(99, base)).toBeNull();
  });
  it("guards invalid attempt counts", () => {
    expect(nextRetryAt(0, base)).toBeNull();
    expect(nextRetryAt(-1, base)).toBeNull();
  });
});

/**
 * Retry offsets are ABSOLUTE days from the invoice DUE DATE: a schedule of 1, 4, 9
 * retries collection 1, 4 and 9 days after the due date.
 *
 * We used to add each offset to the PREVIOUS failure, so 1, 3, 5 fired on days 1, 4, 9
 * and drifted further with every attempt.
 */
describe("retry offsets are absolute, measured from the invoice due date", () => {
  const due = new Date("2026-08-01T00:00:00Z");
  const day = (n: number) => new Date(`2026-08-${String(n).padStart(2, "0")}T00:00:00Z`);

  it("puts 1, 3, 5 on days 1, 3, 5 after the due date — not 1, 4, 9", () => {
    // Each call passes the `now` of THAT failure, which is what the compounding bug
    // used as its anchor; the due date must win.
    expect(nextRetryAt(1, day(1), [1, 3, 5], due)).toEqual(day(2));
    expect(nextRetryAt(2, day(2), [1, 3, 5], due)).toEqual(day(4));
    expect(nextRetryAt(3, day(4), [1, 3, 5], due)).toEqual(day(6));
    // …and the old behaviour would have been day 2, day 5, day 9.
  });

  it("exhausts once the configured offsets run out", () => {
    expect(nextRetryAt(4, day(6), [1, 3, 5], due)).toBeNull();
  });

  it("falls back to the failure time when the invoice has no due date", () => {
    // `invoices.due_date` is nullable. Guessing a date would be worse than falling
    // back to the failure time.
    expect(nextRetryAt(1, day(10), [1, 3, 5], null)).toEqual(day(11));
    expect(nextRetryAt(1, day(10), [1, 3, 5])).toEqual(day(11));
  });

  it("moves a slot that has already passed to a day after the failure, never to now", () => {
    // `from` is the attempt that just failed: "now" would re-present it seconds later.
    const late = new Date("2026-08-20T00:00:00Z");
    expect(nextRetryAt(1, late, [1, 3, 5], due)).toEqual(day(21));
  });

  it("does not retry at once when the first charge lands exactly on the day-1 slot", () => {
    // Due-pass charge 1 day + 26 s after the due date: slot 1 is 26 s in the past.
    const failedAt = new Date("2026-08-02T00:00:26Z");
    expect(nextRetryAt(1, failedAt, [1, 3, 5], due)).toEqual(new Date("2026-08-03T00:00:26Z"));
    // Slot 2 is still ahead, so the schedule resumes on its own offsets.
    expect(nextRetryAt(2, new Date("2026-08-03T00:00:26Z"), [1, 3, 5], due)).toEqual(day(4));
  });

  it("still counts the offset from the due date even when the failure came first", () => {
    // A charge that fails BEFORE the due date (billed early) must not retry before it.
    const early = new Date("2026-07-28T00:00:00Z");
    expect(nextRetryAt(1, early, [1, 3, 5], due)).toEqual(day(2));
  });
});

/**
 * "Skip retries for hard failures" (Settings → Dunning). We modelled only the ON case
 * until a business was found running it OFF — there, the custom retry schedule applies
 * to every decline and hardness stops mattering. With it ON we terminated silently
 * where a retry was still due.
 */
describe("skipRetriesForHardFailures (fixed mode)", () => {
  const base = {
    dunningStatus: null,
    currentNextAttemptAt: null,
    autoCollectOn: true,
    newAttemptCount: 1,
    retryDays: [1, 3, 5],
    now: new Date("2026-08-06T00:00:00Z"),
    mode: "fixed" as const,
  };

  it("ends dunning on a hard decline when ON — the historical default", () => {
    expect(planFailureRearm({ ...base, retriable: false }).action).toBe("exhausted");
    expect(
      planFailureRearm({ ...base, retriable: false, skipRetriesForHardFailures: true }).action,
    ).toBe("exhausted");
  });

  it("keeps retrying a hard decline when OFF", () => {
    const plan = planFailureRearm({ ...base, retriable: false, skipRetriesForHardFailures: false });
    expect(plan.action).toBe("retry");
    // First offset of the configured schedule, not a special-cased delay.
    if (plan.action === "retry") expect(plan.nextAttempt).toEqual(new Date("2026-08-07T00:00:00Z"));
  });

  it("still exhausts when the schedule itself runs out, OFF or not", () => {
    // The toggle changes WHETHER hardness ends dunning, never how many retries exist.
    const plan = planFailureRearm({
      ...base,
      retriable: false,
      skipRetriesForHardFailures: false,
      newAttemptCount: 4,
    });
    expect(plan.action).toBe("exhausted");
  });

  it("does not disturb a soft decline in either setting", () => {
    for (const skip of [true, false, undefined]) {
      expect(
        planFailureRearm({ ...base, retriable: true, skipRetriesForHardFailures: skip }).action,
      ).toBe("retry");
    }
  });
});

/**
 * "Skip retries for hard failures" conflates FUTILE TO RETRY with UNRECOVERABLE.
 * A stolen card is both. A mandate whose per-debit ceiling is below the amount due is
 * only the first — the customer re-authorizes and it pays. Ending dunning there voids
 * the invoice and cancels a subscription over something the customer can fix, and
 * smart mode (which classifies it correctly) is deliberately not selectable.
 */
describe("a hard decline the CUSTOMER can still clear parks instead of cancelling", () => {
  const base = {
    dunningStatus: null,
    currentNextAttemptAt: null,
    autoCollectOn: true,
    retriable: false, // every case here is one the gateway called non-retriable
    newAttemptCount: 1,
    retryDays: [1, 3, 5],
    now: new Date("2026-08-06T00:00:00Z"),
    mode: "fixed" as const,
  };

  it("parks a mandate ceiling breach rather than exhausting", () => {
    // Measured 2026-08-14 by disabling the branch: a ₹66,025 renewal on a ₹15,000 card
    // mandate exhausted on its FIRST attempt — invoice `not_paid`, and since exhaustion
    // lands at the first bill no dunning pass revisits it, so the subscription stayed
    // ACTIVE and unpaid and re-authorizing collected nothing. Silent revenue loss on a
    // live subscription, not a visible cancellation. See `verify:dunning` case E.
    expect(planFailureRearm({ ...base, declineCode: "mandate_ceiling_exceeded" }).action).toBe(
      "parked",
    );
  });

  it("parks a merchant-config refusal — the customer did nothing wrong", () => {
    expect(planFailureRearm({ ...base, declineCode: "recurring_not_enabled" }).action).toBe(
      "parked",
    );
  });

  it("still ENDS dunning on a genuinely unrecoverable card, which is the toggle's promise", () => {
    for (const code of ["stolen_card", "lost_card", "fraudulent", "revocation_of_authorization"]) {
      expect(planFailureRearm({ ...base, declineCode: code }).action).toBe("exhausted");
    }
  });

  it("still ENDS dunning on an ordinary hard-declined card — the toggle's actual scope", () => {
    // The guard this file was missing. The toggle is scoped to payment methods with
    // hard declines, and `card_declined` / `expired_card` are exactly that, so
    // fixed mode must keep cancelling them. A first cut of the carve-out parked every
    // `classifyDecline`-park code and silently stopped fixed-mode businesses from ever
    // cancelling a declined card — caught by `verify:dunning-smart` case 4, not here,
    // which is why these assertions now exist.
    for (const code of ["card_declined", "expired_card", "incorrect_cvc", "do_not_honor"]) {
      expect(planFailureRearm({ ...base, declineCode: code }).action).toBe("exhausted");
    }
  });

  it("still exhausts an unmapped hard decline — parking is opt-in by code, not the default", () => {
    expect(planFailureRearm({ ...base, declineCode: "something_new" }).action).toBe("exhausted");
    // And with no code at all, the historical path is untouched.
    expect(planFailureRearm({ ...base }).action).toBe("exhausted");
  });

  it("leaves every RETRIABLE decline exactly where it was — this narrows cancellation, never widens it", () => {
    // The park branch is reachable only when hardness was already ending dunning. A
    // park-classified code that the gateway marked RETRIABLE keeps its retry schedule,
    // so no business sees a change on an ordinary decline.
    const plan = planFailureRearm({ ...base, retriable: true, declineCode: "card_declined" });
    expect(plan.action).toBe("retry");
  });

  it("does not fire when the merchant turned the toggle OFF", () => {
    // OFF means "apply the schedule to every decline". Parking there would override an
    // explicit merchant choice; the schedule runs and the tail decides, as before.
    const plan = planFailureRearm({
      ...base,
      declineCode: "mandate_ceiling_exceeded",
      skipRetriesForHardFailures: false,
    });
    expect(plan.action).toBe("retry");
  });

  it("a merchant stop_dunning still wins over parking", () => {
    expect(
      planFailureRearm({
        ...base,
        declineCode: "mandate_ceiling_exceeded",
        dunningStatus: "stopped",
      }).action,
    ).toBe("stopped");
  });

  it("an auto-collect-off invoice is still left alone", () => {
    // `offline` until 2026-08-31, now `send_invoice`. The two were one action and had
    // to be split: auto-collect-off must leave the invoice `payment_due` with its
    // dunning state and attempt count untouched (such an invoice stays `payment_due` /
    // `in_progress` with `dunning_attempts: []`), while `offline` — now
    // meaning only "dunning is switched off / out of scope" — still settles a genuinely
    // failed charge to `not_paid`.
    expect(
      planFailureRearm({
        ...base,
        declineCode: "mandate_ceiling_exceeded",
        autoCollectOn: false,
      }).action,
    ).toBe("send_invoice");
  });

  it("HONOURS a configured dunning period instead of parking past it", () => {
    // Reversed 2026-08-14. This first asserted that parking pre-empts the period, on the
    // reasoning that a deadline must not resurrect a cancellation for a customer whose
    // card is fine. That over-corrected: a business that configured "6 days, then act"
    // had these two codes silently opt out of it — no retries, no deadline, no final
    // action — so an invoice nobody paid stayed open FOREVER with the subscription
    // active. Free service, no operator signal.
    //
    // With a period set, nothing is retried during the window (the customer can Pay now,
    // and collect-on-payment-method-update fires the moment they fix the instrument) and
    // there is ONE attempt on the deadline before the final action. That deadline
    // attempt is not futile: `recurring_not_enabled` is cleared by the MERCHANT at the
    // gateway, and nothing else would ever trigger a re-collect.
    const deadline = new Date("2026-08-12T00:00:00Z");
    const plan = planFailureRearm({
      ...base,
      declineCode: "mandate_ceiling_exceeded",
      periodEndsAt: deadline,
    });
    expect(plan.action).toBe("retry");
    if (plan.action === "retry") expect(plan.nextAttempt).toEqual(deadline);
    // Nothing before the deadline — the point is that the window stays quiet.
    expect(plan.action === "retry" && plan.nextAttempt.getTime() > base.now.getTime()).toBe(true);
  });

  it("still parks indefinitely when the business set NO dunning period", () => {
    // No deadline to honour, and exhausting immediately is the original bug (a live
    // subscription whose invoice is abandoned on its first attempt). Park, and let the
    // business configure a period if it wants an end date.
    expect(planFailureRearm({ ...base, declineCode: "mandate_ceiling_exceeded" }).action).toBe(
      "parked",
    );
  });

  it("a period that has ALREADY passed applies the final action rather than waiting", () => {
    expect(
      planFailureRearm({
        ...base,
        declineCode: "mandate_ceiling_exceeded",
        periodEndsAt: new Date("2026-08-01T00:00:00Z"),
      }).action,
    ).toBe("exhausted");
  });
});

const rearmBase = {
  dunningStatus: null,
  currentNextAttemptAt: null,
  autoCollectOn: true,
  retriable: true,
  newAttemptCount: 1,
  retryDays: [1, 3, 5],
  now: new Date("2026-08-06T00:00:00Z"),
  mode: "fixed" as const,
};

/**
 * The final action lands at the END OF THE DUNNING PERIOD, not the moment the last
 * scheduled retry fails. Those dates differ, and only a run comparing cancellation
 * DATES catches it.
 */
describe("dunning period", () => {
  it("is absent by default, leaving the historical behaviour untouched", () => {
    expect(DEFAULT_DUNNING_CONFIG.dunningPeriodDays).toBeNull();
    // Schedule spent + no period ⇒ exhausted immediately, exactly as before.
    expect(planFailureRearm({ ...rearmBase, newAttemptCount: 4 }).action).toBe("exhausted");
  });

  it("runs a scheduled retry that lands inside the period", () => {
    const plan = planFailureRearm({
      ...rearmBase,
      periodEndsAt: new Date("2026-08-20T00:00:00Z"),
    });
    expect(plan.action).toBe("retry");
    if (plan.action === "retry") expect(plan.nextAttempt).toEqual(new Date("2026-08-07T00:00:00Z"));
  });

  it("defers the final action to the period end once the schedule is spent", () => {
    const periodEndsAt = new Date("2026-08-20T00:00:00Z");
    const plan = planFailureRearm({ ...rearmBase, newAttemptCount: 4, periodEndsAt });
    // Not 'exhausted' — one last attempt lands ON the deadline.
    expect(plan.action).toBe("retry");
    if (plan.action === "retry") expect(plan.nextAttempt).toEqual(periodEndsAt);
  });

  it("caps a retry that would overshoot the deadline", () => {
    const periodEndsAt = new Date("2026-08-08T00:00:00Z");
    // The 3rd offset (5 days → Aug 11) overshoots, so the deadline wins.
    const plan = planFailureRearm({ ...rearmBase, newAttemptCount: 3, periodEndsAt });
    expect(plan.action).toBe("retry");
    if (plan.action === "retry") expect(plan.nextAttempt).toEqual(periodEndsAt);
  });

  it("exhausts once the period is actually over", () => {
    expect(
      planFailureRearm({
        ...rearmBase,
        newAttemptCount: 4,
        periodEndsAt: new Date("2026-08-05T00:00:00Z"),
      }).action,
    ).toBe("exhausted");
  });

  it("measures the period from the invoice due date, and needs one to measure from", () => {
    const cfg = { ...DEFAULT_DUNNING_CONFIG, dunningPeriodDays: 6 };
    expect(dunningPeriodEndsAt(cfg, new Date("2026-08-01T00:00:00Z"))).toEqual(
      new Date("2026-08-07T00:00:00Z"),
    );
    expect(dunningPeriodEndsAt(cfg, null)).toBeNull();
    expect(
      dunningPeriodEndsAt(DEFAULT_DUNNING_CONFIG, new Date("2026-08-01T00:00:00Z")),
    ).toBeNull();
  });
});

/**
 * A manual "Collect now" / "Pay now" holds `attempt_count` still (M12), so the FIRST
 * human attempt on an invoice the clock has never touched plans from count 0 — and 0 is
 * not a slot. Read as "the schedule is spent" it exhausted dunning on one click:
 * `not_paid` / `exhausted`, nothing ever retried, and the subscription cancelled by the
 * final action before the clock had attempted once.
 */
describe("an attempt that did not advance the counter still arms the schedule", () => {
  it("plans the FIRST offset instead of exhausting, at count 0", () => {
    const plan = planFailureRearm({ ...rearmBase, newAttemptCount: 0 });
    expect(plan.action).toBe("retry");
    // Offsets are absolute from the due date; with none, from the failure (Aug 6 + 1).
    if (plan.action === "retry") expect(plan.nextAttempt).toEqual(new Date("2026-08-07T00:00:00Z"));
  });

  it("anchors that first slot on the due date, like every other slot", () => {
    const plan = planFailureRearm({
      ...rearmBase,
      newAttemptCount: 0,
      dueDate: new Date("2026-08-10T00:00:00Z"),
    });
    expect(plan.action).toBe("retry");
    if (plan.action === "retry") expect(plan.nextAttempt).toEqual(new Date("2026-08-11T00:00:00Z"));
  });

  it("does not rescue a genuinely spent schedule", () => {
    // The clamp is only about count 0 — a schedule that ran out still exhausts.
    expect(planFailureRearm({ ...rearmBase, newAttemptCount: 4 }).action).toBe("exhausted");
  });

  it("leaves the merchant/scope guards ahead of it untouched", () => {
    expect(
      planFailureRearm({ ...rearmBase, newAttemptCount: 0, dunningStatus: "stopped" }).action,
    ).toBe("stopped");
    // `send_invoice` since the split (see above) — auto-collect-off no longer settles
    // the invoice to not_paid; `dunningApplies: false` below still does.
    expect(
      planFailureRearm({ ...rearmBase, newAttemptCount: 0, autoCollectOn: false }).action,
    ).toBe("send_invoice");
    expect(
      planFailureRearm({ ...rearmBase, newAttemptCount: 0, dunningApplies: false }).action,
    ).toBe("offline");
  });

  it("applies in smart mode too", () => {
    const plan = planFailureRearm({
      ...rearmBase,
      newAttemptCount: 0,
      mode: "smart",
      declineCode: "insufficient_funds",
    });
    expect(plan.action).toBe("retry");
  });
});

/** The master switch and the two dunning scope toggles. */
describe("dunning scope", () => {
  it("defaults preserve today's behaviour: on, trial/future dunned, one-off not", () => {
    const cfg = resolveDunningConfig(null);
    expect(cfg.enabled).toBe(true);
    expect(cfg.dunTrialAndFutureSubscriptions).toBe(true);
    expect(cfg.dunOneTimeInvoices).toBe(false);
  });

  it("only an explicit false turns the master switch off", () => {
    expect(resolveDunningConfig({ dunningConfig: { enabled: false } }).enabled).toBe(false);
    expect(resolveDunningConfig({ dunningConfig: { enabled: "no" } }).enabled).toBe(true);
  });

  it("treats dunning-off exactly like an auto-collect-off invoice", () => {
    expect(planFailureRearm({ ...rearmBase, dunningApplies: false }).action).toBe("offline");
  });

  it("a merchant stop still wins over the master switch", () => {
    expect(
      planFailureRearm({ ...rearmBase, dunningStatus: "stopped", dunningApplies: false }).action,
    ).toBe("stopped");
  });

  it("scopes one-time invoices and trial/future subscriptions", () => {
    const on = DEFAULT_DUNNING_CONFIG;
    expect(dunningAppliesTo(on, { hasSubscription: false })).toBe(false); // one-off, default off
    expect(dunningAppliesTo({ ...on, dunOneTimeInvoices: true }, { hasSubscription: false })).toBe(
      true,
    );
    // Trial/future are dunned by default...
    expect(dunningAppliesTo(on, { hasSubscription: true, subscriptionStatus: "in_trial" })).toBe(
      true,
    );
    // ...and excluded when the merchant turns the toggle off.
    const noTrial = { ...on, dunTrialAndFutureSubscriptions: false };
    expect(
      dunningAppliesTo(noTrial, { hasSubscription: true, subscriptionStatus: "in_trial" }),
    ).toBe(false);
    expect(dunningAppliesTo(noTrial, { hasSubscription: true, subscriptionStatus: "future" })).toBe(
      false,
    );
    expect(dunningAppliesTo(noTrial, { hasSubscription: true, subscriptionStatus: "active" })).toBe(
      true,
    );
    // The master switch overrides every scope.
    expect(
      dunningAppliesTo(
        { ...on, enabled: false },
        { hasSubscription: true, subscriptionStatus: "active" },
      ),
    ).toBe(false);
  });
});

describe("final invoice action", () => {
  it("accepts the four final invoice actions, and falls back to not_paid on junk", () => {
    for (const v of ["not_paid", "void", "write_off", "reverse"]) {
      expect(
        resolveDunningConfig({ dunningConfig: { final_action: { invoice: v } } }).finalAction
          .invoice,
      ).toBe(v);
    }
    expect(
      resolveDunningConfig({ dunningConfig: { final_action: { invoice: "explode" } } }).finalAction
        .invoice,
    ).toBe("not_paid");
  });
});

describe("smart mode: a generic refusal retries, then parks", () => {
  const smart = {
    dunningStatus: "in_progress",
    currentNextAttemptAt: null,
    autoCollectOn: true,
    retriable: false,
    retryDays: [1, 3, 5, 7],
    now: new Date("2026-09-25T00:00:00Z"),
    dueDate: new Date("2026-09-24T00:00:00Z"),
    mode: "smart" as const,
  };

  it("retries card_declined / do_not_honor while attempts remain", () => {
    for (const code of ["card_declined", "do_not_honor"])
      for (const n of [1, 2, 3])
        expect(planFailureRearm({ ...smart, declineCode: code, newAttemptCount: n }).action).toBe(
          "retry",
        );
  });

  it("parks on the fourth failed attempt instead of retrying again", () => {
    expect(
      planFailureRearm({ ...smart, declineCode: "card_declined", newAttemptCount: 4 }).action,
    ).toBe("parked");
  });

  it("parks rather than exhausting when a short schedule runs out first", () => {
    expect(
      planFailureRearm({
        ...smart,
        retryDays: [2],
        declineCode: "do_not_honor",
        newAttemptCount: 2,
      }).action,
    ).toBe("parked");
  });

  it("insufficient_funds still exhausts at the end of the schedule", () => {
    expect(
      planFailureRearm({ ...smart, declineCode: "insufficient_funds", newAttemptCount: 5 }).action,
    ).toBe("exhausted");
  });
});
