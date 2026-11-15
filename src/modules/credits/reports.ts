/**
 * Credit reports (step 7), read-side SQL folds over the append-only facts: grant movements,
 * settlements and the gate's usage rows. Nothing here writes.
 *
 * - Deferred revenue roll-forward: paid credit at cost, per month, currency and unit.
 * - One grant's activity: purchase, draws, breakage, refunds, what is left.
 * - Runway in units for a unit with no rate.
 * - Refused demand: usage the gate refused for lack of credit. No usage total, allowance or
 *   settlement reads refused rows; only this report does.
 */
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import {
  creditGrantMovements,
  creditGrants,
  creditUnitBalances,
  creditUnits,
  creditUsageSettlements,
  invoices,
  meters,
} from "@db/schema";
import { runwayFrom, runwayMessage } from "@/modules/usage-controls/measure";
import { formatSteps } from "./units";
import { grantRemaining, type CreditGrant, type CreditUnit } from "./service";
import { foldRollForward, monthsBetween, rollBucketOf, type RollRow } from "./settings-rules";

export { foldRollForward, monthsBetween, rollBucketOf, type RollRow };

const DAY_MS = 86_400_000;
/** `unit` value for paid credit in money (no custom unit). */
export const MONEY_UNIT_KEY = "money";

const n = (v: string | number | bigint | null | undefined): bigint => BigInt(v ?? 0);

// ── Deferred revenue roll-forward ──────────────────────────────────────────

const nextMonth = (ym: string): string => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/**
 * The roll-forward of paid credit at cost (the `credit_grants_paid` account), months in the
 * business time zone. Every customer counts, so the closing balances per currency equal the
 * ledger account. Credit that is invoiced and not yet paid is not in it (it is pending).
 */
export async function deferredRevenueRollForward(
  tx: Tx,
  input: {
    businessId: string;
    timeZone: string;
    fromMonth: string;
    toMonth: string;
    currency?: string;
    unitKey?: string;
  },
): Promise<RollRow[]> {
  const months = monthsBetween(input.fromMonth, input.toMonth);
  const tz = input.timeZone;
  const start = sql`(${`${input.fromMonth}-01`}::timestamp at time zone ${tz})`;
  const end = sql`(${`${nextMonth(input.toMonth)}-01`}::timestamp at time zone ${tz})`;
  const filters = sql`
    g.business_id = ${input.businessId} and g.category = 'paid'
    ${input.currency ? sql`and g.currency = ${input.currency.toUpperCase()}` : sql``}
    ${
      input.unitKey === MONEY_UNIT_KEY
        ? sql`and g.unit_id is null`
        : input.unitKey
          ? sql`and u.key = ${input.unitKey}`
          : sql``
    }`;
  const openings = (await tx.execute(sql`
    select g.currency, coalesce(u.key, ${MONEY_UNIT_KEY}) as unit,
      coalesce(sum(m.cost_minor), 0)::text as cost
    from credit_grant_movements m
    join credit_grants g on g.id = m.grant_id
    left join credit_units u on u.id = g.unit_id
    where ${filters} and m.created_at < ${start}
    group by 1, 2`)) as unknown as Array<{ currency: string; unit: string; cost: string }>;
  // A paid void with no invoice is a void without a refund (0530): breakage, as an expiry.
  const flows = (await tx.execute(sql`
    select to_char(m.created_at at time zone ${tz}, 'YYYY-MM') as month,
      g.currency, coalesce(u.key, ${MONEY_UNIT_KEY}) as unit,
      case when m.kind = 'void' and m.invoice_id is null then 'expire' else m.kind end as kind,
      coalesce(sum(m.cost_minor), 0)::text as cost
    from credit_grant_movements m
    join credit_grants g on g.id = m.grant_id
    left join credit_units u on u.id = g.unit_id
    where ${filters} and m.created_at >= ${start} and m.created_at < ${end}
    group by 1, 2, 3, 4`)) as unknown as Array<{
    month: string;
    currency: string;
    unit: string;
    kind: string;
    cost: string;
  }>;
  // Credit notes on the pack lines that sold these grants, by the note's month. A full refund
  // also takes back revenue already recognised, so this can exceed the voided cost.
  const credited = (await tx.execute(sql`
    select to_char(cn.created_at at time zone ${tz}, 'YYYY-MM') as month,
      g.currency, coalesce(u.key, ${MONEY_UNIT_KEY}) as unit,
      coalesce(sum(cni.amount_minor), 0)::text as amount
    from credit_note_items cni
    join credit_notes cn on cn.id = cni.credit_note_id
    join invoice_line_items li on li.id = cni.invoice_line_item_id
    join credit_grants g on g.invoice_id = li.invoice_id
      and g.source_ref in (li.id::text, li.public_id)
    left join credit_units u on u.id = g.unit_id
    where ${filters} and cn.status <> 'voided'
      and cn.created_at >= ${start} and cn.created_at < ${end}
    group by 1, 2, 3`)) as unknown as Array<{
    month: string;
    currency: string;
    unit: string;
    amount: string;
  }>;
  const creditedOf = new Map(
    credited.map((c) => [`${c.month}|${c.currency}|${c.unit}`, n(c.amount)]),
  );
  return foldRollForward({
    months,
    openings: openings.map((o) => ({ ...o, cost: n(o.cost) })),
    flows: flows.map((f) => ({ ...f, cost: n(f.cost) })),
  }).map((r) => ({ ...r, credited: creditedOf.get(`${r.month}|${r.currency}|${r.unit}`) ?? 0n }));
}

