import { describe, it, expect } from "vitest";
import { reportingMrrBySubscription } from "@/modules/metrics/mrr";
import type { ActiveDiscountForMrr } from "@/modules/subscriptions/service";
import type { prices } from "@db/schema";

/**
 * `reportingMrrBySubscription` is what stands between the cached `subscriptions.mrr`
 * column and every revenue figure the dashboard prints. The
 * rule it encodes: take the column, EXCEPT for cancelled rows, whose column is
 * deliberately 0 and whose pre-churn rate the history and churn series still need.
 */

const price = (o: Partial<typeof prices.$inferSelect>): typeof prices.$inferSelect =>
  ({
    id: "p1",
    type: "recurring",
    model: "flat",
    amountMinor: 12900n,
    interval: "month",
    intervalCount: 1,
    tiers: null,
    packageSize: null,
    freeUnits: null,
    percentageBps: null,
    ...o,
  }) as unknown as typeof prices.$inferSelect;

const item = (subscriptionId: string, o: Partial<typeof prices.$inferSelect> = {}) => ({
  subscriptionId,
  price: price(o),
  quantity: 1,
  snapshot: null,
});

const cadence = (ids: string[]) =>
  new Map(ids.map((id) => [id, { interval: "month", intervalCount: 1 }]));

describe("reportingMrrBySubscription", () => {
  it("takes the cached column for a live subscription — never re-derives it", () => {
    // The column says 9288 (a discounted rate). The items say 12900. Re-deriving
    // from the items is exactly the gross-MRR bug; the column must win.
    const out = reportingMrrBySubscription({
      subs: [{ id: "s1", status: "active", mrr: 9288n }],
      items: [item("s1")],
      discounts: new Map(),
      cadence: cadence(["s1"]),
    });
    expect(out.get("s1")).toBe(9288n);
  });

  it("reports 0 for a trialing subscription, because the column does", () => {
    // A trial is worth MRR 0 and `recomputeSubscriptionMrr` stores that. Rating the
    // items here would resurrect the plan rate.
    const out = reportingMrrBySubscription({
      subs: [{ id: "s1", status: "in_trial", mrr: 0n }],
      items: [item("s1")],
      discounts: new Map(),
      cadence: cadence(["s1"]),
    });
    expect(out.get("s1")).toBe(0n);
  });

  it("re-rates a CANCELLED subscription from its surviving items", () => {
    // Its column is 0, but the historical MRR series needs the rate it
    // carried in the buckets where it was still live, and the cancellation-MRR
    // series measures precisely this number.
    const out = reportingMrrBySubscription({
      subs: [{ id: "s1", status: "cancelled", mrr: 0n }],
      items: [item("s1")],
      discounts: new Map(),
      cadence: cadence(["s1"]),
    });
    expect(out.get("s1")).toBe(12900n);
  });

  it("nets the churned rate against a discount that was restating it", () => {
    const discounts = new Map<string, ActiveDiscountForMrr[]>([
      [
        "s1",
        [
          {
            source: "manual",
            remainingPeriods: 3,
            totalPeriods: 6,
            manualKind: "percentage",
            manualPercentOffBps: 2000,
            manualAmountOffMinor: null,
            manualCurrency: null,
            coupon: null,
          },
        ],
      ],
    ]);
    const out = reportingMrrBySubscription({
      subs: [{ id: "s1", status: "cancelled", mrr: 0n }],
      items: [item("s1")],
      discounts,
      cadence: cadence(["s1"]),
    });
    expect(out.get("s1")).toBe(10320n); // 12900 × 0.8
  });

  it("normalizes a yearly cancelled subscription to a monthly rate", () => {
    const out = reportingMrrBySubscription({
      subs: [{ id: "s1", status: "cancelled", mrr: 0n }],
      items: [item("s1", { amountMinor: 120000n, interval: "year" })],
      discounts: new Map(),
      cadence: new Map([["s1", { interval: "year", intervalCount: 1 }]]),
    });
    expect(out.get("s1")).toBe(10000n);
  });

  it("falls back to the column for a cancelled subscription with no items left", () => {
    const out = reportingMrrBySubscription({
      subs: [{ id: "s1", status: "cancelled", mrr: 4200n }],
      items: [],
      discounts: new Map(),
      cadence: cadence(["s1"]),
    });
    expect(out.get("s1")).toBe(4200n);
  });
});
