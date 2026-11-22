import { sql, type SQL } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { businessTimezone } from "@/platform/business-tz";
import { loadRateTimeline } from "@/platform/fx/history";
import { businesses } from "@db/schema";
import { eq } from "drizzle-orm";
import { accountHolderName } from "@/modules/customers/names";
import { reportableCustomer } from "./reportable";
import { planProductJoin } from "./plan-of";
import { resolveBuckets, bucketKeySql, type RangeBucket } from "./calendar-ranges";
import {
  cancellationSaves,
  checkoutInvoiceJoin,
  checkoutRecoveredSql,
  checkoutSteps,
  emailLinkMatch,
  SAVE_HOLD_DAYS,
} from "./hosted-page-figures";
import { FIRST_REMINDER_AFTER_MS } from "@/modules/checkout/reminders";
import {
  checkoutTracking,
  portalTracking,
  visitFilterSql,
  DEVICES,
  type VisitFilter,
} from "@/modules/storefront-analytics/reports";

/**
 * The checkout and portal report pages: every figure for one business over a window of
 * business-zone days, with the same-length window before it for the compare deltas.
 *
 * Shared definitions (funnel steps, the revenue invoice, recovery, cancellation saves) come
 * from `hosted-page-figures.ts`, which the Reports library reads too, so a figure here equals
 * the same figure there. Money is integer minor units in ONE reporting currency: the business
 * default, each amount converted at the rate the business held on its day (as Reports does);
 * an amount in a currency with no rate is left out and named in `missing_rates`.
 */

export class HostedReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedReportError";
  }
}

/** Longest window, in days. A year and a day covers "last 12 months" in a leap year. */
export const MAX_REPORT_DAYS = 366;

const DAY_MS = 86_400_000;
const civil = (d: string) => new Date(`${d}T00:00:00.000Z`);
const addDays = (d: string, n: number) =>
  new Date(civil(d).getTime() + n * DAY_MS).toISOString().slice(0, 10);

export interface ReportWindowInput {
  /** First business-zone day, `YYYY-MM-DD`, inclusive. */
  start: string;
  /** Last business-zone day, inclusive. */
  end: string;
  compare?: boolean;
  /** `ALL` (default) converts into the business currency; a code scopes to that currency. */
  currency?: string | null;
  /** Only sessions with a tracked visit from this country (ISO 3166-1 alpha-2). */
  country?: string | null;
  /** Only sessions with a tracked visit from this device category. */
  device?: VisitFilter["device"];
  now?: Date;
}

const visitFilterOf = (input: ReportWindowInput): VisitFilter => ({
  country: input.country ?? null,
  device: input.device ?? null,
});

/** Visitor countries tracked for the business since `from`, for the Country filter. */
async function trackedCountries(tx: Tx, businessId: string, surface: string, from: Date) {
  const rows = (await tx.execute(sql`
    select country::text as c from storefront_visits
    where business_id = ${businessId}::uuid and surface = ${surface}
      and viewed_at >= ${from.toISOString()}::timestamptz and country is not null
    group by 1 order by count(*) desc, 1`)) as unknown as Array<{ c: string }>;
  return rows.map((r) => r.c);
}

export interface Window {
  tz: string;
  cur: { start: Date; end: Date };
  prev: { start: Date; end: Date };
  prevDays: { start: string; end: string };
  buckets: RangeBucket[];
  prevBuckets: RangeBucket[];
}

export async function resolveWindow(tx: Tx, businessId: string, start: string, end: string) {
  const days = Math.round((civil(end).getTime() - civil(start).getTime()) / DAY_MS) + 1;
  if (!(days >= 1)) throw new HostedReportError("start must be on or before end");
  if (days > MAX_REPORT_DAYS)
    throw new HostedReportError(`The window can be at most ${MAX_REPORT_DAYS} days`);
  const tz = await businessTimezone(tx, businessId);
  const prevStart = addDays(start, -days);
  const [r] = (await tx.execute(sql`
    select (${start}::date::timestamp at time zone ${tz}) as a,
           ((${end}::date + 1)::timestamp at time zone ${tz}) as b,
           (${prevStart}::date::timestamp at time zone ${tz}) as c`)) as unknown as Array<{
    a: Date | string;
    b: Date | string;
    c: Date | string;
  }>;
  const cur = { start: new Date(r!.a), end: new Date(r!.b) };
  const prev = { start: new Date(r!.c), end: cur.start };
  const w: Window = {
    tz,
    cur,
    prev,
    prevDays: { start: prevStart, end: addDays(start, -1) },
    buckets: await resolveBuckets(tx, cur, tz, "day"),
    prevBuckets: await resolveBuckets(tx, prev, tz, "day"),
  };
  return w;
}

/** The reporting currency and a dated converter that records what it could not convert. */
export async function moneyContext(
  tx: Tx,
  businessId: string,
  requested: string | null | undefined,
) {
  const [biz] = await tx
    .select({
      defaultCurrency: businesses.defaultCurrency,
      exchangeRates: businesses.exchangeRates,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  const base = (biz?.defaultCurrency ?? "USD").toUpperCase();
  const timeline = await loadRateTimeline(tx, businessId, {
    base,
    currentRates: (biz?.exchangeRates ?? null) as Record<string, unknown> | null,
  });
  const want = (requested ?? "ALL").toUpperCase();
  const scoped = want !== "ALL" ? want : null;
  const reporting = scoped ?? base;
  const missing = new Set<string>();
  const convert = (minor: number, ccy: string, at: Date): number | null => {
    const c = ccy.toUpperCase();
    if (scoped) return c === scoped ? minor : null;
    if (c === reporting) return minor;
    const n = Number(timeline.rateAt(c, at));
    if (Number.isFinite(n) && n > 0) return Math.round(minor / n);
    missing.add(c);
    return null;
  };
  return { reporting, scoped, convert, missing };
}

export const pct = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num * 10000) / den) : null;

const ts = (d: Date) => d.toISOString();

/** A day bucket key for an instant column in the business zone. */
export const dayKey = (col: SQL, tz: string) => bucketKeySql(col, tz, "day");

/** Points of a per-day series, aligned to the window's buckets (missing days read 0). */
function series<T>(
  buckets: RangeBucket[],
  by: Map<string, T>,
  pick: (v: T | undefined) => number | null,
) {
  return buckets.map((b) => pick(by.get(b.key)));
}

export interface DayPoint {
  date: string;
  label: string;
}

export const days = (buckets: RangeBucket[]): DayPoint[] =>
  buckets.map((b) => ({ date: b.t, label: b.label }));

/** Live strip: the last 30 minutes, one count per minute, oldest first. */
const LIVE_MINUTES = 30;
/** "Right now": a page used within this many minutes. */
const ACTIVE_MINUTES = 5;

// ===========================================================================
// Checkout
// ===========================================================================

