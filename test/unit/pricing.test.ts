import { describe, it, expect } from "vitest";
import {
  computeLineAmount,
  effectiveFreeQuantity,
  ratableFromSnapshot,
  snapshotPrice,
  unitRate,
} from "@/modules/catalog/pricing";
import type { prices } from "@db/schema";

type Price = typeof prices.$inferSelect;
function p(
  model: string,
  o: { amountMinor?: number; tiers?: unknown[]; freeQuantity?: number },
): Price {
  return {
    model,
    amountMinor: o.amountMinor != null ? BigInt(o.amountMinor) : null,
    tiers: o.tiers ?? null,
    freeQuantity: o.freeQuantity ?? null,
  } as unknown as Price;
}

describe("computeLineAmount — flat", () => {
  it("is fixed regardless of quantity", () => {
    const price = p("flat", { amountMinor: 4900 });
    expect(computeLineAmount(price, 1)).toBe(4900n);
    expect(computeLineAmount(price, 5)).toBe(4900n);
    expect(computeLineAmount(price, 0)).toBe(4900n);
  });
  it("defaults to 0 when amount missing", () => {
    expect(computeLineAmount(p("flat", {}), 3)).toBe(0n);
  });
});

describe("computeLineAmount — per_unit / usage", () => {
  it("scales linearly with quantity", () => {
    expect(computeLineAmount(p("per_unit", { amountMinor: 1000 }), 3)).toBe(3000n);
    expect(computeLineAmount(p("usage", { amountMinor: 5 }), 100)).toBe(500n);
  });
  it("is 0 at zero quantity", () => {
    expect(computeLineAmount(p("per_unit", { amountMinor: 1000 }), 0)).toBe(0n);
  });
});

describe("computeLineAmount — volume (all units at the tier the qty lands in + that tier flat)", () => {
  const vol = p("volume", {
    tiers: [
      { upToMinor: 100, unitAmountMinor: 200, flatAmountMinor: 1000 },
      { upToMinor: 200, unitAmountMinor: 100, flatAmountMinor: 0 },
      { upToMinor: null, unitAmountMinor: 50, flatAmountMinor: 5000 },
    ],
  });
  it("zero usage → 0 (no flat fee)", () => {
    expect(computeLineAmount(vol, 0)).toBe(0n);
  });
  it("within first tier includes that tier flat", () => {
    expect(computeLineAmount(vol, 1)).toBe(1200n); // 1*200 + 1000
    expect(computeLineAmount(vol, 100)).toBe(21000n); // 100*200 + 1000
  });
  it("second tier (boundary 101 and 200)", () => {
    expect(computeLineAmount(vol, 101)).toBe(10100n); // 101*100 + 0
    expect(computeLineAmount(vol, 200)).toBe(20000n); // 200*100 + 0
  });
  it("unbounded top tier", () => {
    expect(computeLineAmount(vol, 300)).toBe(20000n); // 300*50 + 5000
  });
});

describe("computeLineAmount — tiered/graduated (each tier billed at its own rate)", () => {
  const grad = p("tiered", {
    tiers: [
      { upToMinor: 10, unitAmountMinor: 1000, flatAmountMinor: 200 },
      { upToMinor: 20, unitAmountMinor: 500, flatAmountMinor: 300 },
      { upToMinor: null, unitAmountMinor: 500, flatAmountMinor: 300 },
    ],
  });
  it("zero → 0", () => expect(computeLineAmount(grad, 0)).toBe(0n));
  it("first tier only", () => {
    expect(computeLineAmount(grad, 1)).toBe(1200n); // 1*1000 + 200
    expect(computeLineAmount(grad, 10)).toBe(10200n); // 10*1000 + 200
  });
  it("spanning tiers accumulates each tier flat", () => {
    expect(computeLineAmount(grad, 11)).toBe(11000n); // 10200 + (1*500+300)
    expect(computeLineAmount(grad, 21)).toBe(16300n); // +tier2 full +tier3 1 unit
  });
});

