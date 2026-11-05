import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { rowsOf } from "./usage-sql";

/**
 * Fold a set of (event, meter) hits into `usage_rollups`, one upsert. `hits` yields:
 * organization_id, business_id, customer_id, meter_id, bucket, gv, cur, id, ts, val, amount,
 * cost. Rows go in at the customer-meter's current generation, read `FOR SHARE` so a cutoff
 * that moves it waits for this transaction (design §3.6). Returns the customers touched.
 */
export async function upsertRollups(tx: Tx, businessId: string, hits: SQL): Promise<string[]> {
  const rows = rowsOf<{ customer_id: string }>(
    await tx.execute(sql`
      with hits as (${hits}),
      gens as (
        select b.customer_id, b.meter_id, b.generation from customer_meter_billing b
        where b.business_id = ${businessId}
          and (b.customer_id, b.meter_id) in (select distinct customer_id, meter_id from hits)
        for share of b),
      agg as (
        select h.organization_id, h.business_id, h.customer_id, h.meter_id, h.bucket, h.gv, h.cur,
          coalesce(g.generation, 0) as gen,
          count(*) as n,
          coalesce(sum(h.val), 0) as vsum,
          min(h.val) as vmin,
          max(h.val) as vmax,
          (array_agg(h.val order by h.ts desc, h.id desc))[1] as lastv,
          max(h.ts) as last_at,
          (array_agg(h.id order by h.ts desc, h.id desc))[1] as last_id,
          coalesce(sum(h.amount), 0) as asum,
          coalesce(sum(h.cost), 0) as csum,
          coalesce(sum(coalesce(h.val, 1)) filter (where h.cost is null), 0) as uncosted
        from hits h
        left join gens g on g.customer_id = h.customer_id and g.meter_id = h.meter_id
        group by h.organization_id, h.business_id, h.customer_id, h.meter_id, h.bucket, h.gv,
          h.cur, coalesce(g.generation, 0))
      insert into usage_rollups as r (organization_id, business_id, customer_id, meter_id,
        bucket_start, group_values, currency, generation, event_count, value_sum, value_min,
        value_max, last_value, last_at, last_event_id, amount_sum, cost_sum, uncosted_quantity)
      select organization_id, business_id, customer_id, meter_id, bucket, gv, cur, gen, n, vsum,
        vmin, vmax, lastv, last_at, last_id, asum, csum, uncosted
      from agg
      on conflict (customer_id, meter_id, bucket_start, group_values, currency, generation)
      do update set
        event_count = r.event_count + excluded.event_count,
        value_sum = r.value_sum + excluded.value_sum,
        value_min = least(r.value_min, excluded.value_min),
        value_max = greatest(r.value_max, excluded.value_max),
        last_value = case when r.last_at is null or (excluded.last_at, excluded.last_event_id) > (r.last_at, r.last_event_id)
          then excluded.last_value else r.last_value end,
        last_event_id = case when r.last_at is null or (excluded.last_at, excluded.last_event_id) > (r.last_at, r.last_event_id)
          then excluded.last_event_id else r.last_event_id end,
        last_at = greatest(r.last_at, excluded.last_at),
        amount_sum = r.amount_sum + excluded.amount_sum,
        cost_sum = r.cost_sum + excluded.cost_sum,
        uncosted_quantity = r.uncosted_quantity + excluded.uncosted_quantity
      returning r.customer_id`),
  );
  if (rows.length) await bumpRollupVersion(tx, businessId);
  return [...new Set(rows.map((r) => r.customer_id))];
}

/**
 * Mark the business's rollups changed. Every writer of `usage_rollups` calls it in its own
 * transaction: `readMeterUsage` caches rollup aggregates keyed on this version (0468).
 */
export async function bumpRollupVersion(tx: Tx, businessId: string): Promise<void> {
  await tx.execute(sql`update usage_rollup_state
    set rollup_version = nextval('usage_rollup_version_seq') where business_id = ${businessId}`);
}
