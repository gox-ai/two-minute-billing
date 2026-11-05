import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { afterCommit, systemDb, withTenant, type Tx } from "@/platform/db";
import { scanBusinessFilter } from "@/platform/clock";
import { runBounded } from "@/platform/concurrency";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";
import { decryptCredentials } from "@/platform/secrets";
import {
  backoffSeconds,
  clip,
  errorText,
  MAX_DELIVERY_ATTEMPTS,
  postOnce,
  requestOrigin,
  type DeliveryTranscript,
} from "@/platform/http-delivery";
import {
  dependencyKey,
  loadOpenDependencies,
  recordFailure,
  recordSuccess,
} from "@/platform/circuit-breaker";
import type { EventRow } from "@/modules/events/emit";
import { events, integrationConnections, integrationDeliveries } from "@db/schema";
import { pushIntegration } from "./registry";

const log = createLogger("integrations.outbox");

type Connection = typeof integrationConnections.$inferSelect;
type Delivery = typeof integrationDeliveries.$inferSelect;
type Event = typeof events.$inferSelect;

/**
 * Fan-out for push integrations, inside the emit transaction (ADR-007): one delivery row per
 * active, enabled connection of this business whose integration maps this event type. The
 * connection's livemode is the business's, so the partition needs no extra check.
 */
export async function enqueueIntegrationDeliveries(tx: Tx, event: EventRow): Promise<void> {
  if (!event.businessId) return;
  const conns = await tx
    .select({ id: integrationConnections.id, provider: integrationConnections.provider })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.businessId, event.businessId),
        eq(integrationConnections.status, "active"),
        eq(integrationConnections.enabled, true),
      ),
    );
  // The mapping decides which events have a partner call at all; read it here rather than from
  // a stored list, so a mapping that gains an event type needs no backfill.
  const due = conns.filter((c) =>
    (pushIntegration(c.provider)?.connect.eventTypes as readonly string[] | undefined)?.includes(
      event.type,
    ),
  );
  if (due.length === 0) return;
  await tx.insert(integrationDeliveries).values(
    due.map((c) => ({
      organizationId: event.organizationId,
      businessId: event.businessId!,
      connectionId: c.id,
      eventId: event.id,
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
    })),
  );
  // After commit, through the no-argument SECURITY DEFINER wrapper — same reasons as webhooks.
  if (!afterCommit(async () => requestNudge()))
    await tx.execute(sql`select public.app_nudge_integration_outbox()`);
}

let nudging: Promise<void> | null = null;
let nudgeAgain = false;
/** One nudge in flight per process; a request made meanwhile folds into one more after it. */
function requestNudge(): void {
  if (nudging) {
    nudgeAgain = true;
    return;
  }
  nudging = (async () => {
    do {
      nudgeAgain = false;
      try {
        await systemDb.execute(sql`select public.app_nudge_integration_outbox()`);
      } catch (e) {
        log.warn("integration outbox nudge failed; the minute drain will pick it up", {
          event: "integration_nudge_failed",
          error: (e as Error)?.message,
        });
      }
    } while (nudgeAgain);
    nudging = null;
  })();
}

/**
 * ONE attempt for one delivery, settling the row. The clock and a manual Resend both call this,
 * so a resend cannot report green for a request the clock would judge failed.
 */
