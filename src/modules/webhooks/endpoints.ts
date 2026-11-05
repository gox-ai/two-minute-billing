import { randomBytes } from "node:crypto";
import { clearSubscribedEventTypes } from "./subscribed-types";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { attemptDelivery, signPayload, type DeliveryTranscript } from "./outbox";
import { sampleEventData, type EventType } from "@/modules/events/registry";
import { webhookEndpoints, webhookDeliveries, events, organizations } from "@db/schema";
import {
  cappedTotal,
  clampLimit,
  filterConditions,
  isUuidCursor,
  keysetCondition,
  kindsFromSpecs,
  opsFromSpecs,
  pageOrder,
  parseCursor,
  searchCondition,
  splitMulti,
  toPage,
  type FilterSpec,
  type ListFilter,
  type ListPage,
} from "@/platform/list-query";
import { createLogger } from "@/platform/logger";
import { checkPublicUrl, guardedFetch } from "@/platform/egress";
import { writeAuditLog } from "@/modules/audit/service";
import type { Tx } from "@/platform/db";

const log = createLogger("webhooks.endpoints");

/** A create/update the operator can fix by changing what they sent. Routes map it to a 400. */
export class EndpointValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointValidationError";
  }
}

export class RedeliverConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedeliverConflictError";
  }
}

/** Save-time half of the private-target guard; delivery checks again (platform/egress.ts). */
async function assertPublicTarget(url: string): Promise<void> {
  const reason = await checkPublicUrl(url);
  if (reason)
    throw new EndpointValidationError(`We could not save the webhook endpoint. ${reason}`);
}

export interface CreatedEndpoint {
  endpoint: typeof webhookEndpoints.$inferSelect;
  /** Signing secret — returned once at creation; verify deliveries with it. */
  secret: string;
}

/**
 * What an audit row may say about an endpoint. Never the signing secret, and only the
 * URL's origin: some receivers carry a token in the path or query.
 */
function endpointAuditView(e: typeof webhookEndpoints.$inferSelect) {
  let urlOrigin: string | null = null;
  try {
    urlOrigin = new URL(e.url).origin;
  } catch {
    urlOrigin = null;
  }
  return {
    id: e.publicId,
    url_origin: urlOrigin,
    livemode: e.livemode,
    enabled: e.enabled === "true",
    event_types: e.eventTypes ?? null,
    description: e.description ?? null,
  };
}

function auditEndpoint(
  tx: Tx,
  e: typeof webhookEndpoints.$inferSelect,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  return writeAuditLog(
    {
      organizationId: e.organizationId,
      businessId: e.businessId,
      action,
      resourceType: "webhook_endpoint",
      resourceId: e.publicId,
      before,
      after,
    },
    tx,
  );
}

/**
 * Register an endpoint to receive this org's outbound webhooks.
 * `businessId` (internal uuid) scopes delivery to one business; null/undefined = every
 * business in `livemode`, plus org-level events.
 *
 * `livemode` is the endpoint's partition and is never guessed here: the route resolves
 * it (derived from the business when scoped, from the caller's key mode otherwise) and
 * passes it in. The parameter defaults to `'test'` only so that a caller which has no
 * partition in mind — a verify script standing up a sandbox — fails safe rather than
 * subscribing to live traffic.
 */
export async function createEndpoint(input: {
  organizationId: string;
  url: string;
  businessId?: string | null;
  /** 'test' | 'live' — MUST equal the business's livemode when businessId is set. */
  livemode?: "test" | "live";
  /** null/undefined = subscribe to all events; else the list of registry types. */
  eventTypes?: string[] | null;
  description?: string | null;
}): Promise<CreatedEndpoint> {
  await assertPublicTarget(input.url);
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  return withTenant(input.organizationId, async (tx) => {
    const [endpoint] = await tx
      .insert(webhookEndpoints)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId ?? null,
        publicId: publicId("whe"),
        url: input.url,
        signingSecret: secret,
        enabled: "true",
        livemode: input.livemode ?? "test",
        eventTypes: input.eventTypes ?? null,
        description: input.description ?? null,
      })
      .returning();
    await auditEndpoint(
      tx,
      endpoint!,
      "webhook_endpoint.create",
      null,
      endpointAuditView(endpoint!),
    );
    clearSubscribedEventTypes(input.organizationId);
    return { endpoint: endpoint!, secret };
  });
}