export interface CheckoutReportInput extends ReportWindowInput {
  /** `plink_…`: only sessions from this payment link. */
  paymentLink?: string | null;
  /** Product public id (a plan, a one-time charge or a credit pack): only sessions with an item of it. */
  plan?: string | null;
}

export interface CheckoutFigures {
  /** Sessions first opened in the window (`first_viewed_at`), new sign-ups and purchases. */
  opened: number;
  completed: number;
  conversion_bps: number | null;
  revenue_minor: number;
  aov_minor: number | null;
  abandoned: number;
  /** Sessions CREATED in the window that completed after a reminder, as Reports counts them. */
  recovered: number;
  recovered_revenue_minor: number;
  median_complete_seconds: number | null;
}

const CHECKOUT_STEPS = [
  { key: "opened", label: "Opened the checkout" },
  { key: "details", label: "Entered details" },
  { key: "payment", label: "Started payment" },
  { key: "completed", label: "Paid" },
] as const;

/** Time-to-complete bands, in seconds (upper bound exclusive). */
const TIME_BANDS = [
  { key: "lt1m", label: "Less than 1 minute", max: 60 },
  { key: "1to2m", label: "1 to 2 minutes", max: 120 },
  { key: "2to5m", label: "2 to 5 minutes", max: 300 },
  { key: "5to10m", label: "5 to 10 minutes", max: 600 },
  { key: "10to30m", label: "10 to 30 minutes", max: 1800 },
  { key: "30to60m", label: "30 to 60 minutes", max: 3600 },
  { key: "1to24h", label: "1 to 24 hours", max: 86400 },
  { key: "gt1d", label: "More than 1 day", max: Infinity },
];

