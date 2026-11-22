import { sql } from "drizzle-orm";
import { isOrder, orderRuleOn } from "./order-predicate";
import type { Tx } from "@/platform/db";
import { allocateProRata, billedRevenueByInvoice } from "@/modules/payments/attribution";
import { revenueTotalsByInvoice } from "./revenue-totals";
import type { DimensionId } from "./measures";
import type { MetricDailyRow } from "./write";

/**
 * One-time sales. An ORDER is a billed invoice (posted, payment due, not paid or paid) with no
 * subscription and at least one one-time line that is not a credit pack: a product sold on its
 * own, as a purchase checkout or a manual invoice raises it. Dated by the invoice's issue date.
 *
 * Order slices: `country` is the customer's country as it stands now (`none` when unset);
 * `gateway` the provider of the order's first succeeded payment (`none` while unpaid);
 * `coupon` the one coupon on its discounts (`manual`, `multiple`, `none`); `buyer_type` is
 * `returning` when the customer placed an order before this one.
 */
export { isOrder };
export const ORDER_SUMS = [
  "orders",
  "order_revenue",
  "order_refunds",
  "units_sold",
  "order_discount",
] as const;
export const ORDER_RATIOS = [
  "average_order_value",
  "order_refund_rate",
  "buyer_lifetime_revenue",
] as const;
/** Distinct buyers and their rate: computed at every grain, never summed. */
export const ORDER_PER_GRAIN = ["buyers", "returning_buyers", "returning_buyer_rate"] as const;
export const ORDER_MEASURES = [...ORDER_SUMS, ...ORDER_RATIOS, ...ORDER_PER_GRAIN] as const;

const ORDER_SLICES = ["country", "gateway", "coupon", "buyer_type"] as const;

