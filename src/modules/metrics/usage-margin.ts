import { sql, type SQL } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { billedRevenueByInvoice } from "@/modules/payments/attribution";
import { accountHolderNameSql } from "@/modules/customers/name-sql";
import { planProductJoin } from "./plan-of";

/**
 * Usage margin (design G1b § 3.7, Decision B7): over meter usage lines of finalized invoices
 * (not voided) dated in [from, to), revenue = line amount − its discount − its credit notes
 * − the free credit that paid it (promotional, plan credits, a pack's bonus), before tax;
 * margin = revenue − cost. Usage a paid pack paid keeps the pack's cost as revenue here: the
 * pack's money earned it, though `revenue_billed` counted that money at the sale. A line with no full cost (null, partial, none, no
 * rate) is counted in `lines_without_cost` and left out of both sides. One SQL fold.
 *
 * `scope: "all"` adds usage no invoice line bills (cost only, from `usage_cost_daily`) and, by
 * customer and plan, every revenue line. A fold row is cost only when (a) no usage line of a
 * non-voided invoice of that customer rated that meter over a window that overlaps its day,
 * and (b) no live subscription will bill it: the meter's owner (`customer_meter_billing`) is
 * not cancelled, has a price on the meter from an item created before the day ended, and has
 * not billed through the day's end. Both read facts at query time, so a void or a new invoice
 * moves a day between the sides by itself. A day a line only partly overlaps counts as billed.
 */

export type MarginGroupBy = "customer" | "model" | "meter" | "plan";
export const MARGIN_GROUP_BY: readonly MarginGroupBy[] = ["customer", "model", "meter", "plan"];
export type MarginScope = "billed" | "all";
export const MARGIN_SCOPES: readonly MarginScope[] = ["billed", "all"];

/** Figures `scope: "all"` adds. */
export interface MarginAllFigures {
  /** Every revenue line by customer or plan; every usage line by meter or model. */
  totalRevenueMinor: bigint;
  /** Usage no invoice line bills, with a full cost. */
  costOnlyMinor: bigint;
  /** Customer × meter × group values × day rows of that usage. */
  costOnlyRows: number;
  costOnlyRowsWithoutCost: number;
  /** cost + costOnly. */
  totalCostMinor: bigint;
  totalMarginMinor: bigint;
  totalMarginPercent: string | null;
  /** By plan: recurring and proration lines of plan products. */
  planFeeMinor?: bigint;
  /** By plan: customers with a subscription on the plan live in the range. */
  subscribers?: number;
}

export interface MarginRow {
  /** Customer public id, model value, meter key or plan product id; '' = none. */
  key: string;
  /** Grouped by customer: the name, else the email. By plan: the product name. By meter: the meter name. */
  name?: string | null;
  currency: string;
  revenueMinor: bigint;
  costMinor: bigint;
  marginMinor: bigint;
  /** Margin ÷ revenue × 100, 2 dp as text; null when revenue is 0. */
  marginPercent: string | null;
  lines: number;
  linesWithoutCost: number;
  all?: MarginAllFigures;
}

export interface MarginReport {
  rows: MarginRow[];
  /** One per currency: currencies are never summed together. */
  totals: Array<Omit<MarginRow, "key">>;
}

/** Cost bases a margin counts: the whole quantity had a cost. */
const FULL_COST = sql`('event', 'price_list', 'mixed')`;
/** Line kinds that are revenue (`revenue_billed`): tax, rounding and the discount line are not. */
const REVENUE_KINDS = sql`('recurring', 'proration', 'usage', 'one_time')`;

interface Input {
  organizationId: string;
  businessId: string;
  from: Date;
  to: Date;
  groupBy: MarginGroupBy;
  scope?: MarginScope;
  currency?: string;
  customerId?: string;
}

/**
 * A line's revenue: amount − discount − its credit notes − the free credit on it, before tax.
 * `free` is a jsonb object of line id → minor units (`freeCreditByLine`).
 */
