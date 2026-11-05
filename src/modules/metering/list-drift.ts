import { sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { FIXED12_SCALE, divHalfUp, fixed12FromNumeric } from "@/platform/fixed";
import { loadModelPriceBook } from "@/modules/model-prices/resolve";
import { groupRecord, type MeterRow } from "./meter-rating";
import { listKeyOf } from "./price-list-rating";
import { rowsOf } from "./usage-sql";

/** How far back the drift looks. */
export const DRIFT_DAYS = 7;

export interface ModelDrift {
  provider: string;
  model: string;
  /** USD cents the events reported, and what the list says the same tokens cost. */
  reportedCostMinor: bigint;
  listCostMinor: bigint;
  /** (reported ÷ list − 1) × 100, one decimal place. */
  differencePercent: number;
}

/**
 * List drift (design G1c § 3.4): for each model, what calls that reported their cost really
 * cost against the list price of the same tokens, over the last `DRIFT_DAYS`. Only events with
 * a cost count (a call's other token events carry "0"), and only USD: the list is USD.
 * `businessId` narrows it to one business.
 */
export async function listDrift(
  organizationId: string,
  now = new Date(),
  businessId?: string,
): Promise<ModelDrift[]> {
  const window = { start: new Date(now.getTime() - DRIFT_DAYS * 86_400_000), end: now };
  return withTenant(organizationId, async (tx) => {
    const rows = rowsOf<{
      group_by: string[];
      price_list: MeterRow["priceList"];
      gv: string[];
      bucket: string;
      costed: string;
      cost: string;
    }>(
      await tx.execute(sql`
        select m.group_by, m.price_list, r.group_values gv, r.bucket_start::text bucket,
          ((case when m.aggregation = 'count' then r.event_count::numeric else r.value_sum end)
            - r.uncosted_quantity)::text costed,
          r.cost_sum::text cost
        from usage_rollups r join meters m on m.id = r.meter_id
        where r.organization_id = ${organizationId} and m.price_list is not null
          and m.aggregation in ('sum', 'count') and not m.recurring
          and r.bucket_start >= ${window.start.toISOString()}::timestamptz
          ${businessId ? sql`and r.business_id = ${businessId}` : sql``}
          and coalesce(nullif(r.currency, ''), m.cost_currency, 'USD') = 'USD'
          and (case when m.aggregation = 'count' then r.event_count::numeric else r.value_sum end)
            > r.uncosted_quantity`),
    );
    const keyed = rows.flatMap((r) => {
      const key = listKeyOf(
        { priceList: r.price_list },
        groupRecord(r.group_by ?? [], r.gv ?? []),
        "USD",
      );
      return key ? [{ r, key }] : [];
    });
    if (keyed.length === 0) return [];
    const book = await loadModelPriceBook(
      tx,
      organizationId,
      keyed.map((k) => k.key.model),
      window,
    );
    const S = FIXED12_SCALE;
    const byModel = new Map<
      string,
      { provider: string; model: string; rep: bigint; list: bigint }
    >();
    for (const { r, key } of keyed) {
      const hit = book.listPrice(key, new Date(r.bucket));
      if (!hit.kind) continue;
      const k = `${hit.provider}\u0000${hit.model}`;
      const e = byModel.get(k) ?? { provider: hit.provider, model: hit.model, rep: 0n, list: 0n };
      // Fixed12 cents: reported cost is Fixed12 dollars; the list is cents per divisor units.
      e.rep += fixed12FromNumeric(r.cost) * 100n;
      e.list += divHalfUp(fixed12FromNumeric(r.costed) * hit.unitAmount, hit.quantityDivisor * S);
      byModel.set(k, e);
    }
    return [...byModel.values()]
      .filter((e) => e.list > 0n)
      .map((e) => ({
        provider: e.provider,
        model: e.model,
        reportedCostMinor: divHalfUp(e.rep, S),
        listCostMinor: divHalfUp(e.list, S),
        differencePercent: Number(divHalfUp((e.rep - e.list) * 1000n, e.list)) / 10,
      }))
      .sort((a, b) => Math.abs(b.differencePercent) - Math.abs(a.differencePercent));
  });
}
