// Event emission — the PRIMARY primitive (ADR-009). Emitting a domain event
// means persisting an immutable `events` row (with its enriched envelope). This
// module knows NOTHING about webhooks. Webhook delivery is a downstream
// SUBSCRIBER that registers a sink via `registerEventSink` — so the dependency
// runs webhooks → events, never the reverse (see webhooks/outbox.ts).
//
// The outbox guarantee (ADR-007) is preserved: sinks run inside the SAME
// transaction as the state change, so an event + its deliveries commit atomically
// and are never sent for an uncommitted change.

import { desc } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { type EventType, resourceTypeOf } from "@/modules/events/registry";
import { buildEventContent } from "@/modules/events/content";
import { currentEventContext, type EventSource } from "@/platform/event-context";
import { getTraceId } from "@/platform/trace";
import { events } from "@db/schema";

export type EventRow = typeof events.$inferSelect;

/** A downstream consumer of emitted events (e.g. webhook fan-out). Runs inside
 *  the emit transaction. Registered at a composition root, not by the emitter. */
export type EventSink = (tx: Tx, event: EventRow) => Promise<void>;

const sinks: EventSink[] = [];

/** Register a sink invoked (in-tx) for every emitted event. Idempotent per fn. */
export function registerEventSink(fn: EventSink): void {
  if (!sinks.includes(fn)) sinks.push(fn);
}

/**
 * Best-effort extraction of a resource's public id from an event's `data` payload
 * so the enriched envelope carries `resource.id` even for legacy simple payloads
 * (`data: { invoice: 'inv_…' }`) and the standard shape (`data: { invoice: { id } }`).
 */
function deriveResourceId(data: unknown, resourceType: string): string | null {
  const v = (data as Record<string, unknown> | null | undefined)?.[resourceType];
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") {
    return (v as { id: string }).id;
  }
  return null;
}

/** The arguments of one `emitEvent` call, captured so it can be emitted later. */
export interface EmitEventInput {
  organizationId: string;
  businessId?: string;
  type: EventType;
  data: unknown;
  /** Override the request/job-derived provenance (rarely needed). */
  source?: EventSource;
  actor?: string | null;
  /** Explicit resource pointer; defaults to (resourceTypeOf(type), derived id). */
  resource?: { type: string; id: string };
}

/**
 * A buffer of events an operation WOULD have emitted. Handed in by a caller that
 * must not make the operation's state visible to webhook consumers until a later
 * step succeeds (the auto-collect-ON signup charges the card BEFORE the
 * subscription is allowed to exist — see `chargeBeforeSubscriptionInvoice`).
 *
 * Deleting a row cannot unsend a webhook the outbox worker already delivered, so
 * an event that might have to be undone must never be WRITTEN. Buffering is the
 * only safe order: emit only once the outcome is known good.
 */
export type DeferredEvents = EmitEventInput[];

/**
 * Emit now, or append to `defer` when the caller supplied a buffer. Opt-in: with
 * no buffer this is exactly `emitEvent`, so every existing call site is unchanged.
 */
export async function emitOrDefer(
  tx: Tx,
  input: EmitEventInput,
  defer?: DeferredEvents | null,
): Promise<void> {
  if (defer) {
    defer.push(input);
    return;
  }
  await emitEvent(tx, input);
}

/** Emit a buffer of deferred events, in order, inside the caller's transaction. */
export async function emitDeferred(tx: Tx, deferred: readonly EmitEventInput[]): Promise<void> {
  for (const ev of deferred) await emitEvent(tx, ev);
}

/**
 * Emit a buffer of deferred events in a transaction of their own. Used on the
 * paths that never reach the transaction the events were meant to ride on (e.g.
 * a create that ends up not billing after all) — the events must still land.
 */
export async function flushDeferredEvents(
  organizationId: string,
  deferred: readonly EmitEventInput[],
): Promise<void> {
  if (deferred.length === 0) return;
  await withTenant(organizationId, (tx) => emitDeferred(tx, deferred));
}

/**
 * Emit a domain event (outbox pattern, ADR-007/009). Persists the immutable event
 * row, then runs every registered sink in the SAME transaction. Returns the event.
 *
 * Must be called inside a withTenant() transaction (RLS-scoped).
 */
/**
 * Returned when the context suppresses events. Callers use the row for its id at most,
 * and a suppressed emit has no id — a null return would push that check into every one
 * of them, so a sentinel is the smaller lie and it is clearly labelled as one.
 */
const SUPPRESSED_EVENT = { publicId: "evt_suppressed", suppressed: true } as unknown as EventRow;

export async function emitEvent(tx: Tx, input: EmitEventInput): Promise<EventRow> {
  const prepared = await prepareEvent(tx, input);
  return prepared ? insertPreparedEvent(tx, prepared) : SUPPRESSED_EVENT;
}

/** An event whose content snapshot is built but not yet written (see `prepareEvent`). */
export interface PreparedEvent {
  input: EmitEventInput;
  source: string;
  actor: string | null;
  resourceType: string;
  resourceId: string | null;
  content: Record<string, unknown>;
}

/**
 * `emitEvent` in two halves, for a caller that must take a row lock between building an event's
 * snapshot and writing it: the snapshot reads are the slow part and need not hold the lock.
 * Null when the context suppresses events.
 */
export async function prepareEvent(tx: Tx, input: EmitEventInput): Promise<PreparedEvent | null> {
  const ctx = currentEventContext();
  // Suppressed: no row, and therefore no sinks — webhooks and customer mail both hang
  // off this call, so returning here is what makes the flag mean "silent", not "quiet".
  if (ctx?.suppressEvents === true) return null;
  const source = input.source ?? ctx?.source ?? "system";
  const actor = input.actor ?? ctx?.actor ?? null;
  const resourceType = input.resource?.type ?? resourceTypeOf(input.type);
  const resourceId = input.resource?.id ?? deriveResourceId(input.data, resourceType);

  // BLUEPRINT §11 Part B: replace the thin `{id, status}` payload with a
  // full-snapshot `content` (best-effort — never throws; falls back to the
  // caller's original `data` on any loader failure).
  const content = await buildEventContent(
    tx,
    { type: input.type, resourceType, resourceId, businessId: input.businessId ?? null },
    input.data,
  );
  return { input, source, actor, resourceType, resourceId, content };
}

export async function insertPreparedEvent(tx: Tx, p: PreparedEvent): Promise<EventRow> {
  const [event] = await tx
    .insert(events)
    .values({
      organizationId: p.input.organizationId,
      businessId: p.input.businessId ?? null,
      publicId: publicId("evt"),
      type: p.input.type,
      data: p.content as object,
      source: p.source,
      actor: p.actor,
      resourceType: p.resourceType,
      resourceId: p.resourceId,
      // Which EXECUTION caused this change (source/actor say who). Lets a clock tick
      // list exactly the events it produced — see clock_ticks.trace_id. Null outside
      // a trace context, which no real entry point is.
      traceId: getTraceId() ?? null,
    })
    .returning();

  for (const sink of sinks) await sink(tx, event!);
  return event!;
}

/** Recent domain events for an org (newest first) — the dev event stream. */
export async function listEvents(organizationId: string, limit = 50): Promise<EventRow[]> {
  return withTenant(organizationId, async (tx) =>
    tx.select().from(events).orderBy(desc(events.createdAt)).limit(limit),
  );
}
