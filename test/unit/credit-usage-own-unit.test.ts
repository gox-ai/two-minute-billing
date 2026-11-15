import { describe, expect, it } from "vitest";
import {
  allocateUnitDraws,
  formatCostE6,
  graceCovers,
  lateEventGraceMs,
  parseCostE6,
  payClass,
  resolveCreditCost,
  unitDrawCost,
  unitsDueSteps,
  type UnitGrant,
} from "@/modules/credits/credit-cost";

const E12 = 1_000_000_000_000n;
const at = (iso: string) => new Date(iso);

describe("credit cost of an event", () => {
  it("parses and prints a cost with up to 6 decimal places", () => {
    expect(parseCostE6("0.5")).toBe(500_000n);
    expect(parseCostE6("1")).toBe(1_000_000n);
    expect(parseCostE6("0.000001")).toBe(1n);
    expect(parseCostE6("0.0000001")).toBeNull();
    expect(parseCostE6("-1")).toBeNull();
    expect(parseCostE6("1e3")).toBeNull();
    expect(formatCostE6(500_000n)).toBe("0.5");
    expect(formatCostE6(12_000_000n)).toBe("12");
  });

  it("units due = quantity × cost, in the unit's smallest step", () => {
    // 1 decimal: 4 illustrations at 1 credit, 2 edits at 0.5.
    expect(unitsDueSteps(4n * E12, parseCostE6("1")!, 1)).toBe(40n);
    expect(unitsDueSteps(2n * E12, parseCostE6("0.5")!, 1)).toBe(10n);
    // 0 decimals: 3 × 0.5 = 1.5 rounds half-up to 2; 0.4 rounds to 0.
    expect(unitsDueSteps(3n * E12, parseCostE6("0.5")!, 0)).toBe(2n);
    expect(unitsDueSteps(1n * E12, parseCostE6("0.4")!, 0)).toBe(0n);
    // A decimal quantity: 2.5 × 0.3 = 0.75 at 2 decimals.
    expect(unitsDueSteps((5n * E12) / 2n, parseCostE6("0.3")!, 2)).toBe(75n);
    expect(unitsDueSteps(0n, parseCostE6("1")!, 1)).toBe(0n);
  });
});

describe("cost layers", () => {
  const layers = {
    base: 1_000_000n,
    byProduct: new Map([["plan-pro", 800_000n]]),
    bySubscription: new Map([["sub-deal", 500_000n]]),
  };
  it("a subscription's cost wins over a plan's, a plan's over the meter's", () => {
    expect(resolveCreditCost(layers, [])).toEqual({ costE6: 1_000_000n, source: "meter" });
    expect(resolveCreditCost(layers, [{ id: "sub-a", productIds: ["plan-basic"] }])).toEqual({
      costE6: 1_000_000n,
      source: "meter",
    });
    expect(resolveCreditCost(layers, [{ id: "sub-a", productIds: ["plan-pro"] }])).toEqual({
      costE6: 800_000n,
      source: "plan",
    });
    expect(resolveCreditCost(layers, [{ id: "sub-deal", productIds: ["plan-pro"] }])).toEqual({
      costE6: 500_000n,
      source: "subscription",
    });
  });
  it("a later subscription's own cost wins over an earlier subscription's plan", () => {
    expect(
      resolveCreditCost(layers, [
        { id: "sub-a", productIds: ["plan-pro"] },
        { id: "sub-deal", productIds: [] },
      ]),
    ).toEqual({ costE6: 500_000n, source: "subscription" });
  });
});

