/**
 * THE DIARY — maintaining `due_work`, and proving it right.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────
 * The billing clock currently finds work by scanning the entities that might have some:
 * every `active` subscription for a term that ended, every `in_trial` one for a trial that
 * did, every scheduled change, every invoice awaiting a dunning retry. Each scan is indexed
 * and each is capped, so none is slow at today's size — but each costs what EXISTS rather
 * than what is DUE. At 24,343 live subscriptions nearly every row read needed nothing, and
 * that ratio only gets worse.
 *
 * `due_work` is the inversion: one narrow row per outstanding item, keyed by when it comes
 * due, so the clock range-scans today's page instead of the whole book. The cost stops
 * tracking the customer count and starts tracking the workload — which is the entire
 * definition of "scales" for a scheduler.
 *
 * ── THE ONE DEFINITION ──────────────────────────────────────────────────────────
 * `DUE_SOURCES` below is the single place that says what "due" means for each kind, and it
 * is deliberately expressed as SQL over the SOURCE tables rather than as prose. Everything
 * else derives from it:
 *
 *   - `refreshDueWork()` upserts the projection from it,
 *   - the `due_work_matches_sources` invariant compares the table against it,
 *   - and the eventual cutover replaces the clock's scans with a read of what it produced.
 *
 * Two copies of "what is due" — one in the scans, one in the diary — is precisely the drift
 * this table is most exposed to, and a second definition written in a different file by a
 * different person a month later is how it would happen. There is one, here.
 *
 * ── WHY THIS SHIPS BEFORE ANYTHING READS IT ─────────────────────────────────────
 * A diary is a denormalisation, and denormalisations drift. A missed write is not an error,
 * it is SILENCE: a subscription that quietly never bills again. So the projection and its
 * reconciler ship together and run for a while, with nothing depending on them, until the
 * evidence says the two agree — including across a month boundary, when anchors, timezones
 * and proration all interact at once.
 */