const lineRevenue = (free: SQL) => sql`li.amount_minor - coalesce(li.discount_minor, 0)
  - coalesce((
      select sum(ci.amount_minor) from credit_note_items ci
      join credit_notes cn on cn.id = ci.credit_note_id
      where ci.invoice_line_item_id = li.id and cn.status <> 'voided'
        and coalesce(ci.kind, '') <> 'tax'), 0)
  -- An inclusive price holds its tax inside the amount: take it out.
  - case when p.tax_behavior = 'inclusive' then coalesce((
      select sum(t.amount_minor) from applied_taxes t
      where t.invoice_line_item_id = li.id), 0) else 0 end
  - coalesce((${free}::jsonb ->> li.id::text)::bigint, 0)`;

/**
 * Promotional credit, plan credits and pack bonus per line, from the one billed-revenue rule
 * (`billedRevenueByInvoice`), for the invoices the margin reads. Only non-zero lines are kept.
 */
async function freeCreditByLine(tx: Tx, input: Input, usageOnly: boolean): Promise<SQL> {
  const docs = (await tx.execute(sql`
    select i.id from invoices i join customers c on c.id = i.customer_id
    where i.business_id = ${input.businessId} and not c.exclude_from_reporting
      and i.status not in ('pending', 'voided')
      and coalesce(i.finalized_at, i.created_at) >= ${input.from.toISOString()}::timestamptz
      and coalesce(i.finalized_at, i.created_at) < ${input.to.toISOString()}::timestamptz
      and (i.promotional_credits_applied_minor <> 0 or i.grant_credits_pre_tax_minor <> 0
        or i.grant_credits_post_tax_minor <> 0)
      ${input.currency ? sql`and i.currency = ${input.currency}` : sql``}
      ${input.customerId ? sql`and i.customer_id = ${input.customerId}` : sql``}
      ${usageOnly ? sql`and exists (select 1 from invoice_line_items u where u.invoice_id = i.id and u.kind = 'usage')` : sql``}`)) as unknown as Array<{
    id: string;
  }>;
  const free: Record<string, string> = {};
  const folded = await billedRevenueByInvoice(
    tx,
    docs.map((d) => d.id),
  );
  for (const f of folded.values()) {
    for (const l of f.lines) {
      const v = l.deductions.promotional_credit + l.deductions.plan_credit;
      if (v !== 0n) free[l.lineItemId] = v.toString();
    }
  }
  return sql`${JSON.stringify(free)}`;
}

/** The model value of a usage line: the group value under the meter's model key. */
const lineModel = sql`coalesce(li.rating -> 'group' ->> (array_position(
    array(select jsonb_array_elements_text(li.rating -> 'group_by')),
    coalesce(m.price_list ->> 'model_key', 'model')) - 1), '')`;

/**
 * The name the customer lists show (`accountHolderName`): first + last, then company, then
 * the email. `accountHolderNameSql` names the unaliased table, hence the subquery on `c.id`.
 */
const customerName = sql`coalesce(
  (select ${accountHolderNameSql} from customers where customers.id = c.id), c.email)`;

/** Rows by name (else key), case-insensitive; the "none" row ('') last. */
const rowOrder = sql`order by total, currency, (k is null or k = ''), lower(coalesce(max(name), k)), k`;

export async function usageMargin(input: Input): Promise<MarginReport> {
  return (input.scope ?? "billed") === "all" ? usageMarginAll(input) : usageMarginBilled(input);
}

