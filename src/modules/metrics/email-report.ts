import { sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { accountHolderName } from "@/modules/customers/names";
import { reportableCustomer } from "./reportable";
import { emailLinkMatch } from "./hosted-page-figures";
import {
  HostedReportError,
  FAILED_PAYMENT_EMAILS,
  arrivalSql,
  computePortalReport,
  dayKey,
  days,
  moneyContext,
  pct,
  resolveWindow,
} from "./hosted-page-reports";
import { DELIVERING_TRANSPORTS } from "@/modules/emails/service";
import { resolveEmailConfig } from "@/modules/emails/config";

/**
 * The email report page: every figure for one business over a window of business-zone days,
 * with the same-length window before it for the compare deltas.
 *
 * One definition per figure:
 *  - A status count is the delivery report's (`emails/service.ts`): `delivered` is `sent` on a
 *    transport that delivers; a complaint is `bounced` + `bounce_type = complaint` and counts
 *    only as `complained`.
 *  - A portal link's email, and a visit "from an email", use `emailLinkMatch` and the portal
 *    report's `arrivalSql`. "Recovered by failed-payment emails" IS the portal report's figure.
 *  - An email counts in the day we queued it.
 *  - Opens and clicks count only emails sent while the business had tracking on
 *    (`engagement_tracked_at`), only delivered ones, and once per email. A person's click
 *    also counts as an open. Machine opens (privacy proxies, scanners, prefetch) are counted
 *    apart and never reach a rate. A period with no tracked email has no rate (null).
 */

/** An invoice paid within this many days after a delivered email that asked for it counts as paid after it. */
export const PAID_AFTER_DAYS = 14;

/** The emails that ask the customer to pay or to act, so a payment after one can be tied to it. */
export const PAYMENT_ASK_EMAILS = [
  "invoice_to_pay",
  "invoice_overdue",
  "payment_due_reminder",
  ...FAILED_PAYMENT_EMAILS,
] as const;

/** The dunning sequence keeps this many positions; later emails count at the last one. */
const SEQUENCE_CAP = 4;
const LIVE_MINUTES = 30;
const TOP = 8;

export interface EmailReportInput {
  start: string;
  end: string;
  compare?: boolean;
  currency?: string | null;
  /** Only this email type. */
  type?: string | null;
  /** Only this transport (`smtp`, `ses`, …); `unknown` = the transport was not recorded. */
  transport?: string | null;
  /** Recent emails to return (default 10). */
  recent?: number;
  now?: Date;
}

export interface EmailFigures {
  queued: number;
  delivered: number;
  not_sent: number;
  pending: number;
  failed: number;
  bounced: number;
  complained: number;
  skipped: number;
  /** Emails that reached an outcome: delivered + bounced + complained + failed. */
  attempted: number;
  delivered_bps: number | null;
  bounce_bps: number | null;
  complaint_bps: number | null;
  /** Portal visits whose link came from an email (this window, by login). Null when a transport filter applies. */
  link_visits: number | null;
  recovered_minor: number | null;
  /** Delivered emails sent with tracking on: what the open and click rates are taken over. */
  tracked: number;
  /** Of those, opened by a person (a click counts as an open). */
  opened: number;
  clicked: number;
  /** Of those, opened by a privacy proxy or scanner and NOT counted in `opened`. */
  machine_opened: number;
  open_bps: number | null;
  click_bps: number | null;
}

/** Open and click columns; zero for an email sent without tracking. */
type Eng = { tracked: number; opened: number; clicked: number; machine_opened: number };
const ZERO_ENG: Eng = { tracked: 0, opened: 0, clicked: 0, machine_opened: 0 };

type Counts = {
  queued: number;
  delivered: number;
  not_sent: number;
  pending: number;
  failed: number;
  bounced: number;
  complained: number;
  skipped: number;
};

const ZERO: Counts = {
  queued: 0,
  delivered: 0,
  not_sent: 0,
  pending: 0,
  failed: 0,
  bounced: 0,
  complained: 0,
  skipped: 0,
};

const ts = (d: Date) => d.toISOString();
const SQL_TRANSPORTS = sql`(${sql.join(
  DELIVERING_TRANSPORTS.map((t) => sql`${t}`),
  sql`, `,
)})`;

/** The status counts, as `count(*) filter` columns over `email_messages` aliased `em`. */
const countColumns = sql`
  count(*)::int as queued,
  count(*) filter (where em.status = 'sent' and em.transport in ${SQL_TRANSPORTS})::int as delivered,
  count(*) filter (where em.status = 'sent' and (em.transport is null or em.transport not in ${SQL_TRANSPORTS}))::int as not_sent,
  count(*) filter (where em.status = 'pending')::int as pending,
  count(*) filter (where em.status = 'failed')::int as failed,
  count(*) filter (where em.status = 'bounced' and em.bounce_type is distinct from 'complaint')::int as bounced,
  count(*) filter (where em.bounce_type = 'complaint')::int as complained,
  count(*) filter (where em.status = 'skipped')::int as skipped`;

/** Delivered AND sent with tracking on: the emails a rate is taken over. */
const trackedDelivered = sql`em.status = 'sent' and em.transport in ${SQL_TRANSPORTS}
  and em.engagement_tracked_at is not null`;
const engColumns = sql`
  count(*) filter (where ${trackedDelivered})::int as tracked,
  count(*) filter (where ${trackedDelivered}
    and (em.first_opened_at is not null or em.first_clicked_at is not null))::int as opened,
  count(*) filter (where ${trackedDelivered} and em.first_clicked_at is not null)::int as clicked,
  count(*) filter (where ${trackedDelivered} and exists (
    select 1 from email_engagements g
    where g.email_message_id = em.id and g.kind = 'open' and g.machine))::int as machine_opened`;

const engRates = <T extends Eng>(e: T) => ({
  ...e,
  open_bps: pct(e.opened, e.tracked),
  click_bps: pct(e.clicked, e.tracked),
});

/** A stored error, cut short, with every address in it removed. */
const reasonSql = sql`nullif(left(regexp_replace(regexp_replace(em.last_error,
  '[^[:space:]<>"]+@[^[:space:]<>"]+', '<address>', 'g'), '[[:space:]]+', ' ', 'g'), 160), '')`;

const attempted = (c: Counts) => c.delivered + c.bounced + c.complained + c.failed;
const figuresOf = (
  c: Counts & Eng,
  linkVisits: number | null,
  recovered: number | null,
): EmailFigures => {
  const a = attempted(c);
  return {
    ...engRates(c),
    ...c,
    attempted: a,
    delivered_bps: pct(c.delivered, a),
    bounce_bps: pct(c.bounced, a),
    complaint_bps: pct(c.complained, a),
    link_visits: linkVisits,
    recovered_minor: recovered,
  };
};

type Row = Counts & Partial<Eng> & { period: "c" | "p"; bkey: string | null; total: boolean };

export async function computeEmailReport(
  organizationId: string,
  businessId: string,
  input: EmailReportInput,
) {
  const now = input.now ?? new Date();
  const type = input.type ?? null;
  const transport = input.transport ?? null;
  const recentLimit = Math.min(Math.max(input.recent ?? 10, 1), 500);

  const data = await withTenant(organizationId, async (tx) => {
    const w = await resolveWindow(tx, businessId, input.start, input.end);
    const curStart = ts(w.cur.start);
    const money = await moneyContext(tx, businessId, input.currency);
    const inWindow = (a: Date, b: Date, t = "em") =>
      sql`${sql.raw(t)}.created_at >= ${ts(a)}::timestamptz and ${sql.raw(t)}.created_at < ${ts(b)}::timestamptz`;
    const filtersOf = (t: string) => {
      const a = sql.raw(t);
      return sql`${a}.business_id = ${businessId}::uuid
      ${type ? sql`and ${a}.type = ${type}` : sql``}
      ${
        transport
          ? transport === "unknown"
            ? sql`and ${a}.transport is null`
            : sql`and ${a}.transport = ${transport}`
          : sql``
      }`;
    };
    const filters = filtersOf("em");
    const cur = inWindow(w.cur.start, w.cur.end);

    // --- Status counts per period and per day.
    const q1 = (await tx.execute(sql`
      select em.period, em.bkey, grouping(em.bkey) = 1 as total, ${countColumns}, ${engColumns}
      from (
        select e.*, case when e.created_at >= ${curStart}::timestamptz then 'c' else 'p' end as period,
               ${dayKey(sql`e.created_at`, w.tz)} as bkey
        from email_messages e
        where ${filtersOf("e")} and ${inWindow(w.prev.start, w.cur.end, "e")}
      ) em
      group by grouping sets ((em.period, em.bkey), (em.period))`)) as unknown as Row[];
    const total = (p: "c" | "p"): Counts & Eng => ({
      ...ZERO,
      ...ZERO_ENG,
      ...(q1.find((r) => r.period === p && r.total) ?? {}),
    });
    const dayRows = (p: "c" | "p") =>
      new Map(q1.filter((r) => r.period === p && !r.total).map((r) => [r.bkey!, r]));

    // --- By type, transport and recipient domain.
    const byType = (await tx.execute(sql`
      select em.type, ${countColumns}, ${engColumns},
        count(distinct em.invoice_id) filter (
          where em.type = any(${`{${PAYMENT_ASK_EMAILS.join(",")}}`}::text[])
            and em.status = 'sent' and em.transport in ${SQL_TRANSPORTS}
            and i.status = 'paid' and i.paid_at >= em.created_at
            and i.paid_at < em.created_at + make_interval(days => ${PAID_AFTER_DAYS}))::int as paid_after
      from email_messages em
      left join invoices i on i.id = em.invoice_id
      where ${filters} and ${cur}
      group by em.type order by count(*) desc, em.type`)) as unknown as Array<
      Counts & Eng & { type: string; paid_after: number }
    >;
    const [paidAll] = (await tx.execute(sql`
      select count(distinct em.invoice_id)::int as n
      from email_messages em join invoices i on i.id = em.invoice_id
      where ${filters} and ${cur}
        and em.type = any(${`{${PAYMENT_ASK_EMAILS.join(",")}}`}::text[])
        and em.status = 'sent' and em.transport in ${SQL_TRANSPORTS}
        and i.status = 'paid' and i.paid_at >= em.created_at
        and i.paid_at < em.created_at + make_interval(days => ${PAID_AFTER_DAYS})`)) as unknown as Array<{
      n: number;
    }>;

    const byTransport = (await tx.execute(sql`
      select coalesce(em.transport, 'unknown') as transport, ${countColumns}
      from email_messages em where ${filters} and ${cur}
      group by 1 order by count(*) desc, 1`)) as unknown as Array<Counts & { transport: string }>;
    const byDomain = (await tx.execute(sql`
      select lower(split_part(em.to_address, '@', 2)) as domain, ${countColumns}
      from email_messages em where ${filters} and ${cur} and position('@' in em.to_address) > 0
      group by 1
      having count(*) filter (where em.status in ('sent', 'bounced', 'failed')) > 0
      order by count(*) filter (where em.status in ('sent', 'bounced', 'failed')) desc, 1
      limit 10`)) as unknown as Array<Counts & { domain: string }>;

    // --- Why emails failed, bounced or were skipped.
    const reasons = (await tx.execute(sql`
      select case when em.bounce_type = 'complaint' then 'complained'
                  when em.status = 'bounced' then 'bounced' else 'failed' end as outcome,
             ${reasonSql} as reason, count(*)::int as n
      from email_messages em
      where ${filters} and ${cur} and (em.status in ('failed', 'bounced') or em.bounce_type = 'complaint')
      group by 1, 2 order by 3 desc, 1, 2 limit ${TOP}`)) as unknown as Array<{
      outcome: "failed" | "bounced" | "complained";
      reason: string | null;
      n: number;
    }>;
    const skipReasons = (await tx.execute(sql`
      select ${reasonSql} as reason, count(*)::int as n
      from email_messages em
      where ${filters} and ${cur} and em.status = 'skipped'
      group by 1 order by 2 desc, 1 limit ${TOP}`)) as unknown as Array<{
      reason: string | null;
      n: number;
    }>;

    // --- Dunning sequence: the Nth failed-payment email of an invoice, and whether the invoice
    // was paid after it and before the next one.
    const dunning = (await tx.execute(sql`
      with seq as (
        select em.id, em.type, em.created_at, em.invoice_id,
               row_number() over w as pos, lead(em.created_at) over w as next_at
        from email_messages em
        where em.business_id = ${businessId}::uuid and em.invoice_id is not null
          and em.type = any(${`{${FAILED_PAYMENT_EMAILS.join(",")}}`}::text[])
          and em.status = 'sent' and em.transport in ${SQL_TRANSPORTS}
          and em.created_at >= ${ts(new Date(w.cur.start.getTime() - 120 * 86_400_000))}::timestamptz
          and em.created_at < ${ts(w.cur.end)}::timestamptz
          ${transport ? (transport === "unknown" ? sql`and em.transport is null` : sql`and em.transport = ${transport}`) : sql``}
        window w as (partition by em.invoice_id order by em.created_at, em.id)
      )
      select least(seq.pos, ${SEQUENCE_CAP})::int as pos, count(*)::int as sent,
             count(*) filter (
               where i.status = 'paid' and i.paid_at >= seq.created_at
                 and (seq.next_at is null or i.paid_at < seq.next_at)
                 and i.paid_at < seq.created_at + make_interval(days => ${PAID_AFTER_DAYS}))::int as recovered
      from seq join invoices i on i.id = seq.invoice_id
      where seq.created_at >= ${curStart}::timestamptz ${type ? sql`and seq.type = ${type}` : sql``}
      group by 1 order by 1`)) as unknown as Array<{
      pos: number;
      sent: number;
      recovered: number;
    }>;

    // --- Portal visits whose link came from an email: one definition, the portal report's.
    const ps = sql.raw("ps");
    const arrivalRows = (await tx.execute(sql`
      select case when ps.login_at >= ${curStart}::timestamptz then 'c' else 'p' end as period,
             ${dayKey(sql`ps.login_at`, w.tz)} as bkey, ${arrivalSql(ps)} as arrival, count(*)::int as n
      from portal_sessions ps
      where ps.business_id = ${businessId}::uuid and ${reportableCustomer(sql`ps.customer_id`)}
        and ps.login_at >= ${ts(w.prev.start)}::timestamptz and ps.login_at < ${ts(w.cur.end)}::timestamptz
      group by 1, 2, 3`)) as unknown as Array<{
      period: "c" | "p";
      bkey: string;
      arrival: string;
      n: number;
    }>;
    // Funnel: links of emails queued in the window that were opened.
    const [opened] = (await tx.execute(sql`
      select count(*) filter (where ps.login_at is not null)::int as n
      from portal_sessions ps
      where ps.business_id = ${businessId}::uuid and ps.access_kind = 'email'
        and ${reportableCustomer(sql`ps.customer_id`)}
        and ps.created_at >= ${curStart}::timestamptz and ps.created_at < ${ts(w.cur.end)}::timestamptz
        ${type ? sql`and ${arrivalSql(ps)} = ${type}` : sql``}`)) as unknown as Array<{
      n: number;
    }>;

    // --- Most-clicked links: people's clicks on emails queued in the window.
    const topLinks = (await tx.execute(sql`
      select g.link_label as label, g.link_host as host, g.link_path as path,
             count(*)::int as clicks, count(distinct g.email_message_id)::int as emails
      from email_engagements g join email_messages em on em.id = g.email_message_id
      where g.kind = 'click' and not g.machine and ${filters} and ${cur}
      group by 1, 2, 3 order by 4 desc, 5 desc, 1, 2, 3 limit ${TOP}`)) as unknown as Array<{
      label: string | null;
      host: string | null;
      path: string | null;
      clicks: number;
      emails: number;
    }>;
    const [trk] = (await tx.execute(sql`
      select min(em.engagement_tracked_at) as since from email_messages em
      where em.business_id = ${businessId}::uuid and em.engagement_tracked_at is not null`)) as unknown as Array<{
      since: Date | string | null;
    }>;
    const [bizCfg] = (await tx.execute(sql`
      select b.email_config as cfg from businesses b where b.id = ${businessId}::uuid`)) as unknown as Array<{
      cfg: unknown;
    }>;

    // --- Live: waiting now, and queued per minute.
    const since = new Date(now.getTime() - LIVE_MINUTES * 60_000);
    const [live] = (await tx.execute(sql`
      select count(*) filter (where em.status = 'pending')::int as waiting,
             count(*) filter (where em.created_at >= ${ts(since)}::timestamptz)::int as queued
      from email_messages em where ${filters}
        and (em.status = 'pending' or em.created_at >= ${ts(since)}::timestamptz)`)) as unknown as Array<{
      waiting: number;
      queued: number;
    }>;
    const perMinute = (await tx.execute(sql`
      select floor(extract(epoch from (${ts(now)}::timestamptz - em.created_at)) / 60)::int as m, count(*)::int as n
      from email_messages em
      where ${filters} and em.created_at >= ${ts(since)}::timestamptz and em.created_at <= ${ts(now)}::timestamptz
      group by 1`)) as unknown as Array<{ m: number; n: number }>;

    // --- Filter options: every type and transport seen over both windows, unfiltered.
    const opts = (await tx.execute(sql`
      select 't' as k, em.type as v from email_messages em
        where em.business_id = ${businessId}::uuid and ${inWindow(w.prev.start, w.cur.end)} group by 2
      union all
      select 'x', coalesce(em.transport, 'unknown') from email_messages em
        where em.business_id = ${businessId}::uuid and ${inWindow(w.prev.start, w.cur.end)} group by 2`)) as unknown as Array<{
      k: "t" | "x";
      v: string;
    }>;

    // --- Recent emails.
    const recent = (await tx.execute(sql`
      select em.public_id, em.created_at, em.type, em.status, em.bounce_type, em.transport,
             em.customer_id::text as customer_id, em.created_at as at,
             c.public_id as customer_public_id, c.first_name, c.last_name, c.company, c.email,
             (${trackedDelivered}) as tracked,
             (em.first_opened_at is not null or em.first_clicked_at is not null) as opened_by_person,
             (em.first_clicked_at is not null) as clicked_by_person,
             (em.type = any(${`{${PAYMENT_ASK_EMAILS.join(",")}}`}::text[])
               and em.status = 'sent' and em.transport in ${SQL_TRANSPORTS}
               and i.status = 'paid' and i.paid_at >= em.created_at
               and i.paid_at < em.created_at + make_interval(days => ${PAID_AFTER_DAYS})) as paid_after
      from email_messages em
      left join customers c on c.id = em.customer_id
      left join invoices i on i.id = em.invoice_id
      where ${filters} and ${cur}
      order by em.created_at desc, em.id desc limit ${recentLimit}`)) as unknown as Array<{
      public_id: string;
      at: Date | string;
      type: string;
      status: string;
      bounce_type: string | null;
      transport: string | null;
      customer_id: string | null;
      customer_public_id: string | null;
      first_name: string | null;
      last_name: string | null;
      company: string | null;
      email: string | null;
      paid_after: boolean | null;
      tracked: boolean;
      opened_by_person: boolean;
      clicked_by_person: boolean;
    }>;
    // A link opened: the session made with this email, in the portal report's terms.
    const recentIds = recent.filter((r) => r.customer_id);
    const opened10 = recentIds.length
      ? ((await tx.execute(sql`
          select em.public_id
          from email_messages em
          where em.public_id = any(${`{${recentIds.map((r) => r.public_id).join(",")}}`}::text[])
            and exists (
              select 1 from portal_sessions ps
              where ps.access_kind = 'email' and ps.login_at is not null
                and ${emailLinkMatch(ps, sql.raw("em"))} and ${arrivalSql(ps)} = em.type)`)) as unknown as Array<{
          public_id: string;
        }>)
      : [];

    return {
      w,
      money,
      q1,
      total,
      dayRows,
      byType,
      paidAll,
      byTransport,
      byDomain,
      reasons,
      skipReasons,
      dunning,
      arrivalRows,
      opened,
      topLinks,
      trk,
      bizCfg,
      live,
      perMinute,
      opts,
      recent,
      opened10,
    };
  });

  const { w } = data;
  const emailKey = (a: string) => a !== "api" && a !== "email_code";
  const visitsOf = (p: "c" | "p", pick?: (a: string) => boolean) =>
    data.arrivalRows
      .filter((r) => r.period === p && emailKey(r.arrival) && (pick ? pick(r.arrival) : true))
      .reduce((n, r) => n + r.n, 0);

  // Recovered by failed-payment emails: the portal report's own figure, filtered to the email
  // type when one is chosen. A transport filter has no meaning for portal payments.
  const failedKinds = new Set<string>(FAILED_PAYMENT_EMAILS);
  let portal: Awaited<ReturnType<typeof computePortalReport>> | null = null;
  if (!transport && (!type || failedKinds.has(type)))
    portal = await computePortalReport(organizationId, businessId, {
      start: input.start,
      end: input.end,
      compare: !!input.compare,
      currency: input.currency ?? null,
      arrivedFrom: type,
    });
  const linkVisits = (p: "c" | "p") =>
    transport ? null : visitsOf(p, type ? (a) => a === type : undefined);
  const recoveredNow = transport
    ? null
    : portal
      ? portal.totals.recovered_from_failed_emails_minor
      : 0;
  const recoveredPrev = transport
    ? null
    : portal
      ? (portal.previous?.recovered_from_failed_emails_minor ?? null)
      : 0;

  const totals = figuresOf(data.total("c"), linkVisits("c"), recoveredNow);
  const previous = input.compare
    ? figuresOf(data.total("p"), linkVisits("p"), recoveredPrev)
    : null;

  const cur = data.dayRows("c");
  const prev = data.dayRows("p");
  const at = <T>(f: (r: Row | undefined) => T) => w.buckets.map((b) => f(cur.get(b.key)));
  const linkDay = new Map<string, number>();
  for (const r of data.arrivalRows)
    if (r.period === "c" && emailKey(r.arrival) && (!type || r.arrival === type))
      linkDay.set(r.bkey, (linkDay.get(r.bkey) ?? 0) + r.n);
  const rateAt = (num: (r: Row) => number) => at((r) => (r ? pct(num(r), attempted(r)) : null));

  const portalDay = new Map(
    portal?.days.map((d, i) => [d.date, portal!.series.recovered_from_failed_emails_minor[i]!]),
  );
  const minutes = Array.from(
    { length: LIVE_MINUTES },
    (_, i) => data.perMinute.find((r) => r.m === LIVE_MINUTES - 1 - i)?.n ?? 0,
  );

  const withRates = <T extends Counts>(c: T) => {
    const a = attempted(c);
    return {
      ...c,
      attempted: a,
      delivered_bps: pct(c.delivered, a),
      bounce_bps: pct(c.bounced, a),
      complaint_bps: pct(c.complained, a),
    };
  };

  const statusOf = (r: (typeof data.recent)[number]) =>
    r.bounce_type === "complaint"
      ? "complained"
      : r.status === "sent"
        ? r.transport && (DELIVERING_TRANSPORTS as readonly string[]).includes(r.transport)
          ? "delivered"
          : "not_sent"
        : r.status;
  const trackedSince = data.trk?.since ?? null;
  const openedIds = new Set(data.opened10.map((r) => r.public_id));

  const funnel = [
    { step: "queued", label: "Queued", sessions: totals.queued },
    { step: "delivered", label: "Delivered to a mail server", sessions: totals.delivered },
    // Opens and clicks only where this period has tracked emails.
    ...(totals.tracked > 0
      ? [
          { step: "email_opened", label: "Opened", sessions: totals.opened },
          { step: "email_clicked", label: "Clicked a link", sessions: totals.clicked },
        ]
      : []),
    ...(transport
      ? []
      : [{ step: "opened", label: "Portal link opened", sessions: data.opened?.n ?? 0 }]),
    { step: "paid", label: "Invoice paid afterwards", sessions: data.paidAll?.n ?? 0 },
  ];

  return {
    start: input.start,
    end: input.end,
    previous_start: w.prevDays.start,
    previous_end: w.prevDays.end,
    timezone: w.tz,
    currency: data.money.reporting,
    missing_rates: portal?.missing_rates ?? [],
    filters: { type, transport },
    options: {
      types: data.opts
        .filter((o) => o.k === "t")
        .map((o) => o.v)
        .sort(),
      transports: data.opts
        .filter((o) => o.k === "x")
        .map((o) => o.v)
        .sort(),
    },
    live: {
      waiting: data.live?.waiting ?? 0,
      queued_last_30_minutes: data.live?.queued ?? 0,
      per_minute: minutes,
    },
    totals,
    previous,
    days: days(w.buckets),
    series: {
      queued: at((r) => r?.queued ?? 0),
      delivered: at((r) => r?.delivered ?? 0),
      problems: at((r) => (r ? r.failed + r.bounced + r.complained : 0)),
      delivered_bps: rateAt((r) => r.delivered),
      bounce_bps: rateAt((r) => r.bounced),
      complaint_bps: rateAt((r) => r.complained),
      open_bps: at((r) => (r ? pct(r.opened ?? 0, r.tracked ?? 0) : null)),
      click_bps: at((r) => (r ? pct(r.clicked ?? 0, r.tracked ?? 0) : null)),
      failed: at((r) => r?.failed ?? 0),
      skipped: at((r) => r?.skipped ?? 0),
      link_visits: transport ? null : w.buckets.map((b) => linkDay.get(b.key) ?? 0),
      recovered_minor: transport ? null : w.buckets.map((b) => portalDay.get(b.t) ?? 0),
    },
    previous_series: input.compare
      ? { queued: w.prevBuckets.map((b) => prev.get(b.key)?.queued ?? 0) }
      : null,
    funnel,
    tracking: {
      /** The business's switch now. */
      enabled: resolveEmailConfig({ emailConfig: data.bizCfg?.cfg }).trackEngagement,
      /** The first send with tracking on, or null when there never was one. */
      since: trackedSince ? new Date(trackedSince).toISOString() : null,
      /** False when the period starts before tracking began: a rate would read low. */
      covers_period: !!trackedSince && new Date(trackedSince) <= w.cur.start,
    },
    top_links: data.topLinks.map((l) => ({
      label: l.label,
      host: l.host,
      path: l.path,
      clicks: l.clicks,
      emails: l.emails,
    })),
    by_type: data.byType.map((r) => ({
      ...withRates(r),
      ...engRates(r),
      link_visits: transport ? null : visitsOf("c", (a) => a === r.type),
    })),
    by_transport: data.byTransport.map(withRates),
    by_domain: data.byDomain.map(withRates),
    reasons: data.reasons.map((r) => ({ outcome: r.outcome, reason: r.reason, count: r.n })),
    skipped_reasons: data.skipReasons.map((r) => ({ reason: r.reason, count: r.n })),
    dunning: {
      hold_days: PAID_AFTER_DAYS,
      steps: Array.from({ length: SEQUENCE_CAP }, (_, i) => {
        const r = data.dunning.find((x) => x.pos === i + 1);
        return { position: i + 1, sent: r?.sent ?? 0, recovered: r?.recovered ?? 0 };
      }),
    },
    recent: data.recent.map((r) => ({
      email: r.public_id,
      at: new Date(r.at).toISOString(),
      type: r.type,
      status: statusOf(r),
      transport: r.transport,
      customer: r.customer_public_id,
      customer_name: r.customer_public_id
        ? accountHolderName({
            firstName: r.first_name,
            lastName: r.last_name,
            company: r.company,
            email: r.email,
          })
        : null,
      tracked: r.tracked,
      opened: r.tracked ? r.opened_by_person : null,
      clicked: r.tracked ? r.clicked_by_person : null,
      portal_opened: openedIds.has(r.public_id),
      paid_after: !!r.paid_after,
    })),
  };
}

export type EmailReport = Awaited<ReturnType<typeof computeEmailReport>>;
export { HostedReportError as EmailReportError };
