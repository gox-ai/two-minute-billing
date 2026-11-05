/**
 * Event types an org's enabled endpoints list EXPLICITLY (design G3 C5). An "all events"
 * endpoint (`event_types` null) does not count. High-volume events (credit holds) are written
 * to the outbox only when this set names them. Cached per org for 30 s; any endpoint write
 * in this process drops the entry.
 */
import { sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; types: ReadonlySet<string> }>();

export async function subscribedEventTypes(
  tx: Tx,
  organizationId: string,
): Promise<ReadonlySet<string>> {
  const hit = cache.get(organizationId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.types;
  const rows = (await tx.execute(sql`
    select distinct jsonb_array_elements_text(event_types) as t
    from webhook_endpoints
    where organization_id = ${organizationId} and enabled = 'true'
      and event_types is not null and jsonb_typeof(event_types) = 'array'`)) as unknown as Array<{
    t: string;
  }>;
  const types = new Set(rows.map((r) => r.t));
  cache.set(organizationId, { at: Date.now(), types });
  return types;
}

/** Drop the cached set (an endpoint was created, changed or deleted). Null clears all. */
export function clearSubscribedEventTypes(organizationId: string | null): void {
  if (organizationId == null) cache.clear();
  else cache.delete(organizationId);
}
