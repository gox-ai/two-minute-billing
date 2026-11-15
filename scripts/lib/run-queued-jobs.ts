/**
 * Run one task's queued jobs now, through the worker's own registered task, and return.
 * `dueNow` first moves jobs waiting on a retry back-off to now, so a suite can prove the retry.
 */
import { sql } from "drizzle-orm";
import { Logger, runOnce } from "graphile-worker";
import { config } from "@/platform/config";
import { systemDb } from "@/platform/db";
import { taskList } from "@/platform/jobs";

export async function runQueuedJobs(task: string, opts: { dueNow?: boolean } = {}): Promise<void> {
  const run = taskList[task];
  if (!run) throw new Error(`no registered task ${task}`);
  if (opts.dueNow)
    await systemDb.execute(sql`
      update graphile_worker._private_jobs j set run_at = now()
        from graphile_worker._private_tasks t
       where t.id = j.task_id and t.identifier = ${task} and j.locked_at is null`);
  await runOnce({
    connectionString: config.DATABASE_URL,
    concurrency: 1,
    noHandleSignals: true,
    logger: new Logger(() => () => {}),
    taskList: { [task]: run },
  });
}

/** The live jobs for one key: attempts so far and the last error. */
export async function queuedJob(
  key: string,
): Promise<{ attempts: number; lastError: string | null } | null> {
  const rows = (await systemDb.execute(sql`
    select attempts, last_error from graphile_worker._private_jobs where key = ${key}`)) as unknown as Array<{
    attempts: number;
    last_error: string | null;
  }>;
  return rows[0] ? { attempts: rows[0].attempts, lastError: rows[0].last_error } : null;
}
