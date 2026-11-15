import { describe, expect, it } from "vitest";
import {
  coveredTake,
  defaultEstimateSteps,
  parseUnitSteps,
} from "../../src/modules/credits/credit-cost";
import { inFlightRefused } from "../../src/modules/credits/policy";
import {
  nextTopupTryAt,
  TOPUP_RETRY,
  topupRetryHours,
  topupRetryHoursIssue,
  packTopup,
  purchaseLimitHit,
  type PackTopupInput,
} from "../../src/modules/usage-controls/auto-topup-amount";
import {
  autoTopupLines,
  autoTopupProblem,
  unitPartLines,
} from "../../dashboard/lib/portal-credits-view";

describe("parseUnitSteps", () => {
  it("reads credits at the unit's precision", () => {
    expect(parseUnitSteps("1", 1)).toBe(10n);
    expect(parseUnitSteps("0.5", 1)).toBe(5n);
    expect(parseUnitSteps("12", 0)).toBe(12n);
    expect(parseUnitSteps("2.50", 1)).toBe(25n);
  });
  it("refuses more decimals than the unit has, and anything that is not a plain decimal", () => {
    expect(parseUnitSteps("0.25", 1)).toBeNull();
    expect(parseUnitSteps("0.5", 0)).toBeNull();
    expect(parseUnitSteps("-1", 1)).toBeNull();
    expect(parseUnitSteps("1e3", 1)).toBeNull();
    expect(parseUnitSteps("", 1)).toBeNull();
  });
});

describe("coveredTake", () => {
  it("an event that costs less than the row offers takes its cost", () => {
    expect(coveredTake(30n, 100n)).toEqual({ units: 30n, uncovered: 0n });
  });
  it("an event that costs more takes what is there and records the rest", () => {
    expect(coveredTake(120n, 100n)).toEqual({ units: 100n, uncovered: 20n });
    expect(coveredTake(10n, 0n)).toEqual({ units: 0n, uncovered: 10n });
    expect(coveredTake(10n, -5n)).toEqual({ units: 0n, uncovered: 10n });
  });
});

describe("defaultEstimateSteps", () => {
  it("one event of a count meter, else one step", () => {
    expect(defaultEstimateSteps("count", 1_000_000n, 1)).toBe(10n);
    expect(defaultEstimateSteps("count", 500_000n, 1)).toBe(5n);
    expect(defaultEstimateSteps("sum", 500_000n, 1)).toBe(1n);
    // A cost below one step still asks for one step.
    expect(defaultEstimateSteps("count", 1n, 0)).toBe(1n);
  });
});

describe("the in-flight share in units", () => {
  const base = { balanceBeforeHoldsMinor: 100n, shareBps: 5_000 };
  it("open holds plus the new hold may use the share of the balance", () => {
    expect(inFlightRefused({ ...base, openHoldsMinor: 30n, amountMinor: 20n })).toBe(false);
    expect(inFlightRefused({ ...base, openHoldsMinor: 30n, amountMinor: 21n })).toBe(true);
  });
  it("other_holds_open: no other hold open, no share", () => {
    const one = { ...base, openHoldsMinor: 0n, amountMinor: 90n };
    expect(inFlightRefused({ ...one, applies: "other_holds_open" })).toBe(false);
    expect(inFlightRefused(one)).toBe(true);
  });
});

