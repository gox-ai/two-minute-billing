import { describe, it, expect } from "vitest";
import { netPerItemDiscounts } from "@/modules/subscriptions/service";

const pct = (bps: number, itemIndexes?: number[]) => ({
  kind: "percentage",
  percentOffBps: bps,
  amountOffMinor: null,
  ...(itemIndexes ? { itemIndexes } : {}),
});
const fixed = (minor: bigint, itemIndexes?: number[]) => ({
  kind: "fixed_amount",
  percentOffBps: null,
  amountOffMinor: minor,
  ...(itemIndexes ? { itemIndexes } : {}),
});
const same = (off: bigint) => off;

describe("netPerItemDiscounts", () => {
  it("an item-scoped coupon matching no item takes nothing off", () => {
    expect(netPerItemDiscounts([12900n], [pct(5155, [])], same)).toBe(12900n);
  });

  it("an item-scoped % reduces only its items", () => {
    // plan 10000 + add-on 2000; 50% on the plan only
    expect(netPerItemDiscounts([10000n, 2000n], [pct(5000, [0])], same)).toBe(7000n);
  });

  it("a whole-amount % still nets the total, as before", () => {
    expect(netPerItemDiscounts([10000n, 2000n], [pct(1000)], same)).toBe(10800n);
  });

  it("an item-scoped fixed amount is capped at its items", () => {
    expect(netPerItemDiscounts([10000n, 2000n], [fixed(5000n, [1])], same)).toBe(10000n);
  });

  it("item-scoped discounts net before whole-amount ones", () => {
    // add-on 2000 → 1000, then 10% of 11000
    expect(netPerItemDiscounts([10000n, 2000n], [pct(1000), pct(5000, [1])], same)).toBe(9900n);
  });
});
