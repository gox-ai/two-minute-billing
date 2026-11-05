import { eq } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { jobRuns } from "@db/schema";

const log = createLogger("ops.job-runs");

/**
 * Run `fn` and record the run in `job_runs`: a row opened at start and closed at the end.
 * Recording never fails the job; the job's own error is rethrown after it is recorded.
 */
export async function recordJobRun(job: string, fn: () => Promise<void>): Promise<void> {
  let id: string | undefined;
  try {
    const [row] = await systemDb
      .insert(jobRuns)
      .values({ job, startedAt: new Date() })
      .returning({ id: jobRuns.id });
    id = row?.id;
  } catch (err) {
    log.warn("job run not recorded", { event: "job_run_record_failed", job, err });
  }
  let error: unknown;
  try {
    await fn();
  } catch (err) {
    error = err;
  }
  if (id) {
    await systemDb
      .update(jobRuns)
      .set({
        finishedAt: new Date(),
        ok: error === undefined,
        error:
          error === undefined
            ? null
            : String(error instanceof Error ? error.message : error).slice(0, 500),
      })
      .where(eq(jobRuns.id, id))
      .catch((err) => log.warn("job run not closed", { event: "job_run_record_failed", job, err }));
  }
  if (error !== undefined) throw error;
}