/** One endpoint by its whe_… public id, or null. */
export async function getEndpoint(
  organizationId: string,
  endpointPublicId: string,
): Promise<typeof webhookEndpoints.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const [e] = await tx
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.publicId, endpointPublicId))
      .limit(1);
    return e ?? null;
  });
}

export async function listEndpoints(
  organizationId: string,
): Promise<Array<typeof webhookEndpoints.$inferSelect>> {
  return withTenant(organizationId, async (tx) =>
    tx
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.organizationId, organizationId))
      .orderBy(desc(webhookEndpoints.createdAt)),
  );
}

/**
 * Enable/disable, change the URL, or re-scope an endpoint. `businessId` is an
 * internal uuid (null clears the scope back to all-businesses). Returns the
 * updated row or null.
 *
 * `livemode` is deliberately NOT patchable — an endpoint's partition is fixed at
 * creation, exactly like a business's, so a URL that has been receiving sandbox
 * traffic can never be promoted into the live stream by an edit. That also bounds
 * re-scoping: the new business must be in the endpoint's own partition. The route
 * rejects a cross-partition re-scope with 400; `webhook_endpoints_business_livemode_fk`
 * is the structural backstop if a future path forgets to.
 */
export async function updateEndpoint(
  organizationId: string,
  endpointPublicId: string,
  patch: {
    enabled?: boolean;
    url?: string;
    businessId?: string | null;
    eventTypes?: string[] | null;
    description?: string | null;
  },
): Promise<typeof webhookEndpoints.$inferSelect | null> {
  if (patch.url != null) await assertPublicTarget(patch.url);
  return withTenant(organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.publicId, endpointPublicId))
      .limit(1);
    if (!existing) return null;
    const set: Partial<typeof webhookEndpoints.$inferInsert> = {};
    if (patch.url != null) set.url = patch.url;
    if (patch.enabled != null) set.enabled = patch.enabled ? "true" : "false";
    if (patch.businessId !== undefined) set.businessId = patch.businessId;
    if (patch.eventTypes !== undefined) set.eventTypes = patch.eventTypes;
    if (patch.description !== undefined) set.description = patch.description;
    if (Object.keys(set).length === 0) return existing;
    clearSubscribedEventTypes(organizationId);
    const [e] = await tx
      .update(webhookEndpoints)
      .set(set)
      .where(eq(webhookEndpoints.publicId, endpointPublicId))
      .returning();
    if (e) {
      const was = endpointAuditView(existing) as Record<string, unknown>;
      const now = endpointAuditView(e) as Record<string, unknown>;
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const k of Object.keys(now)) {
        if (JSON.stringify(was[k]) !== JSON.stringify(now[k])) {
          before[k] = was[k];
          after[k] = now[k];
        }
      }
      // The URL's origin can stay the same while its path changes.
      if (existing.url !== e.url) after.url_changed = true;
      if (existing.businessId !== e.businessId) after.business_scope_changed = true;
      if (Object.keys(after).length > 0) {
        await auditEndpoint(tx, e, "webhook_endpoint.update", before, after);
      }
    }
    return e ?? null;
  });
}

/** Hard-delete an endpoint. Past delivery rows are kept as history. */
export async function deleteEndpoint(
  organizationId: string,
  endpointPublicId: string,
): Promise<boolean> {
  return withTenant(organizationId, async (tx) => {
    const [deleted] = await tx
      .delete(webhookEndpoints)
      .where(eq(webhookEndpoints.publicId, endpointPublicId))
      .returning();
    if (!deleted) return false;
    clearSubscribedEventTypes(organizationId);
    await auditEndpoint(tx, deleted, "webhook_endpoint.delete", endpointAuditView(deleted), null);
    return true;
  });
}

