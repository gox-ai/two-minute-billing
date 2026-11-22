import { and, asc, eq, inArray } from "drizzle-orm";
import { events } from "@db/schema";
import { withTenant } from "@/platform/db";

/** What created a record: the source and actor stamped on its creation event. */
export interface CreatedThrough {
  source: string;
  actor: string | null;
}

/** Creation event types per resource, earliest wins. An order is an invoice. */
const CREATION_TYPES = {
  invoice: ["invoice_generated", "invoice_pending_created"],
  subscription: ["subscription_created"],
  customer: ["customer_created"],
  credit_note: ["credit_note_created"],
  payment_request: ["payment_request_created"],
  payment_intent: ["payment_intent_created"],
} as const;

export type ProvenanceResource = keyof typeof CREATION_TYPES;

/** One row per record: the earliest creation event. A record with none is absent (never guessed). */
export async function creationEvents(
  organizationId: string,
  resource: ProvenanceResource,
  ids: readonly string[],
): Promise<Map<string, CreatedThrough & { traceId: string | null; type: string }>> {
  const out = new Map<string, CreatedThrough & { traceId: string | null; type: string }>();
  if (ids.length === 0) return out;
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        resourceId: events.resourceId,
        source: events.source,
        actor: events.actor,
        traceId: events.traceId,
        type: events.type,
      })
      .from(events)
      .where(
        and(
          eq(events.resourceType, resource),
          inArray(events.resourceId, [...ids]),
          inArray(events.type, [...CREATION_TYPES[resource]]),
        ),
      )
      .orderBy(asc(events.createdAt), asc(events.id)),
  );
  for (const r of rows) {
    if (r.resourceId && !out.has(r.resourceId))
      out.set(r.resourceId, {
        source: r.source,
        actor: r.actor,
        traceId: r.traceId,
        type: r.type,
      });
  }
  return out;
}

/** `created_through` of one record, or null when no creation event was recorded. */
export async function createdThrough(
  organizationId: string,
  resource: ProvenanceResource,
  id: string,
): Promise<CreatedThrough | null> {
  const e = (await creationEvents(organizationId, resource, [id])).get(id);
  return e ? { source: e.source, actor: e.actor } : null;
}