export async function computeCheckoutReport(
  organizationId: string,
  businessId: string,
  input: CheckoutReportInput,
) {
  const now = input.now ?? new Date();
  return withTenant(organizationId, async (tx) => {
    const w = await resolveWindow(tx, businessId, input.start, input.end);
    const money = await moneyContext(tx, businessId, input.currency);

    // --- Filters, resolved to row ids. An unknown id is refused, never ignored.
    let linkId: string | null = null;
    if (input.paymentLink) {
      const [l] = (await tx.execute(
        sql`select id::text as id from payment_links where business_id = ${businessId}::uuid and public_id = ${input.paymentLink}`,
      )) as unknown as Array<{ id: string }>;
      if (!l) throw new HostedReportError(`No such payment link: ${input.paymentLink}`);
      linkId = l.id;
    }
    let planId: string | null = null;
    if (input.plan) {
      const [p] = (await tx.execute(
        sql`select id::text as id from products where business_id = ${businessId}::uuid and public_id = ${input.plan}`,
      )) as unknown as Array<{ id: string }>;
      if (!p) throw new HostedReportError(`No such product: ${input.plan}`);
      planId = p.id;
    }

    const s = sql.raw("s");
    const step = checkoutSteps(s);
    // A checkout is "of" a product when any of its items is that product: a plan, a
    // one-time charge or a credit pack alike.
    const hasProduct = (id: string) => sql`exists (select 1 from checkout_session_items ci
        join prices p on p.id = ci.price_id
        where ci.checkout_session_id = s.id and p.product_id = ${id}::uuid)`;
    const filters = sql`s.business_id = ${businessId}::uuid
        and s.mode in ('create', 'purchase')
        ${linkId ? sql`and s.payment_link_id = ${linkId}::uuid` : sql``}
        ${planId ? sql`and ${hasProduct(planId)}` : sql``}
        ${visitFilterSql("checkout", sql`s.id`, visitFilterOf(input))}`;
    const viewedIn = (from: Date, to: Date) =>
      sql`s.first_viewed_at >= ${ts(from)}::timestamptz and s.first_viewed_at < ${ts(to)}::timestamptz`;
    const curStart = ts(w.cur.start);
    const bkey = dayKey(sql`s.first_viewed_at`, w.tz);
    const leftAt = new Date(now.getTime() - FIRST_REMINDER_AFTER_MS);

    // --- Q1: the funnel and the counts, per period and per day (grouping sets).
    type Q1 = {
      period: "c" | "p";
      bkey: string | null;
      opened: number;
      details: number;
      payment: number;
      completed: number;
      abandoned: number;
      med_complete: number | null;
      med_details: number | null;
      med_payment: number | null;
      med_paid: number | null;
      attempts: number;
      failures: number;
      failed_sessions: number;
      failed_then_paid: number;
    };
    const q1 = (await tx.execute(sql`
      with x as (
        select case when s.first_viewed_at >= ${curStart}::timestamptz then 'c' else 'p' end as period,
               ${bkey} as bkey,
               ${step.details} as details,
               ${step.payment} as payment,
               ${step.completed} as completed,
               (${step.details} and s.completed_at is null
                 and (s.last_used_at is null or s.last_used_at <= ${ts(leftAt)}::timestamptz)) as abandoned,
               extract(epoch from (s.completed_at - s.first_viewed_at))::float as secs_complete,
               extract(epoch from (s.details_submitted_at - s.first_viewed_at))::float as secs_details,
               extract(epoch from (s.payment_started_at - s.details_submitted_at))::float as secs_payment,
               extract(epoch from (s.completed_at - s.payment_started_at))::float as secs_paid,
               s.payment_attempt_count as attempts,
               s.payment_failure_count as failures
        from checkout_sessions s
        where ${filters} and ${viewedIn(w.prev.start, w.cur.end)}
      )
      select period, bkey, grouping(bkey) = 1 as total,
             count(*)::int as opened,
             count(*) filter (where details)::int as details,
             count(*) filter (where payment)::int as payment,
             count(*) filter (where completed)::int as completed,
             count(*) filter (where abandoned)::int as abandoned,
             percentile_cont(0.5) within group (order by secs_complete) filter (where secs_complete >= 0) as med_complete,
             percentile_cont(0.5) within group (order by secs_details) filter (where secs_details >= 0) as med_details,
             percentile_cont(0.5) within group (order by secs_payment) filter (where secs_payment >= 0) as med_payment,
             percentile_cont(0.5) within group (order by secs_paid) filter (where secs_paid >= 0) as med_paid,
             coalesce(sum(attempts), 0)::int as attempts,
             coalesce(sum(failures), 0)::int as failures,
             count(*) filter (where failures > 0)::int as failed_sessions,
             count(*) filter (where failures > 0 and completed)::int as failed_then_paid
      from x
      group by grouping sets ((period, bkey), (period))`)) as unknown as Array<
      Q1 & { total: boolean }
    >;
    const q1Total = (p: "c" | "p") => q1.find((r) => r.period === p && r.total);
    const q1Day = new Map(q1.filter((r) => r.period === "c" && !r.total).map((r) => [r.bkey!, r]));
    const q1PrevDay = new Map(
      q1.filter((r) => r.period === "p" && !r.total).map((r) => [r.bkey!, r]),
    );

    // --- Q2: completed sessions, one row each: revenue, method, country, time, coupon.
    type Q2 = {
      period: "c" | "p";
      bkey: string;
      link: string | null;
      inv_status: string | null;
      total_minor: string | null;
      currency: string | null;
      inv_at: Date | string | null;
      secs: number | null;
      method: string | null;
      gateway: string | null;
      country: string | null;
      coupon: boolean;
      discount_minor: string | null;
    };
    const q2 = (await tx.execute(sql`
      select case when s.first_viewed_at >= ${curStart}::timestamptz then 'c' else 'p' end as period,
             ${bkey} as bkey,
             s.payment_link_id::text as link,
             fi.status as inv_status, fi.total_minor::text as total_minor, fi.currency as currency,
             coalesce(fi.paid_at, fi.created_at) as inv_at,
             extract(epoch from (s.completed_at - s.first_viewed_at))::float as secs,
             pay.method, pay.gateway,
             c.country::text as country,
             jsonb_array_length(s.coupon_codes) > 0 as coupon,
             (select sum(d.amount_minor)::text from invoice_line_discounts d where d.invoice_id = fi.id) as discount_minor
      from checkout_sessions s
      ${checkoutInvoiceJoin(s, "fi")}
      left join lateral (
        select coalesce(py.method_type, pm.type) as method, py.provider_key as gateway
        from payments py left join payment_methods pm on pm.id = py.payment_method_id
        where py.invoice_id = fi.id and py.status = 'succeeded'
        order by py.created_at limit 1) pay on true
      left join customers c on c.id = s.resulting_customer_id
      where ${filters} and ${viewedIn(w.prev.start, w.cur.end)} and ${step.completed}`)) as unknown as Q2[];
    const revenueOf = (r: Q2): number | null =>
      r.inv_status === "paid" && r.currency && r.inv_at != null
        ? money.convert(Number(r.total_minor ?? 0), r.currency, new Date(r.inv_at))
        : null;

    // --- Q3: recovery, over sessions CREATED in the window (as the Reports library counts it).
    type Q3 = {
      period: "c" | "p";
      bkey: string;
      reminded: boolean;
      reminders: number;
      recovered: boolean;
      inv_status: string | null;
      total_minor: string | null;
      currency: string | null;
      inv_at: Date | string | null;
    };
    const q3 = (await tx.execute(sql`
      select case when s.created_at >= ${curStart}::timestamptz then 'c' else 'p' end as period,
             ${dayKey(sql`s.created_at`, w.tz)} as bkey,
             s.reminder_count > 0 as reminded, s.reminder_count as reminders,
             ${checkoutRecoveredSql(s)} as recovered,
             fi.status as inv_status, fi.total_minor::text as total_minor, fi.currency as currency,
             coalesce(fi.paid_at, fi.created_at) as inv_at
      from checkout_sessions s
      ${checkoutInvoiceJoin(s, "fi")}
      where s.business_id = ${businessId}::uuid and s.reminder_count > 0
        ${linkId ? sql`and s.payment_link_id = ${linkId}::uuid` : sql``}
        ${planId ? sql`and ${hasProduct(planId)}` : sql``}
        ${visitFilterSql("checkout", sql`s.id`, visitFilterOf(input))}
        and s.created_at >= ${ts(w.prev.start)}::timestamptz and s.created_at < ${ts(w.cur.end)}::timestamptz`)) as unknown as Q3[];

    const figures = (p: "c" | "p"): CheckoutFigures => {
      const t = q1Total(p);
      const done = q2.filter((r) => r.period === p);
      const revenue = done.reduce((a, r) => a + (revenueOf(r) ?? 0), 0);
      const rec = q3.filter((r) => r.period === p && r.recovered);
      const recRevenue = rec.reduce(
        (a, r) =>
          a +
          (r.inv_status === "paid" && r.currency && r.inv_at != null
            ? (money.convert(Number(r.total_minor ?? 0), r.currency, new Date(r.inv_at)) ?? 0)
            : 0),
        0,
      );
      const completed = t?.completed ?? 0;
      return {
        opened: t?.opened ?? 0,
        completed,
        conversion_bps: pct(completed, t?.opened ?? 0),
        revenue_minor: revenue,
        aov_minor: completed > 0 ? Math.round(revenue / completed) : null,
        abandoned: t?.abandoned ?? 0,
        recovered: rec.length,
        recovered_revenue_minor: recRevenue,
        median_complete_seconds: t?.med_complete == null ? null : Math.round(t.med_complete),
      };
    };
    const totals = figures("c");
    const previous = input.compare ? figures("p") : null;

    // Per-day series, for the trend chart and the sparklines.
    const revenueByDay = new Map<string, number>();
    const doneByDayCount = new Map<string, number>();
    for (const r of q2) {
      if (r.period !== "c") continue;
      revenueByDay.set(r.bkey, (revenueByDay.get(r.bkey) ?? 0) + (revenueOf(r) ?? 0));
      doneByDayCount.set(r.bkey, (doneByDayCount.get(r.bkey) ?? 0) + 1);
    }
    const recByDay = new Map<string, number>();
    for (const r of q3)
      if (r.period === "c" && r.recovered) recByDay.set(r.bkey, (recByDay.get(r.bkey) ?? 0) + 1);
    const prevCompleted = w.prevBuckets.map((b) => q1PrevDay.get(b.key)?.completed ?? 0);

    // --- Q4: per payment link, current window.
    type Q4 = {
      link: string | null;
      name: string | null;
      public_id: string | null;
      opened: number;
      completed: number;
      med: number | null;
    };
    const q4 = (await tx.execute(sql`
      select s.payment_link_id::text as link, pl.name, pl.public_id,
             count(*)::int as opened,
             count(*) filter (where ${step.completed})::int as completed,
             percentile_cont(0.5) within group (order by extract(epoch from (s.completed_at - s.first_viewed_at)))
               filter (where s.completed_at >= s.first_viewed_at) as med
      from checkout_sessions s
      left join payment_links pl on pl.id = s.payment_link_id
      where ${filters} and ${viewedIn(w.cur.start, w.cur.end)}
      group by 1, 2, 3`)) as unknown as Q4[];
    const linkRevenue = new Map<string, number>();
    for (const r of q2)
      if (r.period === "c")
        linkRevenue.set(r.link ?? "", (linkRevenue.get(r.link ?? "") ?? 0) + (revenueOf(r) ?? 0));
    const links = q4
      .map((r) => {
        const revenue = linkRevenue.get(r.link ?? "") ?? 0;
        return {
          payment_link: r.public_id,
          name: r.name,
          opened: r.opened,
          completed: r.completed,
          conversion_bps: pct(r.completed, r.opened),
          revenue_minor: revenue,
          aov_minor: r.completed > 0 ? Math.round(revenue / r.completed) : null,
          median_complete_seconds: r.med == null ? null : Math.round(r.med),
        };
      })
      .sort((a, b) => b.revenue_minor - a.revenue_minor || b.opened - a.opened);

    // --- Payment methods of paid checkouts (current window).
    const methodMap = new Map<
      string,
      { method: string; gateway: string | null; paid: number; revenue_minor: number }
    >();
    for (const r of q2) {
      if (r.period !== "c") continue;
      const v = revenueOf(r);
      // A checkout that took no payment (a trial, a free plan, a credit) has no method.
      const method = r.method ?? "none";
      const key = `${method}:${r.gateway ?? ""}`;
      const m = methodMap.get(key) ?? {
        method,
        gateway: r.method ? r.gateway : null,
        paid: 0,
        revenue_minor: 0,
      };
      m.paid += 1;
      m.revenue_minor += v ?? 0;
      methodMap.set(key, m);
    }
    const paymentMethods = [...methodMap.values()].sort((a, b) => b.paid - a.paid);

    // --- Q5: payment failures, current window: the newest refusal of each session.
    const q5 = (await tx.execute(sql`
      select coalesce(nullif(trim(s.last_payment_failure), ''), 'unknown') as reason, count(*)::int as n
      from checkout_sessions s
      where ${filters} and ${viewedIn(w.cur.start, w.cur.end)} and s.payment_failure_count > 0
      group by 1 order by 2 desc`)) as unknown as Array<{ reason: string; n: number }>;
    const c1 = q1Total("c");
    const failures = {
      attempts: c1?.attempts ?? 0,
      failed_attempts: c1?.failures ?? 0,
      sessions_with_failure: c1?.failed_sessions ?? 0,
      paid_after_failure: c1?.failed_then_paid ?? 0,
      reasons: q5.slice(0, 8).map((r) => ({ reason: r.reason, sessions: r.n })),
      other_sessions: q5.slice(8).reduce((a, r) => a + r.n, 0),
    };

    // --- Recovery detail (current window).
    const curQ3 = q3.filter((r) => r.period === "c");
    const recovery = {
      reminded: curQ3.length,
      reminders_sent: curQ3.reduce((a, r) => a + r.reminders, 0),
      recovered: totals.recovered,
      recovered_revenue_minor: totals.recovered_revenue_minor,
      // The reminder a recovered checkout completed after: its last one.
      by_reminder: [1, 2].map((n) => ({
        reminder: n,
        recovered: curQ3.filter((r) => r.recovered && r.reminders === n).length,
      })),
    };

    // --- Q6: coupons, current window.
    const q6 = (await tx.execute(sql`
      select code, count(*)::int as sessions, count(*) filter (where ${step.completed})::int as completed
      from checkout_sessions s cross join lateral jsonb_array_elements_text(s.coupon_codes) as code
      where ${filters} and ${viewedIn(w.cur.start, w.cur.end)}
      group by 1 order by 3 desc, 2 desc limit 20`)) as unknown as Array<{
      code: string;
      sessions: number;
      completed: number;
    }>;
    const [cq] = (await tx.execute(sql`
      select count(*) filter (where jsonb_array_length(s.coupon_codes) > 0)::int as with_sessions,
             count(*) filter (where jsonb_array_length(s.coupon_codes) > 0 and ${step.completed})::int as with_completed,
             count(*) filter (where jsonb_array_length(s.coupon_codes) = 0)::int as without_sessions,
             count(*) filter (where jsonb_array_length(s.coupon_codes) = 0 and ${step.completed})::int as without_completed
      from checkout_sessions s
      where ${filters} and ${viewedIn(w.cur.start, w.cur.end)}`)) as unknown as Array<{
      with_sessions: number;
      with_completed: number;
      without_sessions: number;
      without_completed: number;
    }>;
    let discount = 0;
    for (const r of q2)
      if (r.period === "c" && r.coupon && r.inv_status === "paid" && r.currency && r.inv_at != null)
        discount +=
          money.convert(Number(r.discount_minor ?? 0), r.currency, new Date(r.inv_at)) ?? 0;
    const coupons = {
      sessions_with_coupon: cq?.with_sessions ?? 0,
      completed_with_coupon: cq?.with_completed ?? 0,
      conversion_with_coupon_bps: pct(cq?.with_completed ?? 0, cq?.with_sessions ?? 0),
      sessions_without_coupon: cq?.without_sessions ?? 0,
      completed_without_coupon: cq?.without_completed ?? 0,
      conversion_without_coupon_bps: pct(cq?.without_completed ?? 0, cq?.without_sessions ?? 0),
      discount_minor: discount,
      codes: q6,
    };

    // --- Billing country of paid checkouts, and time to complete (current window).
    const countryMap = new Map<string, number>();
    const bandCounts = new Map<string, number>(TIME_BANDS.map((b) => [b.key, 0]));
    for (const r of q2) {
      if (r.period !== "c") continue;
      const cc = r.country?.trim() || "unknown";
      countryMap.set(cc, (countryMap.get(cc) ?? 0) + 1);
      if (r.secs != null && r.secs >= 0) {
        const band = TIME_BANDS.find((b) => r.secs! < b.max)!;
        bandCounts.set(band.key, (bandCounts.get(band.key) ?? 0) + 1);
      }
    }
    const countries = [...countryMap.entries()]
      .map(([country, completed]) => ({ country, completed }))
      .sort((a, b) => b.completed - a.completed);
    const timeToComplete = TIME_BANDS.map((b) => ({
      band: b.key,
      label: b.label,
      completed: bandCounts.get(b.key) ?? 0,
    }));

    // --- Q7: right now (ignores the window; honours the filters).
    const since = new Date(now.getTime() - LIVE_MINUTES * 60_000);
    const [live] = (await tx.execute(sql`
      select count(*) filter (where s.completed_at is null and s.status = 'open'
               and s.last_used_at >= ${ts(new Date(now.getTime() - ACTIVE_MINUTES * 60_000))}::timestamptz)::int as active,
             count(*) filter (where s.first_viewed_at >= ${ts(since)}::timestamptz)::int as opened
      from checkout_sessions s
      where ${filters} and (s.last_used_at >= ${ts(since)}::timestamptz or s.first_viewed_at >= ${ts(since)}::timestamptz)`)) as unknown as Array<{
      active: number;
      opened: number;
    }>;
    const perMinute = (await tx.execute(sql`
      select floor(extract(epoch from (${ts(now)}::timestamptz - s.first_viewed_at)) / 60)::int as m, count(*)::int as n
      from checkout_sessions s
      where ${filters} and s.first_viewed_at >= ${ts(since)}::timestamptz and s.first_viewed_at <= ${ts(now)}::timestamptz
      group by 1`)) as unknown as Array<{ m: number; n: number }>;
    const minutes = Array.from(
      { length: LIVE_MINUTES },
      (_, i) => perMinute.find((r) => r.m === LIVE_MINUTES - 1 - i)?.n ?? 0,
    );

    // --- Filter options: the business's payment links and plans.
    // --- First-party visit tracking (storefront-analytics), under the same filters.
    const tracking = await checkoutTracking(tx, {
      businessId,
      from: w.cur.start,
      to: w.cur.end,
      sessionWhere: filters,
      filter: visitFilterOf(input),
      revenueOf: money.convert,
    });
    const countryOptions = await trackedCountries(tx, businessId, "checkout", w.prev.start);

    const linkOptions = (await tx.execute(sql`
      select public_id as id, name from payment_links where business_id = ${businessId}::uuid order by active desc, name`)) as unknown as Array<{
      id: string;
      name: string;
    }>;

    const funnel = CHECKOUT_STEPS.map((st, i) => {
      const t = q1Total("c");
      const sessions = t ? (t as unknown as Record<string, number>)[st.key]! : 0;
      const med = i === 0 ? null : [t?.med_details, t?.med_payment, t?.med_paid][i - 1];
      return {
        step: st.key,
        label: st.label,
        sessions,
        median_seconds_from_previous: med == null ? null : Math.round(med),
      };
    });

    return {
      start: input.start,
      end: input.end,
      previous_start: w.prevDays.start,
      previous_end: w.prevDays.end,
      timezone: w.tz,
      currency: money.reporting,
      missing_rates: [...money.missing].sort(),
      filters: {
        payment_link: input.paymentLink ?? null,
        plan: input.plan ?? null,
        country: input.country ?? null,
        device: input.device ?? null,
      },
      options: { payment_links: linkOptions, countries: countryOptions, devices: [...DEVICES] },
      live: {
        active_now: live?.active ?? 0,
        opened_last_30_minutes: live?.opened ?? 0,
        per_minute: minutes,
      },
      totals,
      previous,
      days: days(w.buckets),
      series: {
        opened: series(w.buckets, q1Day, (r) => r?.opened ?? 0),
        completed: series(w.buckets, q1Day, (r) => r?.completed ?? 0),
        conversion_bps: series(w.buckets, q1Day, (r) => (r ? pct(r.completed, r.opened) : null)),
        revenue_minor: w.buckets.map((b) => revenueByDay.get(b.key) ?? 0),
        aov_minor: w.buckets.map((b) => {
          const n = doneByDayCount.get(b.key) ?? 0;
          return n > 0 ? Math.round((revenueByDay.get(b.key) ?? 0) / n) : null;
        }),
        abandoned: series(w.buckets, q1Day, (r) => r?.abandoned ?? 0),
        recovered: w.buckets.map((b) => recByDay.get(b.key) ?? 0),
        median_complete_seconds: series(w.buckets, q1Day, (r) =>
          r?.med_complete == null ? null : Math.round(r.med_complete),
        ),
      },
      previous_series: input.compare ? { completed: prevCompleted } : null,
      funnel,
      links,
      payment_methods: paymentMethods,
      failures,
      recovery,
      coupons,
      countries,
      time_to_complete: timeToComplete,
      tracking,
    };
  });
}

