import type { FastifyInstance } from "fastify";
import { authenticate } from "@/platform/auth";
import { events } from "@db/schema";
import {
  listEventsUnified,
  getEventWithDeliveries,
  getImportedEvent,
  EVENT_FILTER_OPS,
  EVENT_FILTER_KINDS,
  EVENT_SORT_FIELDS,
  webhookStatusFilterError,
  type EventFilters,
  type ImportedEventRow,
  type UnifiedEventRow,
} from "@/modules/events/service";
import {
  badRequest,
  notFound,
  resolveBusiness,
  parseListQuery,
  listResponse,
  requirePerm,
} from "./helpers";

/**
 * Serialize an event to the enriched public envelope (EV-2 shape; WH-4 rollup).
 * Carries the canonical names (event_type, user, content, object)
 * verbatim per BLUEPRINT §11 Part B item 5, alongside the existing type/actor/data
 * aliases the dashboard already reads — additive, not a rename, so both stay green.
 */
function serializeEvent(e: typeof events.$inferSelect & { webhookStatus?: string }) {
  return {
    object: "event",
    id: e.publicId,
    type: e.type,
    event_type: e.type,
    source: e.source,
    actor: e.actor,
    user: e.actor,
    resource: e.resourceType || e.resourceId ? { type: e.resourceType, id: e.resourceId } : null,
    occurred_at: e.createdAt,
    // 0148/0149: the execution that emitted this event. Serialized so the Activity
    // Log can pair an event with the AUDIT row of the same act EXACTLY, instead of
    // matching on a ±60s created_at window — a heuristic that mispaired whenever two
    // actions of the same type landed inside the window.
    trace_id: e.traceId ?? null,
    api_version: e.apiVersion,
    ...(e.webhookStatus !== undefined ? { webhook_status: e.webhookStatus } : {}),
    data: e.data,
    content: e.data,
  };
}

/**
 * Serialize an imported (ievt_…) source-history event into the same envelope.
 * `source` / `user` / `content` come verbatim from the archived source payload,
 * so a migrated event renders exactly like it did at the source.
 */
function serializeImportedEvent(e: ImportedEventRow) {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const user = typeof p.user === "string" ? p.user : `import:${e.source}`;
  const content = (p.content ?? {}) as Record<string, unknown>;
  return {
    object: "event",
    id: e.publicId,
    type: e.eventType,
    event_type: e.eventType,
    source: typeof p.source === "string" ? p.source : "imported",
    actor: user,
    user,
    resource: null,
    occurred_at: e.occurredAt,
    // An imported event was executed in the SOURCE system, so it has no trace of
    // ours. Null rather than absent, so the field's shape is the same either way.
    trace_id: null,
    api_version: null,
    imported: true,
    webhook_status: "not_configured",
    data: content,
    content,
  };
}

const serializeUnified = (r: UnifiedEventRow) =>
  r.kind === "native" ? serializeEvent(r.row) : serializeImportedEvent(r.row);

/** Normalize a repeatable query param into a string[] (Fastify gives string | string[]). */
function toArray(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  return Array.isArray(v) ? (v as string[]) : [String(v)];
}

function parseDate(v: unknown): Date | undefined {
  if (v == null) return undefined;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d;
}

/**
 * Legacy flat-param filters (shared by org- and business-scoped list) — kept
 * working alongside the shared `field[op]=value` grammar below, exactly like
 * the `transactions` endpoint folds its own legacy params in.
 */
function filtersFromQuery(q: Record<string, unknown>, businessId?: string): Partial<EventFilters> {
  return {
    businessId,
    types: toArray(q.type),
    resourceType: q.resource_type ? String(q.resource_type) : undefined,
    resourceId: q.resource_id ? String(q.resource_id) : undefined,
    // One customer's whole footprint, not just the events written against the
    // customer record — what a customer's Activity Log / Events tab reads.
    customer: q.customer ? String(q.customer) : undefined,
    source: q.source ? String(q.source) : undefined,
    occurredAfter: parseDate(q.occurred_after),
    occurredBefore: parseDate(q.occurred_before),
  };
}

