import { sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";

/**
 * Which billing models a business has data for, from stored `metric_daily` day rows over the
 * last {@link PRESENCE_DAYS} days. Screens use it to show a model's dashboards and tabs only
 * when there is something to show. Business Home asks the same measures in its batch.
 */
export type BillingModel = "subscriptions" | "credits" | "usage" | "one_time";

export const PRESENCE_DAYS = 90;

export async function billingModelsPresent(tx: Tx, businessId: string): Promise<Set<BillingModel>> {
  const rows = (await tx.execute(sql`
    select measure, dim, dim_value from metric_daily
    where business_id = ${businessId} and grain = 'day'
      and period_end >= (current_date - ${PRESENCE_DAYS}::int)
      and value <> 0
      and (
        (measure = 'active_subscriptions' and dim = '')
        or (measure in ('credits_outstanding', 'credits_granted') and dim = '')
        or (measure = 'usage_events' and dim = '')
        or (measure = 'orders' and dim = '')
        or (measure = 'revenue_billed' and dim = 'revenue_type' and dim_value = 'usage')
      )
    group by 1, 2, 3`)) as unknown as Array<{ measure: string; dim: string; dim_value: string }>;
  const out = new Set<BillingModel>();
  for (const r of rows) {
    if (r.measure === "active_subscriptions") out.add("subscriptions");
    else if (r.measure.startsWith("credits_")) out.add("credits");
    else if (r.measure === "usage_events") out.add("usage");
    else if (r.measure === "orders") out.add("one_time");
    // A setup fee on a subscription invoice is one-time revenue, not one-time SALES.
    else if (r.dim_value === "usage") out.add("usage");
  }
  return out;
}