/** Ledger balance of `credit_grants_paid` per currency before `end` (the reconciliation). */
export async function paidCreditLedgerBalance(
  tx: Tx,
  input: { businessId: string; before: Date },
): Promise<Map<string, bigint>> {
  const rows = (await tx.execute(sql`
    select upper(currency) as currency,
      coalesce(sum(case when direction = 'credit' then amount_minor else -amount_minor end), 0)::text as balance
    from ledger_entries
    where business_id = ${input.businessId} and account = 'credit_grants_paid'
      and created_at < ${input.before.toISOString()}::timestamptz
    group by 1`)) as unknown as Array<{ currency: string; balance: string }>;
  return new Map(rows.map((r) => [r.currency, n(r.balance)]));
}

export function serializeRollRow(r: RollRow) {
  return {
    month: r.month,
    currency: r.currency,
    unit: r.unit,
    opening_minor: Number(r.opening),
    sold_minor: Number(r.sold),
    recognised_minor: Number(r.recognised),
    breakage_minor: Number(r.breakage),
    refunds_minor: Number(r.refunds),
    other_minor: Number(r.other),
    closing_minor: Number(r.closing),
    credited_minor: Number(r.credited ?? 0n),
  };
}

// ── One grant's activity ───────────────────────────────────────────────────

export interface GrantActivityLine {
  id: string;
  kind: string;
  created_at: string;
  units: number;
  units_decimal: string;
  cost_minor: number;
  invoice: string | null;
  invoice_number: string | null;
  settlement: string | null;
  meter: string | null;
  meter_name: string | null;
}