export const ORDER_MEASURE_DIMS: Record<string, readonly DimensionId[]> = {
  orders: [...ORDER_SLICES],
  order_revenue: ["product", ...ORDER_SLICES],
  order_refunds: ["product"],
  units_sold: ["product"],
  order_discount: [],
  average_order_value: [],
  order_refund_rate: ["product"],
  buyer_lifetime_revenue: [],
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
  const inWindowOrder = sql`i.business_id = ${businessId}
    and i.created_at >= ${startsAt} and i.created_at < ${endsAt} and ${isOrder()}`;

  const docs = (await tx.execute(sql`
    select i.id, i.customer_id::text as customer, upper(i.currency) as currency,
      (i.created_at >= ${startsAt}) as current,
      exists (select 1 from invoices e where e.business_id = i.business_id
        and e.customer_id = i.customer_id and e.created_at < ${startsAt}
        and e.id <> i.id and ${orderRuleOn("e")}) as returning,
      exists (select 1 from invoices e where e.business_id = i.business_id
        and e.customer_id = i.customer_id and e.id <> i.id
        and (e.created_at < i.created_at or (e.created_at = i.created_at and e.id < i.id))
        and ${orderRuleOn("e")}) as repeat,
      coalesce(upper(c.country), 'none') as country
    from invoices i left join customers c on c.id = i.customer_id
    where i.business_id = ${businessId} and i.created_at < ${endsAt} and ${isOrder()}`)) as unknown as Array<{
    id: string;
    customer: string;
    currency: string;
    current: boolean;
    returning: boolean;
    repeat: boolean;
    country: string;
  }>;
  // Nothing ever sold this way by the period's end: no rows, not a wall of zeros.
  if (docs.length === 0) return [];

  const inWindow = docs.filter((d) => d.current);
  const folded = await billedRevenueByInvoice(
    tx,
    inWindow.map((d) => d.id),
  );
  const lifetime = await revenueTotalsByInvoice(
    tx,
    docs.map((d) => d.id),
  );

  const gateways = (await tx.execute(sql`
    select distinct on (p.invoice_id) p.invoice_id::text as invoice, p.provider_key as gateway
    from payments p join invoices i on i.id = p.invoice_id
    where ${inWindowOrder} and p.status = 'succeeded'
    order by p.invoice_id, p.created_at, p.id`)) as unknown as Array<{
    invoice: string;
    gateway: string;
  }>;
  const gatewayOf = new Map(gateways.map((g) => [g.invoice, g.gateway]));

  const coupons = (await tx.execute(sql`
    select d.invoice_id::text as invoice, coalesce(ac.coupon_id::text, 'manual') as coupon
    from invoice_line_discounts d join invoices i on i.id = d.invoice_id
    left join applied_coupons ac on ac.id = d.applied_coupon_id
    where ${inWindowOrder} and d.amount_minor <> 0
    group by 1, 2`)) as unknown as Array<{ invoice: string; coupon: string }>;
  const couponsOf = new Map<string, Set<string>>();
  for (const c of coupons) {
    const set = couponsOf.get(c.invoice) ?? new Set<string>();
    set.add(c.coupon);
    couponsOf.set(c.invoice, set);
  }
  const couponOf = (id: string) => {
    const set = couponsOf.get(id);
    if (!set || set.size === 0) return "none";
    return set.size === 1 ? [...set][0]! : "multiple";
  };

  const units = (await tx.execute(sql`
    select upper(i.currency) as currency, coalesce(pr.product_id::text, 'none') as product,
      coalesce(sum(l.quantity), 0)::text as units
    from invoice_line_items l join invoices i on i.id = l.invoice_id
    left join prices pr on pr.id = l.price_id
    where ${inWindowOrder} and l.kind = 'one_time'
      and coalesce(pr.grants_credit ->> 'kind', '') <> 'pack'
    group by 1, 2`)) as unknown as Array<{ currency: string; product: string; units: string }>;

  // Same rule as `discount_given`: not on an order a discount took to zero.
  const discounts = (await tx.execute(sql`
    select upper(i.currency) as currency, coalesce(sum(l.discount_minor), 0)::text as amount
    from invoice_line_items l join invoices i on i.id = l.invoice_id
    where ${inWindowOrder} and i.total_minor > 0
    group by 1`)) as unknown as Array<{ currency: string; amount: string }>;

  const refunds = (await tx.execute(sql`
    select i.id::text as invoice, upper(r.currency) as currency,
      coalesce(sum(r.amount_minor), 0)::text as amount,
      -- The total the invoice prints (promotional credit off), as cash was paid against it.
      (i.total_minor - i.promotional_credits_applied_minor - i.grant_credits_pre_tax_minor)::text as invoice_total
    from refunds r join payments p on p.id = r.payment_id join invoices i on i.id = p.invoice_id
    where r.business_id = ${businessId} and r.status = 'succeeded'
      and r.created_at >= ${startsAt} and r.created_at < ${endsAt} and ${isOrder()}
    group by i.id, upper(r.currency), i.total_minor, i.promotional_credits_applied_minor,
      i.grant_credits_pre_tax_minor`)) as unknown as Array<{
    invoice: string;
    currency: string;
    amount: string;
    invoice_total: string;
  }>;
  const refundedDocs = await billedRevenueByInvoice(tx, [
    ...new Set(refunds.map((r) => r.invoice)),
  ]);

  const acc = new Map<string, bigint>();
  const add = (measure: string, dim: string, value: string, currency: string, v: bigint) => {
    const k = `${measure}\u0000${dim}\u0000${value}\u0000${currency}`;
    acc.set(k, (acc.get(k) ?? 0n) + v);
  };
  const buyers = new Map<string, Set<string>>();
  const returning = new Map<string, Set<string>>();
  const everBuyers = new Map<string, Set<string>>();
  const everRevenue = new Map<string, bigint>();
  for (const currency of new Set(docs.map((d) => d.currency))) {
    for (const m of ORDER_SUMS) add(m, "", "", currency, 0n);
    buyers.set(currency, new Set());
    returning.set(currency, new Set());
    everBuyers.set(currency, new Set());
    everRevenue.set(currency, 0n);
  }
  for (const d of docs) {
    everBuyers.get(d.currency)!.add(d.customer);
    everRevenue.set(d.currency, everRevenue.get(d.currency)! + (lifetime.get(d.id) ?? 0n));
  }
  for (const d of inWindow) {
    const slices: Array<[string, string]> = [
      ["country", d.country],
      ["gateway", gatewayOf.get(d.id) ?? "none"],
      ["coupon", couponOf(d.id)],
      ["buyer_type", d.repeat ? "returning" : "first"],
    ];
    add("orders", "", "", d.currency, 1n);
    for (const [dim, v] of slices) add("orders", dim, v, d.currency, 1n);
    for (const l of folded.get(d.id)?.lines ?? []) {
      add("order_revenue", "", "", d.currency, l.amountMinor);
      add("order_revenue", "product", l.productId ?? "none", d.currency, l.amountMinor);
      for (const [dim, v] of slices) add("order_revenue", dim, v, d.currency, l.amountMinor);
    }
    buyers.get(d.currency)!.add(d.customer);
    if (d.returning) returning.get(d.currency)!.add(d.customer);
  }
  for (const u of units) {
    add("units_sold", "", "", u.currency, n(u.units));
    add("units_sold", "product", u.product, u.currency, n(u.units));
  }
  for (const d of discounts) add("order_discount", "", "", d.currency, n(d.amount));
  // The rate's numerator: each refund's pre-tax share, so it compares with pre-tax revenue.
  const pretaxRefunds = new Map<string, bigint>();
  const addPretax = (dim: string, value: string, currency: string, v: bigint) => {
    const k = `${dim}\u0000${value}\u0000${currency}`;
    pretaxRefunds.set(k, (pretaxRefunds.get(k) ?? 0n) + v);
  };
  for (const r of refunds) {
    const amount = n(r.amount);
    add("order_refunds", "", "", r.currency, amount);
    // Spread over the order's products by revenue, so the slices sum to the refund.
    const lines = refundedDocs.get(r.invoice)?.lines ?? [];
    const revenues = lines.map((l) => l.amountMinor);
    const shares = allocateProRata(amount, revenues);
    if (lines.length === 0 || shares.every((s) => s === 0n)) {
      add("order_refunds", "product", "none", r.currency, amount);
    } else {
      lines.forEach((l, i) =>
        add("order_refunds", "product", l.productId ?? "none", r.currency, shares[i]!),
      );
    }
    // Pre-tax share = refund x pre-tax revenue / invoice total, half-up to a minor unit.
    // A zero or missing total gives no basis to split, so the refund adds 0 to the rate.
    const total = n(r.invoice_total);
    const pretaxRevenue = revenues.reduce((s, v) => s + v, 0n);
    if (total <= 0n || pretaxRevenue <= 0n) continue;
    const pretax = (2n * amount * pretaxRevenue + total) / (2n * total);
    addPretax("", "", r.currency, pretax);
    const pretaxShares = allocateProRata(pretax, revenues);
    lines.forEach((l, i) =>
      addPretax("product", l.productId ?? "none", r.currency, pretaxShares[i]!),
    );
  }

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
  const get = (measure: string, dim: string, v: string, currency: string) =>
    acc.get(`${measure}\u0000${dim}\u0000${v}\u0000${currency}`) ?? 0n;
  // Refund rate by product: every product with revenue or refunds in the window.
  for (const k of acc.keys()) {
    const [measure, dim, v, currency] = k.split("\u0000") as [string, string, string, string];
    if (dim !== "product" || (measure !== "order_revenue" && measure !== "order_refunds")) continue;
    if (
      measure === "order_refunds" &&
      acc.has(`order_revenue\u0000product\u0000${v}\u0000${currency}`)
    )
      continue;
    rows.push({
      measure: "order_refund_rate",
      dim: "product",
      dimValue: v,
      currency,
      value: pretaxRefunds.get(`product\u0000${v}\u0000${currency}`) ?? 0n,
      denominator: get("order_revenue", "product", v, currency),
    });
  }
  for (const [currency, set] of buyers) {
    const orders = get("orders", "", "", currency);
    const revenue = get("order_revenue", "", "", currency);
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
      {
        measure: "order_refund_rate",
        dim: "",
        dimValue: "",
        currency,
        value: pretaxRefunds.get(`\u0000\u0000${currency}`) ?? 0n,
        denominator: revenue,
      },
      {
        measure: "buyer_lifetime_revenue",
        dim: "",
        dimValue: "",
        currency,
        value: everRevenue.get(currency)!,
        denominator: BigInt(everBuyers.get(currency)!.size),
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
