/**
 * Typed API fetchers for the Developer surface (webhook endpoints + events).
 * Backend routes: src/api/routes.ts (webhook_endpoints), src/api/events-routes.ts (events).
 */
import {
  apiGet,
  apiWrite,
  listQuery,
  type ListParams,
  type PagedList,
  type WebhookEndpoint,
  type WebhookDelivery,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Extended types
// ---------------------------------------------------------------------------

/** Full webhook endpoint with description + event_types subscription list. */
export interface WebhookEndpointDetail extends WebhookEndpoint {
  /** null = all events */
  event_types: string[] | null;
}

/** Result of a test-send call. */
export interface WebhookTestResult {
  object: "webhook_test";
  endpoint: string;
  type: string;
  response_status: number;
  latency_ms: number;
  delivered: boolean;
}

/** Delivery with last_response body excerpt. */
export interface WebhookDeliveryDetail extends WebhookDelivery {
  last_response_body?: string | null;
}

/**
 * Event with full webhook_status rollup and resource metadata.
 * `event_type`/`user`/`content` are the canonical envelope names (BLUEPRINT §11
 * Part B item 5); `type`/`actor`/`data` are kept as aliases since the dashboard
 * already reads them.
 */
export interface EventRecord {
  object: "event";
  id: string;
  type: string;
  event_type: string;
  source: string | null;
  actor: string | null;
  user: string | null;
  resource: { type: string | null; id: string | null } | null;
  occurred_at: string;
  /**
   * The execution that emitted this event (0148). Shared with the AUDIT row and the
   * gateway calls of the same act, which is how the Activity Log pairs an event with
   * its audit row exactly rather than by a created_at window. Null for an imported
   * event (executed in the source system) and for anything emitted before 0148.
   */
  trace_id?: string | null;
  webhook_status?: string | null;
  /** API version the envelope was serialized under. */
  api_version?: string | null;
  data: unknown;
  /** Full-snapshot payload — a map of resource-key -> resource object. */
  content: Record<string, unknown> | null;
}

/** Event with delivery breakdown — from GET /v1/events/:evt */
export interface EventDetail extends EventRecord {
  webhook_deliveries: Array<{
    endpoint: string;
    endpoint_name: string | null;
    enabled: boolean;
    delivery_id: string;
    url: string;
    status: string;
    attempts: number;
    last_response_status: number | null;
    /** The receiver's reply on the last failed attempt, clipped. */
    last_error?: string | null;
    last_attempt_at: string | null;
    /** Row creation time — the stable ordering key for several attempts on one endpoint. */
    created_at: string;
  }>;
}

/**
 * A page of events. **Paginated server-side** — `total`/`has_more`/`next_cursor`
 * are real (see `src/modules/events/service.ts` `listEventsUnified`); a wrapper
 * that dropped them would hide rows the same way `listGatewayRequests`'s bare
 * `List<T>` once did (docs/PROGRESS.md, 2026-08-01).
 */
export type EventsPage = PagedList<EventRecord>;

/** Legacy flat filters (still honoured by the endpoint) + the shared list params. */
export interface EventListFilters extends ListParams {
  /** Repeated `?type=` (multi-value) — the shared grammar's `type[is]=` builder filter is single-value. */
  type?: string[];
  resource_type?: string;
  resource_id?: string;
  /**
   * One customer's whole footprint — the customer record plus its subscriptions,
   * invoices, credit notes, payments and payment methods. What the customer page's
   * Events tab and Activity Log read; `resource_id` alone would show only the
   * handful of events written against the customer row itself.
   */
  customer?: string;
  source?: string;
  occurred_after?: string;
  occurred_before?: string;
}

function eventsQuery(filters: EventListFilters): string {
  const {
    type,
    resource_type,
    resource_id,
    customer,
    source,
    occurred_after,
    occurred_before,
    ...list
  } = filters;
  const sp = new URLSearchParams();
  type?.forEach((t) => sp.append("type", t));
  if (resource_type) sp.set("resource_type", resource_type);
  if (resource_id) sp.set("resource_id", resource_id);
  if (customer) sp.set("customer", customer);
  if (source) sp.set("source", source);
  if (occurred_after) sp.set("occurred_after", occurred_after);
  if (occurred_before) sp.set("occurred_before", occurred_before);
  const flat = sp.toString();
  const rest = listQuery(list);
  return [flat, rest].filter(Boolean).join("&");
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

/** Fetch one endpoint (includes description + event_types). */
export const getWebhookEndpoint = (id: string) =>
  apiGet<WebhookEndpointDetail>(`/v1/webhook_endpoints/${id}`);

/** Requeue every failed delivery on an endpoint; the clock sends them. */
export const redeliverFailed = (endpointId: string) =>
  apiWrite(`/v1/webhook_endpoints/${endpointId}/redeliver_failed`, {}, "POST");

/** List all endpoints (extended shape). */
export const listWebhookEndpointsDetail = () =>
  apiGet<{ object: "list"; data: WebhookEndpointDetail[] }>("/v1/webhook_endpoints");

/** One page of an endpoint's delivery log (cursor-paginated, filterable). */
export function listDeliveries(
  id: string,
  params: ListParams = {},
): Promise<PagedList<WebhookDeliveryDetail>> {
  const q = listQuery(params);
  return apiGet<PagedList<WebhookDeliveryDetail>>(
    `/v1/webhook_endpoints/${id}/deliveries${q ? `?${q}` : ""}`,
  );
}

/** List events (org-level, all businesses) with optional filters. */
export function listEventsFiltered(params: EventListFilters = {}): Promise<EventsPage> {
  const q = eventsQuery(params);
  return apiGet<EventsPage>(`/v1/events${q ? `?${q}` : ""}`);
}

/** Get a single event with delivery detail. */
export const getEvent = (id: string) => apiGet<EventDetail>(`/v1/events/${id}`);

/** List events scoped to a single business (Logs > Events). */
export function listEventsForBusiness(
  biz: string,
  params: EventListFilters = {},
): Promise<EventsPage> {
  const q = eventsQuery(params);
  return apiGet<EventsPage>(`/v1/businesses/${biz}/events${q ? `?${q}` : ""}`);
}

/** Get a single event with delivery detail (business scope uses the same org-level route — event IDs are globally unique). */
export const getEventForBusiness = (_biz: string, id: string) => getEvent(id);

// ---------------------------------------------------------------------------
// Mutations (used in server actions)
// ---------------------------------------------------------------------------

/** PATCH endpoint — update description and/or event_types subscription. */
export const patchWebhookEndpoint = (
  id: string,
  body: { description?: string | null; event_types?: string[] | null },
) => apiWrite(`/v1/webhook_endpoints/${id}`, body, "PATCH");

/** POST test send — returns WebhookTestResult. */
export const testSendWebhook = (id: string, type: string) =>
  apiWrite(`/v1/webhook_endpoints/${id}/test`, { type }, "POST");

/**
 * The ONE attempt a synchronous resend just made.
 *
 * Live only — the engine stores none of this (see `DeliveryTranscript` in
 * `src/modules/webhooks/outbox.ts`). It exists in the resend response and nowhere else, so a
 * screen that wants to show it must render it from the action result; there is no endpoint to
 * fetch it back from later. Both bodies are already capped and truncation-marked engine-side.
 */
export interface RedeliveryAttempt {
  outcome: "delivered" | "failed" | "retrying" | "not_attempted";
  latency_ms: number;
  /** Why no HTTP response arrived (DNS, refused, reset, timeout). Null when one did. */
  error: string | null;
  request: { method: "POST"; url: string; headers: Record<string, string>; body: string };
  /** Null when the request never got a response at all — see `error`. */
  response: { status: number; headers: Record<string, string>; body: string } | null;
}

/** The body of a successful resend: the settled delivery row + that live attempt. */
export interface RedeliveryResponse {
  object: "webhook_delivery";
  id: string;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_response_status: number | null;
  attempt: RedeliveryAttempt;
}

/**
 * POST redeliver_latest — 200 with the attempt (synchronous since 2026-09-02), or 409 when the
 * endpoint has never delivered anything.
 * The one-click "is it working again?" after fixing a receiver: the per-delivery call above
 * needs an id, which means finding one first.
 */
export const redeliverLatest = (endpointId: string) =>
  apiWrite(`/v1/webhook_endpoints/${endpointId}/redeliver_latest`, {}, "POST");

/**
 * POST redeliver — 200, SYNCHRONOUS. The engine calls the subscriber inline and the response
 * carries `attempt`: what was sent and what came back. It used to answer 202 with the resend
 * merely queued, which is why callers must read `attempt` rather than poll for an outcome.
 */
export const redeliverDelivery = (endpointId: string, deliveryId: string) =>
  apiWrite(`/v1/webhook_endpoints/${endpointId}/deliveries/${deliveryId}/redeliver`, {}, "POST");