/** Movements of one grant, oldest first, paged by movement id. */
export async function grantActivity(
  tx: Tx,
  input: { grant: CreditGrant; unit: CreditUnit | null; limit: number; startingAfter?: string },
) {
  const g = input.grant;
  const decimals = input.unit?.decimals ?? 0;
  const conds = [eq(creditGrantMovements.grantId, g.id)];
  if (input.startingAfter) conds.push(gt(creditGrantMovements.publicId, input.startingAfter));
  const rows = await tx
    .select({
      m: creditGrantMovements,
      invoice: invoices.publicId,
      invoiceNumber: invoices.number,
      settlement: creditUsageSettlements.publicId,
      meter: meters.key,
      meterName: meters.name,
    })
    .from(creditGrantMovements)
    .leftJoin(invoices, eq(invoices.id, creditGrantMovements.invoiceId))
    .leftJoin(
      creditUsageSettlements,
      eq(creditUsageSettlements.id, creditGrantMovements.settlementId),
    )
    .leftJoin(meters, eq(meters.id, creditUsageSettlements.meterId))
    .where(and(...conds))
    .orderBy(asc(creditGrantMovements.publicId))
    .limit(input.limit + 1);
  const totals = (await tx.execute(sql`
    select case when kind = 'void' and invoice_id is null then 'void_no_refund' else kind end as kind,
      coalesce(sum(units), 0)::text as units, coalesce(sum(cost_minor), 0)::text as cost
    from credit_grant_movements where grant_id = ${g.id} group by 1`)) as unknown as Array<{
    kind: string;
    units: string;
    cost: string;
  }>;
  const sum = (kinds: string[], f: "units" | "cost") =>
    totals.filter((t) => kinds.includes(t.kind)).reduce((s, t) => s + n(t[f]), 0n);
  const left = (await grantRemaining(tx, [g.id])).get(g.id)!;
  // Credit notes on the pack line that sold this grant (a full refund includes used credits).
  const [creditedRow] =
    g.invoiceId && g.sourceRef
      ? ((await tx.execute(sql`
          select coalesce(sum(cni.amount_minor), 0)::text as amount
          from credit_note_items cni
          join credit_notes cn on cn.id = cni.credit_note_id
          join invoice_line_items li on li.id = cni.invoice_line_item_id
          where li.invoice_id = ${g.invoiceId} and ${g.sourceRef} in (li.id::text, li.public_id)
            and cn.status <> 'voided'`)) as unknown as Array<{ amount: string }>)
      : [];
  const paid = g.category === "paid";
  const usedUnits = -sum(["draw", "restore"], "units");
  const usedCost = -sum(["draw", "restore"], "cost");
  const page = rows.slice(0, input.limit);
  const steps = (v: bigint) => ({ n: Number(v), d: formatSteps(v, decimals) });
  return {
    summary: {
      status: g.status,
      purchased_units: Number(sum(["grant", "activate"], "units")),
      purchased_units_decimal: steps(sum(["grant", "activate"], "units")).d,
      cost_basis_minor: Number(g.costBasisMinor),
      used_units: steps(usedUnits).n,
      used_units_decimal: steps(usedUnits).d,
      // Revenue of paid credit is booked as it is used; given credit books none.
      revenue_recognised_minor: paid ? Number(usedCost) : 0,
      expired_units: Number(-sum(["expire"], "units")),
      expired_units_decimal: formatSteps(-sum(["expire"], "units"), decimals),
      breakage_minor: paid ? Number(-sum(["expire", "void_no_refund"], "cost")) : 0,
      voided_units: Number(-sum(["void", "void_no_refund"], "units")),
      voided_units_decimal: formatSteps(-sum(["void", "void_no_refund"], "units"), decimals),
      refunded_minor: paid ? Number(-sum(["void"], "cost")) : 0,
      credited_minor: paid ? Number(n(creditedRow?.amount)) : 0,
      rolled_over_units: Number(sum(["rollover_in", "rollover_out"], "units")),
      remaining_units: Number(left.units),
      remaining_units_decimal: formatSteps(left.units, decimals),
      remaining_cost_minor: Number(left.cost),
    },
    data: page.map((r): GrantActivityLine => ({
      id: r.m.publicId,
      kind: r.m.kind,
      created_at: r.m.createdAt.toISOString(),
      units: Number(r.m.units),
      units_decimal: formatSteps(r.m.units, decimals),
      cost_minor: Number(r.m.costMinor),
      invoice: r.invoice,
      invoice_number: r.invoiceNumber,
      settlement: r.settlement,
      meter: r.meter,
      meter_name: r.meterName,
    })),
    hasMore: rows.length > input.limit,
  };
}

// ── Runway in units ────────────────────────────────────────────────────────

/**
 * Days of credit left at the burn of the last 7 days, for a unit with no rate. Balance = what
 * the gate offers now; burn = units the gate took in the last 7 days (refused and backfill
 * events take none). Null days = not enough usage (less than a day of it).
 */
export async function measureUnitRunway(
  tx: Tx,
  q: { customerId: string; unit: CreditUnit; now: Date },
) {
  const [bal] = await tx
    .select({ steps: creditUnitBalances.availableSteps })
    .from(creditUnitBalances)
    .where(
      and(
        eq(creditUnitBalances.customerId, q.customerId),
        eq(creditUnitBalances.unitId, q.unit.id),
      ),
    )
    .limit(1);
  const balance = bal?.steps ?? 0n;
  const from = new Date(q.now.getTime() - 7 * DAY_MS);
  const [burn] = (await tx.execute(sql`
    select coalesce(sum(units), 0)::text as units, min(received_at) as first
    from credit_usage_events
    where customer_id = ${q.customerId} and unit_id = ${q.unit.id}
      and status in ('taken', 'pending', 'settled')
      and received_at >= ${from.toISOString()}::timestamptz
      and received_at <= ${q.now.toISOString()}::timestamptz`)) as unknown as Array<{
    units: string;
    first: string | Date | null;
  }>;
  const used7d = n(burn?.units);
  const first = burn?.first ? new Date(burn.first) : null;
  const enoughUsage = !!first && q.now.getTime() - first.getTime() >= DAY_MS;
  const r = runwayFrom({ balanceMinor: balance, spend7dMinor: used7d, enoughUsage, now: q.now });
  return { ...r, balanceSteps: balance, used7dSteps: used7d, enoughUsage };
}

