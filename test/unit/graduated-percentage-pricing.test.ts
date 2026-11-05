import { describe, it, expect } from "vitest";
import {
  computeLineAmount,
  unitRate,
  isMeteredPrice,
  type RatablePrice,
} from "@/modules/catalog/pricing";

function gp(tiers: unknown, freeQuantity: number | null = null): RatablePrice {
  return {
    model: "graduated_percentage",
    amountMinor: null,
    tiers,
    packageSize: null,
    freeUnits: null,
    percentageBps: null,
    freeQuantity,
  };
}

// 1% up to 1000, 2% from 1000 to 2000, 3% above.
const t = gp([
  { upToMinor: 1000, rateBps: 100 },
  { upToMinor: 2000, rateBps: 200 },
  { upToMinor: null, rateBps: 300 },
]);

describe("graduated percentage — tier edges", () => {
  it("base 1500 rates 1000 in tier 1 and 500 in tier 2 (10 + 10)", () => {
    expect(computeLineAmount(t, 1500)).toBe(20n);
  });
  it("base exactly on a bound stays in the lower tier (1000 → 10)", () => {
    expect(computeLineAmount(t, 1000)).toBe(10n);
  });
  it("no one-unit step: 0–1000, 1000–2000 at 2000 → 10 + 20", () => {
    expect(computeLineAmount(t, 2000)).toBe(30n);
  });
  it("into the unbounded tier: 3000 → 10 + 20 + 30", () => {
    expect(computeLineAmount(t, 3000)).toBe(60n);
  });
  it("zero base → 0", () => expect(computeLineAmount(t, 0)).toBe(0n));
});

describe("graduated percentage — flat fees", () => {
  const f = gp([
    { upToMinor: 1000, rateBps: 100, flatAmountMinor: 200 },
    { upToMinor: null, rateBps: 200, flatAmountMinor: 300 },
  ]);
  it("a tier flat is charged once the base reaches the tier", () => {
    expect(computeLineAmount(f, 1)).toBe(200n); // 0.01 + 200 → 200
    expect(computeLineAmount(f, 1000)).toBe(210n); // tier 2 not reached
    expect(computeLineAmount(f, 1001)).toBe(510n); // 10 + 200 + 0.02 + 300
  });
  it("no base, no flat", () => expect(computeLineAmount(f, 0)).toBe(0n));
});

describe("graduated percentage — rounding once on the total", () => {
  // Per tier: 0.5 and 0.5 would each round up to 1 (2); once on the total: 1.
  const r = gp([
    { upToMinor: 50, rateBps: 100 },
    { upToMinor: null, rateBps: 100 },
  ]);
  it("50 + 50 at 1% → 1, not 2", () => expect(computeLineAmount(r, 100)).toBe(1n));
  it("half rounds up: 150 at 1% → 2", () => expect(computeLineAmount(r, 150)).toBe(2n));
});

describe("graduated percentage — free quantity does not apply", () => {
  it("free_quantity is ignored, as on percentage", () => {
    expect(computeLineAmount(gp(t.tiers as unknown[], 1000), 1500)).toBe(20n);
  });
  it("unit rate is the charge on one minor unit", () => expect(unitRate(t)).toBe(0n));
});

describe("isMeteredPrice", () => {
  it("usage is metered", () => expect(isMeteredPrice({ model: "usage" })).toBe(true));
  it("meterable models are metered only with an aggregation", () => {
    expect(isMeteredPrice({ model: "percentage", usageAggregation: "sum" })).toBe(true);
    expect(isMeteredPrice({ model: "graduated_percentage", usageAggregation: "sum" })).toBe(true);
    expect(isMeteredPrice({ model: "graduated_percentage", usageAggregation: null })).toBe(false);
    expect(isMeteredPrice({ model: "tiered", usageAggregation: "sum" })).toBe(true);
    expect(isMeteredPrice({ model: "per_unit", usageAggregation: "sum" })).toBe(false);
  });
});
