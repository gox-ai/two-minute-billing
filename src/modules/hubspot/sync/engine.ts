import { and, eq, inArray, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { isShuttingDown } from "@/platform/shutdown";
import { publicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";
import {
  hubspotConnections,
  hubspotSyncItems,
  hubspotSyncQueue,
  hubspotSyncRuns,
  subscriptions,
} from "@db/schema";
import { HubSpotApiError, HubSpotClient, type Connection } from "../client";
import { HubSpotAuthError } from "../oauth";
import { HANDLERS } from "./handlers";
import { BATCH_LIMIT, pushCustomers, type CustomerResult } from "./customers-batch";
import { pullChanges } from "./pull";
import { parseSettings, type HubSpotSettings } from "../settings";
import type { SyncContext } from "./context";
import type { SyncOutcome } from "./links";

const log = createLogger("hubspot.sync");

export type SyncTrigger = "event" | "autosync" | "manual" | "initial";

type QueueRow = typeof hubspotSyncQueue.$inferSelect;
type Run = typeof hubspotSyncRuns.$inferSelect;

/** Skips are DB-only, so a claim is wide enough that they never starve the customer batches. */
const BATCH = 200;
/** Fewer customer rows than this go one at a time: a batch saves nothing on them. */
const MIN_CUSTOMER_BATCH = 5;
/** Handler work in flight at once; the client paces the requests underneath. */
const LANES = 4;
const MAX_ATTEMPTS = 8;
/** A claim older than this belonged to a worker that died mid-push. */
const STALE_LOCK = "15 minutes";
/** Longer than any run lasts (event passes ~50s, first sync / Sync Now 10 min). */
const ABANDONED_RUN = "20 minutes";

/** 1m, 2m, 4m … capped at 2h. */
const backoffSeconds = (attempts: number) => Math.min(60 * 2 ** Math.max(0, attempts - 1), 7200);

async function startRun(conn: Connection, trigger: SyncTrigger): Promise<Run> {
  return withTenant(conn.organizationId, async (tx) => {
    const [run] = await tx
      .insert(hubspotSyncRuns)
      .values({
        organizationId: conn.organizationId,
        businessId: conn.businessId,
        connectionId: conn.id,
        publicId: publicId("hsr"),
        trigger,
      })
      .returning();
    return run!;
  });
}

async function claim(conn: Connection): Promise<QueueRow[]> {
  return withTenant(conn.organizationId, async (tx) => {
    const rows = await tx.execute(sql`
      UPDATE hubspot_sync_queue SET locked_at = now(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM hubspot_sync_queue
        WHERE connection_id = ${conn.id} AND locked_at IS NULL AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, resource_type, resource_id, attempts
    `);
    return (rows as unknown as Array<Record<string, unknown>>).map(
      (r) =>
        ({
          id: r.id as string,
          resourceType: r.resource_type as string,
          resourceId: r.resource_id as string,
          attempts: Number(r.attempts),
        }) as QueueRow,
    );
  });
}

/**
 * Put a failed row back for later, unless a newer event already queued the same record —
 * the unique index allows one unclaimed row per record, and that one will carry the retry.
 */
async function release(conn: Connection, row: QueueRow, error: string, delaySeconds: number) {
  await withTenant(conn.organizationId, (tx) =>
    tx.execute(sql`
      WITH twin AS (
        SELECT 1 FROM hubspot_sync_queue
        WHERE connection_id = ${conn.id} AND resource_type = ${row.resourceType}
          AND resource_id = ${row.resourceId} AND locked_at IS NULL
      ), dropped AS (
        DELETE FROM hubspot_sync_queue WHERE id = ${row.id} AND EXISTS (SELECT 1 FROM twin)
      )
      UPDATE hubspot_sync_queue
      SET locked_at = NULL, last_error = ${error.slice(0, 500)},
          next_attempt_at = now() + make_interval(secs => ${delaySeconds})
      WHERE id = ${row.id} AND NOT EXISTS (SELECT 1 FROM twin)
    `),
  );
}

async function finishRow(conn: Connection, row: QueueRow) {
  await withTenant(conn.organizationId, (tx) =>
    tx.delete(hubspotSyncQueue).where(eq(hubspotSyncQueue.id, row.id)),
  );
}

async function logItem(conn: Connection, run: Run, o: SyncOutcome) {
  await withTenant(conn.organizationId, (tx) =>
    tx.insert(hubspotSyncItems).values({
      organizationId: conn.organizationId,
      businessId: conn.businessId,
      runId: run.id,
      localType: o.localType,
      localRef: o.localRef ?? null,
      remoteType: o.remoteType ?? null,
      remoteId: o.remoteId ?? null,
      action: o.action,
      message: o.message ?? null,
    }),
  );
}

/** Return claims from a batch that could not be attempted, without burning an attempt. */
async function unclaim(conn: Connection, rows: QueueRow[]) {
  for (const row of rows) {
    await withTenant(conn.organizationId, (tx) =>
      tx.execute(sql`
        UPDATE hubspot_sync_queue SET locked_at = NULL, attempts = GREATEST(attempts - 1, 0)
        WHERE id = ${row.id}
          AND NOT EXISTS (
            SELECT 1 FROM hubspot_sync_queue t
            WHERE t.connection_id = ${conn.id} AND t.resource_type = ${row.resourceType}
              AND t.resource_id = ${row.resourceId} AND t.locked_at IS NULL)
      `),
    );
  }
}

/** `apiSubscriptionStatus` in SQL. */
function statusFilter(statuses: HubSpotSettings["deals"]["statuses"]) {
  const renewing = sql`(cancel_at_period_end OR cancel_scheduled_at IS NOT NULL OR COALESCE(remaining_billing_cycles, -1) = 0)`;
  const one = statuses.map((st) =>
    st === "non_renewing"
      ? sql`(status = 'active' AND ${renewing})`
      : st === "active"
        ? sql`(status = 'active' AND NOT ${renewing})`
        : sql`status = ${st}`,
  );
  return sql.join(one, sql` OR `);
}

/**
 * Queue every customer, and the subscriptions and prices that can sync — the initial sweep and
 * "resync everything". A subscription outside the deal statuses would only be skipped.
 */
async function enqueueAll(conn: Connection): Promise<void> {
  const settings = parseSettings(conn.settings);
  const sources: Array<[string, ReturnType<typeof sql>]> = [
    ["customer", sql`SELECT id FROM customers WHERE business_id = ${conn.businessId}`],
  ];
  if (settings.deals.enabled && settings.deals.statuses.length > 0)
    sources.push([
      "subscription",
      sql`SELECT id FROM subscriptions WHERE business_id = ${conn.businessId} AND deleted_at IS NULL
          AND (${statusFilter(settings.deals.statuses)})`,
    ]);
  if (settings.products.enabled)
    sources.push(["price", sql`SELECT id FROM prices WHERE business_id = ${conn.businessId}`]);
  if (settings.invoices.enabled && settings.invoices.objectType)
    sources.push([
      "invoice",
      sql`SELECT id FROM invoices WHERE business_id = ${conn.businessId} AND status <> 'pending'`,
    ]);
  await withTenant(conn.organizationId, async (tx) => {
    for (const [type, source] of sources) {
      await tx.execute(sql`
        INSERT INTO hubspot_sync_queue
          (organization_id, business_id, connection_id, resource_type, resource_id, reason)
        SELECT ${conn.organizationId}::uuid, ${conn.businessId}::uuid, ${conn.id}::uuid, ${type}, src.id, 'full_sync'
        FROM (${source}) src
        ON CONFLICT (connection_id, resource_type, resource_id) WHERE locked_at IS NULL DO NOTHING
      `);
    }
  });
}

/** subscription id → customer id, for the claimed subscription rows. */
async function subscriptionOwners(conn: Connection, rows: QueueRow[]) {
  if (rows.length === 0) return new Map<string, string>();
  const found = await withTenant(conn.organizationId, (tx) =>
    tx
      .select({ id: subscriptions.id, customerId: subscriptions.customerId })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.businessId, conn.businessId),
          inArray(
            subscriptions.id,
            rows.map((r) => r.resourceId),
          ),
        ),
      ),
  );
  return new Map(found.map((r) => [r.id, r.customerId]));
}

