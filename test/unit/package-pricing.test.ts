import { describe, it, expect } from "vitest";
import { computeLineAmount } from "@/modules/catalog/pricing";
import type { prices } from "@db/schema";

type Price = typeof prices.$inferSelect;
function pkg(o: { amountMinor: number; packageSize: number; freeUnits?: number }): Price {
  return {
    model: "package",
    amountMinor: BigInt(o.amountMinor),
    tiers: null,
    packageSize: o.packageSize,
    freeUnits: o.freeUnits ?? 0,
  } as unknown as Price;
}

describe("package model (amount 100/pkg, size 10)", () => {
  // 121 units, size 10, free 0 → 13 packages × 100 = 1300.
  it("121 units, no free → 1300 (ceil(121/10)=13 pkgs)", () => {
    expect(computeLineAmount(pkg({ amountMinor: 100, packageSize: 10 }), 121)).toBe(1300n);
  });
  // With free_units 10 → ceil(111/10)=12 → 1200.
  it("121 units, 10 free → 1200", () => {
    expect(computeLineAmount(pkg({ amountMinor: 100, packageSize: 10, freeUnits: 10 }), 121)).toBe(
      1200n,
    );
  });
});

describe("package model — boundaries", () => {
  const p = pkg({ amountMinor: 500, packageSize: 100 }); // $5 per 100 units
  it("0 units → 0", () => expect(computeLineAmount(p, 0)).toBe(0n));
  it("exactly 1 package (100) → 500", () => expect(computeLineAmount(p, 100)).toBe(500n));
  it("1 over a package (101) rounds up to 2 packages → 1000", () =>
    expect(computeLineAmount(p, 101)).toBe(1000n));
  it("1 unit → 1 package (round up) → 500", () => expect(computeLineAmount(p, 1)).toBe(500n));
});

describe("package model — free units", () => {
  const p = pkg({ amountMinor: 200, packageSize: 50, freeUnits: 50 }); // first 50 free, then $2/50
  it("within free allotment → 0", () => expect(computeLineAmount(p, 50)).toBe(0n));
  it("1 over free → 1 package → 200", () => expect(computeLineAmount(p, 51)).toBe(200n));
  it("150 units → ceil(100/50)=2 pkgs → 400", () => expect(computeLineAmount(p, 150)).toBe(400n));
});

describe("package model — degenerate", () => {
  it("no package size → 0", () => {
    expect(
      computeLineAmount(
        {
          model: "package",
          amountMinor: 100n,
          packageSize: null,
          freeUnits: 0,
          tiers: null,
        } as unknown as Price,
        100,
      ),
    ).toBe(0n);
  });
});