export type CheckoutReport = Awaited<ReturnType<typeof computeCheckoutReport>>;

// ===========================================================================
// Portal
// ===========================================================================

/**
 * Emails sent because a charge did not go through. A visit from one of these that pays is
 * money the failed-payment emails recovered.
 */
export const FAILED_PAYMENT_EMAILS = [
  "payment_failed",
  "payment_authentication_required",
  "dunning_action_required",
] as const;

/**
 * The portal actions we count, from the events a portal session emits (the session's
 * `psess_…` id is the event's actor). `detail` narrows a type where one type means more
 * than one thing.
 */
export const PORTAL_ACTIONS = [
  { key: "paid_invoice", label: "Paid an invoice", types: ["invoice_paid"] },
  { key: "added_method", label: "Added a payment method", types: ["payment_source_added"] },
  {
    key: "made_primary",
    label: "Made a method primary",
    types: ["payment_source_role_changed"],
    detail: "primary",
  },
  {
    key: "updated_details",
    label: "Updated billing details",
    types: ["customer_billing_info_updated"],
  },
  { key: "deleted_method", label: "Deleted a payment method", types: ["payment_source_deleted"] },
  {
    key: "changed_plan",
    label: "Changed plan",
    types: ["subscription_changed", "subscription_change_scheduled"],
  },
  { key: "paused", label: "Paused a subscription", types: ["subscription_paused"] },
  {
    key: "cancelled",
    label: "Cancelled a subscription",
    types: ["subscription_canceled", "subscription_cancel_scheduled"],
  },
] as const;
type PortalActionKey = (typeof PORTAL_ACTIONS)[number]["key"];
const ACTION_TYPES = [...new Set(PORTAL_ACTIONS.flatMap((a) => [...a.types]))];