/** Rotate an endpoint's signing secret. Returns the new secret (shown once). */
export async function rotateSecret(
  organizationId: string,
  endpointPublicId: string,
): Promise<{ endpoint: typeof webhookEndpoints.$inferSelect; secret: string } | null> {
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  return withTenant(organizationId, async (tx) => {
    const [e] = await tx
      .update(webhookEndpoints)
      .set({ signingSecret: secret })
      .where(eq(webhookEndpoints.publicId, endpointPublicId))
      .returning();
    if (!e) return null;
    await auditEndpoint(tx, e, "webhook_endpoint.rotate_secret", null, { secret_rotated: true });
    return { endpoint: e, secret };
  });
}

export interface DeliveryView {
  delivery: typeof webhookDeliveries.$inferSelect;
  eventType: string;
  eventPublicId: string;
}

/** Column filters on an endpoint's delivery log (`field[op]=value`, list-query grammar). */
export const WEBHOOK_DELIVERY_FILTERS: Record<string, FilterSpec> = {
  id: { column: webhookDeliveries.id, kind: "text" },
  // pending | delivered | failed | skipped | superseded
  status: { column: webhookDeliveries.status, kind: "enum" },
  event: { column: events.publicId, kind: "text" },
  event_type: { column: events.type, kind: "text" },
  attempts: { column: webhookDeliveries.attempts, kind: "number" },
  created_at: { column: webhookDeliveries.createdAt, kind: "date" },
  last_attempt_at: { column: webhookDeliveries.lastAttemptAt, kind: "date" },
};

/** `http_status[is|in]=…`: the last attempt's response, in the grammar below. */
export const HTTP_STATUS_FILTER_OPS = ["is", "in"] as const;

export const WEBHOOK_DELIVERY_FILTER_OPS: Record<string, readonly string[]> = {
  ...opsFromSpecs(WEBHOOK_DELIVERY_FILTERS),
  http_status: HTTP_STATUS_FILTER_OPS,
};
export const WEBHOOK_DELIVERY_FILTER_KINDS = kindsFromSpecs(WEBHOOK_DELIVERY_FILTERS);
export const WEBHOOK_DELIVERY_SORT_FIELDS = ["created_at"] as const;

/**
 * One `http_status` term: an exact code (`404`), a class (`4xx`), an inclusive range
 * (`404-412`) or `timeout` — tried, and no HTTP response came back (timeout, refused
 * connection, blocked address). Null when the term is not in the grammar.
 */
function httpStatusTerm(term: string): SQL | null {
  const col = webhookDeliveries.lastResponseStatus;
  const t = term.trim().toLowerCase();
  if (t === "timeout")
    return sql`(${col} IS NULL AND ${webhookDeliveries.attempts} > 0 AND ${webhookDeliveries.status} IN ('pending', 'failed'))`;
  if (/^[1-5]\d\d$/.test(t)) return sql`${col} = ${Number(t)}`;
  const cls = /^([1-5])xx$/.exec(t);
  if (cls)
    return sql`(${col} >= ${Number(cls[1]) * 100} AND ${col} < ${Number(cls[1]) * 100 + 100})`;
  const range = /^([1-5]\d\d)-([1-5]\d\d)$/.exec(t);
  if (range) {
    const [lo, hi] = [Number(range[1]), Number(range[2])].sort((a, b) => a - b);
    return sql`(${col} >= ${lo} AND ${col} <= ${hi})`;
  }
  return null;
}

/** Why an `http_status` filter is refused, or null. Routes answer 400 with it. */
export function httpStatusFilterError(op: string, value: string): string | null {
  const terms = splitMulti(value);
  if (terms.length === 0)
    return "http_status takes a value, e.g. '404', '4xx', '404-412' or 'timeout'.";
  if (op === "is" && terms.length > 1)
    return "http_status[is] takes one value. Use http_status[in] for several.";
  const bad = terms.find((t) => httpStatusTerm(t) == null);
  return bad
    ? `'${bad}' is not an HTTP status filter. Use an exact code (404), a class (4xx), a range (404-412) or 'timeout'.`
    : null;
}

