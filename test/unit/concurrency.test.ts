import { describe, it, expect, vi, afterEach } from "vitest";
import { runBounded, isFailure } from "@/platform/concurrency";

/**
 * `runBounded` replaced the `for…await` loop in three money-path passes, so what is pinned
 * here is the set of properties the serial version gave for free and a naive `Promise.all`
 * would quietly drop.
 */
describe("runBounded", () => {
  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await runBounded(
      Array.from({ length: 50 }, (_, i) => i),
      5,
      async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      },
    );
    expect(peak).toBe(5);
  });

  it("runs everything when no deadline is set", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const r = await runBounded(items, 4, async (i) => i * 2);
    expect(r.settled).toHaveLength(20);
    expect(r.unstarted).toEqual([]);
    expect(r.settled.map((s) => (s.ok ? s.value : -1)).sort((a, b) => a - b)).toEqual(
      items.map((i) => i * 2),
    );
  });

  it("isolates a failure instead of aborting the batch", async () => {
    // The serial loop wrapped each item in try/catch so one bad subscription could not stall
    // a tick. `Promise.all` would reject on the first throw and lose the other 9 results.
    const r = await runBounded([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      if (n === 4) throw new Error("boom");
      return n;
    });
    expect(r.settled).toHaveLength(10);
    const failures = r.settled.filter(isFailure);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.item).toBe(4);
    expect((failures[0]!.error as Error).message).toBe("boom");
  });

  it("classifies a thrown undefined as a failure", async () => {
    // Why the union discriminates on `ok` rather than on an `error` key being present.
    const r = await runBounded([1], 1, async () => {
      throw undefined;
    });
    expect(r.settled[0]!.ok).toBe(false);
    expect(isFailure(r.settled[0]!)).toBe(true);
  });

  it("stops starting work once the deadline passes and reports the remainder", async () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    const r = await runBounded(items, 2, async () => new Promise((res) => setTimeout(res, 10)), {
      deadline: Date.now() + 45,
    });
    expect(r.unstarted.length).toBeGreaterThan(0);
    // Every item is accounted for exactly once — this is what lets a caller report `capped`
    // truthfully rather than inferring it from how many it managed.
    expect(r.settled.length + r.unstarted.length).toBe(40);
  });

  it("does not interrupt work already in flight", async () => {
    // A renewal must stay atomic: the budget is checked BEFORE starting an item, never
    // mid-flight, so an item that began inside the budget always completes.
    let completed = 0;
    const r = await runBounded(
      [1, 2],
      2,
      async () => {
        await new Promise((res) => setTimeout(res, 60));
        completed++;
      },
      { deadline: Date.now() + 10 },
    );
    expect(completed).toBe(2);
    expect(r.settled).toHaveLength(2);
  });

  it("starts items in input order", async () => {
    // Callers scan oldest-due-first so the row cap is fair; with N lanes the N oldest must
    // start together, or a backlog could starve under TICK_SCAN_LIMIT.
    const started: number[] = [];
    await runBounded(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async (i) => {
        started.push(i);
        await new Promise((r) => setTimeout(r, 1));
      },
    );
    expect(started.slice(0, 3)).toEqual([0, 1, 2]);
    expect(started).toEqual([...started].sort((a, b) => a - b));
  });

  it("degrades to serial rather than doing nothing on a bad limit", async () => {
    for (const limit of [0, -5, Number.NaN]) {
      const r = await runBounded([1, 2, 3], limit, async (n) => n);
      expect(r.settled).toHaveLength(3);
    }
  });

  it("handles an empty input", async () => {
    const r = await runBounded([], 8, async () => 1);
    expect(r.settled).toEqual([]);
    expect(r.unstarted).toEqual([]);
  });

  it("is faster than serial for IO-bound work — the reason it exists", async () => {
    const started = Date.now();
    await runBounded(
      Array.from({ length: 20 }, (_, i) => i),
      10,
      async () => {
        await new Promise((r) => setTimeout(r, 20));
      },
    );
    // 20 items × 20ms serial = 400ms; at 10 lanes it is ~2 rounds. Generous bound so the
    // assertion is about the shape, not the machine.
    expect(Date.now() - started).toBeLessThan(250);
  });
});

