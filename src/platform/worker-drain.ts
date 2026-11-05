/**
 * Wait for a worker's in-flight jobs to finish, bounded by `budgetMs`.
 *
 * `stop()` resolving is not proof the jobs are done: graphile's `gracefulShutdown` returns at
 * once when a shutdown is already under way. On 2026-09-27 that let the worker exit 0.5 s into
 * a running `metric_daily_current` and strand its queue lock. So the drain also waits for the
 * caller's own count of running jobs to reach zero.
 */
export async function drainJobs(opts: {
  stop: () => Promise<void>;
  activeJobs: () => number;
  budgetMs: number;
  pollMs?: number;
}): Promise<"drained" | "timeout"> {
  const pollMs = opts.pollMs ?? 250;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), opts.budgetMs);
    // Never let the budget timer itself be what holds the loop open.
    timer.unref();
  });
  const idle = (async () => {
    await opts.stop();
    while (opts.activeJobs() > 0) await new Promise((r) => setTimeout(r, pollMs));
    return "drained" as const;
  })();
  try {
    return await Promise.race([idle, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