function httpStatusCondition(value: string): SQL | undefined {
  const parts = splitMulti(value)
    .map(httpStatusTerm)
    .filter((c): c is SQL => c != null);
  return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : undefined;
}

export interface DeliveryListFilters {
  /** Delivery id, event id or the event's object id. */
  search?: string;
  filters?: ListFilter[];
  sortDesc?: boolean;
  startingAfter?: string;
  limit?: number;
}

/**
 * One page of an endpoint's delivery log, newest first. Keyset on
 * `(created_at, id)` via `webhook_deliveries_endpoint_created_idx` (0377).
 * Null for an endpoint the caller's organization does not have.
 */
export async function listDeliveriesPage(
  organizationId: string,
  endpointPublicId: string,
  f: DeliveryListFilters = {},
): Promise<ListPage<DeliveryView> | null> {
  const limit = clampLimit(f.limit);
  const descending = f.sortDesc ?? true;
  return withTenant(organizationId, async (tx) => {
    const [ep] = await tx
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.publicId, endpointPublicId))
      .limit(1);
    if (!ep) return null;
    // Org-level screen: day filters use the organization's display zone, as the dates render.
    const [org] = await tx
      .select({ tz: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    const tz = org?.tz ?? "UTC";

    const conds: SQL[] = [
      eq(webhookDeliveries.endpointId, ep.id),
      eq(webhookDeliveries.organizationId, organizationId),
    ];
    const search = searchCondition(
      [webhookDeliveries.id, events.publicId, events.resourceId],
      f.search,
    );
    if (search) conds.push(search);
    const filters = f.filters ?? [];
    conds.push(...filterConditions(WEBHOOK_DELIVERY_FILTERS, filters, tz));
    for (const flt of filters) {
      if (flt.field !== "http_status") continue;
      const c = httpStatusCondition(flt.value);
      if (c) conds.push(c);
    }

    const base = () =>
      tx
        .select({ d: webhookDeliveries, etype: events.type, epid: events.publicId })
        .from(webhookDeliveries)
        .innerJoin(events, eq(webhookDeliveries.eventId, events.id));

    const total = f.startingAfter
      ? null
      : await cappedTotal(
          tx,
          tx
            .select({ one: sql`1` })
            .from(webhookDeliveries)
            .innerJoin(events, eq(webhookDeliveries.eventId, events.id))
            .where(and(...conds)),
        );

    const { keysetId } = parseCursor(f.startingAfter);
    const pageConds = [...conds];
    // The tiebreak is the raw uuid PK; a garbled cursor degrades to the first page.
    if (keysetId && isUuidCursor(keysetId)) {
      const [cursor] = await tx
        .select({
          createdAt: sql<string>`${webhookDeliveries.createdAt}::text`,
          id: webhookDeliveries.id,
        })
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.endpointId, ep.id), eq(webhookDeliveries.id, keysetId)))
        .limit(1);
      const seek = keysetCondition(
        webhookDeliveries.createdAt,
        webhookDeliveries.id,
        cursor ? { sortValue: cursor.createdAt, tiebreak: cursor.id } : undefined,
        descending,
      );
      if (seek) pageConds.push(seek);
    }

    const rows = await base()
      .where(and(...pageConds))
      .orderBy(...pageOrder(webhookDeliveries.createdAt, webhookDeliveries.id, descending, true))
      .limit(limit + 1);
    const views: DeliveryView[] = rows.map((r) => ({
      delivery: r.d,
      eventType: r.etype,
      eventPublicId: r.epid,
    }));
    return toPage(views, limit, {
      keyset: true,
      offset: 0,
      keyOf: (v) => v.delivery.id,
      total,
    });
  });
}

/**
 * Redeliver an endpoint's MOST RECENT delivery.
 *
 * The per-delivery route already exists but needs a delivery id, which means finding one first —
 * fine from the Deliveries list, useless as a one-click "is this endpoint working again?" after
 * fixing a receiver. This is that one click, and it deliberately goes through `redeliverDelivery`
 * rather than reimplementing: the redeliver path already guards against double-delivery (a live
 * pending row for the same event+endpoint) and that guard must apply here too.
 *
 * Returns `null` for an unknown endpoint and `'no_deliveries'` for a real endpoint that has never
 * delivered anything — a brand-new endpoint legitimately has no history, and the caller must be
 * able to say so plainly instead of reporting a failure. Otherwise it returns the settled delivery
 * and this attempt's live transcript, because `redeliverDelivery` now calls the endpoint inline
 * rather than queueing it (WH-2, reworked 2026-09-02).
 */
