import { sql, type SQL } from "drizzle-orm";
import { withTenant } from "@/platform/db";

/**
 * Usage margin (design G1b § 3.7, Decision B7): over meter usage lines of finalized invoices
 * (not voided) dated in [from, to), revenue = line amount − its discount − its credit notes,
 * before tax; margin = revenue − cost. A line with no full cost (null, partial, none, no
 * rate) is counted in `lines_without_cost` and left out of both sides. One SQL fold.
 */

export type MarginGroupBy = "customer" | "model" | "meter";
export const MARGIN_GROUP_BY: readonly MarginGroupBy[] = ["customer", "model", "meter"];

export interface MarginRow {
  /** Customer public id, model value or meter key; '' = a line with no model. */
  key: string;
  /** Grouped by customer: the name, else the email. */
  name?: string | null;
  currency: string;
  revenueMinor: bigint;
  costMinor: bigint;
  marginMinor: bigint;
  /** Margin ÷ revenue × 100, 2 dp as text; null when revenue is 0. */
  marginPercent: string | null;
  lines: number;
  linesWithoutCost: number;
}

export interface MarginReport {
  rows: MarginRow[];
  /** One per currency: currencies are never summed together. */
  totals: Array<Omit<MarginRow, "key">>;
}

/** Cost bases a margin counts: the whole quantity had a cost. */
const FULL_COST = sql`('event', 'price_list', 'mixed')`;

export async function usageMargin(input: {
  organizationId: string;
  businessId: string;
  from: Date;
  to: Date;
  groupBy: MarginGroupBy;
  currency?: string;
  customerId?: string;
}): Promise<MarginReport> {
  const key: SQL =
    input.groupBy === "customer"
      ? sql`c.public_id`
      : input.groupBy === "meter"
        ? sql`m.key`
        : // The group value under the meter's model key (price_list.model_key, default "model").
          sql`coalesce(li.rating -> 'group' ->> (array_position(
              array(select jsonb_array_elements_text(li.rating -> 'group_by')),
              coalesce(m.price_list ->> 'model_key', 'model')) - 1), '')`;
  const rows = (await withTenant(input.organizationId, (tx) =>
    tx.execute(sql`
      with l as (
        select ${key} as k,
          ${input.groupBy === "customer" ? sql`coalesce(nullif(c.name, ''), c.email)` : sql`null::text`} as name,
          i.currency::text as currency,
          li.amount_minor - coalesce(li.discount_minor, 0)
            - coalesce((
                select sum(ci.amount_minor) from credit_note_items ci
                join credit_notes cn on cn.id = ci.credit_note_id
                where ci.invoice_line_item_id = li.id and cn.status <> 'voided'
                  and coalesce(ci.kind, '') <> 'tax'), 0)
            -- An inclusive price holds its tax inside the amount: take it out.
            - case when p.tax_behavior = 'inclusive' then coalesce((
                select sum(t.amount_minor) from applied_taxes t
                where t.invoice_line_item_id = li.id), 0) else 0 end as revenue,
          li.cost_minor,
          (li.cost_minor is not null and li.cost_basis in ${FULL_COST}) as costed
        from invoice_line_items li
        join invoices i on i.id = li.invoice_id
        join customers c on c.id = i.customer_id
        join meters m on m.id = (li.rating ->> 'meter')::uuid
        left join prices p on p.id = li.price_id
        where li.business_id = ${input.businessId} and i.business_id = ${input.businessId}
          and not c.exclude_from_reporting
          and li.kind = 'usage' and li.rating ? 'meter'
          and i.status not in ('pending', 'voided')
          and coalesce(i.finalized_at, i.created_at) >= ${input.from.toISOString()}::timestamptz
          and coalesce(i.finalized_at, i.created_at) < ${input.to.toISOString()}::timestamptz
          ${input.currency ? sql`and i.currency = ${input.currency}` : sql``}
          ${input.customerId ? sql`and i.customer_id = ${input.customerId}` : sql``}
      )
      select k, max(name) as name, currency,
        coalesce(sum(revenue) filter (where costed), 0)::text as revenue,
        coalesce(sum(cost_minor) filter (where costed), 0)::text as cost,
        count(*)::int as lines,
        (count(*) filter (where not costed))::int as without_cost,
        grouping(k)::int as total
      from l
      group by grouping sets ((k, currency), (currency))
      order by total, currency, k`),
  )) as unknown as Array<{
    k: string | null;
    name: string | null;
    currency: string;
    revenue: string;
    cost: string;
    lines: number;
    without_cost: number;
    total: number;
  }>;
  const toRow = (r: (typeof rows)[number]): MarginRow => {
    const revenue = BigInt(r.revenue);
    const cost = BigInt(r.cost);
    const margin = revenue - cost;
    return {
      key: r.k ?? "",
      ...(input.groupBy === "customer" ? { name: r.name } : {}),
      currency: r.currency,
      revenueMinor: revenue,
      costMinor: cost,
      marginMinor: margin,
      marginPercent: revenue === 0n ? null : percent2dp(margin, revenue),
      lines: r.lines,
      linesWithoutCost: r.without_cost,
    };
  };
  return {
    rows: rows.filter((r) => r.total === 0).map(toRow),
    totals: rows
      .filter((r) => r.total === 1)
      .map((r) => {
        const { key: _k, name: _n, ...rest } = toRow(r);
        return rest;
      }),
  };
}

/** a ÷ b × 100, half-up to 2 dp, as text ("-12.50"). */
export function percent2dp(a: bigint, b: bigint): string {
  const neg = a < 0n !== b < 0n && a !== 0n;
  const n = (a < 0n ? -a : a) * 10_000n;
  const d = b < 0n ? -b : b;
  const q = (n * 2n + d) / (2n * d);
  return `${neg ? "-" : ""}${q / 100n}.${String(q % 100n).padStart(2, "0")}`;
}

export function serializeMarginReport(r: MarginReport, groupBy: MarginGroupBy) {
  const row = (x: Omit<MarginRow, "key">) => ({
    currency: x.currency,
    revenue_minor: Number(x.revenueMinor),
    cost_minor: Number(x.costMinor),
    margin_minor: Number(x.marginMinor),
    margin_percent: x.marginPercent,
    lines: x.lines,
    lines_without_cost: x.linesWithoutCost,
  });
  return {
    object: "usage_margin" as const,
    group_by: groupBy,
    data: r.rows.map((x) => ({
      [groupBy]: x.key,
      ...(groupBy === "customer" ? { customer_name: x.name ?? null } : {}),
      ...row(x),
    })),
    totals: r.totals.map(row),
  };
}
