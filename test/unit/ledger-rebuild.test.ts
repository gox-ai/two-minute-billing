import { describe, expect, it } from "vitest";
import {
  monthlyRateOf,
  planLapses,
  planLedger,
  withoutMidTermProrations,
  type BilledPeriod,
} from "@/modules/metrics/ledger-rebuild";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const month = (start: string, end: string, minor: number | null, plan = "p1"): BilledPeriod => ({
  start: d(start),
  end: d(end),
  monthlyMinor: minor == null ? null : BigInt(minor),
  planProductId: plan,
});
const shape = (moves: ReturnType<typeof planLedger>) =>
  moves.map((m) => `${m.reason} ${m.deltaMinor} @${m.occurredAt.toISOString().slice(0, 10)}`);

describe("planLedger", () => {
  it("a steady monthly subscription opens once and churns where billing ended", () => {
    const moves = planLedger({
      periods: [month("2020-10-01", "2020-11-01", 900), month("2020-11-01", "2020-12-01", 900)],
      status: "cancelled",
      finalMinor: 0n,
    });
    expect(shape(moves)).toEqual(["new 900 @2020-10-01", "churn -900 @2020-12-01"]);
  });

  it("a price change lands on the period it took effect", () => {
    const moves = planLedger({
      periods: [
        month("2021-01-01", "2021-02-01", 900),
        month("2021-02-01", "2021-03-01", 1500),
        month("2021-03-01", "2021-04-01", 1200),
      ],
      status: "cancelled",
      finalMinor: 0n,
    });
    expect(shape(moves)).toEqual([
      "new 900 @2021-01-01",
      "expansion 600 @2021-02-01",
      "contraction -300 @2021-03-01",
      "churn -1200 @2021-04-01",
    ]);
  });

  it("paid, then a $0 plan while still live, then cancelled: contraction, and no churn", () => {
    const moves = planLedger({
      periods: [month("2022-01-01", "2022-02-01", 900), month("2022-02-01", "2022-03-01", 0)],
      status: "cancelled",
      finalMinor: 0n,
    });
    expect(shape(moves)).toEqual(["new 900 @2022-01-01", "contraction -900 @2022-02-01"]);
  });

  it("a gap in billing stops revenue, and a later period is a reactivation", () => {
    const moves = planLedger({
      periods: [month("2021-01-01", "2021-02-01", 900), month("2021-06-01", "2021-07-01", 900)],
      status: "cancelled",
      finalMinor: 0n,
    });
    expect(shape(moves)).toEqual([
      "new 900 @2021-01-01",
      "contraction -900 @2021-02-01",
      "reactivation 900 @2021-06-01",
      "churn -900 @2021-07-01",
    ]);
  });

  it("a prorated first period takes the rate of the first full one", () => {
    const moves = planLedger({
      periods: [month("2021-01-20", "2021-02-01", null), month("2021-02-01", "2021-03-01", 900)],
      status: "cancelled",
      finalMinor: 0n,
    });
    expect(shape(moves)).toEqual(["new 900 @2021-01-20", "churn -900 @2021-03-01"]);
  });

  it("the ledger always ends on the stored rate, so Σ delta = mrr", () => {
    for (const finalMinor of [0n, 700n]) {
      const moves = planLedger({
        periods: [month("2023-01-01", "2023-02-01", 900)],
        status: finalMinor === 0n ? "cancelled" : "active",
        finalMinor,
      });
      expect(moves.reduce((a, m) => a + m.deltaMinor, 0n)).toBe(finalMinor);
    }
  });
});

describe("monthlyRateOf", () => {
  it("a yearly line is a twelfth per month, net of its discount", () => {
    expect(
      monthlyRateOf({
        netMinor: 120_000n,
        interval: "year",
        intervalCount: 1,
        start: d("2022-01-01"),
        end: d("2023-01-01"),
      }),
    ).toBe(10_000n);
  });
  it("a line covering well under its interval is a proration and sets no rate", () => {
    expect(
      monthlyRateOf({
        netMinor: 300n,
        interval: "month",
        intervalCount: 1,
        start: d("2022-01-20"),
        end: d("2022-02-01"),
      }),
    ).toBeNull();
  });
});

describe("withoutMidTermProrations", () => {
  it("a mid-term upgrade billed for the rest of the term sets no rate; the renewal does", () => {
    const periods = withoutMidTermProrations([
      month("2021-09-27", "2021-10-27", 700),
      month("2021-09-28", "2021-10-27", 2313), // prorated BASIC for the rest of the term
      month("2021-10-27", "2021-11-27", 2400),
    ]);
    const moves = planLedger({ periods, status: "cancelled", finalMinor: 0n });
    expect(shape(moves)).toEqual([
      "new 700 @2021-09-27",
      "expansion 1700 @2021-10-27",
      "churn -2400 @2021-11-27",
    ]);
  });

  it("a free plan billed as one ten-year line does not swallow the paid periods after it", () => {
    const periods = withoutMidTermProrations([
      month("2022-03-26", "2032-03-26", 0),
      month("2022-04-07", "2022-05-07", 700),
    ]);
    expect(periods.map((p) => p.monthlyMinor)).toEqual([0n, 700n]);
  });
});

