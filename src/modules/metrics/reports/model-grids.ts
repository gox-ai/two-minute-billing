import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { customers, meters, subscriptions } from "@db/schema";
import { accountHolderName } from "@/modules/customers/names";
import { billedRevenueByInvoice } from "@/modules/payments/attribution";
import {
  countedCommitmentFees,
  fullTermEnd,
  proratedCommitment,
  termSegments,
} from "@/modules/subscriptions/commitment";
import { currentUsage } from "@/modules/subscriptions/current-usage";
import { isOrder } from "../daily/order-predicate";
import { revenueTotalsByInvoice } from "../daily/revenue-totals";
import { reportableCustomer } from "../reportable";

/**
 * The grid reports for the billing models other than subscriptions: one-time sales cohorts,
 * top usage consumers and minimum-commitment pacing. Read from the facts at request time,
 * like the subscription cohorts: each is a ranking or a two-axis table that a stored
 * per-day figure cannot hold.
 */

export interface GridContext {
  now: Date;
  /** Into the reporting currency; null excludes the figure. */
  convert: (minor: number, currency: string, at?: Date) => number | null;
}

export interface GridColumn {
  key: string;
  label: string;
  kind: "money" | "count" | "rate" | "text";
}

export interface Grid {
  columns: GridColumn[];
  rows: Array<{ group: string; group_id: string | null; values: Array<number | string | null> }>;
}

