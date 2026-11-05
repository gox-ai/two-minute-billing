import { describe, it, expect } from "vitest";
import { computeLineAmount, snapshotPrice, ratableFromSnapshot } from "@/modules/catalog/pricing";
import type { prices } from "@db/schema";

type Price = typeof prices.$inferSelect;

// Stairstep: each band has a FLAT price; the quantity picks the band, quantity
// within the band doesn't matter. tiers use flatAmountMinor.
function stair(tiers: Array<{ upToMinor: number | null; flatAmountMinor: number }>): Price {
  return {
    model: "stairstep",
    amountMinor: null,
    tiers,
    packageSize: null,
    freeUnits: null,
    percentageBps: null,
  } as unknown as Price;
}

const p = stair([
  { upToMinor: 10, flatAmountMinor: 9000 }, // 1–10 → $90
  { upToMinor: 20, flatAmountMinor: 18000 }, // 11–20 → $180
  { upToMinor: null, flatAmountMinor: 30000 }, // 21+ → $300
]);

describe("stairstep model", () => {
  it("0 units → 0 (no band)", () => expect(computeLineAmount(p, 0)).toBe(0n));
  it("1 unit → band 1 flat ($90)", () => expect(computeLineAmount(p, 1)).toBe(9000n));
  it("exactly band-1 cap (10) → $90", () => expect(computeLineAmount(p, 10)).toBe(9000n));
  it("1 over band 1 (11) → band 2 ($180)", () => expect(computeLineAmount(p, 11)).toBe(18000n));
  it("mid band 2 (15) → $180", () => expect(computeLineAmount(p, 15)).toBe(18000n));
  it("band-2 cap (20) → $180", () => expect(computeLineAmount(p, 20)).toBe(18000n));
  it("into top band (25) → $300", () => expect(computeLineAmount(p, 25)).toBe(30000n));
  it("far into top band (10000) → $300 (flat, qty-independent)", () =>
    expect(computeLineAmount(p, 10000)).toBe(30000n));
});

describe("price snapshot round-trip", () => {
  it("ratableFromSnapshot(snapshotPrice(p)) rates identically (flat)", () => {
    const flat = {
      id: "x",
      publicId: "price_x",
      model: "flat",
      type: "recurring",
      currency: "USD",
      amountMinor: 12345n,
      interval: "month",
      intervalCount: 1,
      usageAggregation: null,
      tiers: null,
      packageSize: null,
      freeUnits: null,
      percentageBps: null,
    } as unknown as Price;
    const snap = snapshotPrice(flat);
    expect(snap.amountMinor).toBe(12345); // serialized to number for jsonb
    expect(computeLineAmount(ratableFromSnapshot(snap, null), 1)).toBe(12345n);
  });
  it("stairstep survives the snapshot round-trip", () => {
    const full = {
      id: "y",
      publicId: "price_y",
      model: "stairstep",
      type: "recurring",
      currency: "USD",
      amountMinor: null,
      interval: "month",
      intervalCount: 1,
      usageAggregation: null,
      tiers: p.tiers,
      packageSize: null,
      freeUnits: null,
      percentageBps: null,
    } as unknown as Price;
    const snap = snapshotPrice(full);
    expect(computeLineAmount(ratableFromSnapshot(snap, null), 15)).toBe(18000n);
  });
});