async function usageMarginBilled(input: Input): Promise<MarginReport> {
  const key: SQL =
    input.groupBy === "customer"
      ? sql`c.public_id`
      : input.groupBy === "meter"
        ? sql`m.key`
        : input.groupBy === "plan"
          ? sql`coalesce(pl.public_id, '')`
          : // The group value under the meter's model key (price_list.model_key, default "model").
            lineModel;
  const name: SQL =
    input.groupBy === "customer"
      ? customerName
      : input.groupBy === "plan"
        ? sql`pl.name`
        : input.groupBy === "meter"
          ? sql`m.name`
          : sql`null::text`;
  const rows = (await withTenant(input.organizationId, async (tx) =>
    tx.execute(sql`
      with l as (
        select ${key} as k,
          ${name} as name,
          i.currency::text as currency,
          ${lineRevenue(await freeCreditByLine(tx, input, true))} as revenue,
          li.cost_minor,
          (li.cost_minor is not null and li.cost_basis in ${FULL_COST}) as costed
        from invoice_line_items li
        join invoices i on i.id = li.invoice_id
        join customers c on c.id = i.customer_id
        join meters m on m.id = (li.rating ->> 'meter')::uuid
        left join prices p on p.id = li.price_id
        ${input.groupBy === "plan" ? planProductJoin(sql`i.subscription_id`, "pl") : sql``}
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
      ${rowOrder}`),
  )) as unknown as RawRow[];
  return assemble(rows, input.groupBy, false);
}

