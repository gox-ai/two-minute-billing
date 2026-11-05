import { describe, it, expect } from "vitest";
import {
  computeRecurringAmount,
  netMrrForDiscounts,
  type ActiveDiscountForMrr,
} from "@/modules/subscriptions/service";
import type { prices } from "@db/schema";

type Price = typeof prices.$inferSelect;
const price = (o: Partial<Price> = {}): Price =>
  ({
    type: "recurring",
    model: "flat",
    amountMinor: 9700n,
    interval: "month",
    intervalCount: 1,
    tiers: null,
    packageSize: null,
    freeUnits: null,
    percentageBps: null,
    ...o,
  }) as unknown as Price;

const coupon = (
  kind: "percentage" | "fixed_amount",
  off: number,
  durationType = "forever",
  totalPeriods: number | null = null,
): ActiveDiscountForMrr => ({
  source: "coupon",
  remainingPeriods: totalPeriods,
  totalPeriods,
  manualKind: null,
  manualPercentOffBps: null,
  manualAmountOffMinor: null,
  manualCurrency: null,
  coupon: {
    kind,
    percentOffBps: kind === "percentage" ? off : null,
    amountOffMinor: kind === "fixed_amount" ? BigInt(off) : null,
    currency: "USD",
    durationType,
  },
});

const base = { status: "active", billingPeriodUnit: "month", billingPeriod: 1 };

describe("computeRecurringAmount", () => {
  it("nets a forever percentage coupon: 9700 at 51.55% off bills 4700", () => {
    expect(
      computeRecurringAmount({
        ...base,
        items: [{ price: price(), quantity: 1 }],
        discounts: [coupon("percentage", 5155)],
      }),
    ).toBe(4700n);
  });

  it("ignores a once coupon", () => {
    expect(
      computeRecurringAmount({
        ...base,
        items: [{ price: price(), quantity: 1 }],
        discounts: [coupon("fixed_amount", 500, "once")],
      }),
    ).toBe(9700n);
  });

  it("subtracts fixed amounts per period, un-normalised, before percentages", () => {
    // Yearly: (120000 - 20000) × 0.9 = 90000, whatever order the rows arrive in.
    expect(
      computeRecurringAmount({
        status: "active",
        billingPeriodUnit: "year",
        billingPeriod: 1,
        items: [{ price: price({ amountMinor: 120000n, interval: "year" }), quantity: 1 }],
        discounts: [coupon("percentage", 1000), coupon("fixed_amount", 20000)],
      }),
    ).toBe(90000n);
  });

  it("is null when an item recurs on a different cadence than the subscription", () => {
    expect(
      computeRecurringAmount({
        ...base,
        items: [
          { price: price(), quantity: 1 },
          { price: price({ amountMinor: 1200n, interval: "year" }), quantity: 1 },
        ],
        discounts: [],
      }),
    ).toBeNull();
  });

  it("is null when cancelled, and not zeroed in trial or paused", () => {
    const items = [{ price: price(), quantity: 1 }];
    expect(
      computeRecurringAmount({ ...base, status: "cancelled", items, discounts: [] }),
    ).toBeNull();
    expect(computeRecurringAmount({ ...base, status: "in_trial", items, discounts: [] })).toBe(
      9700n,
    );
    expect(computeRecurringAmount({ ...base, status: "paused", items, discounts: [] })).toBe(9700n);
  });

  it("skips usage and one-time items, multiplies per-unit by quantity", () => {
    expect(
      computeRecurringAmount({
        ...base,
        items: [
          { price: price({ model: "per_unit", amountMinor: 1000n }), quantity: 3 },
          { price: price({ model: "usage", amountMinor: 50n }), quantity: 100 },
          { price: price({ type: "one_time", interval: null }), quantity: 1 },
        ],
        discounts: [],
      }),
    ).toBe(3000n);
  });
});

describe("netMrrForDiscounts after the shared-helper refactor", () => {
  it("still normalises a yearly fixed discount to monthly before netting", () => {
    const d = [
      { kind: "percentage", percentOffBps: 1000, amountOffMinor: null, currency: "USD" },
      { kind: "fixed_amount", percentOffBps: null, amountOffMinor: 12000n, currency: "USD" },
    ];
    // (10000 - 12000/12) × 0.9 = 8100
    expect(netMrrForDiscounts(10000n, d, "year", 1)).toBe(8100n);
  });
});
