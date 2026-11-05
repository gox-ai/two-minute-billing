import { describe, it, expect } from "vitest";
import {
  tierListIssues,
  proratedMinimum,
  minimumTrueUp,
  snapshotPrice,
  alignSnapshotToCycle,
  deAlignSnapshotFromCycle,
} from "@/modules/catalog/pricing";
import type { prices } from "@db/schema";

const at = (...bounds: (number | null)[]) => bounds.map((upToMinor) => ({ upToMinor }));
const fields = (tiers: ReturnType<typeof at>, model?: string) =>
  tierListIssues(tiers, model).map((i) => `${i.index}.${i.field}`);

describe("tierListIssues", () => {
  it("accepts contiguous ascending tiers ending unbounded", () => {
    expect(tierListIssues(at(10, 20, null), "tiered")).toEqual([]);
    expect(tierListIssues(at(null), "volume")).toEqual([]);
  });
  it("refuses a bounded last tier", () => expect(fields(at(10, 20))).toEqual(["1.upToMinor"]));
  it("refuses an unbounded tier before the last", () =>
    expect(fields(at(null, 10, null))).toEqual(["0.upToMinor"]));
  it("refuses zero width and descending bounds", () => {
    expect(fields(at(10, 10, null))).toEqual(["1.upToMinor"]);
    expect(fields(at(20, 10, null))).toEqual(["1.upToMinor"]);
  });
  it("refuses a first tier that ends at 0", () =>
    expect(fields(at(0, null))).toEqual(["0.upToMinor"]));
  it("refuses an empty list for a tier model only", () => {
    expect(fields([], "tiered")).toEqual(["null.null"]);
    expect(tierListIssues([], "flat")).toEqual([]);
  });
  it("graduated_percentage needs a rate per tier and no unit price", () => {
    expect(
      tierListIssues(
        [
          { upToMinor: 10, rateBps: 100 },
          { upToMinor: null, unitAmountMinor: 5 },
        ],
        "graduated_percentage",
      ).map((i) => `${i.index}.${i.field}`),
    ).toEqual(["1.rateBps", "1.unitAmountMinor"]);
  });
  it("a rate on another model is refused", () => {
    expect(
      tierListIssues([{ upToMinor: null, rateBps: 100 }], "tiered").map((i) => i.field),
    ).toEqual(["rateBps"]);
  });
});

describe("minimum spend", () => {
  const DAY = 86_400_000;
  it("a full period takes the whole minimum", () => {
    expect(proratedMinimum(3000n, 30 * DAY, 30 * DAY)).toBe(3000n);
    expect(proratedMinimum(3000n, 60 * DAY, 30 * DAY)).toBe(3000n);
  });
  it("20 of 30 days → 2000; used 1234 → true-up 766", () => {
    expect(proratedMinimum(3000n, 20 * DAY, 30 * DAY)).toBe(2000n);
    expect(minimumTrueUp(3000n, 1234n, 20 * DAY, 30 * DAY)).toBe(766n);
  });
  it("rounds the prorated minimum half-up", () =>
    expect(proratedMinimum(1000n, 1 * DAY, 3 * DAY)).toBe(333n));
  it("a line at or above the minimum needs no true-up", () => {
    expect(minimumTrueUp(3000n, 3000n, 30 * DAY, 30 * DAY)).toBe(0n);
    expect(minimumTrueUp(3000n, 5000n, 30 * DAY, 30 * DAY)).toBe(0n);
  });
  it("no usage owes the full minimum", () =>
    expect(minimumTrueUp(3000n, 0n, 30 * DAY, 30 * DAY)).toBe(3000n));

  const price = {
    id: "p",
    publicId: "p",
    model: "per_unit",
    type: "recurring",
    currency: "USD",
    amountMinor: 475n,
    interval: "month",
    intervalCount: 1,
    usageAggregation: null,
    tiers: null,
    packageSize: null,
    freeUnits: null,
    percentageBps: null,
    freeQuantity: null,
    minimumAmountMinor: 1000n,
  } as unknown as typeof prices.$inferSelect;
  it("the snapshot freezes the minimum; no minimum leaves the snapshot as before", () => {
    expect(snapshotPrice(price).minimumAmountMinor).toBe(1000);
    expect("minimumAmountMinor" in snapshotPrice({ ...price, minimumAmountMinor: null })).toBe(
      false,
    );
  });
  it("a monthly minimum on a yearly cycle scales with the amount, and rewinds", () => {
    const yearly = alignSnapshotToCycle(snapshotPrice(price), {
      interval: "year",
      intervalCount: 1,
    });
    expect(yearly.minimumAmountMinor).toBe(12000);
    expect(deAlignSnapshotFromCycle(yearly).minimumAmountMinor).toBe(1000);
  });
});