/**
 * How a portal link was made, from what is stored:
 *  - an `email` link carries the email's type: the email row is written in the same
 *    transaction as the link, so the two share `created_at` (`email` when none matches);
 *  - a link that a sign-in code made is one minted within seconds of a code being spent;
 *  - every other link came from the API (the dashboard calls the same API).
 */
export const arrivalSql = (ps: SQL): SQL => sql`(case
  when ${ps}.access_kind = 'email' then coalesce((
    select em.type from email_messages em
    where ${emailLinkMatch(ps, sql.raw("em"))}
    order by em.id limit 1), 'email')
  when exists (
    select 1 from portal_login_codes lc
    where lc.business_id = ${ps}.business_id and lc.used_at is not null
      and lc.used_at between ${ps}.created_at - interval '5 seconds' and ${ps}.created_at)
    then 'email_code'
  else 'api' end)`;

export interface PortalReportInput extends ReportWindowInput {
  /** An arrival key from `options.arrivals`: an email type, `email`, `email_code` or `api`. */
  arrivedFrom?: string | null;
  plan?: string | null;
}

export interface PortalFigures {
  /** Portal sessions signed in during the window (`login_at`). */
  visits: number;
  customers: number;
  visits_with_action: number;
  action_rate_bps: number | null;
  /** Succeeded portal payments in the window. */
  paid_minor: number;
  invoices_paid: number;
  recovered_from_failed_emails_minor: number;
  methods_added: number;
  /** Cancellations through the portal cancel flow (as the cancellation saves report). */
  cancellations: number;
  save_rate_bps: number | null;
}

