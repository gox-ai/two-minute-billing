import { describe, expect, it } from "vitest";
import { computeDisputeMeasures } from "@/modules/metrics/daily/dispute-measures";

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const dispute = (o: Partial<Record<string, unknown>>) => ({
  status: "needs_response",
  amountMinor: 1000n,
  currency: "usd",
  evidenceDueBy: null,
  openedAt: d("2026-09-10"),
  closedAt: null,
  ...o,
});
// The compute makes one read; a stub that answers it is enough to pin the counting rules.
const txOf = (rows: unknown[]) =>
  ({ select: () => ({ from: () => ({ where: async () => rows }) }) }) as never;

const run = async (rows: unknown[], now = d("2026-09-28")) => {
  const out = await computeDisputeMeasures({
    tx: txOf(rows),
    businessId: "b",
    from: d("2026-09-01"),
    toExclusive: d("2026-10-01"),
    now,
  });
  return new Map(out.map((r) => [`${r.measure}|${r.dimValue}`, r.value]));
};

describe("dispute measures", () => {
  it("open = awaiting response or under review, banded by the evidence deadline", async () => {
    const m = await run([
      dispute({ evidenceDueBy: d("2026-10-03") }),
      dispute({ status: "under_review", amountMinor: 500n, evidenceDueBy: d("2026-09-20") }),
      dispute({ status: "won", closedAt: d("2026-09-15") }),
    ]);
    expect(m.get("disputes_open|")).toBe(2n);
    expect(m.get("disputes_open_amount|")).toBe(1500n);
    expect(m.get("disputes_open|1_30")).toBe(1n);
    expect(m.get("disputes_open|overdue")).toBe(1n);
  });

  it("won and lost are dated by closing; withdrawn is neither", async () => {
    const m = await run([
      dispute({ status: "won", closedAt: d("2026-09-15") }),
      dispute({ status: "lost", amountMinor: 700n, closedAt: d("2026-09-20") }),
      dispute({ status: "lost", closedAt: d("2026-10-02") }),
      dispute({ status: "closed", closedAt: d("2026-09-21") }),
    ]);
    expect(m.get("disputes_opened|")).toBe(4n);
    expect(m.get("disputes_opened_amount|")).toBe(3700n);
    expect(m.get("disputes_won|")).toBe(1n);
    expect(m.get("disputes_won_amount|")).toBe(1000n);
    expect(m.get("disputes_lost|")).toBe(1n);
    expect(m.get("disputes_lost_amount|")).toBe(700n);
  });

  it("the run writes a total for every one of the eight", async () => {
    const m = await run([dispute({})]);
    for (const id of [
      "disputes_open",
      "disputes_open_amount",
      "disputes_opened",
      "disputes_opened_amount",
      "disputes_won",
      "disputes_won_amount",
      "disputes_lost",
      "disputes_lost_amount",
    ])
      expect(m.has(`${id}|`)).toBe(true);
  });

  it("a past period gets flows but no open reading", async () => {
    const m = await run([dispute({})], d("2026-11-01"));
    expect(m.get("disputes_opened|")).toBe(1n);
    expect(m.has("disputes_open|")).toBe(false);
  });
});