describe("packTopup", () => {
  const base: PackTopupInput = {
    trigger: "threshold",
    thresholdSteps: 50n,
    balanceSteps: 50n,
    packSteps: 150n,
    packMinor: 900n,
    minMinor: null,
    maxMinor: null,
    afaCapMinor: null,
    monthlyCapMinor: 10_000n,
    usedThisMonthMinor: 0n,
  };
  it("no run above the threshold; one purchase at it", () => {
    expect(packTopup({ ...base, balanceSteps: 51n })).toEqual({ kind: "none" });
    expect(packTopup(base)).toEqual({ kind: "run", purchases: 1n, amountMinor: 900n });
  });
  it("buys the smallest number of purchases that lands above the threshold", () => {
    expect(packTopup({ ...base, thresholdSteps: 400n, balanceSteps: 0n })).toEqual({
      kind: "run",
      purchases: 3n,
      amountMinor: 2700n,
    });
  });
  it("a schedule buys one purchase whatever the balance", () => {
    expect(
      packTopup({ ...base, trigger: "schedule", thresholdSteps: null, balanceSteps: 9_999n }),
    ).toEqual({ kind: "run", purchases: 1n, amountMinor: 900n });
  });
  it("the monthly cap never splits a pack", () => {
    const want3 = { ...base, thresholdSteps: 400n, balanceSteps: 0n };
    expect(packTopup({ ...want3, monthlyCapMinor: 2000n })).toEqual({
      kind: "run",
      purchases: 2n,
      amountMinor: 1800n,
    });
    expect(packTopup({ ...base, monthlyCapMinor: 1000n, usedThisMonthMinor: 900n })).toEqual({
      kind: "skip",
      reason: "monthly_cap",
    });
  });
  it("a purchase limit below one purchase: no run", () => {
    expect(packTopup({ ...base, maxMinor: 899n })).toEqual({ kind: "none" });
    expect(packTopup({ ...base, afaCapMinor: 500n })).toEqual({ kind: "none" });
  });
  it("a minimum raises the purchases", () => {
    expect(packTopup({ ...base, minMinor: 1000n })).toEqual({
      kind: "run",
      purchases: 2n,
      amountMinor: 1800n,
    });
  });
  it("a pack with no price or no credits never runs", () => {
    expect(packTopup({ ...base, packMinor: 0n })).toEqual({ kind: "none" });
    expect(packTopup({ ...base, packSteps: 0n })).toEqual({ kind: "none" });
  });
});

describe("packTopup with a target", () => {
  const base: PackTopupInput = {
    trigger: "threshold",
    thresholdSteps: 50n,
    targetSteps: 400n,
    balanceSteps: 0n,
    packSteps: 150n,
    packMinor: 900n,
    minMinor: null,
    maxMinor: null,
    afaCapMinor: null,
    monthlyCapMinor: 100_000n,
    usedThisMonthMinor: 0n,
  };
  it("buys whole packs to reach at least the target, rounded up", () => {
    expect(packTopup(base)).toEqual({ kind: "run", purchases: 3n, amountMinor: 2700n });
    expect(packTopup({ ...base, balanceSteps: 50n })).toEqual({
      kind: "run",
      purchases: 3n,
      amountMinor: 2700n,
    });
    expect(packTopup({ ...base, targetSteps: 300n })).toEqual({
      kind: "run",
      purchases: 2n,
      amountMinor: 1800n,
    });
  });
  it("no run above the threshold, or at the target on a schedule", () => {
    expect(packTopup({ ...base, balanceSteps: 51n })).toEqual({ kind: "none" });
    expect(
      packTopup({ ...base, trigger: "schedule", thresholdSteps: null, balanceSteps: 400n }),
    ).toEqual({ kind: "none" });
  });
});

describe("purchaseLimitHit", () => {
  const now = new Date("2026-03-15T12:00:00Z");
  const base = {
    now,
    dayStart: new Date("2026-03-15T00:00:00Z"),
    monthStart: new Date("2026-03-01T00:00:00Z"),
    amountMinor: 900n,
  };
  const run = (hoursAgo: number, amountMinor = 900n) => ({
    createdAt: new Date(now.getTime() - hoursAgo * 3_600_000),
    amountMinor,
  });
  it("no limits, no hit", () => {
    expect(purchaseLimitHit({ ...base, limits: null, runs: [run(0.5)] })).toBeNull();
  });
  it("a count in the last hour; a run older than the hour does not count", () => {
    const limits = { hour: { count: 1 } };
    expect(purchaseLimitHit({ ...base, limits, runs: [run(0.5)] })).toBe("hour");
    expect(purchaseLimitHit({ ...base, limits, runs: [run(1.5)] })).toBeNull();
  });
  it("an amount in the last 7 days counts the new purchase", () => {
    const limits = { week: { amount_minor: 2000 } };
    expect(purchaseLimitHit({ ...base, limits, runs: [run(30)] })).toBeNull();
    expect(purchaseLimitHit({ ...base, limits, runs: [run(30), run(60)] })).toBe("week");
    expect(purchaseLimitHit({ ...base, limits, runs: [run(30), run(24 * 8)] })).toBeNull();
  });
  it("day and month start at the calendar edges", () => {
    expect(
      purchaseLimitHit({ ...base, limits: { day: { count: 1 } }, runs: [run(13)] }),
    ).toBeNull();
    expect(purchaseLimitHit({ ...base, limits: { day: { count: 1 } }, runs: [run(11)] })).toBe(
      "day",
    );
    expect(
      purchaseLimitHit({ ...base, limits: { month: { count: 2 } }, runs: [run(24 * 10), run(11)] }),
    ).toBe("month");
  });
});

