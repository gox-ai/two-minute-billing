/**
 * Bounded-concurrency execution for the billing clock's network-bound passes.
 *
 * Renewal and both outboxes were the same shape three times over: scan a bounded set of
 * rows, then `for (const row of rows) await work(row)` until a deadline. That loop makes
 * one network call per row and waits for it before starting the next, so throughput is
 * `budget ÷ latency` — measured 2026-09-11 at 25 renewals per 15s pass against a 593ms
 * Stripe mean. Nothing imposed that but the `await`: the gateway call happens outside the
 * DB transaction, `renewSubscription` already holds a guarded claim against overlapping
 * ticks, and both outboxes lease their rows with a compare-and-swap.
 *
 * The semantics below are the serial loop's, preserved deliberately:
 *
 *  - **The deadline is checked before STARTING an item, never mid-flight.** A renewal must
 *    stay atomic, so work already begun runs to completion even if that overruns. Same
 *    rule the serial version states at its own budget check.
 *  - **Per-item failures are isolated, not thrown.** One bad subscription cannot stall the
 *    pass; the caller records it. `settled` carries either a value or an error per item.
 *  - **Items start in input order.** Callers scan oldest-due-first so the cap is fair; with
 *    N lanes the N oldest start together, which keeps that property. They may FINISH out of
 *    order — callers that care must not infer ordering from `settled`.
 *  - **`unstarted` is what the budget did not reach**, so a caller can report `capped`
 *    truthfully rather than counting what it managed.
 *
 * Concurrency is a per-caller decision, not a constant here: renewal is bounded by the
 * gateway's per-account rate limit (Stripe publishes 100/s live, 25/s sandbox; Razorpay and
 * PayPal publish nothing), while egress is bounded by the relay — an SES account's send rate
 * is often lower than anything in this process.
 */

/**
 * Discriminated on `ok` rather than on the presence of an `error` key: a task that throws
 * `undefined` is rare but real, and a presence check would file it as a success.
 */
export type Settled<T, R> =
  | { ok: true; item: T; value: R }
  | { ok: false; item: T; error: unknown };

export interface BoundedResult<T, R> {
  /** One entry per item that was STARTED, in completion order. */
  settled: Array<Settled<T, R>>;
  /** Items never begun because the deadline passed. Empty when everything ran. */
  unstarted: T[];
}

/**
 * Run `fn` over `items` with at most `limit` in flight, stopping before starting anything
 * new once `deadline` (an epoch ms from `Date.now()`) has passed.
 *
 * `limit` is clamped to at least 1, so a misconfigured 0 degrades to the serial behaviour
 * this replaces rather than silently doing nothing.
 */
export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  opts: { deadline?: number } = {},
): Promise<BoundedResult<T, R>> {
  const settled: Array<Settled<T, R>> = [];
  if (items.length === 0) return { settled, unstarted: [] };

  const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  // Handed out monotonically, so every index below `cursor` has been started. That is what
  // makes `unstarted` a suffix rather than a set we would have to track per item.
  let cursor = 0;
  let outOfBudget = false;

  async function lane(): Promise<void> {
    for (;;) {
      if (outOfBudget) return;
      if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
        // Latched, not re-derived per lane: without it each lane re-reads the clock and the
        // count of "who noticed" varies run to run, which makes `unstarted` non-deterministic
        // for the same input.
        outOfBudget = true;
        return;
      }
      const i = cursor;
      if (i >= items.length) return;
      cursor = i + 1;
      const item = items[i]!;
      try {
        settled.push({ ok: true, item, value: await fn(item) });
      } catch (error) {
        settled.push({ ok: false, item, error });
      }
    }
  }

  await Promise.all(Array.from({ length: lanes }, () => lane()));
  return { settled, unstarted: items.slice(Math.min(cursor, items.length)) };
}

/** Narrowing helper — `settled.filter(isFailure)` reads better than an inline `ok` check. */
export function isFailure<T, R>(s: Settled<T, R>): s is { ok: false; item: T; error: unknown } {
  return !s.ok;
}