describe("computeLineAmount — degenerate inputs", () => {
  it("tiered/volume with no tiers → 0", () => {
    expect(computeLineAmount(p("tiered", {}), 5)).toBe(0n);
    expect(computeLineAmount(p("volume", {}), 5)).toBe(0n);
  });
  it("unknown model → 0", () => {
    expect(computeLineAmount(p("mystery", { amountMinor: 999 }), 5)).toBe(0n);
  });
});

describe("computeLineAmount — free_quantity comes off the quantity before rating", () => {
  const tiers = [
    { upToMinor: 5, unitAmountMinor: 100 },
    { upToMinor: null, unitAmountMinor: 80 },
  ];
  it("per_unit: 10 seats, 3 free, 100 each → 700", () => {
    expect(computeLineAmount(p("per_unit", { amountMinor: 100, freeQuantity: 3 }), 10)).toBe(700n);
  });
  it("free covers the whole quantity → 0", () => {
    expect(computeLineAmount(p("per_unit", { amountMinor: 100, freeQuantity: 12 }), 10)).toBe(0n);
    expect(computeLineAmount(p("tiered", { tiers, freeQuantity: 10 }), 10)).toBe(0n);
  });
  it("tiered: 10 units, 3 free → 7 billable fill tier 1 first (5×100 + 2×80)", () => {
    expect(computeLineAmount(p("tiered", { tiers, freeQuantity: 3 }), 10)).toBe(660n);
  });
  it("volume: the band is picked by the billable count", () => {
    // 7 billable → top band at 80; without the free units, 10 at 80 = 800.
    expect(computeLineAmount(p("volume", { tiers, freeQuantity: 3 }), 10)).toBe(560n);
    // 6 units, 2 free → 4 billable stays in the first band at 100.
    expect(computeLineAmount(p("volume", { tiers, freeQuantity: 2 }), 6)).toBe(400n);
  });
  it("stairstep: 0 billable → 0", () => {
    const st = [{ upToMinor: null, flatAmountMinor: 9000 }];
    expect(computeLineAmount(p("stairstep", { tiers: st, freeQuantity: 5 }), 5)).toBe(0n);
    expect(computeLineAmount(p("stairstep", { tiers: st, freeQuantity: 5 }), 6)).toBe(9000n);
  });
  it("flat ignores it", () => {
    expect(computeLineAmount(p("flat", { amountMinor: 4900, freeQuantity: 3 }), 1)).toBe(4900n);
  });
  it("unitRate states the rate, not 0", () => {
    expect(unitRate(p("per_unit", { amountMinor: 100, freeQuantity: 3 }))).toBe(100n);
  });
});

describe("effectiveFreeQuantity — item value wins, else the price's frozen at attach", () => {
  const price = {
    ...p("per_unit", { amountMinor: 100, freeQuantity: 2 }),
    id: "x",
    publicId: "x",
    type: "recurring",
    currency: "USD",
    interval: "month",
    intervalCount: 1,
    usageAggregation: null,
    packageSize: null,
    freeUnits: null,
    percentageBps: null,
  } as unknown as Price;
  const snap = snapshotPrice(price);
  it("snapshot carries the price value", () => expect(snap.freeQuantity).toBe(2));
  it("null item → price value", () => {
    expect(effectiveFreeQuantity(null, snap)).toBe(2);
    expect(computeLineAmount(ratableFromSnapshot(snap, null), 10)).toBe(800n);
  });
  it("item value overrides, 0 included", () => {
    expect(computeLineAmount(ratableFromSnapshot(snap, 3), 10)).toBe(700n);
    expect(computeLineAmount(ratableFromSnapshot(snap, 0), 10)).toBe(1000n);
  });
  it("a snapshot from before the field existed → 0", () => {
    const { freeQuantity: _drop, ...old } = snap;
    expect(computeLineAmount(ratableFromSnapshot(old, null), 10)).toBe(1000n);
  });
});
