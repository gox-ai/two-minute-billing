import type { WorkerEvents } from "graphile-worker";

/**
 * The ids graphile-worker writes into `locked_by` for this process, kept current from events.
 *
 * graphile-worker keeps no worker registry, so `_private_job_queues.locked_by` is an opaque
 * string traceable to a process only if somebody records the mapping. Nobody did — which is why
 * the lock left by the worker killed at 18:34 on 2026-08-29 could not be told apart from a lock
 * held by a worker running right now. This is that mapping, published on every heartbeat and
 * consumed by `liveGraphileWorkerIds` / `releaseStrandedQueueLocks`.
 *
 * Since 0.17 a lock names the worker POOL (`workerPool.id`), not the in-pool worker. Publishing
 * only worker ids then matches no lock, and the sweep releases held ones: a second tick renews
 * the same subscription. Both are published, so a 0.16 process still draining during a deploy
 * keeps covering its own locks.
 *
 * From events rather than captured once: graphile replaces an in-pool worker after a fatal
 * error, and a boot-time snapshot would drift into naming dead ids while omitting live ones.
 * Attach BEFORE `run()`: `pool:create` and `worker:create` fire synchronously inside it.
 */
export function trackGraphileLockIds(events: WorkerEvents, onChange: () => void): () => string[] {
  const workerIds = new Set<string>();
  // Never removed while the process lives: a pool still holds locks while it shuts down.
  const poolIds = new Set<string>();
  events.on("pool:create", ({ workerPool }) => {
    poolIds.add(workerPool.id);
    onChange();
  });
  events.on("worker:create", ({ worker }) => {
    poolIds.add(worker.workerPool.id);
    workerIds.add(worker.workerId);
    onChange();
  });
  events.on("worker:stop", ({ worker }) => {
    workerIds.delete(worker.workerId);
    onChange();
  });
  return () => [...poolIds, ...workerIds];
}