export async function computePortalReport(
  organizationId: string,
  businessId: string,
  input: PortalReportInput,
) {
  const now = input.now ?? new Date();
  const pre = await withTenant(organizationId, async (tx) => {
    const w = await resolveWindow(tx, businessId, input.start, input.end);
    const money = await moneyContext(tx, businessId, input.currency);
    let planId: string | null = null;
    if (input.plan) {
      const [p] = (await tx.execute(
        sql`select id::text as id from products where business_id = ${businessId}::uuid and public_id = ${input.plan}`,
      )) as unknown as Array<{ id: string }>;
      if (!p) throw new HostedReportError(`No such plan: ${input.plan}`);
      planId = p.id;
    }
    return { w, money, planId };
  });
  const { w, money, planId } = pre;
  const ps = sql.raw("ps");
  const curStart = ts(w.cur.start);

  const result = await withTenant(organizationId, async (tx) => {
    const planFilter = planId
      ? sql`and exists (select 1 from subscriptions sb ${planProductJoin(sql`sb.id`, "pp")}
            where sb.customer_id = ps.customer_id and pp.id = ${planId}::uuid)`
      : sql``;
    const arrivalFilter = input.arrivedFrom
      ? sql`and ${arrivalSql(ps)} = ${input.arrivedFrom}`
      : sql``;
    const sessionFilters = sql`ps.business_id = ${businessId}::uuid
        and ${reportableCustomer(sql`ps.customer_id`)} ${planFilter} ${arrivalFilter}
        ${visitFilterSql("portal", sql`ps.id`, visitFilterOf(input))}`;

    // --- E: portal events (actions and payments) from the previous window's start to now.
    type ERow = { actor: string; type: string; detail: string | null; at: Date | string };
    const evRows = (await tx.execute(sql`
      select e.actor, e.type,
             case e.type
               when 'payment_source_role_changed' then e.data->'payment_source'->>'role'
               when 'payment_source_deleted' then e.data->'deletion_reason'->>'code'
               when 'subscription_changed' then e.data->>'settings_only'
             end as detail,
             e.created_at as at
      from events e
      where e.business_id = ${businessId}::uuid
        and e.type = any(${`{${ACTION_TYPES.join(",")}}`}::text[])
        and e.created_at >= ${ts(w.prev.start)}::timestamptz
        and e.actor like 'psess\\_%'`)) as unknown as ERow[];

    // Portal payments: each payment event names its payment.
    type PRow = {
      actor: string;
      at: Date | string;
      ok: boolean;
      amount_minor: string;
      currency: string;
      method: string | null;
      invoice: string | null;
      saved: boolean | null;
    };
    const payRows = (await tx.execute(sql`
      select e.actor, e.created_at as at, e.type = 'payment_succeeded' as ok,
             py.amount_minor::text as amount_minor, py.currency,
             coalesce(py.method_type, pm.type) as method,
             py.invoice_id::text as invoice,
             (select pi.saved_method_chosen from transactions t
                join payment_intents pi on pi.id = t.payment_intent_id
              where t.payment_id = py.id order by t.created_at limit 1) as saved
      from events e
      join payments py on py.public_id = e.data->'payment'->>'id' and py.business_id = e.business_id
      left join payment_methods pm on pm.id = py.payment_method_id
      where e.business_id = ${businessId}::uuid
        and e.type in ('payment_succeeded', 'payment_failed')
        and e.created_at >= ${ts(w.prev.start)}::timestamptz and e.created_at < ${ts(w.cur.end)}::timestamptz
        and e.actor like 'psess\\_%'`)) as unknown as PRow[];

    const actors = [...new Set([...evRows.map((r) => r.actor), ...payRows.map((r) => r.actor)])];

    // --- S: the sessions behind every visit and every event, with the filters applied.
    type SRow = {
      public_id: string;
      customer: string;
      customer_public_id: string;
      first_name: string | null;
      last_name: string | null;
      company: string | null;
      email: string | null;
      login_at: Date | string | null;
      arrival: string;
    };
    const sessRows = (await tx.execute(sql`
      select ps.public_id, ps.customer_id::text as customer, c.public_id as customer_public_id,
             c.first_name, c.last_name, c.company, c.email,
             ps.login_at, ${arrivalSql(ps)} as arrival
      from portal_sessions ps
      join customers c on c.id = ps.customer_id
      where ${sessionFilters}
        and ((ps.login_at >= ${ts(w.prev.start)}::timestamptz and ps.login_at < ${ts(w.cur.end)}::timestamptz)
             or ps.public_id = any(${`{${actors.join(",")}}`}::text[]))`)) as unknown as SRow[];
    const sessions = new Map(sessRows.map((r) => [r.public_id, r]));

    // --- Funnel: links made in the window, opened, and with an action.
    const [made] = (await tx.execute(sql`
      select count(*)::int as made, count(*) filter (where ps.login_at is not null)::int as opened,
             coalesce(array_agg(ps.public_id) filter (where ps.login_at is not null), '{}') as opened_ids
      from portal_sessions ps
      where ${sessionFilters}
        and ps.created_at >= ${curStart}::timestamptz and ps.created_at < ${ts(w.cur.end)}::timestamptz`)) as unknown as Array<{
      made: number;
      opened: number;
      opened_ids: string[];
    }>;

    // --- Funnel and arrival options: every arrival seen over both windows, unfiltered.
    const arrivalOptions = (await tx.execute(sql`
      select ${arrivalSql(ps)} as arrival, count(*)::int as n
      from portal_sessions ps
      where ps.business_id = ${businessId}::uuid and ps.login_at >= ${ts(w.prev.start)}::timestamptz
      group by 1 order by 2 desc`)) as unknown as Array<{ arrival: string; n: number }>;

    // --- Right now.
    const since = new Date(now.getTime() - LIVE_MINUTES * 60_000);
    const [live] = (await tx.execute(sql`
      select count(*) filter (where ps.logout_at is null
               and ps.last_used_at >= ${ts(new Date(now.getTime() - ACTIVE_MINUTES * 60_000))}::timestamptz)::int as active,
             count(*) filter (where ps.login_at >= ${ts(since)}::timestamptz)::int as visits
      from portal_sessions ps
      where ${sessionFilters} and (ps.last_used_at >= ${ts(since)}::timestamptz or ps.login_at >= ${ts(since)}::timestamptz)`)) as unknown as Array<{
      active: number;
      visits: number;
    }>;
    const perMinute = (await tx.execute(sql`
      select floor(extract(epoch from (${ts(now)}::timestamptz - ps.login_at)) / 60)::int as m, count(*)::int as n
      from portal_sessions ps
      where ${sessionFilters} and ps.login_at >= ${ts(since)}::timestamptz and ps.login_at <= ${ts(now)}::timestamptz
      group by 1`)) as unknown as Array<{ m: number; n: number }>;

    // First-party visit tracking (storefront-analytics), under the same filters.
    const tracking = await portalTracking(tx, {
      businessId,
      from: w.cur.start,
      to: w.cur.end,
      sessionWhere: sessionFilters,
      filter: visitFilterOf(input),
    });
    const countryOptions = await trackedCountries(tx, businessId, "portal", w.prev.start);

    return {
      evRows,
      payRows,
      sessions,
      made,
      arrivalOptions,
      live,
      perMinute,
      tracking,
      countryOptions,
    };
  });

  // Business-zone day key of an instant, matching resolveBuckets' `YYYY-MM-DD 00:00` keys.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: w.tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const keyOf = (d: Date | string) => `${fmt.format(new Date(d))} 00:00`;
  const inCur = (d: Date | string) => {
    const t = new Date(d).getTime();
    return t >= w.cur.start.getTime() && t < w.cur.end.getTime();
  };
  const inPrev = (d: Date | string) => {
    const t = new Date(d).getTime();
    return t >= w.prev.start.getTime() && t < w.prev.end.getTime();
  };

  const { evRows, payRows, sessions } = result;

  // Actions of each session (ever), and actions in each window.
  const actionOf = (r: { type: string; detail: string | null }): PortalActionKey | null => {
    for (const a of PORTAL_ACTIONS) {
      if (!(a.types as readonly string[]).includes(r.type)) continue;
      if ("detail" in a && r.detail !== a.detail) continue;
      if (r.type === "subscription_changed" && r.detail === "true") continue;
      return a.key;
    }
    return null;
  };
  const actionsBySession = new Map<string, Set<PortalActionKey>>();
  for (const r of evRows) {
    if (!sessions.has(r.actor)) continue;
    const k = actionOf(r);
    if (!k) continue;
    const set = actionsBySession.get(r.actor) ?? new Set();
    set.add(k);
    actionsBySession.set(r.actor, set);
  }

  const visitsIn = (inWin: (d: Date | string) => boolean) =>
    [...sessions.values()].filter((s) => s.login_at != null && inWin(s.login_at));

  const failedEmails = new Set<string>(FAILED_PAYMENT_EMAILS);
  const savesCur = await cancellationSaves(
    organizationId,
    businessId,
    w.cur.start,
    w.cur.end,
    planId
      ? sql`exists (select 1 from subscriptions sb ${planProductJoin(sql`sb.id`, "pp")}
        where sb.id = ${sql.raw('"retention_events"."subscription_id"')} and pp.id = ${planId}::uuid)`
      : undefined,
  );
  const savesPrev = input.compare
    ? await cancellationSaves(
        organizationId,
        businessId,
        w.prev.start,
        w.prev.end,
        planId
          ? sql`exists (select 1 from subscriptions sb ${planProductJoin(sql`sb.id`, "pp")}
            where sb.id = ${sql.raw('"retention_events"."subscription_id"')} and pp.id = ${planId}::uuid)`
          : undefined,
      )
    : null;

  const paymentsIn = (inWin: (d: Date | string) => boolean) =>
    payRows.filter((p) => sessions.has(p.actor) && inWin(p.at));
  const amountOf = (p: PRowLike) =>
    money.convert(Number(p.amount_minor), p.currency, new Date(p.at)) ?? 0;

  const figures = (inWin: (d: Date | string) => boolean, saves: typeof savesCur): PortalFigures => {
    const visits = visitsIn(inWin);
    const withAction = visits.filter(
      (v) => (actionsBySession.get(v.public_id)?.size ?? 0) > 0,
    ).length;
    const pays = paymentsIn(inWin).filter((p) => p.ok);
    return {
      visits: visits.length,
      customers: new Set(visits.map((v) => v.customer)).size,
      visits_with_action: withAction,
      action_rate_bps: pct(withAction, visits.length),
      paid_minor: pays.reduce((a, p) => a + amountOf(p), 0),
      invoices_paid: new Set(pays.map((p) => p.invoice).filter(Boolean)).size,
      recovered_from_failed_emails_minor: pays
        .filter((p) => failedEmails.has(sessions.get(p.actor)!.arrival))
        .reduce((a, p) => a + amountOf(p), 0),
      methods_added: evRows.filter(
        (r) => sessions.has(r.actor) && inWin(r.at) && actionOf(r) === "added_method",
      ).length,
      cancellations: saves.inWindow.filter((r) => r.kind === "cancelled").length,
      save_rate_bps: saves.rateBps,
    };
  };
  const totals = figures(inCur, savesCur);
  const previous = savesPrev ? figures(inPrev, savesPrev) : null;

  // Per-day series.
  const zero = () => new Map(w.buckets.map((b) => [b.key, 0]));
  const visitsDay = zero();
  const actedDay = zero();
  const customersDay = new Map<string, Set<string>>();
  for (const v of visitsIn(inCur)) {
    const k = keyOf(v.login_at!);
    visitsDay.set(k, (visitsDay.get(k) ?? 0) + 1);
    if ((actionsBySession.get(v.public_id)?.size ?? 0) > 0)
      actedDay.set(k, (actedDay.get(k) ?? 0) + 1);
    const set = customersDay.get(k) ?? new Set();
    set.add(v.customer);
    customersDay.set(k, set);
  }
  const paidDay = zero();
  const recoveredDay = zero();
  for (const p of paymentsIn(inCur)) {
    if (!p.ok) continue;
    const k = keyOf(p.at);
    paidDay.set(k, (paidDay.get(k) ?? 0) + amountOf(p));
    if (failedEmails.has(sessions.get(p.actor)!.arrival))
      recoveredDay.set(k, (recoveredDay.get(k) ?? 0) + amountOf(p));
  }
  const addedDay = zero();
  const actionCounts = new Map<PortalActionKey, number>(PORTAL_ACTIONS.map((a) => [a.key, 0]));
  const deleteReasons = new Map<string, number>();
  for (const r of evRows) {
    if (!sessions.has(r.actor) || !inCur(r.at)) continue;
    const k = actionOf(r);
    if (!k) continue;
    actionCounts.set(k, (actionCounts.get(k) ?? 0) + 1);
    if (k === "added_method") addedDay.set(keyOf(r.at), (addedDay.get(keyOf(r.at)) ?? 0) + 1);
    if (k === "deleted_method")
      deleteReasons.set(r.detail ?? "none", (deleteReasons.get(r.detail ?? "none") ?? 0) + 1);
  }
  const cancelDay = zero();
  for (const r of savesCur.inWindow)
    if (r.kind === "cancelled")
      cancelDay.set(keyOf(r.createdAt), (cancelDay.get(keyOf(r.createdAt)) ?? 0) + 1);
  const prevVisitsDay = new Map<string, number>();
  const prevActedDay = new Map<string, number>();
  if (input.compare)
    for (const v of visitsIn(inPrev)) {
      const k = keyOf(v.login_at!);
      prevVisitsDay.set(k, (prevVisitsDay.get(k) ?? 0) + 1);
      if ((actionsBySession.get(v.public_id)?.size ?? 0) > 0)
        prevActedDay.set(k, (prevActedDay.get(k) ?? 0) + 1);
    }

  // How customers arrive.
  const arrivalMap = new Map<
    string,
    { visits: number; customers: Set<string>; acted: number; paid: number }
  >();
  for (const v of visitsIn(inCur)) {
    const a = arrivalMap.get(v.arrival) ?? { visits: 0, customers: new Set(), acted: 0, paid: 0 };
    a.visits += 1;
    a.customers.add(v.customer);
    if ((actionsBySession.get(v.public_id)?.size ?? 0) > 0) a.acted += 1;
    arrivalMap.set(v.arrival, a);
  }
  for (const p of paymentsIn(inCur)) {
    if (!p.ok) continue;
    const s = sessions.get(p.actor)!;
    const a = arrivalMap.get(s.arrival) ?? { visits: 0, customers: new Set(), acted: 0, paid: 0 };
    a.paid += amountOf(p);
    arrivalMap.set(s.arrival, a);
  }
  const arrivals = [...arrivalMap.entries()]
    .map(([arrival, a]) => ({
      arrival,
      visits: a.visits,
      customers: a.customers.size,
      visits_with_action: a.acted,
      action_rate_bps: pct(a.acted, a.visits),
      paid_minor: a.paid,
    }))
    .sort((a, b) => b.visits - a.visits);

  // Funnel: links made in the window → opened → took an action.
  const made = result.made;
  const acted = (made?.opened_ids ?? []).filter(
    (id) => (actionsBySession.get(id)?.size ?? 0) > 0,
  ).length;
  const funnel = [
    { step: "made", label: "Links made", sessions: made?.made ?? 0 },
    { step: "opened", label: "Opened", sessions: made?.opened ?? 0 },
    { step: "acted", label: "Took an action", sessions: acted },
  ];

  // Payments in the portal, by method.
  const methodMap = new Map<
    string,
    { method: string; paid: number; amount_minor: number; failed: number }
  >();
  let savedCount = 0;
  let newCount = 0;
  for (const p of paymentsIn(inCur)) {
    const method = p.method ?? "unknown";
    const m = methodMap.get(method) ?? { method, paid: 0, amount_minor: 0, failed: 0 };
    if (p.ok) {
      m.paid += 1;
      m.amount_minor += amountOf(p);
      if (p.saved === true) savedCount += 1;
      else if (p.saved === false) newCount += 1;
    } else m.failed += 1;
    methodMap.set(method, m);
  }
  const portalPayments = {
    saved_method: savedCount,
    new_method: newCount,
    methods: [...methodMap.values()]
      .map((m) => ({ ...m, success_rate_bps: pct(m.paid, m.paid + m.failed) }))
      .sort((a, b) => b.paid - a.paid || b.failed - a.failed),
  };

  // Retention: the cancel flow.
  const inW = savesCur.inWindow;
  const accepted = inW.filter((r) => r.kind === "offer_accepted");
  const cancelled = inW.filter((r) => r.kind === "cancelled");
  const retention = {
    hold_days: SAVE_HOLD_DAYS,
    started: accepted.length + cancelled.length,
    saw_offer: accepted.length + cancelled.filter((r) => r.offersShown).length,
    accepted: accepted.length,
    saved: savesCur.saves.length,
    /** Cancels that count against the save rate: saves ÷ (saves + lost). */
    lost: savesCur.lost.length,
    cancelled: cancelled.length,
    offers: [...new Set(accepted.map((r) => r.offer ?? "other"))].map((offer) => ({
      offer,
      accepted: accepted.filter((r) => (r.offer ?? "other") === offer).length,
      saved: savesCur.saves.filter((r) => (r.offer ?? "other") === offer).length,
    })),
    reasons: [...new Set(inW.map((r) => r.reasonCode))]
      .map((reason) => ({
        reason,
        started: inW.filter((r) => r.reasonCode === reason).length,
        saved: savesCur.saves.filter((r) => r.reasonCode === reason).length,
      }))
      .sort((a, b) => b.started - a.started),
  };

  // Recent visits: the newest ten in the window.
  const paidBySession = new Map<string, number>();
  for (const p of paymentsIn(inCur))
    if (p.ok) paidBySession.set(p.actor, (paidBySession.get(p.actor) ?? 0) + amountOf(p));
  const recent = visitsIn(inCur)
    .sort((a, b) => new Date(b.login_at!).getTime() - new Date(a.login_at!).getTime())
    .slice(0, 10)
    .map((v) => ({
      session: v.public_id,
      at: new Date(v.login_at!).toISOString(),
      customer: v.customer_public_id,
      customer_name: accountHolderName({
        firstName: v.first_name,
        lastName: v.last_name,
        company: v.company,
        email: v.email,
      }),
      arrival: v.arrival,
      actions: PORTAL_ACTIONS.filter((a) => actionsBySession.get(v.public_id)?.has(a.key)).map(
        (a) => a.key,
      ),
      paid_minor: paidBySession.get(v.public_id) ?? 0,
    }));

  const minutes = Array.from(
    { length: LIVE_MINUTES },
    (_, i) => result.perMinute.find((r) => r.m === LIVE_MINUTES - 1 - i)?.n ?? 0,
  );
  const at = (m: Map<string, number>) => w.buckets.map((b) => m.get(b.key) ?? 0);

  return {
    start: input.start,
    end: input.end,
    previous_start: w.prevDays.start,
    previous_end: w.prevDays.end,
    timezone: w.tz,
    currency: money.reporting,
    missing_rates: [...money.missing].sort(),
    filters: {
      arrived_from: input.arrivedFrom ?? null,
      plan: input.plan ?? null,
      country: input.country ?? null,
      device: input.device ?? null,
    },
    options: {
      arrivals: result.arrivalOptions.map((r) => r.arrival),
      countries: result.countryOptions,
      devices: [...DEVICES],
    },
    live: {
      active_now: result.live?.active ?? 0,
      visits_last_30_minutes: result.live?.visits ?? 0,
      per_minute: minutes,
    },
    totals,
    previous,
    days: days(w.buckets),
    series: {
      visits: at(visitsDay),
      customers: w.buckets.map((b) => customersDay.get(b.key)?.size ?? 0),
      visits_with_action: at(actedDay),
      action_rate_bps: w.buckets.map((b) =>
        pct(actedDay.get(b.key) ?? 0, visitsDay.get(b.key) ?? 0),
      ),
      paid_minor: at(paidDay),
      recovered_from_failed_emails_minor: at(recoveredDay),
      methods_added: at(addedDay),
      cancellations: at(cancelDay),
    },
    previous_series: input.compare
      ? {
          visits: w.prevBuckets.map((b) => prevVisitsDay.get(b.key) ?? 0),
          visits_with_action: w.prevBuckets.map((b) => prevActedDay.get(b.key) ?? 0),
        }
      : null,
    funnel,
    arrivals,
    actions: PORTAL_ACTIONS.map((a) => ({
      action: a.key,
      label: a.label,
      count: actionCounts.get(a.key) ?? 0,
    })),
    payments: portalPayments,
    payment_methods: {
      added: actionCounts.get("added_method") ?? 0,
      deleted: actionCounts.get("deleted_method") ?? 0,
      made_primary: actionCounts.get("made_primary") ?? 0,
      delete_reasons: [...deleteReasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    },
    plan_changes: {
      changed_plan: actionCounts.get("changed_plan") ?? 0,
      paused: actionCounts.get("paused") ?? 0,
      cancelled: actionCounts.get("cancelled") ?? 0,
    },
    retention,
    recent,
    tracking: result.tracking,
  };
}

type PRowLike = { amount_minor: string; currency: string; at: Date | string };

export type PortalReport = Awaited<ReturnType<typeof computePortalReport>>;