async function usageMarginAll(input: Input): Promise<MarginReport> {
  const g = input.groupBy;
  const byPayer = g === "customer" || g === "plan";
  const from = sql`${input.from.toISOString()}::timestamptz`;
  const to = sql`${input.to.toISOString()}::timestamptz`;
  const invoiceIn = sql`li.business_id = ${input.businessId} and i.business_id = ${input.businessId}
    and not c.exclude_from_reporting
    and i.status not in ('pending', 'voided')
    and coalesce(i.finalized_at, i.created_at) >= ${from}
    and coalesce(i.finalized_at, i.created_at) < ${to}
    ${input.currency ? sql`and i.currency = ${input.currency}` : sql``}
    ${input.customerId ? sql`and i.customer_id = ${input.customerId}` : sql``}`;
  const planKey = sql`coalesce(pl.public_id, '')`;
  const lineKey: SQL =
    g === "customer"
      ? sql`c.public_id`
      : g === "meter"
        ? sql`m.key`
        : g === "plan"
          ? planKey
          : lineModel;
  const foldKey: SQL =
    g === "customer"
      ? sql`c.public_id`
      : g === "meter"
        ? sql`m.key`
        : g === "plan"
          ? planKey
          : sql`d.model`;
  const nameOf: SQL =
    g === "customer"
      ? customerName
      : g === "plan"
        ? sql`pl.name`
        : g === "meter"
          ? sql`m.name`
          : sql`null::text`;
  const plan = (col: SQL) => (g === "plan" ? planProductJoin(col, "pl") : sql``);
  const z = sql`0::bigint`;

  const rows = (await withTenant(input.organizationId, async (tx) => {
    const free = await freeCreditByLine(tx, input, !byPayer);
    return tx.execute(sql`
      with u as (
        select ${lineKey} as k, ${nameOf} as name, i.currency::text as currency,
          ${lineRevenue(free)} as revenue, li.cost_minor,
          (li.cost_minor is not null and li.cost_basis in ${FULL_COST}) as costed
        from invoice_line_items li
        join invoices i on i.id = li.invoice_id
        join customers c on c.id = i.customer_id
        join meters m on m.id = (li.rating ->> 'meter')::uuid
        left join prices p on p.id = li.price_id
        ${plan(sql`i.subscription_id`)}
        where ${invoiceIn} and li.kind = 'usage' and li.rating ? 'meter'
      ),
      r as (
        select ${byPayer ? lineKey : sql`''::text`} as k, ${byPayer ? nameOf : sql`null::text`} as name, i.currency::text as currency,
          ${lineRevenue(free)} as revenue,
          (li.kind in ('recurring', 'proration') and prd.kind = 'plan') as plan_fee
        from invoice_line_items li
        join invoices i on i.id = li.invoice_id
        join customers c on c.id = i.customer_id
        left join prices p on p.id = li.price_id
        left join products prd on prd.id = p.product_id
        ${plan(sql`i.subscription_id`)}
        where ${invoiceIn} and li.kind in ${REVENUE_KINDS}
          ${byPayer ? sql`` : sql`and false`}
      ),
      co as (
        select ${foldKey} as k, ${nameOf} as name, d.currency::text as currency, d.cost_minor,
          (d.cost_minor is not null and d.cost_basis in ${FULL_COST}) as costed
        from usage_cost_daily d
        join customers c on c.id = d.customer_id
        join meters m on m.id = d.meter_id
        ${plan(sql`d.subscription_id`)}
        where d.business_id = ${input.businessId} and not c.exclude_from_reporting
          and d.starts_at >= ${from} and d.starts_at < ${to}
          ${input.currency ? sql`and d.currency = ${input.currency}` : sql``}
          ${input.customerId ? sql`and d.customer_id = ${input.customerId}` : sql``}
          -- (a) no usage line of a live invoice covers the day.
          and not exists (
            select 1 from invoices bi
            join invoice_line_items bl on bl.invoice_id = bi.id
            where bi.business_id = ${input.businessId} and bi.customer_id = d.customer_id
              and bi.status <> 'voided' and bl.kind = 'usage'
              and bl.rating ->> 'meter' = d.meter_id::text
              and coalesce((bl.rating -> 'window' ->> 'start')::timestamptz, bl.period_start) < d.ends_at
              and coalesce((bl.rating -> 'window' ->> 'end')::timestamptz, bl.period_end) > d.starts_at)
          -- (b) no live subscription will bill it.
          and not exists (
            select 1 from customer_meter_billing cmb
            join subscriptions s on s.id = cmb.subscription_id
            where cmb.customer_id = d.customer_id and cmb.meter_id = d.meter_id
              and s.status <> 'cancelled' and s.deleted_at is null
              and (cmb.usage_through is null or cmb.usage_through < d.ends_at)
              and exists (
                select 1 from subscription_items si join prices sp on sp.id = si.price_id
                where si.subscription_id = s.id and sp.meter_id = d.meter_id
                  and si.created_at < d.ends_at))
      ),
      s as (
        select ${planKey} as k, pl.name as name, upper(s.currency) as currency, s.customer_id
        from subscriptions s
        join customers c on c.id = s.customer_id
        ${planProductJoin(sql`s.id`, "pl")}
        where ${g === "plan" ? sql`true` : sql`false`}
          and s.business_id = ${input.businessId} and s.deleted_at is null
          and not c.exclude_from_reporting and s.status <> 'future'
          and coalesce(s.started_at, s.start_date, s.created_at) < ${to}
          and (s.canceled_at is null or s.canceled_at > ${from})
          ${input.currency ? sql`and upper(s.currency) = ${input.currency}` : sql``}
          ${input.customerId ? sql`and s.customer_id = ${input.customerId}` : sql``}
      ),
      x as (
        select k, name, currency,
          case when costed then revenue else ${z} end as revenue,
          case when costed then cost_minor else ${z} end as cost,
          1 as line, case when costed then 0 else 1 end as line_wo,
          ${byPayer ? z : sql`revenue`} as total_revenue, ${z} as plan_fee,
          ${z} as co_cost, 0 as co_row, 0 as co_wo, null::uuid as subscriber
        from u
        union all
        select k, name, currency, ${z}, ${z}, 0, 0, revenue,
          case when plan_fee then revenue else ${z} end, ${z}, 0, 0, null
        from r
        union all
        select k, name, currency, ${z}, ${z}, 0, 0, ${z}, ${z},
          case when costed then cost_minor else ${z} end, 1, case when costed then 0 else 1 end, null
        from co
        union all
        select k, name, currency, ${z}, ${z}, 0, 0, ${z}, ${z}, ${z}, 0, 0, customer_id
        from s
      )
      select k, max(name) as name, currency,
        coalesce(sum(revenue), 0)::text as revenue,
        coalesce(sum(cost), 0)::text as cost,
        sum(line)::int as lines,
        sum(line_wo)::int as without_cost,
        coalesce(sum(total_revenue), 0)::text as total_revenue,
        coalesce(sum(plan_fee), 0)::text as plan_fee,
        coalesce(sum(co_cost), 0)::text as co_cost,
        sum(co_row)::int as co_rows,
        sum(co_wo)::int as co_without_cost,
        count(distinct subscriber)::int as subscribers,
        grouping(k)::int as total
      from x
      group by grouping sets ((k, currency), (currency))
      ${rowOrder}`);
  })) as unknown as RawRow[];
  return assemble(rows, g, true);
}

