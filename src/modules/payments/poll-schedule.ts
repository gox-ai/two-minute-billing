/**
 * Widening intervals for the settlement sweeps.
 *
 * ── The problem this solves ─────────────────────────────────────────────────────
 * The three sweeps in `stale-pending.ts` each ask a gateway a question about a transaction
 * and, when the answer changes nothing, record NOTHING. That is the money policy and it is
 * correct: the gateway's opinion outranks the clock's, and inventing an outcome is the one
 * thing a money sweep must never do.
 *
 * But recording nothing also meant remembering nothing, so the next tick asked the identical
 * question sixty seconds later, forever. Measured on dev 2026-09-02, on every tick:
 * `stale_pending` examined 103 and settled 0, `afa_recheck` examined 30 and recovered 0,
 * `zero_due` examined 209 and closed 0 — 10.3s of a 10.6s tick, 98% of the billing clock,
 * spent re-asking questions answered the same way about thirteen thousand times.
 *
 * Same disease as the dead SMTP relay the circuit breaker was built for: cost proportional
 * to the number of BROKEN things rather than to the work due.
 *
 * ── What this module does and does not do ───────────────────────────────────────
 * It changes WHEN a row is next asked about. It never decides an outcome, never gives up on
 * a charge, and holds no verdict. A row is polled until the gateway says something terminal;
 * only the gap between fruitless polls grows.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { settlementPollSchedule } from "@db/schema";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";

const log = createLogger("poll-schedule");

/**
 * The questions a transaction can be scheduled against.
 *
 * Per-PASS rather than per-transaction because the sweeps select overlapping rows: a debit
 * can be both "past its rail's grace period" (`stale_pending`) and "still live against an
 * invoice that owes nothing" (`zero_due`). One shared schedule would let the first defer a
 * row by an hour and thereby hide it from the second — and the second exists to release the
 * buyer's money. An hour of held funds is not a reasonable price for a saved poll.
 */
export const SETTLEMENT_POLL_PASSES = [
  "stale_pending",
  "afa_recheck",
  "zero_due",
  "lost_answer",
] as const;
export type SettlementPollPass = (typeof SETTLEMENT_POLL_PASSES)[number];

/**
 * The transaction ids this pass must NOT ask about yet.
 *
 * Returned as a set the caller filters its candidates through, rather than a join in each
 * sweep's query: two of the three build their candidate list with `selectDistinctOn` or a
 * join of their own, and bolting a `left join ... and pass = ?` onto each duplicated the
 * predicate three times with three chances to get the `IS NULL` half wrong. One small
 * indexed read per pass is cheaper than that risk — the table only ever holds rows that are
 * currently deferred.
 */
export async function deferredUntilLater(
  pass: SettlementPollPass,
  now: Date,
): Promise<ReadonlySet<string>> {
  try {
    const rows = await systemDb
      .select({ transactionId: settlementPollSchedule.transactionId })
      .from(settlementPollSchedule)
      .where(
        and(
          eq(settlementPollSchedule.pass, pass),
          // Strictly in the future = still deferred. Anything due or overdue is eligible,
          // and its stale row is simply overwritten when it defers again.
          sql`${settlementPollSchedule.nextAt} > ${now.toISOString()}::timestamptz`,
        ),
      );
    return new Set(rows.map((r) => r.transactionId));
  } catch (e) {
    // Fail OPEN: an unreadable schedule means "poll everything", which is exactly the old
    // behaviour — slow, but never wrong. Failing closed would silently stop asking the
    // gateway about live money, which is the one outcome this module must not cause.
    log.warn("could not read the settlement poll schedule; polling everything this pass", {
      event: "settlement_poll_schedule_read_failed",
      pass,
      error: String(e),
    });
    return new Set();
  }
}

/** Which of these transactions this pass has already scheduled (asked about) at least once. */
export async function scheduledBefore(
  pass: SettlementPollPass,
  transactionIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (transactionIds.length === 0) return new Set();
  const rows = await systemDb
    .select({ transactionId: settlementPollSchedule.transactionId })
    .from(settlementPollSchedule)
    .where(
      and(
        eq(settlementPollSchedule.pass, pass),
        inArray(settlementPollSchedule.transactionId, [...transactionIds]),
      ),
    );
  return new Set(rows.map((r) => r.transactionId));
}

/**
 * How long to wait before asking again, after `attempts` fruitless polls.
 *
 * ── The exponent is clamped, and that clamp is load-bearing ─────────────────────
 * `base * 2 ** attempts` reaches Infinity in JS (and overflows bigint in Postgres) long
 * before a `Math.min(..., cap)` applied AFTERWARDS can help, because the multiplication runs
 * first. That exact mistake — a cap that could never run — took the entire mail lane down on
 * 2026-09-02 at 51 consecutive failures; see `platform/circuit-breaker.ts`. With a 60s base
 * and a 1h ceiling the wait is already pinned by attempt 7, so 30 is unreachable in practice
 * and keeps the product finite regardless of what a caller passes.
 */
export function nextPollAt(attempts: number, now: Date): Date {
  const wait = Math.min(
    config.SETTLEMENT_POLL_BACKOFF_BASE_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 30),
    config.SETTLEMENT_POLL_MAX_BACKOFF_MS,
  );
  return new Date(now.getTime() + wait);
}

/** A row the caller asked about and learned nothing new from. */
export interface PollDeferral {
  organizationId: string;
  transactionId: string;
}

