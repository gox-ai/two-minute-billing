import { sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { billedRevenueByInvoice } from "@/modules/payments/attribution";
import type { DimensionId } from "./measures";
import type { MetricDailyRow } from "./write";

/**
 * Metered usage. Volume comes from `usage_rollups` (folded events; every generation is a
 * different batch of events, so all are summed). Money comes from usage invoice lines.
 *
 * There is no summed QUANTITY: meters count different things (tokens, images, seconds) and
 * aggregate differently (max, unique, last…), so a total across them means nothing.
 */
export const USAGE_SUMS = ["usage_events", "usage_cost"] as const;
/** Distinct counts and the retention rate: computed at every grain, never summed. */
export const USAGE_PER_GRAIN = ["usage_customers", "usage_revenue_retention"] as const;
export const USAGE_MEASURES = [...USAGE_SUMS, ...USAGE_PER_GRAIN] as const;

export const USAGE_MEASURE_DIMS: Record<string, readonly DimensionId[]> = {
  usage_events: ["meter"],
  usage_cost: ["meter"],
  usage_customers: [],
  usage_revenue_retention: [],
};
/** Not currency-scoped: stored under `XXX`. */
export const USAGE_NO_CURRENCY = new Set<string>(["usage_events", "usage_customers"]);

/** Cost bases a margin counts: the whole quantity had a cost (same set as `usage-margin.ts`). */
const FULL_COST = sql`('event', 'price_list', 'mixed')`;
const BILLED = sql`('posted', 'payment_due', 'not_paid', 'paid')`;
const n = (v: string | number | bigint | null | undefined): bigint => BigInt(v ?? 0);

export async function computeUsageMeasures(input: {
  tx: Tx;
  businessId: string;
  from: Date;
  toExclusive: Date;
}): Promise<MetricDailyRow[]> {
  const { tx, businessId, from, toExclusive } = input;
  const startsAt = sql`${from.toISOString()}::timestamptz`;
  const endsAt = sql`${toExclusive.toISOString()}::timestamptz`;
  const reportable = (col: string) =>
    sql.raw(
      `not exists (select 1 from customers rx where rx.id = ${col} and rx.exclude_from_reporting)`,
    );
  const rows: MetricDailyRow[] = [];
  const push = (
    measure: string,
    dim: string,
    dimValue: string,
    currency: string,
    value: bigint,
    denominator?: bigint,
  ) =>
    rows.push({
      measure,
      dim,
      dimValue,
      currency,
      value,
      ...(denominator != null ? { denominator } : {}),
    });

  // ── Volume ────────────────────────────────────────────────────────────────────────────
  const volume = (await tx.execute(sql`
    select r.meter_id::text as meter, sum(r.event_count)::text as events
    from usage_rollups r
    where r.business_id = ${businessId} and r.bucket_start >= ${startsAt} and r.bucket_start < ${endsAt}
      and ${reportable("r.customer_id")}
    group by 1`)) as unknown as Array<{ meter: string; events: string }>;
  const [{ customers = "0", ever = "0" } = {}] = (await tx.execute(sql`
    select
      count(distinct r.customer_id) filter (where r.bucket_start >= ${startsAt})::text as customers,
      count(*)::text as ever
    from usage_rollups r
    where r.business_id = ${businessId} and r.bucket_start < ${endsAt}
      and ${reportable("r.customer_id")}`)) as unknown as Array<{
    customers: string;
    ever: string;
  }>;
  if (n(ever) > 0n) {
    push(
      "usage_events",
      "",
      "",
      "XXX",
      volume.reduce((s, v) => s + n(v.events), 0n),
    );
    for (const v of volume) push("usage_events", "meter", v.meter, "XXX", n(v.events));
    push("usage_customers", "", "", "XXX", n(customers));
  }

  // ── Cost, on billed usage lines that carry a full cost ────────────────────────────────
  const cost = (await tx.execute(sql`
    select upper(i.currency) as currency, coalesce(li.rating ->> 'meter', '') as meter,
      coalesce(sum(li.cost_minor), 0)::text as cost
    from invoice_line_items li join invoices i on i.id = li.invoice_id
    where li.business_id = ${businessId} and li.kind = 'usage'
      and li.cost_minor is not null and li.cost_basis in ${FULL_COST}
      and i.status in ${BILLED} and i.created_at >= ${startsAt} and i.created_at < ${endsAt}
      and ${reportable("i.customer_id")}
    group by 1, 2`)) as unknown as Array<{ currency: string; meter: string; cost: string }>;

  // ── Retention: usage revenue this window from customers who had it the window before ──
  const prevFrom = new Date(from.getTime() - (toExclusive.getTime() - from.getTime()));
  const docs = (await tx.execute(sql`
    select i.id, i.customer_id::text as customer, upper(i.currency) as currency,
      (i.created_at >= ${startsAt}) as current
    from invoices i
    where i.business_id = ${businessId} and i.status in ${BILLED}
      and i.created_at >= ${prevFrom.toISOString()}::timestamptz and i.created_at < ${endsAt}
      and ${reportable("i.customer_id")}
      and exists (select 1 from invoice_line_items li where li.invoice_id = i.id and li.kind = 'usage')`)) as unknown as Array<{
    id: string;
    customer: string;
    currency: string;
    current: boolean;
  }>;
  const folded = await billedRevenueByInvoice(
    tx,
    docs.map((d) => d.id),
  );
  // currency → customer → [previous, current]
  const byCustomer = new Map<string, Map<string, [bigint, bigint]>>();
  for (const d of docs) {
    const usage = (folded.get(d.id)?.lines ?? [])
      .filter((l) => l.type === "usage")
      .reduce((s, l) => s + l.amountMinor, 0n);
    const cur = byCustomer.get(d.currency) ?? new Map<string, [bigint, bigint]>();
    const pair = cur.get(d.customer) ?? [0n, 0n];
    pair[d.current ? 1 : 0] += usage;
    cur.set(d.customer, pair);
    byCustomer.set(d.currency, cur);
  }

  const currencies = new Set<string>([...cost.map((c) => c.currency), ...byCustomer.keys()]);
  for (const currency of currencies) {
    const mine = cost.filter((c) => c.currency === currency);
    push(
      "usage_cost",
      "",
      "",
      currency,
      mine.reduce((s, c) => s + n(c.cost), 0n),
    );
    for (const c of mine) if (c.meter) push("usage_cost", "meter", c.meter, currency, n(c.cost));
    let retained = 0n;
    let opening = 0n;
    for (const [prev, now] of byCustomer.get(currency)?.values() ?? []) {
      if (prev <= 0n) continue;
      opening += prev;
      retained += now;
    }
    push("usage_revenue_retention", "", "", currency, retained, opening);
  }
  return rows;
}
