/**
 * A restart must not cut a running job off. On 2026-09-27 the worker exited 0.5 s into a
 * `metric_daily_current` run and stranded its queue lock: graphile's own SIGINT handler had
 * already started the shutdown, so our `runner.stop()` returned at once and read as drained.
 */
import { describe, it, expect, vi } from "vitest";
import { drainJobs } from "@/platform/worker-drain";
import { startWorker } from "@/platform/jobs";
import { config } from "@/platform/config";

const run = vi.fn(async (_opts: Record<string, unknown>) => ({}) as never);
vi.mock("graphile-worker", async (orig) => ({
  ...(await orig<typeof import("graphile-worker")>()),
  run: (opts: Record<string, unknown>) => run(opts),
}));

describe("drainJobs", () => {
  it("waits for running jobs even when stop() resolves immediately", async () => {
    let active = 1;
    setTimeout(() => (active = 0), 120);
    const t0 = Date.now();
    const r = await drainJobs({
      stop: async () => {},
      activeJobs: () => active,
      budgetMs: 5_000,
      pollMs: 10,
    });
    expect(r).toBe("drained");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });

  it("gives up at the budget when a job outlives it", async () => {
    const r = await drainJobs({
      stop: async () => {},
      activeJobs: () => 1,
      budgetMs: 80,
      pollMs: 10,
    });
    expect(r).toBe("timeout");
  });

  it("returns at once when nothing is running", async () => {
    const r = await drainJobs({ stop: async () => {}, activeJobs: () => 0, budgetMs: 5_000 });
    expect(r).toBe("drained");
  });

  it("surfaces a stop() failure instead of calling it drained", async () => {
    await expect(
      drainJobs({
        stop: async () => {
          throw new Error("boom");
        },
        activeJobs: () => 0,
        budgetMs: 5_000,
      }),
    ).rejects.toThrow("boom");
  });
});

describe("startWorker", () => {
  it("leaves signal handling to worker.ts and aborts no earlier than the drain budget", async () => {
    await startWorker("billing");
    const opts = run.mock.calls[0]![0];
    expect(opts.noHandleSignals).toBe(true);
    expect(opts.gracefulShutdownAbortTimeout).toBe(config.WORKER_SHUTDOWN_TIMEOUT_MS);
  });
});
