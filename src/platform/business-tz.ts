import { eq } from 'drizzle-orm'
import { businesses } from '@db/schema'
import type { Tx } from '@/platform/db'

/**
 * A business's IANA timezone, defaulting to UTC (the column's own default).
 *
 * Exists so the LIST layer can bucket date filters by the business's day rather than the
 * UTC day. `filterSql`'s `on`/`after`/`before` operators compare against a calendar day
 * the operator picked in the dashboard, and a `timestamptz` compared to a bare `::date`
 * resolves at 00:00 UTC — so for an Asia/Kolkata business a row created 21-Aug 00:30 IST
 * (stored 20-Aug 19:00Z) fell outside "on 21-Aug". The list showed it dated 21-Aug and
 * the filter dropped it.
 *
 * One indexed primary-key lookup per list request, alongside the count + page queries
 * those endpoints already run. Deliberately not cached: a timezone change must take
 * effect immediately, and staleness here silently shifts every subsequent filter.
 */
export async function businessTimezone(tx: Tx, businessId: string): Promise<string> {
  const [b] = await tx
    .select({ timezone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)
  return b?.timezone ?? 'UTC'
}
