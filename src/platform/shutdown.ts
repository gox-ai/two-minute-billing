/**
 * Set once the process starts draining. Long-running jobs check it between units of work so
 * they return inside the worker's drain budget instead of being cut off mid-run.
 */
let draining = false;

export const isShuttingDown = (): boolean => draining;

export function beginShutdown(): void {
  draining = true;
}