export async function attemptIntegrationDelivery(input: {
  delivery: Delivery;
  event: Event;
  connection: Connection;
  now: Date;
  timeoutMs: number;
  openDeps?: ReadonlySet<string>;
  /** When false (a resend), an open breaker does not stop the call. */
  skipOpenCircuit?: boolean;
  capture?: boolean;
}): Promise<DeliveryTranscript> {
  const { delivery: d, event, connection: conn, now, timeoutMs } = input;
  const skipOpenCircuit = input.skipOpenCircuit ?? true;
  const capture = input.capture ?? false;
  const settle = (set: Partial<typeof integrationDeliveries.$inferInsert>) =>
    systemDb.update(integrationDeliveries).set(set).where(eq(integrationDeliveries.id, d.id));
  const none = { method: "POST" as const, url: conn.apiBase, headers: {}, body: "" };

  const integration = pushIntegration(conn.provider);
  // A disconnected or unknown connection can never deliver; settle rather than strand.
  if (!integration || conn.status !== "active" || !conn.credentialsEnc) {
    const reason = !integration
      ? `Unknown integration: ${conn.provider}`
      : "The integration is disconnected";
    await settle({ status: "failed", lastAttemptAt: now, lastError: reason });
    return {
      request: none,
      response: null,
      error: reason,
      latencyMs: 0,
      outcome: "failed",
      attempts: d.attempts,
    };
  }

  // `build` reads the database and the credentials, so it can throw. A build error is
  // deterministic, so it is terminal; a throw left uncaught would strand the row on its lease.
  let built;
  try {
    built = await integration.build({
      event,
      baseUrl: conn.apiBase,
      credentials: decryptCredentials(conn.credentialsEnc),
      config: conn.config ?? {},
    });
  } catch (e) {
    const reason = (e as Error)?.message ?? "The integration could not build a request";
    log.error("integration could not build a request — settling the delivery failed", {
      event: "integration_build_failed",
      connection: conn.publicId,
      delivery: d.id,
      detail: reason,
    });
    await settle({
      status: "failed",
      attempts: d.attempts + 1,
      lastAttemptAt: now,
      lastError: errorText(reason),
    });
    return {
      request: none,
      response: null,
      error: reason,
      latencyMs: 0,
      outcome: "failed",
      attempts: d.attempts + 1,
    };
  }
  // Nothing to send for this event (an organic signup, a zero-value sale). No attempt counted.
  if (!built) {
    await settle({ status: "skipped", lastAttemptAt: now });
    return {
      request: none,
      response: null,
      error: null,
      latencyMs: 0,
      outcome: "skipped",
      attempts: d.attempts,
    };
  }

  const secret = new Set((built.secretHeaders ?? []).map((h) => h.toLowerCase()));
  const safeHeaders = Object.fromEntries(
    Object.entries(built.headers).map(([k, v]) => [k, secret.has(k.toLowerCase()) ? "***" : v]),
  );
  const request = {
    method: "POST" as const,
    url: built.url,
    headers: safeHeaders,
    body: capture ? clip(built.body) : "",
  };

  const origin = requestOrigin(built.url);
  const depKey = origin ? dependencyKey("integration", event.businessId, origin) : null;
  if (skipOpenCircuit && depKey && input.openDeps?.has(depKey)) {
    await settle({ nextAttemptAt: new Date(now.getTime() + config.CIRCUIT_BREAKER_COOLDOWN_MS) });
    return {
      request,
      response: null,
      error: "The partner host is circuit-broken. We did not call it.",
      latencyMs: 0,
      outcome: "not_attempted",
      attempts: d.attempts,
    };
  }

  const res = await postOnce({
    url: built.url,
    headers: built.headers,
    body: built.body,
    timeoutMs,
    capture,
  });
  // A refused target made no request, so it says nothing about the host's health.
  if (depKey && !res.refused) {
    if (res.status === 0) {
      await recordFailure(depKey, "integration", event.businessId, "no response from partner", now);
    } else {
      await recordSuccess(depKey, now, input.openDeps?.has(depKey) ?? false);
    }
  }

  const attempts = d.attempts + 1;
  const response = res.headers
    ? { status: res.status, headers: res.headers, body: res.body }
    : null;
  const base = { request, response, error: res.error, latencyMs: res.latencyMs, attempts };
  const lastError = errorText(res.error ?? res.body);
  // The partner's vocabulary first (a duplicate is delivered; a refusal is terminal), then 2xx.
  const verdict = res.status === 0 ? null : integration.judge(res.status, built);
  const delivered =
    verdict === "delivered" || (verdict === null && res.status >= 200 && res.status < 300);
  const common = {
    attempts,
    lastAttemptAt: now,
    lastResponseStatus: res.status,
    durationMs: res.latencyMs,
  };

  if (delivered) {
    // A 2xx says nothing worth keeping; a partner's "delivered" 404/409 still does.
    await settle({
      ...common,
      status: "delivered",
      lastError: res.status < 300 ? null : lastError,
    });
    return { ...base, outcome: "delivered" };
  }
  if (verdict === "terminal" || res.refused || attempts >= MAX_DELIVERY_ATTEMPTS) {
    await settle({ ...common, status: "failed", lastError });
    return { ...base, outcome: "failed" };
  }
  await settle({
    ...common,
    lastError,
    nextAttemptAt: new Date(now.getTime() + backoffSeconds(attempts) * 1000),
  });
  return { ...base, outcome: "retrying" };
}

