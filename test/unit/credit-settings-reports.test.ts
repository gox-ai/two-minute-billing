import { describe, it, expect } from "vitest";
import {
  foldRollForward,
  monthsBetween,
  overageMinorFor,
  pickOveragePrice,
  pickOverdraftLimit,
  policiesIssue,
  rollBucketOf,
  voidReasonIssue,
} from "@/modules/credits/settings-rules";
import { E12 } from "@/modules/credits/units";

describe("pickOverdraftLimit", () => {
  const subs = [{ productIds: ["basic"] }, { productIds: ["pro"] }];
  it("customer, then the oldest subscription's plan, then the unit, then 0", () => {
    const byProduct = new Map([
      ["basic", 30n],
      ["pro", 90n],
    ]);
    expect(pickOverdraftLimit({ customer: 0n, unit: 10n, byProduct }, subs)).toEqual({
      steps: 0n,
      source: "customer",
    });
    expect(pickOverdraftLimit({ unit: 10n, byProduct }, subs)).toEqual({ steps: 30n, source: "plan" });
    expect(pickOverdraftLimit({ unit: 10n, byProduct: new Map() }, subs)).toEqual({
      steps: 10n,
      source: "unit",
    });
    expect(pickOverdraftLimit({ byProduct: new Map() }, [])).toEqual({ steps: 0n, source: "default" });
  });
  it("a plan row the customer is not on does not apply", () => {
    expect(pickOverdraftLimit({ byProduct: new Map([["pro", 5n]]) }, [{ productIds: ["basic"] }])).toEqual(
      { steps: 0n, source: "default" },
    );
  });
});

describe("overage price", () => {
  it("a meter's own usage price wins over the unit's overage price", () => {
    expect(pickOveragePrice({ meterUsagePrice: true, unitOverageMinorPerUnitE12: E12 })).toBe(
      "meter_price",
    );
    expect(pickOveragePrice({ meterUsagePrice: false, unitOverageMinorPerUnitE12: E12 })).toBe(
      "unit_overage",
    );
    expect(pickOveragePrice({ meterUsagePrice: false, unitOverageMinorPerUnitE12: null })).toBe("none");
  });
  it("money for overage rounds half up at the unit's precision", () => {
    // 4.5 minor per credit, 1 decimal: 2.5 credits = 25 steps → 11.25 → 11; 2.7 → 12.15 → 12.
    expect(overageMinorFor(25n, 4_500_000_000_000n, 1)).toBe(11n);
    expect(overageMinorFor(27n, 4_500_000_000_000n, 1)).toBe(12n);
    expect(overageMinorFor(1n, 5_000_000_000_000n, 1)).toBe(1n);
  });
  it("only a unit with no rate takes the unit policies", () => {
    expect(policiesIssue({ minorPerUnitE12: E12 }, { overageMinorPerUnitE12: E12 })).toMatch(/overage/);
    expect(policiesIssue({ minorPerUnitE12: E12 }, { overdraftSteps: 1n })).toMatch(/overdraft/);
    expect(policiesIssue({ minorPerUnitE12: E12 }, { negativeAtReset: "forgive" })).toMatch(/Forgive/);
    expect(policiesIssue({ minorPerUnitE12: E12 }, { overdraftSteps: 0n, negativeAtReset: "carry" })).toBe(
      null,
    );
    expect(policiesIssue({ minorPerUnitE12: null }, { overageMinorPerUnitE12: E12, overdraftSteps: 9n })).toBe(
      null,
    );
  });
});

describe("voidReasonIssue", () => {
  it("other needs a note; a note needs a reason", () => {
    expect(voidReasonIssue({ reason: "other" })).toMatch(/note/);
    expect(voidReasonIssue({ note: "x" })).toMatch(/reason/);
    expect(voidReasonIssue({ reason: "fraud" })).toBe(null);
    expect(voidReasonIssue({})).toBe(null);
  });
});

describe("deferred revenue roll-forward", () => {
  it("maps every movement kind to one line", () => {
    expect(rollBucketOf("grant")).toBe("sold");
    expect(rollBucketOf("activate")).toBe("sold");
    expect(rollBucketOf("draw")).toBe("recognised");
    expect(rollBucketOf("restore")).toBe("recognised");
    expect(rollBucketOf("expire")).toBe("breakage");
    expect(rollBucketOf("void")).toBe("refunds");
    expect(rollBucketOf("rollover_in")).toBe("other");
    expect(rollBucketOf("rollover_out")).toBe("other");
  });
  it("months across a year end", () => {
    expect(monthsBetween("2026-11", "2027-02")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(monthsBetween("2026-05", "2026-05")).toEqual(["2026-05"]);
  });
  it("reconciles: opening + sold − recognised − breakage − refunds + other = closing, chained", () => {
    const rows = foldRollForward({
      months: ["2026-01", "2026-02", "2026-03"],
      openings: [{ currency: "USD", unit: "credit", cost: 100n }],
      flows: [
        { month: "2026-01", currency: "USD", unit: "credit", kind: "activate", cost: 900n },
        { month: "2026-01", currency: "USD", unit: "credit", kind: "draw", cost: -300n },
        { month: "2026-02", currency: "USD", unit: "credit", kind: "restore", cost: 50n },
        { month: "2026-02", currency: "USD", unit: "credit", kind: "void", cost: -400n },
        { month: "2026-03", currency: "USD", unit: "credit", kind: "expire", cost: -350n },
        { month: "2026-02", currency: "INR", unit: "money", kind: "grant", cost: 1000n },
      ],
    });
    const usd = rows.filter((r) => r.currency === "USD");
    expect(usd.map((r) => [r.opening, r.closing])).toEqual([
      [100n, 700n],
      [700n, 350n],
      [350n, 0n],
    ]);
    expect(usd[0]).toMatchObject({ sold: 900n, recognised: 300n });
    expect(usd[1]).toMatchObject({ recognised: -50n, refunds: 400n });
    expect(usd[2]).toMatchObject({ breakage: 350n });
    for (const r of rows)
      expect(r.opening + r.sold - r.recognised - r.breakage - r.refunds + r.other).toBe(r.closing);
    const inr = rows.filter((r) => r.currency === "INR");
    expect(inr.map((r) => r.closing)).toEqual([0n, 1000n, 1000n]);
  });
});