export async function redeliverLatest(
  organizationId: string,
  endpointPublicId: string,
): Promise<RedeliverResult | null | "no_deliveries"> {
  const latest = await withTenant(organizationId, async (tx) => {
    const [ep] = await tx
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.publicId, endpointPublicId))
      .limit(1);
    if (!ep) return null;
    const [row] = await tx
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, ep.id))
      // Newest first, with the id as a tiebreak — two deliveries can share a created_at to the
      // microsecond when an event fans out, and an unordered pick would make "latest" arbitrary.
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(1);
    return row
      ? { endpointFound: true, deliveryId: row.id }
      : { endpointFound: true, deliveryId: null };
  });
  if (!latest) return null;
  if (!latest.deliveryId) return "no_deliveries";
  return redeliverDelivery(organizationId, endpointPublicId, latest.deliveryId);
}

/**
 * Requeue every FAILED delivery on an endpoint, in one statement.
 *
 * Not `redeliverDelivery` in a loop: that one POSTs INLINE so it can hand back a live
 * transcript, which is right for one operator-initiated resend and wrong for a backlog — 28
 * dead deliveries at up to 10s each is a request nobody waits out, held open on a pooled
 * connection. This writes fresh `pending` rows and lets the billing clock drain them, so the
 * replay gets the real retry ladder, the circuit breaker and the fair share for free.
 *
 * The `NOT EXISTS` is the double-delivery guard `redeliverDelivery` does with `FOR UPDATE`:
 * an event that already has a live pending row on this endpoint is skipped rather than queued
 * twice. Doing it inside the INSERT keeps it atomic without N round trips.
 *
 * Bounded at `limit` (default 500) because this is one statement and an unbounded backlog
 * would write an unbounded number of rows inside one transaction.
 */
export async function requeueFailed(
  organizationId: string,
  endpointPublicId: string,
  opts: { limit?: number } = {},
): Promise<{ requeued: number } | null> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 500);
  return withTenant(organizationId, async (tx) => {
    const [ep] = await tx
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.publicId, endpointPublicId))
      .limit(1);
    if (!ep) return null;

    const inserted = await tx.execute(sql`
      insert into webhook_deliveries (organization_id, event_id, business_id, endpoint_id, status, attempts, next_attempt_at)
      select x.organization_id, x.event_id, x.business_id, x.endpoint_id, 'pending', 0, now()
      from (
        -- ONE row per EVENT, not per failed row. An event accumulates a failed row per
        -- attempt-and-replay cycle — a 401 before a connection was fixed and a 404 after is
        -- two — and the NOT EXISTS below cannot see rows this same statement is inserting, so
        -- without the DISTINCT a history of two failures queues the event twice and sends it
        -- twice. The partner's own event_id dedup would answer the second 409, which we map
        -- to delivered, so nothing is double-credited — but it is a wasted call and two more
        -- rows in a log this change exists to stop bloating.
        select distinct on (d.event_id)
          d.organization_id, d.event_id, d.endpoint_id, d.created_at, d.id,
          -- Failed rows from before 0350 carry no business.
          coalesce(d.business_id, (select e.business_id from events e where e.id = d.event_id)) business_id
        from webhook_deliveries d
        where d.endpoint_id = ${ep.id}
          and d.status = 'failed'
          and not exists (
            select 1 from webhook_deliveries live
            where live.event_id = d.event_id
              and live.endpoint_id = d.endpoint_id
              and live.status = 'pending'
          )
        order by d.event_id, d.created_at, d.id
      ) x
      order by x.created_at, x.id
      limit ${limit}
      returning id`);
    const rows = (inserted as { rows?: unknown[] }).rows ?? (inserted as unknown[]);
    const requeued = Array.isArray(rows) ? rows.length : 0;

    /**
     * Retire the rows we just replayed.
     *
     * A replay INSERTS a new delivery and leaves the original alone, so without this the log
     * shows every replayed event twice and the old failure stays red forever — visually
     * identical to one that still needs attention. `superseded` is terminal and benign: the
     * delivery did fail, and a newer row now carries the outcome. Scoped to rows whose event
     * has a live pending delivery, which is exactly the set the INSERT above just created.
     */
    if (requeued > 0) {
      await tx.execute(sql`
        update webhook_deliveries d
        set status = 'superseded'
        where d.endpoint_id = ${ep.id}
          and d.status = 'failed'
          and exists (
            select 1 from webhook_deliveries live
            where live.event_id = d.event_id
              and live.endpoint_id = d.endpoint_id
              and live.status = 'pending'
          )`);
    }

    // Same nudge `enqueueDeliveries` uses, through the SECURITY DEFINER wrapper — without it
    // the rows sit until the next 60-second tick, which on a backlog someone is watching reads
    // as "the button did nothing".
    if (requeued > 0) await tx.execute(sql`select public.app_nudge_webhook_outbox()`);
    log.info("failed deliveries requeued", {
      event: "webhook_failed_requeued",
      endpoint: endpointPublicId,
      requeued,
    });
    return { requeued };
  });
}