describe("nextTopupTryAt", () => {
  const start = new Date("2026-03-15T00:00:00Z");
  const at = (h: number) => new Date(start.getTime() + h * 3_600_000);
  const hours = TOPUP_RETRY.defaultHours;
  it("default: try 2 after 4 hours, try 3 after 12 more, then none", () => {
    expect(nextTopupTryAt({ failedTries: 1, now: at(0), hours })).toEqual(at(4));
    expect(nextTopupTryAt({ failedTries: 2, now: at(4), hours })).toEqual(at(16));
    expect(nextTopupTryAt({ failedTries: 3, now: at(16), hours })).toBeNull();
  });
  it("a custom list: each delay from the try before", () => {
    const h = [1, 1, 2];
    expect(nextTopupTryAt({ failedTries: 1, now: at(0), hours: h })).toEqual(at(1));
    expect(nextTopupTryAt({ failedTries: 3, now: at(2), hours: h })).toEqual(at(4));
    expect(nextTopupTryAt({ failedTries: 4, now: at(4), hours: h })).toBeNull();
  });
});

describe("topupRetryHours / topupRetryHoursIssue", () => {
  it("unset = the default; false = off", () => {
    expect(topupRetryHours(null, "card")).toEqual([4, 12]);
    expect(
      topupRetryHours({ auto_topup_retries: false, auto_topup_retry_hours: [1] }, null),
    ).toEqual([]);
  });
  it("the method kind's list, else the business list", () => {
    const cfg = {
      auto_topup_retry_hours: [2],
      auto_topup_retry_hours_by_method: { bank_debit: [24, 24] },
    };
    expect(topupRetryHours(cfg, "bank_debit")).toEqual([24, 24]);
    expect(topupRetryHours(cfg, "card")).toEqual([2]);
    expect(topupRetryHours(cfg, null)).toEqual([2]);
  });
  it("at most 4 delays (5 tries), whole hours, 72 hours in total", () => {
    expect(topupRetryHoursIssue([1, 1, 1, 1])).toBeNull();
    expect(topupRetryHoursIssue([1, 1, 1, 1, 1])).toMatch(/4 delays or fewer/);
    expect(topupRetryHoursIssue([24, 24, 25])).toMatch(/72 hours or less/);
    expect(topupRetryHoursIssue([24, 24, 24])).toBeNull();
    expect(topupRetryHoursIssue([0.5])).toMatch(/whole number/);
  });
});