describe("a switch to a free plan billed alongside the last paid month", () => {
  it("drops to 0 when the paid month ends, not across the free plan's ten years", () => {
    const moves = planLedger({
      periods: [
        month("2022-08-18", "2022-09-18", 6200),
        month("2022-09-18", "2022-10-18", 6200),
        month("2022-09-18", "2032-09-18", 0),
      ],
      status: "cancelled",
      finalMinor: 0n,
    });
    expect(shape(moves)).toEqual(["new 6200 @2022-08-18", "contraction -6200 @2022-10-18"]);
  });
});

describe("a lump charge dated across years", () => {
  it("sets no rate, so it cannot hold every later change back to its end", () => {
    expect(
      monthlyRateOf({
        netMinor: 198_635n,
        interval: "month",
        intervalCount: 1,
        start: d("2021-09-07"),
        end: d("2037-12-31"),
      }),
    ).toBeNull();
    // A free plan billed as one ten-year line on a ten-year price is still a rate: zero.
    expect(
      monthlyRateOf({
        netMinor: 0n,
        interval: "year",
        intervalCount: 10,
        start: d("2022-09-18"),
        end: d("2032-09-18"),
      }),
    ).toBe(0n);
  });
});

describe("planLapses", () => {
  const cover = (a: string, b: string) => ({ start: d(a), end: d(b) });
  const mv = (at: string, reason: "new" | "expansion" | "churn", delta: number) => ({
    occurredAt: d(at),
    reason,
    deltaMinor: BigInt(delta),
  });
  const net = (moves: Array<{ deltaMinor: bigint }>, lapses: ReturnType<typeof planLapses>) =>
    moves.reduce((a, m) => a + m.deltaMinor, 0n) +
    lapses.flatMap((l) => l.rows).reduce((a, r) => a + r.deltaMinor, 0n);

  it("zeroes a stretch with no billing between two billed periods", () => {
    const moves = [mv("2025-10-01", "new", 900)];
    const lapses = planLapses({
      coverage: [cover("2025-10-01", "2025-11-01"), cover("2026-03-01", "2026-04-01")],
      moves,
    });
    expect(lapses).toHaveLength(1);
    expect(
      lapses[0]!.rows.map(
        (r) => `${r.reason} ${r.deltaMinor} @${r.occurredAt.toISOString().slice(0, 10)}`,
      ),
    ).toEqual(["churn -900 @2025-11-01", "reactivation 900 @2026-03-01"]);
    expect(net(moves, lapses)).toBe(900n);
  });

  it("counters a movement inside the lapse, so the rate on return is the one the ledger had", () => {
    const moves = [mv("2025-10-01", "new", 900), mv("2026-01-15", "expansion", 300)];
    const lapses = planLapses({
      coverage: [cover("2025-10-01", "2025-11-01"), cover("2026-03-01", "2026-04-01")],
      moves,
    });
    expect(lapses[0]!.rows.map((r) => `${r.reason} ${r.deltaMinor}`)).toEqual([
      "churn -900",
      "expansion -300",
      "reactivation 1200",
    ]);
    expect(net(moves, lapses)).toBe(1200n);
  });

  it("leaves a short gap (renewal slack) and an open gap at the end alone", () => {
    const moves = [mv("2025-10-01", "new", 900)];
    expect(
      planLapses({
        coverage: [cover("2025-10-01", "2025-11-01"), cover("2025-11-05", "2025-12-05")],
        moves,
      }),
    ).toEqual([]);
    expect(planLapses({ coverage: [cover("2025-10-01", "2025-11-01")], moves })).toEqual([]);
  });

  it("leaves a gap alone when its movements cancel out and it never earned", () => {
    const moves = [
      mv("2025-10-01", "new", 900),
      mv("2025-11-01", "churn", -900),
      mv("2026-01-10", "new", 500),
      mv("2026-01-10", "new", -500),
    ];
    expect(
      planLapses({
        coverage: [cover("2025-10-01", "2025-11-01"), cover("2026-03-01", "2026-04-01")],
        moves,
      }),
    ).toEqual([]);
  });

  it("is idempotent: once closed, the lapse earns nothing and plans nothing", () => {
    const moves = [mv("2025-10-01", "new", 900)];
    const coverage = [cover("2025-10-01", "2025-11-01"), cover("2026-03-01", "2026-04-01")];
    const first = planLapses({ coverage, moves });
    const after = [...moves, ...first.flatMap((l) => l.rows)];
    expect(planLapses({ coverage, moves: after })).toEqual([]);
  });
});
