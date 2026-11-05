import { describe, it, expect } from "vitest";
import {
  computeLineAmount,
  meteredGrowth,
  rateMeteredQuantity,
  ratableFromSnapshot,
  usagePricingIssues,
  isMeteredPrice,
  type PriceSnapshot,
} from "@/modules/catalog/pricing";
import { recurringLevel, timeWeightedLevel, type LevelEvent } from "@/modules/metering/levels";

const H = 3_600_000;
const snap = (over: Partial<PriceSnapshot>): PriceSnapshot => ({
  priceId: "p",
  publicId: "p",
  model: "tiered",
  type: "recurring",
  currency: "INR",
  amountMinor: null,
  interval: "month",
  intervalCount: 1,
  usageAggregation: "sum",
  tiers: [
    { upToMinor: 1000, unitAmountMinor: 100 },
    { upToMinor: 5000, unitAmountMinor: 50 },
    { upToMinor: null, unitAmountMinor: 20 },
  ],
  packageSize: null,
  freeUnits: null,
  percentageBps: null,
  ...over,
});
const rate = (s: PriceSnapshot, q: number, free: number | null = null) =>
  rateMeteredQuantity({ snapshot: s, itemFreeQuantity: free, quantity: BigInt(q) });
const ev = (
  at: number,
  quantity: number,
  op: "add" | "remove" = "add",
  key?: string,
): LevelEvent => ({
  at,
  quantity: BigInt(quantity),
  uniqueKey: key ?? null,
  operation: op,
});

describe("metered pricing", () => {
  it("rates each model on measured usage", () => {
    expect(rate(snap({}), 6200).amountMinor).toBe(324_000n);
    expect(rate(snap({}), 6200, 200).amountMinor).toBe(320_000n);
    expect(rate(snap({ model: "volume" }), 6200).amountMinor).toBe(124_000n);
    // A quantity on a bound stays in the lower tier.
    expect(rate(snap({ model: "volume" }), 1000).amountMinor).toBe(100_000n);
    expect(
      rate(snap({ model: "package", amountMinor: 3000, packageSize: 100, freeUnits: 50 }), 1234)
        .amountMinor,
    ).toBe(36_000n);
  });

  it("bills 0 and no tier rows for zero usage, even with a first-tier flat fee", () => {
    const flat = snap({ tiers: [{ upToMinor: null, unitAmountMinor: 10, flatAmountMinor: 500 }] });
    for (const model of ["tiered", "volume", "stairstep", "package", "usage", "percentage"]) {
      const r = rate({ ...flat, model, amountMinor: 10, packageSize: 10, percentageBps: 100 }, 0);
      expect(r.amountMinor).toBe(0n);
      expect(r.tiers ?? []).toEqual([]);
    }
  });

  it("tier rows add up to the amount and carry no one-step counting", () => {
    const r = rate(snap({}), 6200);
    expect(r.tiers!.map((t) => [t.from, t.to, t.units])).toEqual([
      [1n, 1000n, 1000n],
      [1001n, 5000n, 4000n],
      [5001n, null, 1200n],
    ]);
    expect(r.tiers!.reduce((s, t) => s + t.amountMinor, 0n)).toBe(r.amountMinor);
  });

  it("amount always equals computeLineAmount (property)", () => {
    const models = ["tiered", "volume", "stairstep", "package", "usage"];
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let i = 0; i < 500; i++) {
      const s = snap({
        model: models[rnd(models.length)]!,
        amountMinor: rnd(500),
        packageSize: 1 + rnd(50),
        freeUnits: rnd(20),
        tiers: [
          { upToMinor: 10 + rnd(100), unitAmountMinor: rnd(90), flatAmountMinor: rnd(300) },
          { upToMinor: null, unitAmountMinor: rnd(40), flatAmountMinor: rnd(200) },
        ],
      });
      const q = rnd(400);
      const free = rnd(3) === 0 ? rnd(30) : null;
      const r = rate(s, q, free);
      expect(r.amountMinor).toBe(q > 0 ? computeLineAmount(ratableFromSnapshot(s, free), q) : 0n);
      if (r.tiers?.length && s.model !== "stairstep")
        expect(r.tiers.reduce((a, t) => a + t.amountMinor, 0n)).toBe(r.amountMinor);
    }
  });

  it("knows which prices are metered and refuses bad usage fields", () => {
    expect(isMeteredPrice({ model: "tiered", usageAggregation: "sum" })).toBe(true);
    expect(isMeteredPrice({ model: "tiered", usageAggregation: null })).toBe(false);
    expect(isMeteredPrice({ model: "per_unit", usageAggregation: "sum" })).toBe(false);
    expect(usagePricingIssues({ model: "flat", usageAggregation: "sum" })[0]?.field).toBe(
      "usage_aggregation",
    );
    expect(
      usagePricingIssues({ model: "usage", usageAggregation: "count", usageRecurring: true })[0]
        ?.field,
    ).toBe("usage_recurring");
    expect(
      usagePricingIssues({ model: "usage", usageAggregation: "sum", usageTimeUnit: "hour" })[0]
        ?.field,
    ).toBe("usage_time_unit");
    expect(
      usagePricingIssues({ model: "volume", usageAggregation: "unique", usageRecurring: true }),
    ).toEqual([]);
  });

  it("classifies growth for a projection", () => {
    expect(meteredGrowth({ model: "usage", usageAggregation: "sum" })).toBe("additive");
    expect(meteredGrowth({ model: "usage", usageAggregation: "count" })).toBe("additive");
    expect(meteredGrowth({ model: "usage", usageAggregation: "max" })).toBe("level");
    expect(meteredGrowth({ model: "usage", usageAggregation: "unique" })).toBe("level");
    expect(meteredGrowth({ model: "usage", usageAggregation: "sum", usageRecurring: true })).toBe(
      "level",
    );
    expect(meteredGrowth({ model: "usage", usageAggregation: "weighted_sum" })).toBe(
      "time_weighted",
    );
  });
});