describe("late events", () => {
  const H = 3_600_000;
  it("the grace window is 12 hours when unset; 0 turns it off", () => {
    expect(lateEventGraceMs(null)).toBe(12 * H);
    expect(lateEventGraceMs({})).toBe(12 * H);
    expect(lateEventGraceMs({ late_event_grace_hours: 2 })).toBe(2 * H);
    expect(lateEventGraceMs({ late_event_grace_hours: 0 })).toBe(0);
  });
  it("inside the window the event's own time decides; outside it, the time of receipt", () => {
    const receivedAt = at("2026-03-10T12:00:00Z");
    const cls = (eventAt: string, graceMs = 12 * H) =>
      payClass({ eventAt: at(eventAt), receivedAt, graceMs });
    expect(cls("2026-03-10T12:00:00Z")).toBe("receipt_time");
    expect(cls("2026-03-10T11:59:59Z")).toBe("event_time");
    expect(cls("2026-03-10T00:00:00Z")).toBe("event_time");
    expect(cls("2026-03-09T23:59:59Z")).toBe("receipt_time");
    expect(cls("2026-03-10T12:03:00Z")).toBe("receipt_time");
    expect(cls("2026-03-10T11:00:00Z", 0)).toBe("receipt_time");
  });
  it("a closed grant pays an event dated in its life, until its window locks", () => {
    const g = {
      validFrom: at("2026-03-01T00:00:00Z"),
      validUntil: at("2026-03-10T00:00:00Z"),
      locksAt: at("2026-03-10T12:00:00Z"),
      lockedAt: null,
    };
    const rx = at("2026-03-10T06:00:00Z");
    expect(graceCovers(g, at("2026-03-09T23:00:00Z"), rx)).toBe(true);
    expect(graceCovers(g, at("2026-03-10T00:00:00Z"), rx)).toBe(false);
    expect(graceCovers(g, at("2026-02-28T23:00:00Z"), rx)).toBe(false);
    expect(graceCovers(g, at("2026-03-09T23:00:00Z"), at("2026-03-10T12:00:00Z"))).toBe(false);
    expect(graceCovers({ ...g, lockedAt: rx }, at("2026-03-09T23:00:00Z"), rx)).toBe(false);
  });
});

describe("cost of the units drawn", () => {
  it("is cumulative, so a grant closes to 0 units and 0 cost", () => {
    // The worked example: 15 credits (150 steps) bought for 900.
    const g = { amount: 150n, costBasisMinor: 900n, remainingUnits: 150n, remainingCost: 900n };
    expect(unitDrawCost(g, 50n)).toBe(300n);
    // Thirds of 100: 33, 34 (cumulative 67), then the rest.
    const t = { amount: 3n, costBasisMinor: 100n, remainingUnits: 3n, remainingCost: 100n };
    const first = unitDrawCost(t, 1n);
    expect(first).toBe(33n);
    const second = unitDrawCost({ ...t, remainingUnits: 2n, remainingCost: 67n }, 1n);
    expect(second).toBe(34n);
    expect(unitDrawCost({ ...t, remainingUnits: 1n, remainingCost: 33n }, 1n)).toBe(33n);
    // Given credit carries no money.
    expect(
      unitDrawCost(
        { amount: 750n, costBasisMinor: 0n, remainingUnits: 750n, remainingCost: 0n },
        10n,
      ),
    ).toBe(0n);
  });
});