/** Close runs whose worker stopped mid-run (a deploy, a crash); their records were requeued. */
async function closeAbandonedRuns(conn: Connection): Promise<void> {
  await withTenant(conn.organizationId, (tx) =>
    tx.execute(sql`
      UPDATE hubspot_sync_runs
      SET status = 'interrupted', finished_at = now(),
          error = 'The worker stopped mid-run; its records were put back in the queue and retried.'
      WHERE connection_id = ${conn.id} AND status = 'running'
        AND started_at < now() - ${ABANDONED_RUN}::interval
    `),
  );
}

async function reclaimStaleLocks(conn: Connection): Promise<void> {
  await withTenant(conn.organizationId, (tx) =>
    tx.execute(sql`
      WITH stale AS (
        SELECT s.id, EXISTS (
          SELECT 1 FROM hubspot_sync_queue t
          WHERE t.connection_id = s.connection_id AND t.resource_type = s.resource_type
            AND t.resource_id = s.resource_id AND t.locked_at IS NULL) AS has_twin
        FROM hubspot_sync_queue s
        WHERE s.connection_id = ${conn.id} AND s.locked_at < now() - ${STALE_LOCK}::interval
      ), dropped AS (
        DELETE FROM hubspot_sync_queue WHERE id IN (SELECT id FROM stale WHERE has_twin)
      )
      UPDATE hubspot_sync_queue SET locked_at = NULL
      WHERE id IN (SELECT id FROM stale WHERE NOT has_twin)
    `),
  );
}

