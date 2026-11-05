import type { RetryRow } from "@/lib/api/retries";

/**
 * How a row on the Retries screen describes where its dunning has got to.
 *
 * Lives here rather than beside its fetcher because it is pure presentation with no
 * server dependency, and `lib/api/retries` is server-only — it reaches `next/headers`
 * for the session. A `'use client'` table importing this VALUE from there dragged the
 * server module into the client bundle and broke the production build. Types alone
 * cross that boundary safely (they erase); functions do not.
 */
/**
 * The Retries screen's segments — a partition of "under retry", resolved in SQL by
 * `RETRY_STATE` (src/modules/invoicing/retries.ts).
 *
 * Here, not beside the fetcher, for the reason in this file's header: the segment list
 * is built inside a `'use client'` table, so the DEFAULT has to cross the boundary as a
 * value. Defining it in `lib/api/retries` and importing it there pulled `next/headers`
 * into the client bundle and 500'd the page — the same mistake this module was created
 * to prevent, made a second time.
 */
export type RetryState = "attention" | "recovered" | "given_up" | "all";

/**
 * The segment the screen opens on, and the state its SERVER-rendered first page must
 * therefore be fetched with.
 *
 * `ListPage` builds its `ssrQueryKey` from `segments[0].filters` and skips the mount
 * refetch when the live query matches, so the two cannot disagree — the table derives
 * its segment order from this constant rather than trusting a literal order.
 */
export const DEFAULT_RETRY_STATE: RetryState = "attention";

/** Newest first. The SSR page and the table must agree, or the first page shows another order. */
export const DEFAULT_RETRY_SORT = { field: "retry_started_at", desc: true } as const;

export function retryStatusLabel(r: RetryRow): string {
  if (r.dunning_status) return r.dunning_status.replace(/_/g, " ");
  return r.status === "not_paid" ? "not paid" : "in progress";
}
