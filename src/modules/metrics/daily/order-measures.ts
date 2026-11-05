import { sql } from "drizzle-orm";
import { isOrder } from "./order-predicate";
import type { Tx } from "@/platform/db";
import { billedRevenueByInvoice } from "@/modules/payments/attribution";
import type { DimensionId } from "./measures";
import type { MetricDailyRow } from "./write";

/**
 * One-time sales. An ORDER is a billed invoice (posted, payment due, not paid or paid) with no
 * subscription and at least one one-time line that is not a credit pack: a product sold on its
 * own, as a purchase checkout or a manual invoice raises it. Dated by the invoice's issue date.
 */
export { isOrder };
export const ORDER_SUMS = ["orders", "order_revenue", "order_refunds"] as const;
export const ORDER_RATIOS = ["average_order_value"] as const;
/** Distinct buyers and their rate: computed at every grain, never summed. */
export const ORDER_PER_GRAIN = ["buyers", "returning_buyers", "returning_buyer_rate"] as const;
export const ORDER_MEASURES = [...ORDER_SUMS, ...ORDER_RATIOS, ...ORDER_PER_GRAIN] as const;

export const ORDER_MEASURE_DIMS: Record<string, readonly DimensionId[]> = {
  orders: [],
  order_revenue: ["product"],
  order_refunds: [],
  average_order_value: [],
  buyers: [],
  returning_buyers: [],
  returning_buyer_rate: [],
};

const n = (v: string | number | bigint | null | undefined): bigint => BigInt(v ?? 0);

export async function computeOrderMeasures(input: {
  tx: Tx;
  businessId: string;
  from: Date;
  toExclusive: Date;
}): Promise<MetricDailyRow[]> {
  const { tx, businessId, from, toExclusive } = input;
  const startsAt = sql`${from.toISOString()}::timestamptz`;
  const endsAt = sql`${toExclusive.toISOString()}::timestamptz`;

  const docs = (await tx.execute(sql`
    select i.id, i.customer_id::text as customer, upper(i.currency) as currency,
      (i.created_at >= ${startsAt}) as current,
      exists (select 1 from invoices e where e.business_id = i.business_id
        and e.customer_id = i.customer_id and e.created_at < ${startsAt}
        and e.id <> i.id
        and e.status in ('posted', 'payment_due', 'not_paid', 'paid') and e.subscription_id is null
        and exists (select 1 from invoice_line_items el left join prices ep on ep.id = el.price_id
          where el.invoice_id = e.id and el.kind = 'one_time'
            and coalesce(ep.grants_credit ->> 'kind', '') <> 'pack')) as returning
    from invoices i
    where i.business_id = ${businessId} and i.created_at < ${endsAt} and ${isOrder()}`)) as unknown as Array<{
    id: string;
    customer: string;
    currency: string;
    current: boolean;
    returning: boolean;
  }>;
  // Nothing ever sold this way by the period's end: no rows, not a wall of zeros.
  if (docs.length === 0) return [];

  const inWindow = docs.filter((d) => d.current);
  const folded = await billedRevenueByInvoice(
    tx,
    inWindow.map((d) => d.id),
  );
  const refunds = (await tx.execute(sql`
    select upper(r.currency) as currency, coalesce(sum(r.amount_minor), 0)::text as amount
    from refunds r join payments p on p.id = r.payment_id join invoices i on i.id = p.invoice_id
    where r.business_id = ${businessId} and r.status = 'succeeded'
      and r.created_at >= ${startsAt} and r.created_at < ${endsAt} and ${isOrder()}
    group by 1`)) as unknown as Array<{ currency: string; amount: string }>;

  const acc = new Map<string, bigint>();
  const add = (measure: string, dim: string, value: string, currency: string, v: bigint) => {
    const k = `${measure}\u0000${dim}\u0000${value}\u0000${currency}`;
    acc.set(k, (acc.get(k) ?? 0n) + v);
  };
  const buyers = new Map<string, Set<string>>();
  const returning = new Map<string, Set<string>>();
  for (const currency of new Set(docs.map((d) => d.currency))) {
    for (const m of ORDER_SUMS) add(m, "", "", currency, 0n);
    buyers.set(currency, new Set());
    returning.set(currency, new Set());
  }
  for (const d of inWindow) {
    add("orders", "", "", d.currency, 1n);
    for (const l of folded.get(d.id)?.lines ?? []) {
      add("order_revenue", "", "", d.currency, l.amountMinor);
      add("order_revenue", "product", l.productId ?? "none", d.currency, l.amountMinor);
    }
    buyers.get(d.currency)!.add(d.customer);
    if (d.returning) returning.get(d.currency)!.add(d.customer);
  }
  for (const r of refunds) add("order_refunds", "", "", r.currency, n(r.amount));

  const rows: MetricDailyRow[] = [];
  for (const [k, value] of acc) {
    const [measure, dim, dimValue, currency] = k.split("\u0000") as [
      string,
      string,
      string,
      string,
    ];
    rows.push({ measure, dim, dimValue, currency, value });
  }
  for (const [currency, set] of buyers) {
    const orders = acc.get(`orders\u0000\u0000\u0000${currency}`) ?? 0n;
    const revenue = acc.get(`order_revenue\u0000\u0000\u0000${currency}`) ?? 0n;
    const back = BigInt(returning.get(currency)!.size);
    const all = BigInt(set.size);
    rows.push(
      {
        measure: "average_order_value",
        dim: "",
        dimValue: "",
        currency,
        value: revenue,
        denominator: orders,
      },
      { measure: "buyers", dim: "", dimValue: "", currency, value: all },
      { measure: "returning_buyers", dim: "", dimValue: "", currency, value: back },
      {
        measure: "returning_buyer_rate",
        dim: "",
        dimValue: "",
        currency,
        value: back,
        denominator: all,
      },
    );
  }
  return rows;
}
