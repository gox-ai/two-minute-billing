import { describe, expect, it } from "vitest";
import {
  drawRestoreCost,
  parseMoneyPerCreditE12,
  planGrantCostMinor,
  repayOvershoot,
  splitEventUnits,
  unitDrawCost,
} from "@/modules/credits/credit-cost";
import { overageMinorFor, pickOveragePrice } from "@/modules/credits/settings-rules";

const E12 = 1_000_000_000_000n;
const split = (
  o: Partial<Parameters<typeof splitEventUnits>[0]> & { due: bigint; offered: bigint },
) => splitEventUnits({ policy: "block", priced: false, floor: 0n, ...o });

describe("splitEventUnits: each unit is covered, billed or overdrawn, never two", () => {
  it("credits pay first", () => {
    expect(split({ due: 30n, offered: 50n })).toEqual({
      covered: 30n,
      billed: 0n,
      overdraft: 0n,
      refused: false,
    });
  });
  it("bill with a price: the rest is billed in money", () => {
    expect(split({ due: 30n, offered: 10n, policy: "bill", priced: true })).toEqual({
      covered: 10n,
      billed: 20n,
      overdraft: 0n,
      refused: false,
    });
  });
  it("bill with no price acts as block: refused at a floor of 0", () => {
    expect(split({ due: 30n, offered: 10n, policy: "bill" }).refused).toBe(true);
  });
  it("block never bills, even with a price", () => {
    expect(split({ due: 30n, offered: 10n, priced: true }).refused).toBe(true);
  });
  it("inside the overdraft floor: the rest is an overshoot", () => {
    expect(split({ due: 30n, offered: 10n, floor: 20n })).toEqual({
      covered: 10n,
      billed: 0n,
      overdraft: 20n,
      refused: false,
    });
  });
  it("past the floor: refused whole", () => {
    expect(split({ due: 31n, offered: 10n, floor: 20n }).refused).toBe(true);
  });
  it("a balance already below zero counts against the floor", () => {
    expect(split({ due: 5n, offered: -15n, floor: 20n })).toEqual({
      covered: 0n,
      billed: 0n,
      overdraft: 5n,
      refused: false,
    });
    expect(split({ due: 6n, offered: -15n, floor: 20n }).refused).toBe(true);
  });
  it("an event a hold covers is never refused", () => {
    expect(split({ due: 30n, offered: 10n, coveredByHold: true })).toEqual({
      covered: 10n,
      billed: 0n,
      overdraft: 20n,
      refused: false,
    });
  });
  it("the three parts always add up to what is due", () => {
    for (const offered of [-20n, -1n, 0n, 7n, 40n])
      for (const policy of ["block", "bill"] as const)
        for (const priced of [true, false])
          for (const floor of [0n, 10n, 100n]) {
            const s = split({ due: 25n, offered, policy, priced, floor });
            if (s.refused) continue;
            expect(s.covered + s.billed + s.overdraft).toBe(25n);
            expect(s.billed > 0n && s.overdraft > 0n).toBe(false);
          }
  });
});

describe("repayOvershoot: an unbilled overshoot is paid first, oldest first", () => {
  const parts = [
    { id: "a", units: 10n },
    { id: "b", units: 5n },
  ];
  it("whole parts while the capacity lasts, then one in part", () => {
    expect(repayOvershoot(parts, 12n)).toEqual([
      { id: "a", units: 10n, whole: true },
      { id: "b", units: 2n, whole: false },
    ]);
  });
  it("no capacity: nothing", () => {
    expect(repayOvershoot(parts, 0n)).toEqual([]);
    expect(repayOvershoot(parts, -4n)).toEqual([]);
  });
});

describe("pickOveragePrice and the overage money", () => {
  it("the meter's own price wins, then the unit's, else none", () => {
    expect(pickOveragePrice({ meterUsagePrice: true, unitOverageMinorPerUnitE12: 5n })).toBe(
      "meter_price",
    );
    expect(pickOveragePrice({ meterUsagePrice: false, unitOverageMinorPerUnitE12: 5n })).toBe(
      "unit_overage",
    );
    expect(pickOveragePrice({ meterUsagePrice: false, unitOverageMinorPerUnitE12: null })).toBe(
      "none",
    );
  });
  it("half up to the minor unit", () => {
    // 2.5 credits (decimals 1) at 0.10 USD (10 minor) each = 25 minor.
    expect(overageMinorFor(25n, 10n * E12, 1)).toBe(25n);
    // 0.5 credit at 3 minor = 1.5 → 2.
    expect(overageMinorFor(5n, 3n * E12, 1)).toBe(2n);
  });
});

describe("the per-unit cost basis on plan credits", () => {
  it("parses money per credit and rounds the grant's cost half up", () => {
    const e12 = parseMoneyPerCreditE12("0.40", 2)!;
    expect(e12).toBe(40n * E12);
    // 75 credits at 0.40 = 30.00
    expect(planGrantCostMinor(75n, e12, 0)).toBe(3000n);
    // 7.5 credits (decimals 1) at 0.33 = 2.475 → 2.48
    expect(planGrantCostMinor(75n, parseMoneyPerCreditE12("0.33", 2)!, 1)).toBe(248n);
    expect(parseMoneyPerCreditE12("0", 2)).toBeNull();
  });
  it("revenue on use follows the cumulative rule and closes the grant at 0", () => {
    const g = { amount: 75n, costBasisMinor: 3000n, remainingUnits: 75n, remainingCost: 3000n };
    let units = 0n;
    let cost = 0n;
    for (const take of [7n, 13n, 30n, 25n]) {
      const c = unitDrawCost(
        { ...g, remainingUnits: g.amount - units, remainingCost: g.costBasisMinor - cost },
        take,
      );
      units += take;
      cost += c;
    }
    expect(units).toBe(75n);
    expect(cost).toBe(3000n);
  });
});

describe("drawRestoreCost: a correction gives back what the draw took", () => {
  it("in proportion, and the exact rest with the last units", () => {
    const draw = { units: 30n, costMinor: 100n };
    const a = drawRestoreCost(draw, { units: 0n, costMinor: 0n }, 10n);
    expect(a).toBe(33n);
    const b = drawRestoreCost(draw, { units: 10n, costMinor: a }, 20n);
    expect(a + b).toBe(100n);
  });
});