export async function registerEventRoutes(app: FastifyInstance) {
  // Org-level event stream (all businesses).
  app.get(
    "/v1/events",
    {
      preHandler: [authenticate, requirePerm("events:view")],
      config: { repeatableQuery: ["type"] },
    },
    async (req, reply) => {
      const parsed = parseListQuery(req, reply, {
        includeDeleted: "none",
        filterOps: EVENT_FILTER_OPS,
        // The VALUE shape too, so `?occurred_at[on]=31/08/2026` is a 400 that names the
        // shape rather than a 500 out of the Postgres `::date` cast.
        filterKinds: EVENT_FILTER_KINDS,
        sortFields: [...EVENT_SORT_FIELDS],
        bareParams: [
          "type",
          "resource_type",
          "resource_id",
          "customer",
          "source",
          "occurred_after",
          "occurred_before",
        ],
      });
      if (!parsed) return;
      const statusError = webhookStatusFilterError(parsed.filters);
      if (statusError) return badRequest(reply, statusError);
      const q = req.query as Record<string, unknown>;
      const filters: EventFilters = {
        ...filtersFromQuery(q),
        filters: parsed.filters,
        search: parsed.search,
        startingAfter: parsed.startingAfter,
        limit: parsed.limit,
        sortDesc: parsed.sortDesc ?? true,
      };
      const page = await listEventsUnified(req.organization!.id, filters);
      return listResponse(page, serializeUnified);
    },
  );

  // Single event + its per-endpoint webhook deliveries.
  app.get(
    "/v1/events/:evt",
    { preHandler: [authenticate, requirePerm("events:view")] },
    async (req, reply) => {
      const evt = (req.params as { evt: string }).evt;
      if (evt.startsWith("ievt_")) {
        const imported = await getImportedEvent(req.organization!.id, evt);
        if (!imported) return notFound(reply, `No such event: ${evt}`);
        return { ...serializeImportedEvent(imported), webhook_deliveries: [] };
      }
      const found = await getEventWithDeliveries(req.organization!.id, evt);
      if (!found) return notFound(reply, `No such event: ${evt}`);
      return {
        ...serializeEvent(found.event),
        webhook_deliveries: found.deliveries.map((d) => ({
          endpoint: d.endpoint,
          endpoint_name: d.endpointName,
          enabled: d.enabled === "true",
          delivery_id: d.deliveryId,
          url: d.url,
          status: d.status,
          attempts: d.attempts,
          last_response_status: d.lastResponseStatus,
          last_error: d.lastError,
          last_attempt_at: d.lastAttemptAt,
          created_at: d.createdAt,
        })),
      };
    },
  );

  // Business-scoped event stream (backs the dashboard's `ListPage` server mode
  // via `/api/lists/events`).
  app.get(
    "/v1/businesses/:biz/events",
    {
      preHandler: [authenticate, requirePerm("events:view")],
      config: { repeatableQuery: ["type"] },
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseListQuery(req, reply, {
        includeDeleted: "none",
        filterOps: EVENT_FILTER_OPS,
        // The VALUE shape too, so `?occurred_at[on]=31/08/2026` is a 400 that names the
        // shape rather than a 500 out of the Postgres `::date` cast.
        filterKinds: EVENT_FILTER_KINDS,
        sortFields: [...EVENT_SORT_FIELDS],
        bareParams: [
          "type",
          "resource_type",
          "resource_id",
          "customer",
          "source",
          "occurred_after",
          "occurred_before",
        ],
      });
      if (!parsed) return;
      const statusError = webhookStatusFilterError(parsed.filters);
      if (statusError) return badRequest(reply, statusError);
      const q = req.query as Record<string, unknown>;
      const filters: EventFilters = {
        ...filtersFromQuery(q, business.id),
        filters: parsed.filters,
        search: parsed.search,
        startingAfter: parsed.startingAfter,
        limit: parsed.limit,
        sortDesc: parsed.sortDesc ?? true,
      };
      const page = await listEventsUnified(req.organization!.id, filters);
      return listResponse(page, serializeUnified);
    },
  );
}