export interface RedeliverResult {
  delivery: typeof webhookDeliveries.$inferSelect;
  /**
   * What this resend actually sent and got back. Live only — never stored (decided 2026-09-02,
   * see `DeliveryTranscript`). The caller renders it immediately or it is gone.
   */
  transcript: DeliveryTranscript;
}

/**
 * Resend one delivery — SYNCHRONOUSLY, and hand back the transcript.
 *
 * It used to insert a pending clone and return, leaving the POST to the next drain. Two things
 * were wrong with that. The visible one: `enqueueDeliveries` had been taught to wake the drainer
 * on commit (2026-08-27) and this path was never brought along, so a manual resend waited out the
 * 60-second cron tick and the screen showed `Pending`, attempts 0, long after the call should
 * have been made and the card updated. The deeper one: an operator pressing Resend is asking
 * "does my receiver work NOW?", and a queued answer cannot tell them. Calling inline answers the
 * question they actually asked, and lets the request and response be shown live without storing
 * either.
 *
 * So this is deliberately NOT the outbox pattern, and that is not a violation of ADR-009: the
 * durable delivery row is still written and still settled by the shared `attemptDelivery`, so a
 * crash mid-POST leaves the row for the clock to retry exactly as before. Only the WAIT is gone.
 */
export async function redeliverDelivery(
  organizationId: string,
  endpointPublicId: string,
  deliveryId: string,
): Promise<RedeliverResult | null> {
  /**
   * Phase 1, in a transaction: resolve, guard, and write the clone.
   *
   * The POST is deliberately NOT in here — a network call inside an open transaction holds a
   * pooled connection and the `FOR UPDATE` lock for as long as the subscriber takes to answer,
   * which on a dead receiver is the full timeout.
   */
  const prepared = await withTenant(organizationId, async (tx) => {
    const [ep] = await tx
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.publicId, endpointPublicId))
      .limit(1);
    if (!ep) return null;
    const [orig] = await tx
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.endpointId, ep.id)))
      .limit(1);
    if (!orig) return null;
    const [ev] = await tx.select().from(events).where(eq(events.id, orig.eventId)).limit(1);
    if (!ev) return null;
    // Guard against double-delivery: a still-pending delivery will be attempted by
    // the clock anyway, and any live pending row for the same (event, endpoint)
    // means a redeliver is already queued. `FOR UPDATE` serializes concurrent
    // redeliver calls on the original row.
    await tx.execute(sql`SELECT id FROM webhook_deliveries WHERE id = ${orig.id} FOR UPDATE`);
    const [live] = await tx
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.eventId, orig.eventId),
          eq(webhookDeliveries.endpointId, ep.id),
          eq(webhookDeliveries.status, "pending"),
        ),
      )
      .limit(1);
    if (live)
      throw new RedeliverConflictError(
        "a delivery for this event is already pending on this endpoint",
      );
    /**
     * `nextAttemptAt` is set an hour OUT, not to now, and that is what makes calling inline safe.
     *
     * `deliverPending` drains `status = 'pending' AND next_attempt_at <= now`, so a row due
     * immediately can be claimed by a cron tick in the moment between this commit and our POST —
     * and `attemptDelivery` does not re-claim, so both would deliver. Dating it forward hides the
     * row from the drainer until we have had our attempt; the attempt then overwrites
     * `nextAttemptAt` with the real backoff (or settles the row), so the schedule is never
     * actually delayed. If this process dies between the commit and the POST, the clock picks the
     * row up an hour later — late, but never lost, which is the right way round.
     */
    const [clone] = await tx
      .insert(webhookDeliveries)
      .values({
        organizationId,
        eventId: orig.eventId,
        businessId: ev.businessId,
        endpointId: orig.endpointId,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(Date.now() + 3_600_000),
      })
      .returning();
    // Same retirement as the bulk path: the clone carries the outcome from here, so leaving
    // the original `failed` would show one event as two live failures.
    if (clone && orig.status === "failed") {
      await tx
        .update(webhookDeliveries)
        .set({ status: "superseded" })
        .where(eq(webhookDeliveries.id, orig.id));
    }
    return clone ? { clone, endpoint: ep, event: ev } : null;
  });
  if (!prepared) return null;

  /**
   * Phase 2, outside the transaction: the real attempt, through the same code the clock uses.
   *
   * `skipOpenCircuit: false` — an open breaker does not stop a human-initiated resend. The
   * breaker protects the clock's pass budget, which one operator click does not threaten, and
   * refusing here would disable the button in the exact moment it is most useful: right after
   * someone fixed the receiver. A success still closes the breaker.
   */
  const transcript = await attemptDelivery({
    delivery: prepared.clone,
    event: prepared.event,
    endpoint: prepared.endpoint,
    now: new Date(),
    timeoutMs: 10_000,
    skipOpenCircuit: false,
    // The only caller that wants the bodies: there is an operator on the other end of this call.
    capture: true,
  });

  // Read the settled row back so the caller renders the outcome, not the pending row it replaced.
  const settled = await withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, prepared.clone.id))
      .limit(1);
    return row ?? null;
  });
  return { delivery: settled ?? prepared.clone, transcript };
}