/**
 * `fairShareFor` — the egress scan's per-business cap. What is pinned here is the property
 * both outboxes' comments and `TICK_FAIR_SHARE_PER_BUSINESS`'s own note always CLAIMED and
 * the fixed `rn <= 50` never delivered: a tenant alone in the queue is not slowed.
 */
describe("fairShareFor", () => {
  /**
   * BOTH gate states go through this mock, neither reads the ambient config.
   *
   * `config` is frozen at import, so the gate is toggled by re-mocking the module rather
   * than by mutating it — a mutated config object leaks into the next test. Reading the
   * real one instead would make the OFF case assert this machine's `.env`, and a developer
   * who has turned the flag on locally would fail a suite that is about the code.
   */
  const withGate = async (value: "TRUE" | "FALSE") => {
    vi.resetModules();
    const actual = await vi.importActual<typeof import("@/platform/config")>("@/platform/config");
    vi.doMock("@/platform/config", () => ({
      ...actual,
      config: { ...actual.config, TICK_FAIR_SHARE_DYNAMIC: value },
    }));
    const clock = await import("@/platform/clock");
    return { fairShareFor: clock.fairShareFor, config: actual.config };
  };

  afterEach(() => {
    vi.doUnmock("@/platform/config");
    vi.resetModules();
  });

  // OFF is the shipped default, so it is asserted first: identical to the fixed cap,
  // because a deploy must not change what any pass selects.
  it("returns the fixed floor while TICK_FAIR_SHARE_DYNAMIC is off", async () => {
    const { fairShareFor, config } = await withGate("FALSE");
    for (const n of [1, 2, 10, 1000]) {
      expect(fairShareFor(n)).toBe(config.TICK_FAIR_SHARE_PER_BUSINESS);
    }
  });

  /**
   * With the gate ON — the bug fix. What is pinned is the property both outbox comments and
   * `TICK_FAIR_SHARE_PER_BUSINESS`'s own note always CLAIMED and the fixed `rn <= 50` never
   * delivered: a tenant alone in the queue is not slowed.
   */
  describe("with TICK_FAIR_SHARE_DYNAMIC=TRUE", () => {
    const withDynamic = () => withGate("TRUE");

    it("gives the whole scan to a business that is alone", async () => {
      const { fairShareFor, config } = await withDynamic();
      expect(fairShareFor(1)).toBe(config.TICK_SCAN_LIMIT);
    });

    it("divides the scan evenly between businesses with due work", async () => {
      const { fairShareFor, config } = await withDynamic();
      expect(fairShareFor(5)).toBe(Math.ceil(config.TICK_SCAN_LIMIT / 5));
    });

    it("never drops below the configured floor", async () => {
      // The density the cap was actually written for: many tenants, one hoarding the oldest
      // rows. Here the dynamic share is identical to the old fixed one.
      const { fairShareFor, config } = await withDynamic();
      expect(fairShareFor(1000)).toBe(config.TICK_FAIR_SHARE_PER_BUSINESS);
      expect(fairShareFor(50)).toBeGreaterThanOrEqual(config.TICK_FAIR_SHARE_PER_BUSINESS);
    });

    it("never returns Infinity or 0 for a degenerate count", async () => {
      const { fairShareFor } = await withDynamic();
      for (const n of [0, -1]) {
        const share = fairShareFor(n);
        expect(Number.isFinite(share)).toBe(true);
        expect(share).toBeGreaterThan(0);
      }
    });

    it("is monotonic — more tenants never means a bigger share", async () => {
      const { fairShareFor } = await withDynamic();
      let prev = Infinity;
      for (const n of [1, 2, 5, 10, 25, 100, 500]) {
        const share = fairShareFor(n);
        expect(share).toBeLessThanOrEqual(prev);
        prev = share;
      }
    });
  });
});
