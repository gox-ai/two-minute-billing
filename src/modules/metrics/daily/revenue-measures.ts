import { sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { revenueTotalsByInvoice } from "./revenue-totals";
import type { DimensionId } from "./measures";
import type { MetricDailyRow } from "./write";

/**
 * Revenue of every type, per customer: subscriptions, usage, one-time sales and credit
 * packs. The revenue of an invoice is the `revenue_billed` rule (billed status, dated by the
 * issue date, before tax, net of discounts and credits); a credit pack counts when it is sold.
 * Credit notes are dated by the note, not the invoice, so they stay out of these per-invoice
 * totals.
 *
 * Every figure here is per currency: a customer billed in two currencies counts in each.
 */
/** A ratio of two stocks at the period's end. */
export const REVENUE_RATIOS = ["customer_revenue_lifetime"] as const;
/** Window figures over distinct customers: computed at every grain, never summed. */
export const REVENUE_PER_GRAIN = [
  "revenue_retention_all",
  "revenue_top10_share",
  "paying_customers_all",
] as const;
export const REVENUE_MEASURES = [...REVENUE_RATIOS, ...REVENUE_PER_GRAIN] as const;

export const REVENUE_MEASURE_DIMS: Record<string, readonly DimensionId[]> = Object.fromEntries(
  REVENUE_MEASURES.map((id) => [id, [] as readonly DimensionId[]]),
);

const TOP = 10;
const BILLED = sql`('posted', 'payment_due', 'not_paid', 'paid')`;
const reportable = (col: string) =>
  sql.raw(
    `not exists (select 1 from customers rx where rx.id = ${col} and rx.exclude_from_reporting)`,
  );

export async function computeRevenueMeasures(input: {
  tx: Tx;
  businessId: string;
  from: Date;
  toExclusive: Date;
}): Promise<MetricDailyRow[]> {
  const { tx, businessId, from, toExclusive } = input;
  const startsAt = from.toISOString();
  const prevFrom = new Date(
    from.getTime() - (toExclusive.getTime() - from.getTime()),
  ).toISOString();
  const endsAt = toExclusive.toISOString();

  // Every billed invoice up to the period's end; the lifetime figure needs them all.
  const docs = (await tx.execute(sql`
    select i.id, i.customer_id::text as customer, upper(i.currency) as currency,
      case when i.created_at >= ${startsAt}::timestamptz then 'current'
        when i.created_at >= ${prevFrom}::timestamptz then 'previous' else 'earlier' end as at
    from invoices i
    where i.business_id = ${businessId} and i.status in ${BILLED}
      and i.created_at < ${endsAt}::timestamptz and ${reportable("i.customer_id")}`)) as unknown as Array<{
    id: string;
    customer: string;
    currency: string;
    at: "current" | "previous" | "earlier";
  }>;
  const paid = (await tx.execute(sql`
    select upper(p.currency) as currency, count(distinct p.customer_id)::text as customers
    from payments p
    where p.business_id = ${businessId} and p.status = 'succeeded' and p.amount_minor > 0
      and p.created_at >= ${startsAt}::timestamptz and p.created_at < ${endsAt}::timestamptz
      and p.customer_id is not null and ${reportable("p.customer_id")}
    group by 1`)) as unknown as Array<{ currency: string; customers: string }>;
  if (docs.length === 0 && paid.length === 0) return [];

  const revenue = await revenueTotalsByInvoice(
    tx,
    docs.map((d) => d.id),
  );

  interface Acc {
    lifetime: bigint;
    everCustomers: Set<string>;
    /** customer → [previous window, current window] */
    byCustomer: Map<string, [bigint, bigint]>;
  }
  const accs = new Map<string, Acc>();
  const accOf = (currency: string): Acc => {
    let a = accs.get(currency);
    if (!a) {
      a = { lifetime: 0n, everCustomers: new Set(), byCustomer: new Map() };
      accs.set(currency, a);
    }
    return a;
  };
  for (const d of docs) {
    const a = accOf(d.currency);
    const v = revenue.get(d.id) ?? 0n;
    a.lifetime += v;
    a.everCustomers.add(d.customer);
    if (d.at === "earlier") continue;
    const pair = a.byCustomer.get(d.customer) ?? [0n, 0n];
    pair[d.at === "current" ? 1 : 0] += v;
    a.byCustomer.set(d.customer, pair);
  }
  for (const p of paid) accOf(p.currency);

  const rows: MetricDailyRow[] = [];
  const push = (measure: string, currency: string, value: bigint, denominator?: bigint) =>
    rows.push({
      measure,
      dim: "",
      dimValue: "",
      currency,
      value,
      ...(denominator != null ? { denominator } : {}),
    });
  for (const [currency, a] of accs) {
    push("customer_revenue_lifetime", currency, a.lifetime, BigInt(a.everCustomers.size));

    let retained = 0n;
    let opening = 0n;
    const current: bigint[] = [];
    for (const [prev, now] of a.byCustomer.values()) {
      if (now !== 0n) current.push(now);
      if (prev <= 0n) continue;
      opening += prev;
      retained += now;
    }
    push("revenue_retention_all", currency, retained, opening);

    const total = current.reduce((s, v) => s + v, 0n);
    const top = [...current]
      .sort((x, y) => (y > x ? 1 : y < x ? -1 : 0))
      .slice(0, TOP)
      .reduce((s, v) => s + v, 0n);
    push("revenue_top10_share", currency, top, total);

    push(
      "paying_customers_all",
      currency,
      BigInt(paid.find((p) => p.currency === currency)?.customers ?? 0),
    );
  }
  return rows;
}