describe("levels", () => {
  it("recurring sum bills the peak and keeps a negative running level", () => {
    const r = recurringLevel({
      aggregation: "sum",
      carriedIn: 0n,
      events: [ev(1, 10), ev(2, -15), ev(3, 8)],
      startMs: 0,
    });
    expect(r.closing).toBe(3n);
    expect(r.peak).toBe(10n);
    expect(r.quantity).toBe(10n);
    const neg = recurringLevel({ aggregation: "sum", carriedIn: -5n, events: [], startMs: 0 });
    expect(neg.quantity).toBe(0n);
  });

  it("last bills the closing level; max includes the carried-in level", () => {
    const e = [ev(1, 4), ev(2, 2)];
    expect(
      recurringLevel({ aggregation: "last", carriedIn: 9n, events: e, startMs: 0 }).quantity,
    ).toBe(2n);
    expect(
      recurringLevel({ aggregation: "max", carriedIn: 9n, events: e, startMs: 0 }).quantity,
    ).toBe(9n);
  });

  it("unique: a swap counts once, a repeated add and an absent remove do nothing", () => {
    const keys = new Set(["a"]);
    const r = recurringLevel({
      aggregation: "unique",
      carriedIn: 1n,
      activeKeys: keys,
      events: [
        ev(1, 1, "remove", "a"),
        ev(2, 1, "add", "b"),
        ev(3, 1, "add", "b"),
        ev(4, 1, "remove", "z"),
      ],
      startMs: 0,
    });
    expect(r.peak).toBe(1n);
    expect(r.closing).toBe(1n);
    // Same instant: applied together, so still one seat.
    const same = recurringLevel({
      aggregation: "unique",
      carriedIn: 1n,
      activeKeys: new Set(["a"]),
      events: [ev(5, 1, "add", "b"), ev(5, 1, "remove", "a")],
      startMs: 0,
    });
    expect(same.peak).toBe(1n);
  });

  it("an event at the window start replaces the carried-in level", () => {
    const r = recurringLevel({
      aggregation: "sum",
      carriedIn: 5n,
      events: [ev(0, -5)],
      startMs: 0,
    });
    expect(r.peak).toBe(0n);
  });

  it("weighted_sum: the 30-day example to the unit-hour", () => {
    const r = timeWeightedLevel({
      carriedIn: 100n,
      events: [ev(240 * H, 50), ev(600 * H, -30)],
      startMs: 0,
      endMs: 720 * H,
      unitMs: H,
    });
    expect(r.quantity).toBe(92_400n);
    expect(r.closing).toBe(120n);
  });

  it("weighted_sum rounds half-up once and ignores zero-length intervals", () => {
    const half = timeWeightedLevel({
      carriedIn: 1n,
      events: [],
      startMs: 0,
      endMs: H / 2,
      unitMs: H,
    });
    expect(half.quantity).toBe(1n);
    const under = timeWeightedLevel({
      carriedIn: 1n,
      events: [],
      startMs: 0,
      endMs: H / 2 - 1,
      unitMs: H,
    });
    expect(under.quantity).toBe(0n);
    const zero = timeWeightedLevel({
      carriedIn: 0n,
      events: [ev(H, 5), ev(H, -5)],
      startMs: 0,
      endMs: 2 * H,
      unitMs: H,
    });
    expect(zero.quantity).toBe(0n);
  });
});