export interface CohortMatrix {
  columns: string[];
  base_kind: "count";
  /** `rate` values are basis points; `money` values are minor units of the reporting currency. */
  value_kind: "rate" | "money";
  rows: Array<{ group: string; base: number; values: Array<number | null> }>;
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const addMonths = (d: Date, n: number) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
const monthLabel = (d: Date) => `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

async function customerNames(organizationId: string, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, { name: string; publicId: string }>();
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        id: customers.id,
        publicId: customers.publicId,
        firstName: customers.firstName,
        lastName: customers.lastName,
        company: customers.company,
        email: customers.email,
      })
      .from(customers)
      .where(inArray(customers.id, [...ids])),
  );
  return new Map(
    rows.map((c) => [c.id, { name: accountHolderName(c) ?? c.publicId, publicId: c.publicId }]),
  );
}

/**
 * Buyers grouped by the month of their first order (the last 12 months).
 *
 * `repeat`: the share of the cohort that placed a second order by the end of month N, in
 * basis points. `revenue`: the order revenue of the cohort up to the end of month N, per
 * buyer. A month that has not begun is null. Months are calendar months in UTC, as the
 * subscription cohorts use.
 */
export async function orderCohort(
  organizationId: string,
  businessId: string,
  kind: "repeat" | "revenue",
  ctx: GridContext,
): Promise<{ headline: number | null; matrix: CohortMatrix }> {
  const MONTHS = 12;
  const orders = await withTenant(organizationId, async (tx) => {
    const docs = (await tx.execute(sql`
      select i.id, i.customer_id::text as customer, upper(i.currency) as currency, i.created_at
      from invoices i
      where i.business_id = ${businessId} and i.created_at <= ${ctx.now.toISOString()}::timestamptz
        and ${isOrder()}
      order by i.created_at, i.id`)) as unknown as Array<{
      id: string;
      customer: string;
      currency: string;
      created_at: string | Date;
    }>;
    const revenue =
      kind === "revenue"
        ? await revenueTotalsByInvoice(
            tx,
            docs.map((d) => d.id),
          )
        : new Map<string, bigint>();
    return docs.map((d) => ({
      customer: d.customer,
      at: new Date(d.created_at),
      value:
        kind === "revenue"
          ? ctx.convert(Number(revenue.get(d.id) ?? 0n), d.currency, new Date(d.created_at))
          : null,
    }));
  });

  const byBuyer = new Map<string, typeof orders>();
  for (const o of orders) {
    const list = byBuyer.get(o.customer) ?? [];
    list.push(o);
    byBuyer.set(o.customer, list);
  }
  const firstMonth = monthStart(addMonths(ctx.now, -(MONTHS - 1)));
  const columns = Array.from({ length: MONTHS }, (_, i) => `M${i}`);
  const rows: CohortMatrix["rows"] = [];
  for (let i = 0; i < MONTHS; i++) {
    const cohortStart = addMonths(firstMonth, i);
    const members = [...byBuyer.values()].filter(
      (list) => monthStart(list[0]!.at).getTime() === cohortStart.getTime(),
    );
    if (members.length === 0) continue;
    const values: Array<number | null> = [];
    for (let k = 0; k < MONTHS; k++) {
      if (addMonths(cohortStart, k) > ctx.now) {
        values.push(null);
        continue;
      }
      const end = addMonths(cohortStart, k + 1);
      if (kind === "repeat") {
        const repeated = members.filter((list) => list[1] != null && list[1].at < end).length;
        values.push(Math.round((repeated / members.length) * 10_000));
      } else {
        let sum = 0;
        for (const list of members)
          for (const o of list) if (o.at < end && o.value != null) sum += o.value;
        values.push(Math.round(sum / members.length));
      }
    }
    rows.push({ group: monthLabel(cohortStart), base: members.length, values });
  }
  return {
    // The newest cohort's size: a grid has no single figure.
    headline: rows.at(-1)?.base ?? null,
    matrix: { columns, base_kind: "count", value_kind: kind === "repeat" ? "rate" : "money", rows },
  };
}

/**
 * The customers billed the most usage revenue in the window, with the units each sent per
 * meter. Units are shown only for meters that add up their events (a non-recurring sum or a
 * count, the `usage_quantity` rule). Customers with units and no billed usage rank after,
 * by events.
 */
export async function topUsageConsumers(
  organizationId: string,
  businessId: string,
  window: { start: Date; end: Date },
  ctx: GridContext,
): Promise<{
  headline: number;
  rows: Array<{ group: string; group_id: string | null; value: number }>;
  grid: Grid;
}> {
  const TOP = 20;
  const s = window.start.toISOString();
  const e = window.end.toISOString();
  const { revenue, units, meterNames } = await withTenant(organizationId, async (tx) => {
    const docs = (await tx.execute(sql`
      select i.id, i.customer_id::text as customer, upper(i.currency) as currency, i.created_at
      from invoices i
      where i.business_id = ${businessId} and i.status in ('posted', 'payment_due', 'not_paid', 'paid')
        and i.created_at >= ${s}::timestamptz and i.created_at < ${e}::timestamptz
        and ${reportableCustomer(sql`i.customer_id`)}
        and exists (select 1 from invoice_line_items li where li.invoice_id = i.id and li.kind = 'usage')`)) as unknown as Array<{
      id: string;
      customer: string;
      currency: string;
      created_at: string | Date;
    }>;
    const folded = await billedRevenueByInvoice(
      tx,
      docs.map((d) => d.id),
    );
    const revenue = new Map<string, number>();
    for (const d of docs) {
      const minor = (folded.get(d.id)?.lines ?? [])
        .filter((l) => l.type === "usage")
        .reduce((sum, l) => sum + l.amountMinor, 0n);
      const v = ctx.convert(Number(minor), d.currency, new Date(d.created_at));
      if (v != null) revenue.set(d.customer, (revenue.get(d.customer) ?? 0) + v);
    }
    const units = (await tx.execute(sql`
      select r.customer_id::text as customer, r.meter_id::text as meter,
        round(sum(case when m.aggregation = 'count' then r.event_count::numeric else r.value_sum end))::text as units,
        sum(r.event_count)::text as events
      from usage_rollups r join meters m on m.id = r.meter_id
      where r.business_id = ${businessId}
        and r.bucket_start >= ${s}::timestamptz and r.bucket_start < ${e}::timestamptz
        and ${reportableCustomer(sql`r.customer_id`)}
      group by 1, 2`)) as unknown as Array<{
      customer: string;
      meter: string;
      units: string;
      events: string;
    }>;
    const meterRows = await tx
      .select({
        id: meters.id,
        name: meters.name,
        aggregation: meters.aggregation,
        recurring: meters.recurring,
      })
      .from(meters)
      .where(eq(meters.businessId, businessId));
    return { revenue, units, meterNames: meterRows };
  });

  const additive = new Map(
    meterNames
      .filter((m) => m.aggregation === "count" || (m.aggregation === "sum" && !m.recurring))
      .map((m) => [m.id, m.name]),
  );
  const unitsOf = new Map<string, Map<string, number>>();
  const eventsOf = new Map<string, number>();
  for (const u of units) {
    eventsOf.set(u.customer, (eventsOf.get(u.customer) ?? 0) + Number(u.events));
    if (!additive.has(u.meter)) continue;
    const m = unitsOf.get(u.customer) ?? new Map<string, number>();
    m.set(u.meter, Number(u.units));
    unitsOf.set(u.customer, m);
  }
  const ranked = [...new Set([...revenue.keys(), ...eventsOf.keys()])].sort(
    (a, b) =>
      (revenue.get(b) ?? 0) - (revenue.get(a) ?? 0) ||
      (eventsOf.get(b) ?? 0) - (eventsOf.get(a) ?? 0) ||
      a.localeCompare(b),
  );
  const top = ranked.slice(0, TOP);
  const names = await customerNames(organizationId, top);
  const meterCols = [...additive.entries()].filter(([id]) =>
    top.some((c) => unitsOf.get(c)?.has(id)),
  );
  const grid: Grid = {
    columns: [
      { key: "usage_revenue", label: "Usage revenue", kind: "money" },
      ...meterCols.map(([id, name]): GridColumn => ({ key: id, label: name, kind: "count" })),
    ],
    rows: top.map((c) => ({
      group: names.get(c)?.name ?? "Unknown",
      group_id: names.get(c)?.publicId ?? null,
      values: [revenue.get(c) ?? 0, ...meterCols.map(([id]) => unitsOf.get(c)?.get(id) ?? 0)],
    })),
  };
  const rows = grid.rows.map((r) => ({
    group: r.group,
    group_id: r.group_id,
    value: r.values[0] as number,
  }));
  return { headline: [...revenue.values()].reduce((n, v) => n + v, 0), rows, grid };
}

/** Pace bands: below 80% of the commitment due so far, 80–110%, above 110%. */
export const PACE_BANDS = ["under", "on", "over"] as const;
export type PaceBand = (typeof PACE_BANDS)[number];
const PACE_LABELS: Record<PaceBand, string> = {
  under: "Under pace",
  on: "On pace",
  over: "Over pace",
};
/** A row whose usage cannot be rated before the term closes: counted at invoiced fees only. */
export const PACE_AT_TERM_END = "term_end";
const PACE_AT_TERM_END_LABEL = "Pace shown at term end";
export function paceBand(paceBps: number): PaceBand {
  if (paceBps < 8_000) return "under";
  if (paceBps <= 11_000) return "on";
  return "over";
}

/** Price models whose amount depends on the closing total: usage so far is no honest part. */
const RATED_AT_CLOSE = new Set(["volume", "stairstep"]);

/**
 * Subscriptions with a minimum commitment, by how their fees track the commitment due so
 * far in the current term. Due so far is the commitment weighted by the time elapsed
 * (`proratedCommitment`). Fees are what the true-up counts (invoiced recurring, proration
 * and usage lines of the term, plus settled usage not yet invoiced) PLUS the usage rated so
 * far and not yet invoiced, at the subscription's prices (`currentUsage`, the invoice's own
 * rating path). A subscription with a volume or stairstep usage price is counted at its
 * invoiced fees only, and its status says the pace shows at term end: its amount depends on
 * the closing total. It is in no pace band.
 */
export async function commitmentPacing(
  organizationId: string,
  businessId: string,
  ctx: GridContext,
): Promise<{
  headline: number;
  rows: Array<{ group: string; group_id: string | null; value: number }>;
  grid: Grid;
}> {
  const now = ctx.now;
  const invoicedOnly = await withTenant(organizationId, async (tx) => {
    const subs = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.businessId, businessId),
          eq(subscriptions.status, "active"),
          isNotNull(subscriptions.commitmentAmountMinor),
          isNotNull(subscriptions.currentPeriodStart),
          isNotNull(subscriptions.currentPeriodEnd),
          reportableCustomer(subscriptions.customerId),
          sql`${subscriptions.deletedAt} is null`,
        ),
      );
    const out = [];
    for (const sub of subs) {
      const term = { start: sub.currentPeriodStart!, end: sub.currentPeriodEnd! };
      if (term.start > now) continue;
      const segments = termSegments(sub, term.start);
      const full = fullTermEnd(term.start, sub);
      const upTo = now < term.end ? now : term.end;
      const due = proratedCommitment(segments, term.start, upTo, full);
      const whole = proratedCommitment(segments, term.start, term.end, full);
      const invoiced = await countedCommitmentFees(tx, sub.id, term, {
        includePendingSettlements: true,
      });
      out.push({ sub, term, due, whole, invoiced });
    }
    return out;
  });
  const found = [];
  for (const f of invoicedOnly) {
    const usage = await currentUsage({
      organizationId,
      businessId,
      subscriptionId: f.sub.id,
      surface: "commitment_pacing",
    });
    const w = usage?.window;
    // Only usage of THIS term: a window that opened before it bills the previous term.
    const inTerm = !!w && w.start >= f.term.start && w.start < f.term.end;
    const atClose = (usage?.items ?? []).some((i) => RATED_AT_CLOSE.has(i.model));
    const unbilled =
      inTerm && !atClose ? (usage?.items ?? []).reduce((n, i) => n + i.amountMinor, 0n) : 0n;
    found.push({ ...f, unbilled, counted: f.invoiced + unbilled, atClose });
  }

  const names = await customerNames(
    organizationId,
    found.map((f) => f.sub.customerId),
  );
  const counts: Record<PaceBand, number> = { under: 0, on: 0, over: 0 };
  let atTermEnd = 0;
  const gridRows: Grid["rows"] = [];
  for (const f of found) {
    // Nothing due yet (the term began this instant) has no pace to read.
    if (f.due <= 0n) continue;
    const pace = Number((f.counted * 10_000n) / f.due);
    let status = PACE_AT_TERM_END_LABEL;
    if (f.atClose) atTermEnd += 1;
    else {
      const band = paceBand(pace);
      counts[band] += 1;
      status = PACE_LABELS[band];
    }
    const money = (v: bigint) => ctx.convert(Number(v), f.sub.currency);
    gridRows.push({
      group: names.get(f.sub.customerId)?.name ?? "Unknown",
      group_id: names.get(f.sub.customerId)?.publicId ?? null,
      values: [
        f.sub.publicId,
        money(f.counted),
        money(f.due),
        money(f.whole),
        pace,
        status,
        money(f.unbilled),
      ],
    });
  }
  gridRows.sort((a, b) => (a.values[4] as number) - (b.values[4] as number));
  const rows = [
    ...PACE_BANDS.map((b) => ({ group: PACE_LABELS[b], group_id: b, value: counts[b] })),
    { group: PACE_AT_TERM_END_LABEL, group_id: PACE_AT_TERM_END, value: atTermEnd },
  ];
  return {
    headline: gridRows.length,
    rows,
    grid: {
      columns: [
        { key: "subscription", label: "Subscription", kind: "text" },
        { key: "counted", label: "Fees so far", kind: "money" },
        { key: "due", label: "Commitment due so far", kind: "money" },
        { key: "commitment", label: "Commitment for the term", kind: "money" },
        { key: "pace", label: "Pace", kind: "rate" },
        { key: "band", label: "Status", kind: "text" },
        { key: "unbilled", label: "Usage not invoiced yet", kind: "money" },
      ],
      rows: gridRows,
    },
  };
}
