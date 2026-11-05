import { createHmac } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { afterCommit, systemDb, type Tx } from "@/platform/db";
import { scanBusinessFilterNullable, fairShareFor } from "@/platform/clock";
import { runBounded } from "@/platform/concurrency";
import { config } from "@/platform/config";
import { registerEventSink, type EventRow } from "@/modules/events/emit";
import { events, webhookEndpoints, webhookDeliveries } from "@db/schema";
import { createLogger } from "@/platform/logger";
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

const log = createLogger("webhooks.outbox");

// Re-exported: the webhook reference generator and its test read the retry promise from here.
export { MAX_DELIVERY_ATTEMPTS, BACKOFF_SECONDS } from "@/platform/http-delivery";
export type { DeliveryTranscript } from "@/platform/http-delivery";

/** Our signed envelope for this event. Its headers hold no secret, so the transcript shows them. */
function buildRequest(
  endpoint: typeof webhookEndpoints.$inferSelect,
  event: typeof events.$inferSelect,
): { url: string; headers: Record<string, string>; body: string } {
  // The envelope, verbatim (BLUEPRINT §11 Part B item 5): the subscriber sees
  // exactly these fields, nothing more.
  const body = JSON.stringify({
    id: event.publicId,
    occurred_at: event.createdAt,
    source: event.source,
    user: event.actor,
    event_type: event.type,
    api_version: event.apiVersion,
    content: event.data,
    object: "event",
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Tmbilling-Signature": signPayload(endpoint.signingSecret, body),
    "Tmbilling-Event-Id": event.publicId,
  };
  return { url: endpoint.url, headers, body };
}

/**
 * Make ONE delivery attempt and settle the row: the single place that knows how to sign, POST,
 * judge and re-schedule a webhook. A manual Resend runs this too, so it can never report green
 * for a request the clock would judge failed.
 *
 * `skipOpenCircuit: false` is what an operator-initiated resend passes: the breaker protects the
 * clock's pass budget, not one human click, and a successful resend still closes it.
 */
export async function attemptDelivery(input: {
  delivery: typeof webhookDeliveries.$inferSelect;
  event: typeof events.$inferSelect;
  endpoint: typeof webhookEndpoints.$inferSelect;
  now: Date;
  timeoutMs: number;
  /** Pre-loaded open-breaker set. Omit to consult none (a resend). */
  openDeps?: ReadonlySet<string>;
  /** When false, an open breaker does not stop the call. */
  skipOpenCircuit?: boolean;
  /** Read the whole response body. Off for the clock: it never displays one. */
  capture?: boolean;
}): Promise<DeliveryTranscript> {
  const { delivery: d, event, endpoint, now, timeoutMs } = input;
  const skipOpenCircuit = input.skipOpenCircuit ?? true;
  const capture = input.capture ?? false;

  const origin = requestOrigin(endpoint.url);
  const depKey = origin ? dependencyKey("webhook", event.businessId, origin) : null;

  const { url, headers, body } = buildRequest(endpoint, event);
  // `clip(body)` only when a reader is waiting — the clock would be copying a payload nobody sees.
  const request = { method: "POST" as const, url, headers, body: capture ? clip(body) : "" };

  // The endpoint's host is not answering: do not call it, and count nothing against the six.
  if (skipOpenCircuit && depKey && input.openDeps?.has(depKey)) {
    await systemDb
      .update(webhookDeliveries)
      .set({ nextAttemptAt: new Date(now.getTime() + config.CIRCUIT_BREAKER_COOLDOWN_MS) })
      .where(eq(webhookDeliveries.id, d.id));
    return {
      request,
      response: null,
      error: "The endpoint host is circuit-broken. We did not call it.",
      latencyMs: 0,
      outcome: "not_attempted",
      attempts: d.attempts,
    };
  }

  const res = await postOnce({ url, headers, body, timeoutMs, capture });
  if (res.status === 0) {
    log.warn("webhook delivery failed at the network layer", {
      endpoint: endpoint.publicId,
      event: event.publicId,
      error: res.cause?.message,
      code: res.cause?.code,
    });
  }

  // Only a transport fault (status 0) trips the breaker: a 500 means the host answered.
  // A refused target made no request, so it says nothing about the host's health.
  if (depKey && !res.refused) {
    if (res.status === 0) {
      await recordFailure(depKey, "webhook", event.businessId, "no response from endpoint", now);
    } else {
      await recordSuccess(depKey, now, input.openDeps?.has(depKey) ?? false);
    }
  }

  const attempts = d.attempts + 1;
  const response = res.headers
    ? { status: res.status, headers: res.headers, body: res.body }
    : null;
  const lastError = errorText(res.error ?? res.body);
  const base = { request, response, error: res.error, latencyMs: res.latencyMs, attempts };

  if (res.status >= 200 && res.status < 300) {
    await systemDb
      .update(webhookDeliveries)
      .set({
        status: "delivered",
        attempts,
        lastAttemptAt: now,
        lastResponseStatus: res.status,
        // Last attempt only; `attempts` counts the rest. Egress concurrency is sized from it.
        durationMs: res.latencyMs,
        lastError: null,
      })
      .where(eq(webhookDeliveries.id, d.id));
    return { ...base, outcome: "delivered" };
  }
  // Terminal: the same URL is refused on every pass. The operator changes it and resends.
  if (res.refused || attempts >= MAX_DELIVERY_ATTEMPTS) {
    await systemDb
      .update(webhookDeliveries)
      .set({
        status: "failed",
        attempts,
        lastAttemptAt: now,
        lastResponseStatus: res.status,
        durationMs: res.latencyMs,
        lastError,
      })
      .where(eq(webhookDeliveries.id, d.id));
    return { ...base, outcome: "failed" };
  }
  await systemDb
    .update(webhookDeliveries)
    .set({
      attempts,
      lastAttemptAt: now,
      lastResponseStatus: res.status,
      durationMs: res.latencyMs,
      lastError,
      nextAttemptAt: new Date(now.getTime() + backoffSeconds(attempts) * 1000),
    })
    .where(eq(webhookDeliveries.id, d.id));
  return { ...base, outcome: "retrying" };
}

/**
 * Webhook fan-out: the SUBSCRIBER side of the outbox (ADR-009). Given a freshly
 * emitted event, write a delivery row per subscribed+enabled endpoint, in the
 * SAME transaction as the event (so nothing is lost / sent for an uncommitted
 * change). Delivery happens asynchronously via deliverPending().
 *
 * Registered as an event sink (below) — the events module never calls this
 * directly, keeping the dependency direction webhooks → events.
 */
export async function enqueueDeliveries(tx: Tx, event: EventRow): Promise<void> {
  // Business-scoped endpoints only receive their own business's events.
  //
  // TEST/LIVE PARTITION: an event belongs to the partition of the business that
  // produced it, and an endpoint only ever receives its own partition. Without this,
  // an org-wide endpoint (business_id NULL) received BOTH — so a customer's production
  // consumer saw a sandbox business's renewals, including everything Time Travel
  // manufactures, as real billing activity.
  //
  // The partition is read as a scalar subquery rather than a second round trip because
  // this runs inside the emit transaction of EVERY state change. It also fails CLOSED:
  // an event whose business row cannot be read yields NULL, the comparison is NULL, and
  // nothing is enqueued — an event we cannot place in a partition is never broadcast to
  // both, which is the failure this whole change exists to prevent.
  //
  // ORG-LEVEL EVENTS (no business) still go to every enabled endpoint, in both
  // partitions, and that stays coherent: they are about the organization itself, and
  // nothing simulated is org-level — Time Travel and sample data are business-scoped
  // and always test. So an org-level event is never fake, and withholding it from one
  // partition would drop a real notification for no safety gain.
  const candidates = await tx
    .select()
    .from(webhookEndpoints)
    .where(
      event.businessId
        ? and(
            eq(webhookEndpoints.enabled, "true"),
            or(
              isNull(webhookEndpoints.businessId),
              eq(webhookEndpoints.businessId, event.businessId),
            ),
            sql`${webhookEndpoints.livemode} = (SELECT b.livemode FROM businesses b WHERE b.id = ${event.businessId})`,
          )
        : eq(webhookEndpoints.enabled, "true"),
    );

  // WH-1: per-endpoint subscription filter — null event_types = all types;
  // otherwise the endpoint only receives the types it subscribed to.
  const endpoints = candidates.filter(
    (ep) => !ep.eventTypes || (ep.eventTypes as string[]).includes(event.type),
  );

  if (endpoints.length > 0) {
    await tx.insert(webhookDeliveries).values(
      endpoints.map((ep) => ({
        organizationId: event.organizationId,
        eventId: event.id,
        businessId: event.businessId,
        endpointId: ep.id,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
      })),
    );

    // WAKE THE DRAINER. The rows above are already due (`next_attempt_at = now()`), but the
    // only thing that drained them was the 60-second cron tick — so a first delivery sat for
    // 0-60s, ~30s on average, waiting on nothing. Enqueueing the nudge HERE, inside the same
    // transaction, is what makes it safe: the job row commits atomically with the event and
    // the deliveries, so it can never wake a worker for a change that then rolls back, and
    // graphile-worker's insert trigger NOTIFYs on commit so the worker starts immediately.
    //
    // The POST itself still happens on the worker, outside this transaction, with the same
    // claim + retry + backoff — the outbox (ADR-007) is unchanged. Only the wait is gone.
    //
    // Inside `if (endpoints.length > 0)` deliberately: an org with no endpoint subscribed to
    // this type adds no write at all, so the common path costs nothing.
    //
    // `job_key` coalesces a burst into ONE pending nudge instead of one per event.
    // Deliberately NOT on a named queue: a queued job misses graphile-worker's insert NOTIFY
    // and waits for the poll instead — measured at ~890ms vs ~37ms. Serialization was never
    // needed for correctness, because `deliverPending` leases each row with an atomic
    // compare-and-swap, so concurrent drains cannot double-deliver.
    // Through a no-argument SECURITY DEFINER wrapper (0201), NOT `graphile_worker.add_job`
    // directly: that function is not SECURITY DEFINER, so `tmbilling_app` cannot reach the
    // tables under it, and granting it those rights would let this role enqueue ARBITRARY
    // tasks — a way out of the RLS sandbox. The wrapper takes no arguments, so the only
    // thing this transaction can express is "there is webhook work to drain".
    //
    // AFTER COMMIT, not in this transaction: the nudge upserts ONE job row by its key, so in
    // the transaction it held that row locked until commit and every event-emitting
    // transaction in the platform queued behind the others (D4 load test: 50 renewals waiting,
    // ~800 ms each). After commit it never wakes a worker for a rollback either.
    if (!afterCommit(async () => requestNudge()))
      await tx.execute(sql`select public.app_nudge_webhook_outbox()`);
  }
}

/**
 * One nudge in flight per process. Every nudge writes the same job row, so concurrent ones only
 * queue on it, each holding a pool connection (D4: 56 waiting). A request made while one is in
 * flight is folded into ONE more after it, so a commit that lands mid-nudge still wakes a drain.
 */
let nudging: Promise<void> | null = null;
let nudgeAgain = false;
function requestNudge(): void {
  if (nudging) {
    nudgeAgain = true;
    return;
  }
  nudging = (async () => {
    do {
      nudgeAgain = false;
      try {
        await systemDb.execute(sql`select public.app_nudge_webhook_outbox()`);
      } catch (e) {
        log.warn("webhook outbox nudge failed; the minute drain will pick it up", {
          event: "webhook_nudge_failed",
          error: (e as Error)?.message,
        });
      }
    } while (nudgeAgain);
    nudging = null;
  })();
}

// Wire webhooks as a subscriber of emitted events. This runs at module load;
// the composition roots (src/index.ts server, src/platform/jobs.ts worker) import
// this module so the sink is registered before any event is emitted.
registerEventSink(enqueueDeliveries);

/** Sign a webhook body: HMAC-SHA256(secret, body) → `sha256=<hex>`. */
export function signPayload(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Deliver due webhook deliveries (driven by the billing clock). System-wide scan
 * (admin connection bypasses RLS); POSTs the signed event to each endpoint, with
 * retry + exponential backoff, giving up after MAX_DELIVERY_ATTEMPTS.
 */
export async function deliverPending(now: Date): Promise<{
  attempted: number;
  delivered: number;
  failed: number;
  /**
   * Not attempted: the subscriber's host is circuit-broken. Separate from `failed` because
   * nothing was tried and nothing went wrong on our side — and because a pass that is
   * skipping everything must not read as a pass with nothing to do.
   */
  circuitOpen: number;
  /** Reached, and settled with no request made: the transform had nothing to send. */
  skipped: number;
  capped?: boolean;
}> {
  // Clock-scope (finale review blocker): a time-travel travel must deliver ONLY
  // its own business's webhooks (a simulated 2027 `now` would otherwise fire every
  // business's backoff-scheduled retries early), and the real tick must skip
  // time-travelled businesses. Deliveries scope through their event's business;
  // org-level (null-business) events stay on the real clock.
  // BOUNDED (finding #3): every due row, each with an awaited POST at up to a 10s timeout,
  // is an unbounded tick — 10k backlogged deliveries would hold a worker slot for hours.
  //
  // FAIR (phase 2), the same change as the email outbox and for the same reason: a flat
  // `order by next_attempt_at limit N` is FIFO, and a subscriber whose server is down
  // accumulates the OLDEST due rows, so it sorts to the front of every pass and pushes
  // every other business's notifications behind it. Ranking within each business and
  // capping the rank bounds one tenant's share without slowing a tenant that is alone.
  //
  // Partitioned on the event's business, copied onto the delivery (0350): joining events here
  // cost ~100 ms a pass over a few thousand pending rows, several passes a second (D4).
  const ranked = systemDb
    .select({
      id: webhookDeliveries.id,
      nextAttemptAt: webhookDeliveries.nextAttemptAt,
      rn: sql<number>`row_number() over (
        partition by ${webhookDeliveries.businessId}
        order by ${webhookDeliveries.nextAttemptAt}, ${webhookDeliveries.id}
      )`.as("rn"),
    })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        lte(webhookDeliveries.nextAttemptAt, now),
        scanBusinessFilterNullable(webhookDeliveries.businessId),
      ),
    )
    .as("ranked");

  // How many businesses actually have work due right now — the divisor for the share
  // below. Counted rather than assumed: a fixed `rn <= 50` held a business that was ALONE
  // in the queue to 50 rows a minute, which is the opposite of what the comment above and
  // `TICK_FAIR_SHARE_PER_BUSINESS`'s own note both claim. See `fairShareFor`.
  // Gated: OFF, the pass runs exactly the query set it always did — no count, fixed share.
  const dynamicShare = config.TICK_FAIR_SHARE_DYNAMIC === "TRUE";
  const [busy] = !dynamicShare
    ? [undefined]
    : await systemDb
        .select({ n: sql<number>`count(distinct ${webhookDeliveries.businessId})::int` })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.status, "pending"),
            lte(webhookDeliveries.nextAttemptAt, now),
            scanBusinessFilterNullable(webhookDeliveries.businessId),
          ),
        );
  const share = dynamicShare ? fairShareFor(busy?.n ?? 1) : config.TICK_FAIR_SHARE_PER_BUSINESS;

  const picked = await systemDb
    .select({ id: ranked.id })
    .from(ranked)
    .where(lte(ranked.rn, share))
    .orderBy(ranked.nextAttemptAt)
    .limit(config.TICK_SCAN_LIMIT);

  const due = picked.length
    ? await systemDb
        .select({ d: webhookDeliveries, eventBusinessId: events.businessId })
        .from(webhookDeliveries)
        .innerJoin(events, eq(events.id, webhookDeliveries.eventId))
        .where(
          inArray(
            webhookDeliveries.id,
            picked.map((p) => p.id),
          ),
        )
        .orderBy(webhookDeliveries.nextAttemptAt)
    : [];
  const capped = picked.length >= config.TICK_SCAN_LIMIT;

  let delivered = 0;
  let failed = 0;
  let skipped = 0;
  // Wall-clock budget (finding #3): the row cap bounds how many we take, this bounds how
  // long we spend. 500 deliveries each hitting the 10s HTTP timeout would otherwise be 83
  // minutes in one pass, holding a worker slot and blocking shutdown. Checked BETWEEN rows,
  // so an in-flight POST is never abandoned half-way.
  const deadline = Date.now() + config.TICK_PASS_BUDGET_MS;
  let budgetSpent = false;
  let attempted = 0;
  /**
   * Which endpoints are currently cut off — read ONCE, here, consulted in memory below.
   * Same reasoning as the email outbox: a breaker that queried per row would reintroduce a
   * per-row cost to remove one.
   */
  const openDeps = await loadOpenDependencies(now);
  /** Not attempted: this endpoint's host is circuit-broken. */
  let circuitOpen = 0;
  // BOUNDED-CONCURRENT since 2026-09-11 (was serial). Each row is one POST to a machine we
  // do not own, and awaiting each before starting the next made this pass's throughput
  // `budget ÷ latency`. It compounds badly here: a failed delivery costs 5.61 attempts
  // against 1.23 for a success, so retries dominate as volume grows, and with the timeout
  // below at up to 10s a single dead endpoint yielded roughly ONE delivery per pass — the
  // 2026-09-01 mechanism. `TICK_EGRESS_CONCURRENCY` defaults to 1, so this is the old
  // behaviour until a deployment states otherwise.
  //
  // Safe because the atomic claim below already assumed concurrent scanners: a travel step
  // and the real tick could always race, so the lease is what prevents double-delivery —
  // not the fact that the loop happened to be serial.
  // ATOMIC CLAIM (finale review blocker): concurrent drains (a travel step, the tick, every
  // commit's nudge) pick the same candidates, so lease rows before POSTing and an endpoint is
  // never double-delivered. ONE statement for the whole pick, `skip locked`: claiming row by row
  // made every concurrent drain try every candidate (D4: 1.9M claim updates in 12 minutes).
  const claimedIds = new Set<string>();
  if (due.length > 0) {
    const leaseUntil = new Date(now.getTime() + 60_000).toISOString();
    const ids = "{" + due.map(({ d }) => d.id).join(",") + "}";
    const rows = (await systemDb.execute(sql`
      update webhook_deliveries set next_attempt_at = ${leaseUntil}::timestamptz
      where id in (select id from webhook_deliveries
                   where id = any(${ids}::uuid[]) and status = 'pending'
                     and next_attempt_at <= ${now.toISOString()}::timestamptz
                   for update skip locked)
      returning id`)) as unknown as Array<{ id: string }>;
    for (const r of rows) claimedIds.add(r.id);
  }
  const mine = due.filter(({ d }) => claimedIds.has(d.id));
  const run = await runBounded(
    mine,
    config.TICK_EGRESS_CONCURRENCY,
    async ({ d }) => {
      attempted++;
      const [event] = await systemDb.select().from(events).where(eq(events.id, d.eventId)).limit(1);
      const [endpoint] = await systemDb
        .select()
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.id, d.endpointId))
        .limit(1);
      if (!event || !endpoint) {
        await systemDb
          .update(webhookDeliveries)
          .set({ status: "failed" })
          .where(eq(webhookDeliveries.id, d.id));
        failed++;
        return;
      }

      /**
       * One attempt, through the shared path (`attemptDelivery`) rather than a copy of it.
       *
       * The timeout it gets is the smaller of the per-request ceiling and whatever is LEFT of the
       * pass budget. The budget is checked between rows, so without this the last row of a pass
       * starts just inside the deadline and then runs its full ceiling past it — which is exactly
       * how a 90s budget produced a measured 103s pass on 2026-09-01. Deriving the signal from the
       * remaining time makes the deadline mean what it says.
       *
       * The transcript is DISCARDED here on purpose: it exists for the synchronous Resend that
       * renders it live, and a background pass has nobody to show it to.
       */
      const t = await attemptDelivery({
        delivery: d,
        event,
        endpoint,
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
  budgetSpent = run.unstarted.length > 0;
  // Leased but never reached: due again now rather than when the lease runs out.
  if (run.unstarted.length > 0) {
    const ids = "{" + run.unstarted.map(({ d }) => d.id).join(",") + "}";
    await systemDb.execute(sql`
      update webhook_deliveries set next_attempt_at = ${now.toISOString()}::timestamptz
      where id = any(${ids}::uuid[]) and status = 'pending'`);
  }
  // A row that threw rather than returning an outcome is still a row we reached. It was
  // previously impossible for the loop to continue past one (the throw escaped the pass);
  // isolating it is strictly safer, but it must not vanish from the count.
  for (const outcome of run.settled) {
    if (!outcome.ok) {
      failed++;
      log.error(outcome.error, {
        event: "webhook_delivery_pass_failed",
        delivery: outcome.item.d.id,
      });
    }
  }
  // `attempted` counts rows we actually reached, not rows we selected — otherwise a
  // budget-truncated pass would report attempts it never made.
  return {
    attempted,
    delivered,
    failed,
    circuitOpen,
    skipped,
    ...(capped || budgetSpent
      ? { capped: true, cappedBy: budgetSpent ? ("budget" as const) : ("scan_limit" as const) }
      : {}),
  };
}