export function unitRunwayView(
  customer: string,
  unit: CreditUnit,
  r: Awaited<ReturnType<typeof measureUnitRunway>>,
) {
  const d = unit.decimals;
  const perDay = r.enoughUsage && r.used7dSteps > 0n ? r.used7dSteps / 7n : null;
  return {
    object: "credit_runway" as const,
    customer,
    currency: unit.currency,
    unit: unit.key,
    estimate: true,
    runway_days: r.runwayDays,
    runs_out_at: r.runsOutAt?.toISOString() ?? null,
    balance_units: Number(r.balanceSteps),
    balance_units_decimal: formatSteps(r.balanceSteps, d),
    burn_units_per_day: perDay == null ? null : Number(perDay),
    burn_units_per_day_decimal: perDay == null ? null : formatSteps(perDay, d),
    units_last_7_days: Number(r.used7dSteps),
    units_last_7_days_decimal: formatSteps(r.used7dSteps, d),
    message: runwayMessage(r.runwayDays, r.balanceSteps <= 0n),
  };
}

// ── Refused demand ─────────────────────────────────────────────────────────

export type RefusedGroup = "meter" | "day" | "customer";

/**
 * Usage the gate refused for lack of credit, per meter and, by `group_by`, per day (business
 * time zone) or customer. Quantity is in the meter's own unit, so it is never summed across
 * meters. `units` is what the refused usage would have cost in credits.
 */
export async function refusedDemand(
  tx: Tx,
  q: {
    businessId: string;
    timeZone: string;
    from: Date;
    to: Date;
    groupBy: RefusedGroup;
    limit: number;
  },
) {
  const tz = q.timeZone;
  const groupCol =
    q.groupBy === "day"
      ? sql`to_char(e.received_at at time zone ${tz}, 'YYYY-MM-DD')`
      : q.groupBy === "customer"
        ? sql`c.public_id`
        : sql`''`;
  const rows = (await tx.execute(sql`
    select ${groupCol} as grp, m.key as meter, m.name as meter_name, u.key as unit,
      u.decimals,
      -- The account holder's name, as the dashboard names a customer.
      max(coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''),
        nullif(trim(c.company), ''), nullif(trim(c.name), ''), c.email)) as customer_name,
      count(distinct e.event_id)::text as events,
      count(distinct e.customer_id)::text as customers,
      coalesce(sum(e.quantity), 0)::text as quantity,
      coalesce(sum(e.units_due), 0)::text as units
    from credit_usage_events e
    join meters m on m.id = e.meter_id
    join credit_units u on u.id = e.unit_id
    left join customers c on c.id = e.customer_id
    where e.business_id = ${q.businessId} and e.status = 'refused'
      and e.received_at >= ${q.from.toISOString()}::timestamptz
      and e.received_at < ${q.to.toISOString()}::timestamptz
    group by 1, 2, 3, 4, 5
    order by 1 desc, coalesce(sum(e.units_due), 0) desc, 2
    limit ${q.limit + 1}`)) as unknown as Array<{
    grp: string;
    meter: string;
    meter_name: string;
    unit: string;
    decimals: number;
    customer_name: string | null;
    events: string;
    customers: string;
    quantity: string;
    units: string;
  }>;
  const page = rows.slice(0, q.limit);
  return {
    data: page.map((r) => ({
      ...(q.groupBy === "day" ? { day: r.grp } : {}),
      ...(q.groupBy === "customer" ? { customer: r.grp, customer_name: r.customer_name } : {}),
      meter: r.meter,
      meter_name: r.meter_name,
      unit: r.unit,
      refused_events: Number(r.events),
      customers: Number(r.customers),
      refused_quantity: r.quantity,
      refused_units: Number(r.units),
      refused_units_decimal: formatSteps(n(r.units), Number(r.decimals)),
    })),
    hasMore: rows.length > q.limit,
  };
}

/** A unit by key, any status. */
export async function unitByKey(
  tx: Tx,
  businessId: string,
  key: string,
): Promise<CreditUnit | null> {
  const [u] = await tx
    .select()
    .from(creditUnits)
    .where(and(eq(creditUnits.businessId, businessId), eq(creditUnits.key, key)))
    .limit(1);
  return u ?? null;
}

/** A grant of a customer by public id. */
export async function grantOfCustomer(
  tx: Tx,
  input: { businessId: string; customerId: string; grantPublicId: string },
): Promise<{ grant: CreditGrant; unit: CreditUnit | null } | null> {
  const [r] = await tx
    .select({ g: creditGrants, u: creditUnits })
    .from(creditGrants)
    .leftJoin(creditUnits, eq(creditUnits.id, creditGrants.unitId))
    .where(
      and(
        eq(creditGrants.businessId, input.businessId),
        eq(creditGrants.customerId, input.customerId),
        eq(creditGrants.publicId, input.grantPublicId),
      ),
    )
    .limit(1);
  return r ? { grant: r.g, unit: r.u } : null;
}