import { and, sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { subscriptions, invoices } from "@db/schema";

/** Fixed for the life of the table. Chosen large so re-sharding is reassignment, not rehash. */
export const DUE_WORK_SHARDS = 1024;

export type DueWorkKind = "renewal" | "trial_end" | "scheduled_change" | "dunning_retry";

/**
 * What "due" means, per kind, as a SELECT over the source tables.
 *
 * Each yields `(entity_id, kind, due_at, business_id, organization_id)`. The predicates are
 * transcribed from the live scans and must stay identical to them — that is what the
 * reconciler checks, and it is why they are quoted here with their origin rather than
 * paraphrased:
 *
 *   renewal          `renewal.ts` — status 'active' AND current_period_end <= now
 *   trial_end        `renewal.ts` — status 'in_trial' AND (trial_end <= now OR
 *                    current_period_end <= now); due_at is coalesce(trial_end,
 *                    current_period_end), matching that scan's own ORDER BY. The `or` is
 *                    not redundant: rows created before migration 0189 carry the boundary
 *                    on the term rather than on `trial_end`.
 *   scheduled_change `scheduled-changes.ts` — status 'scheduled' AND effective_at <= now
 *   dunning_retry    `dunning.ts` — status 'payment_due' AND next_attempt_at IS NOT NULL
 *                    AND next_attempt_at <= now
 *
 * `autoCollectionOnSql()` is deliberately NOT applied to `dunning_retry`. It depends on
 * customer and business settings that can change between the diary being written and the
 * work being done, and a diary that pre-judges a live setting would silently drop work the
 * moment a merchant switched auto-collection back on. The diary answers "there is something
 * here on this date"; whether it is still ACTIONABLE is the pass's question, asked at the
 * moment it acts.
 *
 * ⚠ `due_at` is NOT filtered by `now` here. The diary holds FUTURE work too — that is what
 * lets the clock ask "what is due" instead of "what is overdue", and it is what makes the
 * range scan bounded. The source scans filter by `<= now` because they have no other way to
 * bound themselves.
 */
const DUE_SOURCES: Record<DueWorkKind, ReturnType<typeof sql>> = {
  renewal: sql`
    select s.id as entity_id, 'renewal' as kind, s.current_period_end as due_at,
           s.business_id, s.organization_id
    from subscriptions s
    where s.status = 'active' and s.current_period_end is not null`,

  trial_end: sql`
    select s.id as entity_id, 'trial_end' as kind,
           coalesce(s.trial_end, s.current_period_end) as due_at,
           s.business_id, s.organization_id
    from subscriptions s
    where s.status = 'in_trial'
      and coalesce(s.trial_end, s.current_period_end) is not null`,

  scheduled_change: sql`
    select c.id as entity_id, 'scheduled_change' as kind, c.effective_at as due_at,
           c.business_id, c.organization_id
    from scheduled_changes c
    where c.status = 'scheduled'`,

  dunning_retry: sql`
    select i.id as entity_id, 'dunning_retry' as kind, i.next_attempt_at as due_at,
           i.business_id, i.organization_id
    from invoices i
    where i.status = 'payment_due' and i.next_attempt_at is not null`,
};

/** Every source as one relation — also what the back-office reconciler compares against. */
export function dueWorkSources(): ReturnType<typeof sql> {
  const parts = Object.values(DUE_SOURCES);
  return parts.reduce((acc, part, i) => (i === 0 ? part : sql`${acc} union all ${part}`));
}

/**
 * Bring `due_work` into line with the sources.
 *
 * Upsert-then-delete rather than truncate-then-insert: a truncate has a window in which
 * everything is due and nothing is visible, and on this table that window is bills not going
 * out. The upsert is keyed on (entity_id, kind), so re-running it is free and concurrent
 * runs converge rather than conflict.
 *
 * Returns what changed, so the caller can log a delta rather than a heartbeat — a refresh
 * that reports "0 written, 0 removed" every time is one you can leave running and still
 * notice when it stops being true.
 */
export async function refreshDueWork(): Promise<{ upserted: number; removed: number }> {
  const upsertResult = (await systemDb.execute(sql`
    insert into due_work (shard, due_at, kind, entity_id, business_id, organization_id, updated_at)
    select
      -- hashtext can be negative; abs() before the modulo, or a business lands on a
      -- negative shard no scheduler will ever lease. A null business (org-level work)
      -- hashes the empty string, which is a stable shard rather than a null one.
      abs(hashtext(coalesce(src.business_id::text, ''))) % ${DUE_WORK_SHARDS},
      src.due_at, src.kind, src.entity_id, src.business_id, src.organization_id, now()
    from (${dueWorkSources()}) src
    -- Only rows missing or moved. ON CONFLICT locks every conflicting row even when its WHERE
    -- then skips the update, so upserting the whole book held every diary row for the length
    -- of the statement: each renewal's trigger queued behind it (D4: 70 renewals stalled 15 s
    -- at 1.2M subscriptions), then the refresh wrote back the due date it read before them.
    left join due_work cur on cur.entity_id = src.entity_id and cur.kind = src.kind
    where cur.due_at is distinct from src.due_at
    on conflict (entity_id, kind) do update
      set due_at = excluded.due_at,
          shard = excluded.shard,
          business_id = excluded.business_id,
          organization_id = excluded.organization_id,
          updated_at = now()
      -- Only touch rows that actually moved. Without this every refresh rewrites every
      -- row, which on a table this hot is pure vacuum pressure for no information.
      where due_work.due_at is distinct from excluded.due_at
    returning 1`)) as unknown;

  // Anything the sources no longer claim: a subscription that cancelled, a change that
  // applied, an invoice that got paid. Left behind, these are the diary's other failure
  // mode — work that is due forever because nothing ever retracts it.
  const deleteResult = (await systemDb.execute(sql`
    delete from due_work d
    where not exists (
      select 1 from (${dueWorkSources()}) src
      where src.entity_id = d.entity_id and src.kind = d.kind
    )
    returning 1`)) as unknown;

  const count = (r: unknown) =>
    Array.isArray(r) ? r.length : ((r as { rows?: unknown[] }).rows?.length ?? 0);
  return { upserted: count(upsertResult), removed: count(deleteResult) };
}