describe("settlement allocation", () => {
  const grant = (over: Partial<UnitGrant> & { id: string }): UnitGrant => ({
    category: "promotional",
    source: "manual",
    priority: 50,
    effectiveAt: at("2026-03-01T00:00:00Z"),
    expiresAt: null,
    applicability: { kind: "metered" },
    amount: 100n,
    costBasisMinor: 0n,
    remainingUnits: 100n,
    remainingCost: 0n,
    ...over,
  });
  const demand = (units: bigint, payAt = "2026-03-05T00:00:00Z", meterId = "m1") => ({
    meterId,
    meterKey: meterId,
    payAt: at(payAt),
    units,
  });

  it("given credit pays before paid credit, and revenue is the paid cost drawn", () => {
    const plan = grant({ id: "plan", source: "plan_cycle", amount: 750n, remainingUnits: 20n });
    const pack = grant({
      id: "pack",
      category: "paid",
      source: "purchase",
      amount: 150n,
      costBasisMinor: 900n,
      remainingUnits: 150n,
      remainingCost: 900n,
    });
    const r = allocateUnitDraws([pack, plan], [demand(50n)]);
    expect(r.fallbackUnits).toBe(0n);
    expect(r.shortUnits).toBe(0n);
    expect(r.draws).toEqual([
      { meterId: "m1", grantId: "plan", units: 20n, costMinor: 0n },
      { meterId: "m1", grantId: "pack", units: 30n, costMinor: 180n },
    ]);
  });

  it("keeps the order: restore grants, priority, soonest expiry, oldest", () => {
    const g = [
      grant({ id: "late-expiry", expiresAt: at("2026-06-01T00:00:00Z"), remainingUnits: 5n }),
      grant({ id: "soon-expiry", expiresAt: at("2026-04-01T00:00:00Z"), remainingUnits: 5n }),
      grant({ id: "first", priority: 10, remainingUnits: 5n }),
      grant({ id: "restored", source: "restore", priority: 90, remainingUnits: 5n }),
    ];
    const r = allocateUnitDraws(g, [demand(18n)]);
    expect(r.draws.map((d) => [d.grantId, d.units])).toEqual([
      ["restored", 5n],
      ["first", 5n],
      ["soon-expiry", 5n],
      ["late-expiry", 3n],
    ]);
  });

  it("a window grant pays only usage inside its window", () => {
    const march = grant({
      id: "march",
      effectiveAt: at("2026-03-01T00:00:00Z"),
      expiresAt: at("2026-04-01T00:00:00Z"),
      remainingUnits: 10n,
    });
    const april = grant({
      id: "april",
      effectiveAt: at("2026-04-01T00:00:00Z"),
      expiresAt: at("2026-05-01T00:00:00Z"),
      remainingUnits: 10n,
    });
    const r = allocateUnitDraws(
      [march, april],
      [demand(4n, "2026-03-31T23:00:00Z"), demand(6n, "2026-04-01T00:00:00Z")],
    );
    expect(r.draws.map((d) => [d.grantId, d.units])).toEqual([
      ["march", 4n],
      ["april", 6n],
    ]);
    expect(r.fallbackUnits).toBe(0n);
  });

  it("a grant scoped to other meters pays last, and only because the gate took the units", () => {
    const scoped = grant({
      id: "scoped",
      applicability: { kind: "meters", meters: ["m2"] },
      priority: 1,
      remainingUnits: 10n,
    });
    const open = grant({ id: "open", remainingUnits: 3n });
    const r = allocateUnitDraws([scoped, open], [demand(5n)]);
    expect(r.draws.map((d) => [d.grantId, d.units])).toEqual([
      ["open", 3n],
      ["scoped", 2n],
    ]);
    expect(r.fallbackUnits).toBe(2n);
    expect(r.windowFallbackUnits).toBe(0n);
  });

  it("a term grant that waits for its renewal pays usage received after its term end", () => {
    const term = grant({
      id: "term",
      effectiveAt: at("2026-03-01T00:00:00Z"),
      expiresAt: at("2026-04-01T00:00:00Z"),
      paysUntil: null,
      remainingUnits: 10n,
    });
    const pack = grant({ id: "pack", remainingUnits: 10n });
    const r = allocateUnitDraws([pack, term], [demand(4n, "2026-04-01T00:01:00Z")]);
    expect(r.draws.map((d) => [d.grantId, d.units])).toEqual([["term", 4n]]);
    expect(r.fallbackUnits).toBe(0n);
  });

  it("counts a draw from a grant that was not live apart from a scope fallback", () => {
    const ended = grant({
      id: "ended",
      effectiveAt: at("2026-03-01T00:00:00Z"),
      expiresAt: at("2026-04-01T00:00:00Z"),
      remainingUnits: 10n,
    });
    const r = allocateUnitDraws([ended], [demand(4n, "2026-04-01T00:00:01Z")]);
    expect(r.fallbackUnits).toBe(4n);
    expect(r.windowFallbackUnits).toBe(4n);
  });

  it("reports units the grants do not have", () => {
    const r = allocateUnitDraws([grant({ id: "g", remainingUnits: 3n })], [demand(5n)]);
    expect(r.shortUnits).toBe(2n);
    expect(r.draws).toEqual([{ meterId: "m1", grantId: "g", units: 3n, costMinor: 0n }]);
  });

  it("several draws on one grant add up to the cumulative cost", () => {
    const pack = grant({
      id: "pack",
      category: "paid",
      amount: 3n,
      costBasisMinor: 100n,
      remainingUnits: 3n,
      remainingCost: 100n,
    });
    const r = allocateUnitDraws(
      [pack],
      [
        demand(1n, "2026-03-05T00:00:00Z"),
        demand(1n, "2026-03-06T00:00:00Z"),
        demand(1n, "2026-03-07T00:00:00Z"),
      ],
    );
    expect(r.draws).toEqual([{ meterId: "m1", grantId: "pack", units: 3n, costMinor: 100n }]);
  });
});