/**
 * Push the given rows out to their next interval, one statement per organization.
 *
 * Batched rather than a `withTenant` per row because a sweep can defer up to
 * `TICK_SCAN_LIMIT` rows and a transaction each would cost more than the polls it saves.
 * Grouped by organization because `withTenant` is what satisfies RLS and a single statement
 * cannot span two tenants.
 *
 * Failures are logged and swallowed. A missed deferral means the row is polled again next
 * tick — the behaviour we are moving away from, not a correctness problem — whereas throwing
 * would abort a pass that has already resolved real payments. Same reasoning as the circuit
 * breaker failing open: bookkeeping ABOUT work must never be able to undo the work.
 */
export async function deferPolls(
  pass: SettlementPollPass,
  rows: readonly PollDeferral[],
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  const byOrg = new Map<string, PollDeferral[]>();
  for (const r of rows) {
    const list = byOrg.get(r.organizationId);
    if (list) list.push(r);
    else byOrg.set(r.organizationId, [r]);
  }

  for (const [organizationId, orgRows] of byOrg) {
    try {
      await withTenant(organizationId, async (tx) => {
        // `attempts + 1` is computed by the DB in the conflict branch, so two sweeps racing
        // on the same row cannot both read 3 and both write 4. The insert path starts at 1.
        //
        // `.toISOString()` on every timestamp is required, not cosmetic: a bare `Date`
        // interpolated into a raw `sql` fragment binds as its JS string form
        // ("Wed Sep 02 2026 18:07:30 GMT+0530") and the statement fails. Drizzle's typed
        // helpers serialise a Date; a raw fragment does not. This has now cost a debug cycle
        // twice — here and in the worker-lifecycle suite.
        const values = sql.join(
          orgRows.map(
            (r) =>
              sql`(${r.transactionId}::uuid, ${pass}, ${organizationId}::uuid, ${nextPollAt(1, now).toISOString()}::timestamptz)`,
          ),
          sql`, `,
        );
        await tx.execute(sql`
          insert into settlement_poll_schedule (transaction_id, pass, organization_id, attempts, next_at)
          select v.txn, v.pass, v.org, 1, v.next_at
            from (values ${values}) as v(txn, pass, org, next_at)
          on conflict (transaction_id, pass) do update
            set attempts   = settlement_poll_schedule.attempts + 1,
                -- Recomputed from the INCREMENTED count, in SQL, for the same reason the
                -- increment is: the interval must follow the count that was actually stored.
                next_at    = ${now.toISOString()}::timestamptz
                             + least(
                                 ${config.SETTLEMENT_POLL_BACKOFF_BASE_MS}::bigint
                                   * power(2, least(settlement_poll_schedule.attempts, 30))::bigint,
                                 ${config.SETTLEMENT_POLL_MAX_BACKOFF_MS}::bigint
                               ) * interval '1 millisecond',
                updated_at = ${now.toISOString()}::timestamptz`);
      });
    } catch (e) {
      log.warn("could not record the settlement poll backoff", {
        event: "settlement_poll_defer_failed",
        pass,
        // `organizationId`, not `organization` — one name per concept, or a query for one
        // spelling silently misses the rows logged under the other (`verify:logging`).
        organizationId,
        rows: orgRows.length,
        error: String(e),
      });
    }
  }
}

/**
 * Forget a row's schedule for a pass.
 *
 * Called when a row stops being that pass's business — it settled, failed, or was handed to
 * a different sweep. Without this the table would keep a row per transaction ever polled,
 * and, worse, a transaction handed from `stale_pending` to `afa_recheck` would arrive with
 * an hour-wide interval earned answering a different question.
 */
export async function clearPollSchedule(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  transactionId: string,
  passes: readonly SettlementPollPass[] = SETTLEMENT_POLL_PASSES,
): Promise<void> {
  await tx.execute(sql`delete from settlement_poll_schedule
    where transaction_id = ${transactionId}::uuid
      and pass in (${sql.join(
        passes.map((p) => sql`${p}`),
        sql`, `,
      )})`);
}

/**
 * Drop schedules whose transaction has left the population of the pass that made them.
 *
 * Per-pass, because the passes watch different statuses: `stale_pending` and `zero_due` only
 * ever look at `in_progress` debits, while `afa_recheck` only looks at ones that have already
 * been marked `failure`. A single "is it finished?" rule leaks — a debit that ends in
 * `failure` is done with `stale_pending` forever, but `failure` is exactly the state
 * `afa_recheck` wants, so a shared rule keeps that row for good.
 *
 * `clearPollSchedule` covers the hand-offs that go through this module; this covers the
 * routes that never touch it — a webhook settling the charge, an operator reconciling by
 * hand. Cheap, and harmless if it never runs: a leaked row can only ever suppress polling of
 * a transaction no pass is polling.
 */
export async function reapFinishedPollSchedules(): Promise<void> {
  try {
    await systemDb.execute(sql`
      delete from settlement_poll_schedule s
       using transactions t
       where t.id = s.transaction_id
         and (
           (s.pass in ('stale_pending', 'zero_due') and t.status <> 'in_progress')
           or (s.pass = 'afa_recheck' and t.status <> 'failed')
           or (s.pass = 'lost_answer' and t.status <> 'timeout')
         )`);
  } catch (e) {
    // Housekeeping. A failure here leaks rows, which costs disk and nothing else — never a
    // reason to abort a sweep that has already resolved real payments.
    log.warn("could not reap finished settlement poll schedules", {
      event: "settlement_poll_reap_failed",
      error: String(e),
    });
  }
}

/** Exported for the verify suite: the passes a caller may schedule against. */
export function isSettlementPollPass(v: string): v is SettlementPollPass {
  return (SETTLEMENT_POLL_PASSES as readonly string[]).includes(v);
}