/**
 * Drain due deliveries: fair share per business, atomic `skip locked` lease, bounded
 * concurrency and a wall-clock budget — the webhook drain's shape, on this table.
 */
export async function deliverPendingIntegrations(now: Date): Promise<{
  attempted: number;
  delivered: number;
  failed: number;
  circuitOpen: number;
  skipped: number;
  capped?: boolean;
}> {
  const ranked = systemDb
    .select({
      id: integrationDeliveries.id,
      nextAttemptAt: integrationDeliveries.nextAttemptAt,
      rn: sql<number>`row_number() over (
        partition by ${integrationDeliveries.businessId}
        order by ${integrationDeliveries.nextAttemptAt}, ${integrationDeliveries.id}
      )`.as("rn"),
    })
    .from(integrationDeliveries)
    .where(
      and(
        eq(integrationDeliveries.status, "pending"),
        lte(integrationDeliveries.nextAttemptAt, now),
        scanBusinessFilter(integrationDeliveries.businessId),
      ),
    )
    .as("ranked");
  const picked = await systemDb
    .select({ id: ranked.id })
    .from(ranked)
    .where(lte(ranked.rn, config.TICK_FAIR_SHARE_PER_BUSINESS))
    .orderBy(ranked.nextAttemptAt)
    .limit(config.TICK_SCAN_LIMIT);
  const capped = picked.length >= config.TICK_SCAN_LIMIT;

  const claimed: Delivery[] = [];
  if (picked.length > 0) {
    const leaseUntil = new Date(now.getTime() + 60_000).toISOString();
    const ids = "{" + picked.map((p) => p.id).join(",") + "}";
    const rows = (await systemDb.execute(sql`
      update integration_deliveries set next_attempt_at = ${leaseUntil}::timestamptz
      where id in (select id from integration_deliveries
                   where id = any(${ids}::uuid[]) and status = 'pending'
                     and next_attempt_at <= ${now.toISOString()}::timestamptz
                   for update skip locked)
      returning id`)) as unknown as Array<{ id: string }>;
    if (rows.length > 0) {
      claimed.push(
        ...(await systemDb
          .select()
          .from(integrationDeliveries)
          .where(
            inArray(
              integrationDeliveries.id,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(integrationDeliveries.nextAttemptAt)),
      );
    }
  }

  let attempted = 0;
  let delivered = 0;
  let failed = 0;
  let skipped = 0;
  let circuitOpen = 0;
  const deadline = Date.now() + config.TICK_PASS_BUDGET_MS;
  const openDeps = await loadOpenDependencies(now);
  const run = await runBounded(
    claimed,
    config.TICK_EGRESS_CONCURRENCY,
    async (d) => {
      attempted++;
      const [event] = await systemDb.select().from(events).where(eq(events.id, d.eventId)).limit(1);
      const [connection] = await systemDb
        .select()
        .from(integrationConnections)
        .where(eq(integrationConnections.id, d.connectionId))
        .limit(1);
      if (!event || !connection) {
        await systemDb
          .update(integrationDeliveries)
          .set({ status: "failed" })
          .where(eq(integrationDeliveries.id, d.id));
        failed++;
        return;
      }
      const t = await attemptIntegrationDelivery({
        delivery: d,
        event,
        connection,
        now,
        timeoutMs: Math.min(10_000, deadline - Date.now()),
        openDeps,
        skipOpenCircuit: true,
      });
      if (t.outcome === "not_attempted") circuitOpen++;
      else if (t.outcome === "skipped") skipped++;
      else if (t.outcome === "delivered") delivered++;
      else if (t.outcome === "failed") failed++;
    },
    { deadline },
  );
  // Leased but never reached: due again now rather than when the lease runs out.
  if (run.unstarted.length > 0) {
    const ids = "{" + run.unstarted.map((d) => d.id).join(",") + "}";
    await systemDb.execute(sql`
      update integration_deliveries set next_attempt_at = ${now.toISOString()}::timestamptz
      where id = any(${ids}::uuid[]) and status = 'pending'`);
  }
  for (const outcome of run.settled) {
    if (!outcome.ok) {
      failed++;
      log.error(outcome.error, {
        event: "integration_delivery_pass_failed",
        delivery: outcome.item.id,
      });
    }
  }
  return {
    attempted,
    delivered,
    failed,
    circuitOpen,
    skipped,
    ...(capped || run.unstarted.length > 0 ? { capped: true } : {}),
  };
}

export interface IntegrationDeliveryView {
  delivery: Delivery;
  eventType: string;
  eventPublicId: string;
}

/** A connection's delivery log, newest first, capped. */
export async function listIntegrationDeliveries(
  organizationId: string,
  connectionId: string,
  limit = 100,
): Promise<IntegrationDeliveryView[]> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({ d: integrationDeliveries, etype: events.type, epid: events.publicId })
      .from(integrationDeliveries)
      .leftJoin(events, eq(integrationDeliveries.eventId, events.id))
      .where(eq(integrationDeliveries.connectionId, connectionId))
      .orderBy(desc(integrationDeliveries.createdAt), desc(integrationDeliveries.id))
      .limit(limit);
    return rows.map((r) => ({
      delivery: r.d,
      eventType: r.etype ?? "?",
      eventPublicId: r.epid ?? "?",
    }));
  });
}

