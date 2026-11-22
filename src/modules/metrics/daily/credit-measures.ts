import { sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import {
  EXCESS_PAYMENT,
  PROMOTIONAL_CREDIT,
  REFUNDABLE_CREDIT,
} from "@/modules/customers/balances-read";
import { horizonBand } from "./scheduled-measures";
import { RUNWAY_AMOUNT, RUNWAY_POOL } from "./credit-runway";
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
  "credit_units_granted",
  "credit_units_used",
  "credit_units_expired",
] as const;
export const CREDIT_STOCKS = [
  "credits_outstanding",
  "credits_liability",
  "credit_customers",
  "prepaid_balance",
  "credit_units_outstanding",
] as const;
/** As at the run only: days to expiry and the last 7 days' use are measured from now. */
export const CREDIT_READINGS = [
  "credits_expiring",
  "credit_runway_customers",
  "credit_units_expiring",
] as const;
/** Two halves, read at the period's end. */
export const CREDIT_RATIOS = ["credit_burn_rate"] as const;
export const CREDIT_MEASURES = [
  ...CREDIT_FLOWS,
  ...CREDIT_STOCKS,
  ...CREDIT_READINGS,
  ...CREDIT_RATIOS,
] as const;
/**
 * Credit in a unit with no money rate, in the unit's smallest step. Its money face value is 0,
 * so the money measures cannot see it. Stored under `XXX`, sliced by `credit_unit`.
 */
export const CREDIT_UNIT_MEASURES = [
  "credit_units_granted",
  "credit_units_used",
  "credit_units_expired",
  "credit_units_outstanding",
  "credit_units_expiring",
] as const;
const UNIT_SET = new Set<string>(CREDIT_UNIT_MEASURES);
/** Customer counts and units with no currency: stored under `XXX`. */
export const CREDIT_NO_CURRENCY = new Set<string>([
  "credit_runway_customers",
  ...CREDIT_UNIT_MEASURES,
]);

/** The trailing window the burn rate averages over. */
const BURN_DAYS = 30;
/** `credit_runway_days` (customers/service.ts) averages the last 7 days of draws. */
const RUNWAY_DAYS = 7;

