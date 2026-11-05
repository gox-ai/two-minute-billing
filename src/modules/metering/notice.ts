import { sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { currentClockScope } from "@/platform/clock";
import { createLogger } from "@/platform/logger";
import { emitEvent } from "@/modules/events/emit";
import { pgTextArray, rowsOf, uuidFloor } from "./usage-sql";

const log = createLogger("metering.notice");

const HOUR_MS = 3_600_000;

/** The business clause of the clock scope, for a raw scan of `usage_events` aliased `e`. */
function scopeSql() {
  const s = currentClockScope();
  if (s?.onlyBusinessId) return sql`and e.business_id = ${s.onlyBusinessId}`;
  if (s?.excludeBusinessIds?.length)
    return sql`and not (e.business_id = any(${pgTextArray(s.excludeBusinessIds)}::uuid[]))`;
  return sql``;
}

/**
 * The hourly `usage_unmatched_notice` cron: per business with unmatched events received in
 * the last whole hour, one `usage_event_unmatched` event with the count and the first 10
 * distinct customer keys. At most one per business per hour, even if the job runs twice.
 */
export async function runUnmatchedNotice(now: Date = new Date()): Promise<{ notified: number }> {
  const end = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const start = end - HOUR_MS;
  const windowStart = new Date(start).toISOString();
  const windowEnd = new Date(end).toISOString();
  const rows = rowsOf<{ organization_id: string; business_id: string; n: number; keys: string[] }>(
    await systemDb.execute(sql`
      select e.organization_id, e.business_id, count(*)::int as n,
        (array_agg(distinct e.customer_key order by e.customer_key))[1:10] as keys
      from usage_events e
      where e.customer_id is null and e.voided_at is null
        and e.id >= ${uuidFloor(start)}::uuid and e.id < ${uuidFloor(end)}::uuid
        ${scopeSql()}
      group by e.organization_id, e.business_id`),
  );
  let notified = 0;
  for (const r of rows) {
    try {
      const sent = await withTenant(r.organization_id, async (tx) => {
        const [dup] = rowsOf<{ x: number }>(
          await tx.execute(sql`select 1 as x from events
            where business_id = ${r.business_id} and type = 'usage_event_unmatched'
              and data -> 'usage_event' ->> 'window_start' = ${windowStart} limit 1`),
        );
        if (dup) return false;
        await emitEvent(tx, {
          organizationId: r.organization_id,
          businessId: r.business_id,
          type: "usage_event_unmatched",
          data: {
            usage_event: {
              object: "unmatched_summary",
              window_start: windowStart,
              window_end: windowEnd,
              count: r.n,
              customer_keys: r.keys,
            },
          },
        });
        return true;
      });
      if (sent) notified++;
    } catch (e) {
      log.error(e, { event: "usage_unmatched_notice_failed", business_id: r.business_id });
    }
  }
  return { notified };
}