export class IntegrationRedeliverConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationRedeliverConflictError";
  }
}

/**
 * Resend one delivery SYNCHRONOUSLY and return the live transcript. The clone is dated an hour
 * out so the drainer cannot claim it between this commit and our POST; the attempt then sets
 * the real schedule. A live pending row for the same event is a conflict, not a second send.
 */
export async function redeliverIntegrationDelivery(
  organizationId: string,
  connectionId: string,
  deliveryId: string,
): Promise<{ delivery: Delivery; transcript: DeliveryTranscript } | null> {
  const prepared = await withTenant(organizationId, async (tx) => {
    const [conn] = await tx
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId))
      .limit(1);
    if (!conn) return null;
    const [orig] = await tx
      .select()
      .from(integrationDeliveries)
      .where(
        and(
          eq(integrationDeliveries.id, deliveryId),
          eq(integrationDeliveries.connectionId, conn.id),
        ),
      )
      .limit(1);
    if (!orig) return null;
    const [ev] = await tx.select().from(events).where(eq(events.id, orig.eventId)).limit(1);
    if (!ev) return null;
    await tx.execute(sql`SELECT id FROM integration_deliveries WHERE id = ${orig.id} FOR UPDATE`);
    const [live] = await tx
      .select({ id: integrationDeliveries.id })
      .from(integrationDeliveries)
      .where(
        and(
          eq(integrationDeliveries.eventId, orig.eventId),
          eq(integrationDeliveries.connectionId, conn.id),
          eq(integrationDeliveries.status, "pending"),
        ),
      )
      .limit(1);
    if (live)
      throw new IntegrationRedeliverConflictError(
        "A delivery for this event is already pending on this integration",
      );
    const [clone] = await tx
      .insert(integrationDeliveries)
      .values({
        organizationId,
        businessId: orig.businessId,
        connectionId: conn.id,
        eventId: orig.eventId,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(Date.now() + 3_600_000),
      })
      .returning();
    // The clone carries the outcome now; a kept `failed` would show one event as two failures.
    if (clone && orig.status === "failed") {
      await tx
        .update(integrationDeliveries)
        .set({ status: "superseded" })
        .where(eq(integrationDeliveries.id, orig.id));
    }
    return clone ? { clone, conn, ev } : null;
  });
  if (!prepared) return null;

  const transcript = await attemptIntegrationDelivery({
    delivery: prepared.clone,
    event: prepared.ev,
    connection: prepared.conn,
    now: new Date(),
    timeoutMs: 10_000,
    skipOpenCircuit: false,
    capture: true,
  });
  const settled = await withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(integrationDeliveries)
      .where(eq(integrationDeliveries.id, prepared.clone.id))
      .limit(1);
    return row ?? null;
  });
  return { delivery: settled ?? prepared.clone, transcript };
}