/** A runway in days (rounded to 0.1, as the customer field) as its band. */
export function runwayBand(days: number | null): string {
  if (days == null) return "no_recent_use";
  if (days <= 7) return "0_7";
  if (days <= 30) return "8_30";
  if (days <= 90) return "31_90";
  return "90_plus";
}

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
  credit_runway_customers: ["runway_band"],
  credit_burn_rate: [],
  credit_units_granted: ["credit_unit", "credit_source"],
  credit_units_used: ["credit_unit"],
  credit_units_expired: ["credit_unit"],
  credit_units_outstanding: ["credit_unit"],
  credit_units_expiring: ["credit_unit", "horizon"],
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
      coalesce(u.key, ${MONEY_UNIT}) as unit, m.kind, g.unit_rated as rated,
      coalesce(sum(m.face_minor) filter (where m.created_at >= ${startsAt}), 0)::text as face_in,
      coalesce(sum(m.cost_minor) filter (where m.created_at >= ${startsAt}), 0)::text as cost_in,
      coalesce(sum(m.units) filter (where m.created_at >= ${startsAt}), 0)::text as units_in,
      coalesce(sum(m.face_minor), 0)::text as face_all,
      coalesce(sum(m.cost_minor), 0)::text as cost_all,
      coalesce(sum(m.units), 0)::text as units_all
    from credit_grant_movements m
    join credit_grants g on g.id = m.grant_id
    left join credit_units u on u.id = g.unit_id
    where m.business_id = ${businessId} and m.created_at < ${endsAt}
      and ${reportable("g.customer_id")}
    group by 1, 2, 3, 4, 5, 6`)) as unknown as Array<{
    currency: string;
    category: string;
    source: string;
    unit: string;
    kind: string;
    rated: boolean;
    face_in: string;
    cost_in: string;
    units_in: string;
    face_all: string;
    cost_all: string;
    units_all: string;
  }>;

  // A holder of credit with no money rate holds units, not face value.
  const holders = (await tx.execute(sql`
    select currency, count(*)::text as customers from (
      select upper(g.currency) as currency, g.customer_id
      from credit_grant_movements m join credit_grants g on g.id = m.grant_id
      where m.business_id = ${businessId} and m.created_at < ${endsAt}
        and ${reportable("g.customer_id")}
      group by 1, 2
      having sum(m.face_minor) > 0
        or coalesce(sum(m.units) filter (where not g.unit_rated), 0) > 0
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
        select upper(g.currency) as currency, g.expires_at, g.unit_rated as rated,
          coalesce(u.key, ${MONEY_UNIT}) as unit,
          coalesce(sum(m.face_minor), 0)::text as face, coalesce(sum(m.units), 0)::text as units
        from credit_grants g join credit_grant_movements m on m.grant_id = g.id
        left join credit_units u on u.id = g.unit_id
        where g.business_id = ${businessId} and g.status = 'active'
          and ${reportable("g.customer_id")}
        group by g.id, 1, 2, 3, 4
        having sum(m.face_minor) > 0 or (not g.unit_rated and sum(m.units) > 0)`)) as unknown as Array<{
        currency: string;
        expires_at: string | Date | null;
        rated: boolean;
        unit: string;
        face: string;
        units: string;
      }>)
    : [];

  // Used in the 30 days up to the period's end: draws, less restores (the `credits_used` rule).
  const burnFrom = new Date(toExclusive.getTime() - BURN_DAYS * 86_400_000).toISOString();
  const burned = (await tx.execute(sql`
    select upper(g.currency) as currency, coalesce(-sum(m.face_minor), 0)::text as used
    from credit_grant_movements m join credit_grants g on g.id = m.grant_id
    where m.business_id = ${businessId} and m.kind in ('draw', 'restore')
      and m.created_at >= ${burnFrom}::timestamptz and m.created_at < ${endsAt}
      and ${reportable("g.customer_id")}
    group by 1`)) as unknown as Array<{ currency: string; used: string }>;

  // The customer field's rule (`credit-runway.ts`): per pool, active balance × 7 ÷ draws
  // in the last 7 days, to 0.1 day; the customer's runway is the pool that runs out first.
  const runway = reading
    ? ((await tx.execute(sql`
        select min(case when used > 0 then round(bal * ${sql.raw(`${RUNWAY_DAYS}.0`)} / used, 1) end)::text as days
        from (
          select g.customer_id, ${RUNWAY_POOL} as pool,
            coalesce(sum(${RUNWAY_AMOUNT}) filter (where g.status = 'active'), 0) as bal,
            coalesce(-sum(${RUNWAY_AMOUNT}) filter (where m.kind = 'draw'
              and m.created_at > ${now.toISOString()}::timestamptz - make_interval(days => ${sql.raw(String(RUNWAY_DAYS))})), 0) as used
          from credit_grant_movements m join credit_grants g on g.id = m.grant_id
          where g.business_id = ${businessId} and ${reportable("g.customer_id")}
          group by 1, 2
        ) s
        where bal > 0 or used > 0
        group by customer_id`)) as unknown as Array<{ days: string | null }>)
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
    for (const m of [...CREDIT_FLOWS, ...CREDIT_STOCKS])
      if (!UNIT_SET.has(m)) add(m, "", "", currency, 0n);
    if (reading) add("credits_expiring", "", "", currency, 0n);
  }

  // Units with no money rate. A headline across units adds unlike things, so the total and
  // the other slices are written only while the business has one such unit.
  const unitKeys = new Set(moved.filter((r) => !r.rated).map((r) => r.unit));
  const oneUnit = unitKeys.size === 1;
  const addUnits = (measure: string, unit: string, v: bigint, slice?: [string, string]) => {
    add(measure, "credit_unit", unit, "XXX", v);
    if (!oneUnit) return;
    add(measure, "", "", "XXX", v);
    if (slice) add(measure, slice[0], slice[1], "XXX", v);
  };
  for (const unit of unitKeys) {
    for (const m of [
      "credit_units_granted",
      "credit_units_used",
      "credit_units_expired",
      "credit_units_outstanding",
    ])
      addUnits(m, unit, 0n);
    if (reading) addUnits("credit_units_expiring", unit, 0n);
  }
  for (const r of moved) {
    if (r.rated) continue;
    const unitsIn = n(r.units_in);
    if (r.kind === "grant" || r.kind === "activate")
      addUnits("credit_units_granted", r.unit, unitsIn, ["credit_source", r.source]);
    if (r.kind === "draw" || r.kind === "restore") addUnits("credit_units_used", r.unit, -unitsIn);
    if (r.kind === "expire") addUnits("credit_units_expired", r.unit, -unitsIn);
    addUnits("credit_units_outstanding", r.unit, n(r.units_all));
  }
  for (const e of expiring) {
    if (e.rated) continue;
    const at = e.expires_at == null ? null : new Date(e.expires_at);
    addUnits("credit_units_expiring", e.unit, n(e.units), ["horizon", horizonBand(at, now)]);
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
    // A unit with no money rate has no face value: its balance is in `credit_units_outstanding`.
    if (r.rated) add("credits_outstanding", "credit_unit", r.unit, c, faceAll);
    if (paid) add("credits_liability", "", "", c, n(r.cost_all));
  }
  for (const h of holders) add("credit_customers", "", "", h.currency, n(h.customers));
  for (const p of packs)
    if (held.has(p.currency)) add("credit_packs_sold", "", "", p.currency, n(p.lines));
  for (const p of prepaid)
    if (held.has(p.currency)) add("prepaid_balance", "", "", p.currency, n(p.balance));
  for (const e of expiring) {
    if (!e.rated) continue;
    const at = e.expires_at == null ? null : new Date(e.expires_at);
    add("credits_expiring", "", "", e.currency, n(e.face));
    add("credits_expiring", "horizon", horizonBand(at, now), e.currency, n(e.face));
  }

  const rows: MetricDailyRow[] = [];
  for (const currency of held) {
    rows.push({
      measure: "credit_burn_rate",
      dim: "",
      dimValue: "",
      currency,
      value: n(burned.find((b) => b.currency === currency)?.used),
      denominator: BigInt(BURN_DAYS),
    });
  }
  if (reading) {
    const bands = new Map<string, bigint>();
    for (const r of runway) {
      const band = runwayBand(r.days == null ? null : Number(r.days));
      bands.set(band, (bands.get(band) ?? 0n) + 1n);
    }
    rows.push({
      measure: "credit_runway_customers",
      dim: "",
      dimValue: "",
      currency: "XXX",
      value: BigInt(runway.length),
    });
    for (const [band, v] of bands)
      rows.push({
        measure: "credit_runway_customers",
        dim: "runway_band",
        dimValue: band,
        currency: "XXX",
        value: v,
      });
  }
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