describe("autoTopupLines (portal)", () => {
  const base = {
    unit_name: "credit",
    unit_plural_name: "credits",
    decimals: 1,
    currency: "USD",
    trigger: "threshold" as const,
    threshold_amount: 50,
    target_amount: null,
    pack_credits_amount: 150,
    pack_amount_minor: 900,
    pack_quantity: 1,
    has_payment_method: true,
    status: "active" as const,
    disabled_reason: null,
  };
  it("a fixed top-up of one pack: the pack, its credits and its price before tax", () => {
    const l = autoTopupLines(base);
    expect(l.title).toBe("Automatic top-up of credits is on");
    expect(l.detail).toBe(
      "When you have 5 credits or less, we buy a pack of 15 credits for $9.00 before tax.",
    );
    expect(l.problem).toBeNull();
  });
  it("a fixed top-up of two packs: one pack's size, then the purchase's credits and price", () => {
    const l = autoTopupLines({
      ...base,
      pack_quantity: 2,
      pack_credits_amount: 300,
      pack_amount_minor: 1800,
    });
    expect(l.detail).toBe(
      "When you have 5 credits or less, we buy 2 packs of 15 credits. That is 30 credits for $18.00 before tax.",
    );
  });
  it("an older API with no pack count states the purchase only", () => {
    const { pack_quantity: _, ...old } = base;
    expect(autoTopupLines(old).detail).toBe(
      "When you have 5 credits or less, we buy 15 credits for $9.00 before tax.",
    );
  });
  it("a target top-up buys single packs, so it states the price of one", () => {
    const l = autoTopupLines({ ...base, target_amount: 400 });
    expect(l.detail).toBe(
      "When you have 5 credits or less, we buy packs of 15 credits until you have 40 credits or more. Each pack is $9.00 before tax.",
    );
    const two = autoTopupLines({ ...base, target_amount: 400, trigger: "schedule" });
    expect(two.detail).toBe(
      "On a schedule, we buy packs of 15 credits until you have 40 credits or more. Each pack is $9.00 before tax.",
    );
  });
  it("off: the sentence says what it does when it is on", () => {
    const l = autoTopupLines({ ...base, status: "disabled", disabled_reason: "customer" });
    expect(l.title).toBe("Automatic top-up of credits is off");
    expect(l.detail).toBe(
      "If you enable it, we buy a pack of 15 credits for $9.00 before tax when you have 5 credits or less.",
    );
    expect(l.problem).toBeNull();
    const target = autoTopupLines({
      ...base,
      status: "disabled",
      disabled_reason: "customer",
      target_amount: 400,
    });
    expect(target.detail).toBe(
      "If you enable it, we buy packs of 15 credits when you have 5 credits or less, until you have 40 credits or more. Each pack is $9.00 before tax.",
    );
  });
  it("a failed payment", () => {
    const l = autoTopupLines({ ...base, status: "disabled", disabled_reason: "retries_exhausted" });
    expect(l.problem).toBe(
      "The last automatic top-up payment failed. Check your payment method. Then enable automatic top-up.",
    );
  });
});

describe("autoTopupProblem: no payment method", () => {
  const noPm =
    "You have no payment method that we can charge. Add a payment method so that we can buy credit for you.";
  it("warns while the top-up has no method to charge; off, it says what to do before Enable", () => {
    const t = { status: "active" as const, disabled_reason: null, has_payment_method: false };
    expect(autoTopupProblem(t)).toBe(noPm);
    expect(autoTopupProblem({ ...t, has_payment_method: true })).toBeNull();
    expect(autoTopupProblem({ ...t, status: "disabled", disabled_reason: "customer" })).toBe(
      "You have no payment method that we can charge. Add a payment method before you enable automatic top-up.",
    );
  });
  it("an older API without the field: no warning", () => {
    expect(autoTopupProblem({ status: "active", disabled_reason: null })).toBeNull();
  });
  it("a failed payment comes first", () => {
    expect(
      autoTopupProblem({
        status: "disabled",
        disabled_reason: "payment_declined",
        has_payment_method: false,
      }),
    ).toBe(
      "The last automatic top-up payment failed. Check your payment method. Then enable automatic top-up.",
    );
  });
});

describe("unitPartLines (portal)", () => {
  const u = { name: "API call", plural_name: "API calls", decimals: 0 };
  it("held and unsettled, in the buyer's words; zero or absent is left out", () => {
    expect(unitPartLines({ ...u, held_amount: 900, unsettled_amount: 150 })).toEqual([
      "Reserved for usage in progress: 900 API calls",
      "Used recently, not in the history yet: 150 API calls",
    ]);
    expect(unitPartLines({ ...u, held_amount: 0, unsettled_amount: 1 })).toEqual([
      "Used recently, not in the history yet: 1 API call",
    ]);
    expect(unitPartLines(u)).toEqual([]);
  });
});