/**
 * Requeue every FAILED delivery on a connection through the outbox, one row per event, and
 * retire the originals as `superseded`. Bounded at 500 rows per call.
 */
export async function requeueFailedIntegrationDeliveries(
  organizationId: string,
  connectionId: string,
): Promise<{ requeued: number }> {
  return withTenant(organizationId, async (tx) => {
    const inserted = await tx.execute(sql`
      insert into integration_deliveries (organization_id, business_id, connection_id, event_id, status, attempts, next_attempt_at)
      select x.organization_id, x.business_id, x.connection_id, x.event_id, 'pending', 0, now()
      from (
        select distinct on (d.event_id) d.organization_id, d.business_id, d.connection_id, d.event_id, d.created_at, d.id
        from integration_deliveries d
        where d.connection_id = ${connectionId}
          and d.status = 'failed'
          and not exists (
            select 1 from integration_deliveries live
            where live.event_id = d.event_id
              and live.connection_id = d.connection_id
              and live.status = 'pending'
          )
        order by d.event_id, d.created_at, d.id
      ) x
      order by x.created_at, x.id
      limit 500
      returning id`);
    const rows = (inserted as { rows?: unknown[] }).rows ?? (inserted as unknown[]);
    const requeued = Array.isArray(rows) ? rows.length : 0;
    if (requeued > 0) {
      await tx.execute(sql`
        update integration_deliveries d
        set status = 'superseded'
        where d.connection_id = ${connectionId}
          and d.status = 'failed'
          and exists (
            select 1 from integration_deliveries live
            where live.event_id = d.event_id
              and live.connection_id = d.connection_id
              and live.status = 'pending'
          )`);
      await tx.execute(sql`select public.app_nudge_integration_outbox()`);
    }
    return { requeued };
  });
}

/** Pending and failed counts plus the last day's deliveries, for the connection page. */
export async function integrationDeliveryStats(organizationId: string, connectionId: string) {
  return withTenant(organizationId, async (tx) => {
    const [r] = await tx
      .select({
        pending: sql<number>`count(*) filter (where ${integrationDeliveries.status} = 'pending')::int`,
        failed: sql<number>`count(*) filter (where ${integrationDeliveries.status} = 'failed')::int`,
        delivered24h: sql<number>`count(*) filter (where ${integrationDeliveries.status} = 'delivered' and ${integrationDeliveries.lastAttemptAt} > now() - interval '24 hours')::int`,
      })
      .from(integrationDeliveries)
      .where(eq(integrationDeliveries.connectionId, connectionId));
    return {
      pending: r?.pending ?? 0,
      failed: r?.failed ?? 0,
      delivered_24h: r?.delivered24h ?? 0,
    };
  });
}
