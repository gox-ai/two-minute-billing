import { sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import {
  EXCESS_PAYMENT,
  PROMOTIONAL_CREDIT,
  REFUNDABLE_CREDIT,
} from "@/modules/customers/balances-read";
import { horizonBand } from "./scheduled-measures";
import type { DimensionId } from "./measures";
import type { MetricDailyRow } from "./write";

/**
 * Prepaid and AI credits, per currency of the grant, from `credit_grant_movements` (append-only:
 * remaining = Σ movements, so every past day can be rebuilt). Money figures are FACE value
 * unless the name says cost; cost basis is what a paid grant was sold for.
 *
 * A pending grant has no movements, so it counts nowhere until it activates. Plan credits are
 * paid for by their recurring line: they show here as credit, never a second time as revenue.
 */
export const CREDIT_FLOWS = [
  "credits_granted",
  "credits_used",
  "credits_used_cost",
  "credits_expired",
  "credit_breakage",
  "credit_packs_sold",
] as const;
export const CREDIT_STOCKS = [
  "credits_outstanding",
  "credits_liability",
  "credit_customers",
  "prepaid_balance",
] as const;
/** As at the run only: days to expiry are measured from now. */
export const CREDIT_READINGS = ["credits_expiring"] as const;
export const CREDIT_MEASURES = [...CREDIT_FLOWS, ...CREDIT_STOCKS, ...CREDIT_READINGS] as const;

export const CREDIT_MEASURE_DIMS: Record<string, readonly DimensionId[]> = {
  credits_granted: ["credit_category", "credit_source"],
  credits_used: ["credit_category"],
  credits_used_cost: [],
  credits_expired: ["credit_category"],
  credit_breakage: [],
  credit_packs_sold: [],
  credits_outstanding: ["credit_category", "credit_unit"],
  credits_liability: [],
  credit_customers: [],
  prepaid_balance: [],
  credits_expiring: ["horizon"],
};

/** `credit_unit` value for a money grant (no unit). */
export const MONEY_UNIT = "money";

const n = (v: string | number | bigint | null | undefined): bigint => BigInt(v ?? 0);

export async function computeCreditMeasures(input: {
  tx: Tx;
  businessId: string;
  from: Date;
  toExclusive: Date;
  now: Date;
}): Promise<MetricDailyRow[]> {
  const { tx, businessId, from, toExclusive, now } = input;
  const startsAt = sql`${from.toISOString()}::timestamptz`;
  const endsAt = sql`${toExclusive.toISOString()}::timestamptz`;
  const reportable = (col: string) =>
    sql.raw(
      `not exists (select 1 from customers rx where rx.id = ${col} and rx.exclude_from_reporting)`,
    );

  // Movements by kind in the window, and the remaining stock at the period's end, in one read.
  const moved = (await tx.execute(sql`
    select upper(g.currency) as currency, g.category, g.source,
      coalesce(u.key, ${MONEY_UNIT}) as unit, m.kind,
      coalesce(sum(m.face_minor) filter (where m.created_at >= ${startsAt}), 0)::text as face_in,
      coalesce(sum(m.cost_minor) filter (where m.created_at >= ${startsAt}), 0)::text as cost_in,
      coalesce(sum(m.face_minor), 0)::text as face_all,
      coalesce(sum(m.cost_minor), 0)::text as cost_all
    from credit_grant_movements m
    join credit_grants g on g.id = m.grant_id
    left join credit_units u on u.id = g.unit_id
    where m.business_id = ${businessId} and m.created_at < ${endsAt}
      and ${reportable("g.customer_id")}
    group by 1, 2, 3, 4, 5`)) as unknown as Array<{
    currency: string;
    category: string;
    source: string;
    unit: string;
    kind: string;
    face_in: string;
    cost_in: string;
    face_all: string;
    cost_all: string;
  }>;

  const holders = (await tx.execute(sql`
    select currency, count(*)::text as customers from (
      select upper(g.currency) as currency, g.customer_id
      from credit_grant_movements m join credit_grants g on g.id = m.grant_id
      where m.business_id = ${businessId} and m.created_at < ${endsAt}
        and ${reportable("g.customer_id")}
      group by 1, 2 having sum(m.face_minor) > 0
    ) s group by currency`)) as unknown as Array<{ currency: string; customers: string }>;

  const packs = (await tx.execute(sql`
    select upper(i.currency) as currency, count(*)::text as lines
    from invoice_line_items li
    join invoices i on i.id = li.invoice_id
    join prices p on p.id = li.price_id
    where li.business_id = ${businessId} and li.kind = 'one_time'
      and p.grants_credit ->> 'kind' = 'pack'
      and i.status in ('posted', 'payment_due', 'not_paid', 'paid')
      and i.created_at >= ${startsAt} and i.created_at < ${endsAt}
      and ${reportable("i.customer_id")}
    group by 1`)) as unknown as Array<{ currency: string; lines: string }>;

  const prepaid = (await tx.execute(sql`
    select upper(currency) as currency,
      coalesce(sum(case when direction = 'credit' then amount_minor else -amount_minor end), 0)::text as balance
    from ledger_entries
    where business_id = ${businessId} and created_at < ${endsAt}
      and account in (${PROMOTIONAL_CREDIT}, ${REFUNDABLE_CREDIT}, ${EXCESS_PAYMENT})
      and (customer_id is null or ${reportable("customer_id")})
    group by 1`)) as unknown as Array<{ currency: string; balance: string }>;

  const reading = now >= from && now < toExclusive;
  const expiring = reading
    ? ((await tx.execute(sql`
        select upper(g.currency) as currency, g.expires_at, coalesce(sum(m.face_minor), 0)::text as face
        from credit_grants g join credit_grant_movements m on m.grant_id = g.id
        where g.business_id = ${businessId} and g.status = 'active'
          and ${reportable("g.customer_id")}
        group by g.id, 1, 2 having sum(m.face_minor) > 0`)) as unknown as Array<{
        currency: string;
        expires_at: string | Date | null;
        face: string;
      }>)
    : [];

  const held = new Set<string>([
    ...moved.map((r) => r.currency),
    ...prepaid.filter((r) => n(r.balance) !== 0n).map((r) => r.currency),
  ]);
  if (held.size === 0) return [];

  const acc = new Map<string, bigint>();
  const add = (measure: string, dim: string, value: string, currency: string, v: bigint) => {
    const k = `${measure}\u0000${dim}\u0000${value}\u0000${currency}`;
    acc.set(k, (acc.get(k) ?? 0n) + v);
  };
  for (const currency of held) {
    for (const m of [...CREDIT_FLOWS, ...CREDIT_STOCKS]) add(m, "", "", currency, 0n);
    if (reading) add("credits_expiring", "", "", currency, 0n);
  }

  for (const r of moved) {
    const c = r.currency;
    const faceIn = n(r.face_in);
    const costIn = n(r.cost_in);
    const paid = r.category === "paid";
    // New credit: a grant that became spendable (a restore or a rollover is not new).
    if (r.kind === "grant" || r.kind === "activate") {
      add("credits_granted", "", "", c, faceIn);
      add("credits_granted", "credit_category", r.category, c, faceIn);
      add("credits_granted", "credit_source", r.source, c, faceIn);
    }
    // Used, net of give-backs: a draw is negative, a restore hands part of one back.
    if (r.kind === "draw" || r.kind === "restore") {
      add("credits_used", "", "", c, -faceIn);
      add("credits_used", "credit_category", r.category, c, -faceIn);
      if (paid) add("credits_used_cost", "", "", c, -costIn);
    }
    if (r.kind === "expire") {
      add("credits_expired", "", "", c, -faceIn);
      add("credits_expired", "credit_category", r.category, c, -faceIn);
      if (paid) add("credit_breakage", "", "", c, -costIn);
    }
    const faceAll = n(r.face_all);
    add("credits_outstanding", "", "", c, faceAll);
    add("credits_outstanding", "credit_category", r.category, c, faceAll);
    add("credits_outstanding", "credit_unit", r.unit, c, faceAll);
    if (paid) add("credits_liability", "", "", c, n(r.cost_all));
  }
  for (const h of holders) add("credit_customers", "", "", h.currency, n(h.customers));
  for (const p of packs)
    if (held.has(p.currency)) add("credit_packs_sold", "", "", p.currency, n(p.lines));
  for (const p of prepaid)
    if (held.has(p.currency)) add("prepaid_balance", "", "", p.currency, n(p.balance));
  for (const e of expiring) {
    const at = e.expires_at == null ? null : new Date(e.expires_at);
    add("credits_expiring", "", "", e.currency, n(e.face));
    add("credits_expiring", "horizon", horizonBand(at, now), e.currency, n(e.face));
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
  return rows;
}
