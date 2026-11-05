import { describe, it, expect } from "vitest";
import { absoluteThreshold, crossed, recovered } from "@/modules/usage-controls/alerts";
import {
  effectiveCustomerAmount,
  nestingIssue,
  resolveApplicable,
  type SpendLimit,
} from "@/modules/usage-controls/limits";
import { calendarWindow, runwayFrom } from "@/modules/usage-controls/measure";

const E12 = 1_000_000_000_000n;

describe("crossing", () => {
  it("rising: fires every t with prev < t ≤ cur", () => {
    expect(crossed([50n, 80n, 100n], 40n, 100n, false)).toEqual([50n, 80n, 100n]);
    expect(crossed([50n, 80n, 100n], 50n, 79n, false)).toEqual([]);
    expect(crossed([50n, 80n, 100n], 79n, 80n, false)).toEqual([80n]);
  });
  it("rising from no observation starts at 0, and equal to the threshold fires", () => {
    expect(crossed([0n, 10n], null, 10n, false)).toEqual([10n]);
  });
  it("falling: fires every t with cur ≤ t < prev; the first observation fires at once", () => {
    expect(crossed([200n, 100n], 500n, 100n, true)).toEqual([200n, 100n]);
    expect(crossed([200n], 200n, 150n, true)).toEqual([]);
    expect(crossed([200n], null, 150n, true)).toEqual([200n]);
  });
  it("recovered: back across an in-alarm threshold", () => {
    expect(recovered([200n], 201n, true)).toEqual([200n]);
    expect(recovered([200n], 200n, true)).toEqual([]);
    expect(recovered([80n], 79n, false)).toEqual([80n]);
  });
  it("percent thresholds round half-up on the reference", () => {
    expect(absoluteThreshold({ value: 80, unit: "percent" }, 1000n * E12)).toBe(800n * E12);
    expect(absoluteThreshold({ value: 50, unit: "percent" }, 3n)).toBe(2n);
    expect(absoluteThreshold({ value: 50, unit: "percent" }, null)).toBeNull();
    expect(absoluteThreshold({ value: 7, unit: "days" }, null)).toBe(7n * E12);
  });
});

describe("nesting", () => {
  it("day ≤ week ≤ month, period only when the term is a month or longer", () => {
    expect(nestingIssue({ day: 600n, week: 500n }, true)?.message).toBe(
      "The daily limit cannot be more than the weekly limit.",
    );
    expect(nestingIssue({ week: 700n, month: 600n }, true)?.message).toBe(
      "The weekly limit cannot be more than the monthly limit.",
    );
    expect(nestingIssue({ day: 10n, month: 5n }, false)?.interval).toBe("day");
    expect(nestingIssue({ month: 700n, period: 600n }, true)?.interval).toBe("month");
    expect(nestingIssue({ month: 700n, period: 600n }, false)).toBeNull();
    expect(nestingIssue({ day: 5n, week: 5n, month: 5n }, true)).toBeNull();
  });
});

describe("tiers", () => {
  const t0 = new Date("2026-11-01T00:00:00Z");
  const t1 = new Date("2026-11-02T00:00:00Z");
  it("the tier raises an older hand-set limit", () => {
    expect(
      effectiveCustomerAmount(
        { amountMinor: 100n, updatedAt: t0 },
        { amountMinor: 500n, reachedAt: t1 },
      ),
    ).toBe(500n);
  });
  it("a hand-set limit changed after the tier wins, even when lower", () => {
    expect(
      effectiveCustomerAmount(
        { amountMinor: 100n, updatedAt: t1 },
        { amountMinor: 500n, reachedAt: t0 },
      ),
    ).toBe(100n);
  });
  it("either alone applies", () => {
    expect(effectiveCustomerAmount(null, { amountMinor: 500n, reachedAt: t0 })).toBe(500n);
    expect(effectiveCustomerAmount({ amountMinor: 100n, updatedAt: t0 }, null)).toBe(100n);
    expect(effectiveCustomerAmount(null, null)).toBeNull();
  });
});

describe("applicable limits", () => {
  const row = (over: Partial<SpendLimit>): SpendLimit =>
    ({
      id: over.publicId ?? "x",
      publicId: "slim_x",
      scope: "property",
      subscriptionId: null,
      propertyKey: "user",
      propertyValue: null,
      meterIds: null,
      interval: "day",
      amountMinor: 100n,
      currency: "USD",
      mode: "hard",
      setBy: "operator",
      active: true,
      updatedAt: new Date(0),
      ...over,
    }) as SpendLimit;
  const req = (scope: Record<string, string> | null) => ({
    meterId: null,
    subscriptionIds: null,
    scope,
    currency: "USD",
  });
  it("an exact-value row overrides the each-value row for that value only", () => {
    const loaded = {
      rows: [
        row({ publicId: "slim_each" }),
        row({ publicId: "slim_vip", propertyValue: "vip", amountMinor: 900n }),
      ],
      tiers: new Map(),
    };
    expect(resolveApplicable(loaded, req({ user: "vip" })).applicable.map((l) => l.id)).toEqual([
      "slim_vip",
    ]);
    expect(
      resolveApplicable(loaded, req({ user: "bob" })).applicable.map((l) => [
        l.id,
        l.propertyValue,
      ]),
    ).toEqual([["slim_each", "bob"]]);
  });
  it("a property missing from the request is not_checked, never applied", () => {
    const r = resolveApplicable({ rows: [row({})], tiers: new Map() }, req(null));
    expect(r.applicable).toEqual([]);
    expect(r.notChecked.length).toBe(1);
  });
});

describe("runway and intervals", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  it("floor(balance × 7 ÷ spend7d), null without enough usage", () => {
    expect(
      runwayFrom({ balanceMinor: 5600n, spend7dMinor: 1400n, enoughUsage: true, now }).runwayDays,
    ).toBe(28);
    expect(
      runwayFrom({ balanceMinor: 100n, spend7dMinor: 1400n, enoughUsage: true, now }).runwayDays,
    ).toBe(0);
    expect(
      runwayFrom({ balanceMinor: 5600n, spend7dMinor: 0n, enoughUsage: true, now }).runwayDays,
    ).toBeNull();
    expect(
      runwayFrom({ balanceMinor: 5600n, spend7dMinor: 1400n, enoughUsage: false, now }).runwayDays,
    ).toBeNull();
    expect(
      runwayFrom({ balanceMinor: 0n, spend7dMinor: 700n, enoughUsage: true, now, extraMinor: 500n })
        .runwayDays,
    ).toBe(5);
  });
  it("calendar windows follow the business zone; the week starts on Monday", () => {
    expect(calendarWindow("day", now, "Asia/Kolkata").start.toISOString()).toBe(
      "2026-11-03T18:30:00.000Z",
    );
    expect(calendarWindow("week", now, "UTC").start.toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(calendarWindow("month", now, "UTC").end.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });
});