export interface TestSendResult {
  responseStatus: number;
  latencyMs: number;
}

/**
 * WH-3: send a canned sample payload for `type` to the endpoint synchronously
 * (carries `data.test: true`), returning the receiver's HTTP status + latency.
 * Does NOT write a delivery row — it's a connectivity check, not a real event.
 */
export async function testSendEndpoint(
  organizationId: string,
  endpointPublicId: string,
  type: EventType,
): Promise<TestSendResult | null> {
  const endpoint = await withTenant(organizationId, async (tx) => {
    const [ep] = await tx
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.publicId, endpointPublicId))
      .limit(1);
    return ep ?? null;
  });
  if (!endpoint) return null;

  // Same envelope as real deliveries (deliverPending in outbox.ts).
  const body = JSON.stringify({
    id: publicId("evt_test"),
    occurred_at: new Date().toISOString(),
    source: "system",
    user: null,
    event_type: type,
    api_version: "v1",
    content: sampleEventData(type),
    object: "event",
  });
  const startedAt = Date.now();
  let responseStatus = 0;
  try {
    const res = await guardedFetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Tmbilling-Signature": signPayload(endpoint.signingSecret, body),
        "Tmbilling-Event-Id": "evt_test",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    responseStatus = res.status;
    await res.body?.cancel().catch(() => {});
  } catch (e) {
    responseStatus = 0; // network error / timeout / private target
    log.warn("test webhook delivery failed", {
      endpoint: endpoint.publicId,
      error: (e as Error)?.message,
    });
  }
  return { responseStatus, latencyMs: Date.now() - startedAt };
}