interface RawRow {
  k: string | null;
  name: string | null;
  currency: string;
  revenue: string;
  cost: string;
  lines: number;
  without_cost: number;
  total_revenue?: string;
  plan_fee?: string;
  co_cost?: string;
  co_rows?: number;
  co_without_cost?: number;
  subscribers?: number;
  total: number;
}

function assemble(rows: RawRow[], groupBy: MarginGroupBy, all: boolean): MarginReport {
  const named = groupBy === "customer" || groupBy === "plan" || groupBy === "meter";
  const toRow = (r: RawRow): MarginRow => {
    const revenue = BigInt(r.revenue);
    const cost = BigInt(r.cost);
    const margin = revenue - cost;
    const out: MarginRow = {
      key: r.k ?? "",
      ...(named ? { name: r.name } : {}),
      currency: r.currency,
      revenueMinor: revenue,
      costMinor: cost,
      marginMinor: margin,
      marginPercent: revenue === 0n ? null : percent2dp(margin, revenue),
      lines: r.lines,
      linesWithoutCost: r.without_cost,
    };
    if (all) {
      const totalRevenue = BigInt(r.total_revenue ?? "0");
      const costOnly = BigInt(r.co_cost ?? "0");
      const totalCost = cost + costOnly;
      const totalMargin = totalRevenue - totalCost;
      out.all = {
        totalRevenueMinor: totalRevenue,
        costOnlyMinor: costOnly,
        costOnlyRows: r.co_rows ?? 0,
        costOnlyRowsWithoutCost: r.co_without_cost ?? 0,
        totalCostMinor: totalCost,
        totalMarginMinor: totalMargin,
        totalMarginPercent: totalRevenue === 0n ? null : percent2dp(totalMargin, totalRevenue),
        ...(groupBy === "plan"
          ? { planFeeMinor: BigInt(r.plan_fee ?? "0"), subscribers: r.subscribers ?? 0 }
          : {}),
      };
    }
    return out;
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

export function serializeMarginReport(
  r: MarginReport,
  groupBy: MarginGroupBy,
  scope: MarginScope = "billed",
) {
  const row = (x: Omit<MarginRow, "key">) => ({
    currency: x.currency,
    revenue_minor: Number(x.revenueMinor),
    cost_minor: Number(x.costMinor),
    margin_minor: Number(x.marginMinor),
    margin_percent: x.marginPercent,
    lines: x.lines,
    lines_without_cost: x.linesWithoutCost,
    ...(x.all
      ? {
          total_revenue_minor: Number(x.all.totalRevenueMinor),
          cost_only_minor: Number(x.all.costOnlyMinor),
          cost_only_rows: x.all.costOnlyRows,
          cost_only_rows_without_cost: x.all.costOnlyRowsWithoutCost,
          total_cost_minor: Number(x.all.totalCostMinor),
          total_margin_minor: Number(x.all.totalMarginMinor),
          total_margin_percent: x.all.totalMarginPercent,
          ...(x.all.planFeeMinor != null ? { plan_fee_minor: Number(x.all.planFeeMinor) } : {}),
          ...(x.all.subscribers != null ? { subscribers: x.all.subscribers } : {}),
        }
      : {}),
  });
  return {
    object: "usage_margin" as const,
    group_by: groupBy,
    scope,
    data: r.rows.map((x) => ({
      [groupBy]: x.key,
      ...(groupBy === "customer" ? { customer_name: x.name ?? null } : {}),
      ...(groupBy === "plan" ? { plan_name: x.name ?? null } : {}),
      ...(groupBy === "meter" ? { meter_name: x.name ?? null } : {}),
      ...row(x),
    })),
    totals: r.totals.map(row),
  };
}