export interface RunResult {
  run: Run | null;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

/**
 * One pass for one connection. A `full` pass queues the whole book first. Event passes
 * create a run row only when there was work, so an idle portal leaves no log noise.
 */
export async function runSync(
  conn: Connection,
  trigger: SyncTrigger,
  opts: { full?: boolean; budgetMs?: number } = {},
): Promise<RunResult> {
  const deadline = Date.now() + (opts.budgetMs ?? 50_000);
  const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  let run: Run | null = trigger === "event" ? null : await startRun(conn, trigger);
  let fatal: string | null = null;

  if (conn.status !== "active") {
    fatal = "HubSpot is not connected";
  } else {
    await reclaimStaleLocks(conn);
    await closeAbandonedRuns(conn);
    if (opts.full) {
      await enqueueAll(conn);
      await withTenant(conn.organizationId, (tx) =>
        tx
          .update(hubspotConnections)
          .set({ initialSync: "running" })
          .where(eq(hubspotConnections.id, conn.id)),
      );
    }
    const ctx: SyncContext = {
      client: new HubSpotClient(conn),
      conn,
      settings: parseSettings(conn.settings),
    };

    // HubSpot-side edits first, so a push in this pass does not overwrite what was just pulled.
    if (trigger !== "event") {
      try {
        const pulled = await pullChanges(ctx);
        if (pulled.length > 0) {
          run ??= await startRun(conn, trigger);
          for (const o of pulled) {
            counts[o.action] += 1;
            await logItem(conn, run, o);
          }
        }
      } catch (err) {
        if (err instanceof HubSpotAuthError) fatal = err.message;
        else log.error(err, { event: "hubspot_pull_error", connection: conn.publicId });
      }
    }

    // A draining worker stops like a spent budget: the unreached claims go straight back.
    const stop = () => fatal !== null || Date.now() >= deadline || isShuttingDown();

    /** Log a row's result and finish or reschedule it; an auth failure stops the pass instead. */
    const settle = async (row: QueueRow, result: CustomerResult, settled: Set<string>) => {
      if ("outcomes" in result) {
        for (const outcome of result.outcomes) {
          counts[outcome.action] += 1;
          if (outcome.action !== "skipped" || outcome.message !== "No changes")
            await logItem(conn, run!, outcome);
        }
        await finishRow(conn, row);
        settled.add(row.id);
        return;
      }
      const err = result.error;
      if (err instanceof HubSpotAuthError) {
        fatal ??= err.message;
        return;
      }
      const message = (err as Error).message ?? String(err);
      const retryable = err instanceof HubSpotApiError ? err.retryable : true;
      counts.failed += 1;
      await logItem(conn, run!, {
        action: "failed",
        localType: row.resourceType,
        message: retryable && row.attempts < MAX_ATTEMPTS ? `${message}. We will retry.` : message,
      });
      if (retryable && row.attempts < MAX_ATTEMPTS) {
        await release(conn, row, message, backoffSeconds(row.attempts));
      } else {
        await finishRow(conn, row);
      }
      settled.add(row.id);
      if (!(err instanceof HubSpotApiError))
        log.error(err, { event: "hubspot_push_error", row: row.id });
    };

    const runOne = async (row: QueueRow, settled: Set<string>) => {
      if (stop()) return;
      const handler = HANDLERS[row.resourceType];
      if (!handler) {
        await finishRow(conn, row);
        settled.add(row.id);
        return;
      }
      let result: CustomerResult;
      try {
        result = { outcomes: await handler(ctx, row.resourceId) };
      } catch (error) {
        result = { error };
      }
      await settle(row, result, settled);
    };

    const runCustomers = async (rows: QueueRow[], settled: Set<string>) => {
      if (rows.length < MIN_CUSTOMER_BATCH) {
        for (const row of rows) await runOne(row, settled);
        return;
      }
      for (let i = 0; i < rows.length; i += BATCH_LIMIT) {
        if (stop()) return;
        const part = rows.slice(i, i + BATCH_LIMIT);
        let results: Map<string, CustomerResult>;
        try {
          results = await pushCustomers(
            ctx,
            part.map((r) => r.resourceId),
          );
        } catch (err) {
          if (err instanceof HubSpotAuthError) {
            fatal ??= err.message;
            return;
          }
          log.error(err, { event: "hubspot_batch_error", connection: conn.publicId });
          for (const row of part) await runOne(row, settled);
          continue;
        }
        for (const row of part) {
          const r = results.get(row.resourceId);
          if (r) await settle(row, r, settled);
          else await runOne(row, settled);
        }
      }
    };

    while (!stop()) {
      const batch = await claim(conn);
      if (batch.length === 0) break;
      run ??= await startRun(conn, trigger);
      const settled = new Set<string>();

      // Customers go first as one lane; a subscription may push its customer, so subscriptions
      // of a customer claimed here wait for that lane, and one customer's run in sequence.
      const customerRows = batch.filter((r) => r.resourceType === "customer");
      const subRows = batch.filter((r) => r.resourceType === "subscription");
      // Invoices go last, so they find the contacts, companies and deals this batch links.
      const invoiceRows = batch.filter((r) => r.resourceType === "invoice");
      const otherRows = batch.filter(
        (r) =>
          r.resourceType !== "customer" &&
          r.resourceType !== "subscription" &&
          r.resourceType !== "invoice",
      );
      const owners = await subscriptionOwners(conn, subRows);
      const claimedCustomers = new Set(customerRows.map((r) => r.resourceId));
      const groups = new Map<string, QueueRow[]>();
      for (const row of subRows) {
        const owner = owners.get(row.resourceId) ?? row.resourceId;
        groups.set(owner, [...(groups.get(owner) ?? []), row]);
      }
      const unit = (rows: QueueRow[]) => async () => {
        for (const row of rows) await runOne(row, settled);
      };
      const queue: Array<() => Promise<void>> = [];
      const after: Array<() => Promise<void>> = [];
      for (const [owner, rows] of groups)
        (claimedCustomers.has(owner) ? after : queue).push(unit(rows));
      if (otherRows.length > 0) queue.push(unit(otherRows));

      let leadDone = false;
      const lead = runCustomers(customerRows, settled).finally(() => {
        queue.push(...after);
        leadDone = true;
      });
      const worker = async () => {
        for (;;) {
          const next = queue.shift();
          if (next) await next();
          else if (leadDone) return;
          else await lead.catch(() => undefined);
        }
      };
      await Promise.all([lead, ...Array.from({ length: LANES - 1 }, worker)]);
      // One lane: two invoices of an unlinked customer must not both create its contact.
      for (const row of invoiceRows) await runOne(row, settled);

      const left = batch.filter((r) => !settled.has(r.id));
      if (left.length > 0) {
        await unclaim(conn, left);
        break;
      }
    }
  }

  const pending = await withTenant(conn.organizationId, async (tx) => {
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(hubspotSyncQueue)
      .where(eq(hubspotSyncQueue.connectionId, conn.id));
    return r?.n ?? 0;
  });

  if (run) {
    const status = fatal
      ? "failed"
      : isShuttingDown()
        ? "interrupted"
        : counts.failed > 0
          ? "partial"
          : "succeeded";
    await withTenant(conn.organizationId, async (tx) => {
      const [done] = await tx
        .update(hubspotSyncRuns)
        .set({
          ...counts,
          status,
          error:
            fatal ??
            (status === "interrupted"
              ? "The worker restarted. We put the remaining items back in the queue."
              : null),
          finishedAt: new Date(),
        })
        .where(eq(hubspotSyncRuns.id, run!.id))
        .returning();
      run = done ?? run;
      await tx
        .update(hubspotConnections)
        .set({
          lastSyncAt: new Date(),
          lastError: fatal,
          // The first sync outlasts its own job; whichever run drains the queue completes it.
          ...((opts.full || conn.initialSync === "running") && !fatal && pending === 0
            ? { initialSync: "done" }
            : {}),
        })
        .where(eq(hubspotConnections.id, conn.id));
    });
  }
  return { run, ...counts };
}

/** Connections with pushes due, across tenants (a clock scan), for the per-minute tick. */
export async function connectionsWithDueWork(): Promise<
  Array<{ organizationId: string; id: string }>
> {
  const rows = await systemDb.execute(sql`
    SELECT DISTINCT c.organization_id, c.id
    FROM hubspot_connections c
    JOIN hubspot_sync_queue q ON q.connection_id = c.id
    WHERE c.status = 'active' AND c.autosync AND c.initial_sync <> 'pending'
      AND q.locked_at IS NULL AND q.next_attempt_at <= now()
  `);
  return (rows as unknown as Array<{ organization_id: string; id: string }>).map((r) => ({
    organizationId: r.organization_id,
    id: r.id,
  }));
}

/** Every autosyncing connection, for the 15-minute pass. */
export async function autosyncConnections(): Promise<
  Array<{ organizationId: string; id: string }>
> {
  const rows = await systemDb.execute(sql`
    SELECT organization_id, id FROM hubspot_connections
    WHERE status = 'active' AND autosync AND initial_sync <> 'pending'
  `);
  return (rows as unknown as Array<{ organization_id: string; id: string }>).map((r) => ({
    organizationId: r.organization_id,
    id: r.id,
  }));
}

export async function loadConnection(
  organizationId: string,
  id: string,
): Promise<Connection | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(hubspotConnections)
      .where(eq(hubspotConnections.id, id))
      .limit(1);
    return row ?? null;
  });
}
