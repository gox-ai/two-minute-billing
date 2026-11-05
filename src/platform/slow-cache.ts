/**
 * A per-process cache for reads that are expensive only on large books (D4.5).
 *
 * - Single-flight: callers asking one key while it computes share that computation.
 * - Only a SLOW answer is kept (`slowMs`). A small business keeps a live read on every request;
 *   only one whose answer took real time is served from memory for `ttlMs`.
 * - A failure is never cached.
 */
export function slowReadCache<K extends string, V>(opts: {
  ttlMs: number;
  slowMs: number;
  maxEntries: number;
  now?: () => number;
}): (key: K, compute: () => Promise<V>) => Promise<V> {
  const now = opts.now ?? Date.now;
  const kept = new Map<K, { at: number; value: V }>();
  const inFlight = new Map<K, Promise<V>>();
  return (key, compute) => {
    const hit = kept.get(key);
    if (hit && now() - hit.at < opts.ttlMs) return Promise.resolve(hit.value);
    if (hit) kept.delete(key);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const started = now();
    const p = compute().then(
      (value) => {
        inFlight.delete(key);
        if (now() - started >= opts.slowMs) {
          kept.set(key, { at: now(), value });
          // Oldest first: Map keeps insertion order.
          while (kept.size > opts.maxEntries) kept.delete(kept.keys().next().value!);
        }
        return value;
      },
      (err: unknown) => {
        inFlight.delete(key);
        throw err;
      },
    );
    inFlight.set(key, p);
    return p;
  };
}
