import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { checkoutInvoiceJoin } from "@/modules/metrics/hosted-page-figures";
import { channelOf, mediumOf, sourceOf, type Channel } from "./channels";
import type { DeviceCategory } from "./user-agent";

/**
 * The tracked figures of the checkout and portal reports (`metrics/hosted-page-reports.ts`
 * calls these inside its own transaction, with its own session filters and money converter).
 * Only visits whose page ran in a browser (`viewed_at`) inside the window count.
 */

/** A portal section counts as viewed once it was on screen this long in one visit. */
export const SECTION_SEEN_MS = 1000;

export const DEVICES = ["desktop", "mobile", "tablet"] as const;

export interface VisitFilter {
  /** ISO 3166-1 alpha-2, from the visitor's request. */
  country?: string | null;
  device?: DeviceCategory | null;
}

const ts = (d: Date) => d.toISOString();

function visitConds(f: VisitFilter): SQL {
  return sql`${f.country ? sql`and sv.country = ${f.country.toUpperCase()}` : sql``}
    ${f.device ? sql`and sv.device_category = ${f.device}` : sql``}`;
}

/**
 * Narrow a report's sessions to those with a tracked visit from this country / device. Empty
 * when no filter is set. `session` is the session row's id column (`s.id`, `ps.id`).
 */
export function visitFilterSql(surface: "checkout" | "portal", session: SQL, f: VisitFilter): SQL {
  if (!f.country && !f.device) return sql``;
  const col = surface === "checkout" ? sql`sv.checkout_session_id` : sql`sv.portal_session_id`;
  return sql`and exists (select 1 from storefront_visits sv where ${col} = ${session} ${visitConds(f)})`;
}

/** First tracked view for the business on this surface; null when nothing is tracked yet. */
async function trackingSince(tx: Tx, businessId: string, surface: "checkout" | "portal") {
  const [r] = (await tx.execute(sql`
    select min(viewed_at) as since from storefront_visits
    where business_id = ${businessId}::uuid and surface = ${surface} and viewed_at is not null`)) as unknown as Array<{
    since: Date | string | null;
  }>;
  return r?.since ? new Date(r.since).toISOString() : null;
}

export interface Converted {
  key: string | null;
  views: number;
  completed: number;
  /** Basis points; null when there are no views. */
  conversion_bps: number | null;
  revenue_minor: number;
}
export interface ChannelRow extends Converted {
  channel: Channel;
  source: string;
  medium: string;
  campaign: string | null;
}
export interface CheckoutTracking {
  /** First tracked view, any range. A window that starts before it is partly untracked. */
  since: string | null;
  views: number;
  completed: number;
  channels: ChannelRow[];
  countries: Converted[];
  devices: Converted[];
  browsers: Converted[];
  /** Median visible time per step, over the visits that showed the step. */
  step_time: Array<{ step: string; visits: number; median_ms: number }>;
}

const bp = (num: number, den: number) => (den > 0 ? Math.round((num * 10000) / den) : null);

type Acc = { views: number; completed: number; revenue_minor: number };
function add(m: Map<string, Acc>, key: string, done: boolean, revenue: number) {
  const a = m.get(key) ?? { views: 0, completed: 0, revenue_minor: 0 };
  a.views += 1;
  if (done) a.completed += 1;
  a.revenue_minor += revenue;
  m.set(key, a);
}
const rowsOf = (m: Map<string, Acc>): Converted[] =>
  [...m.entries()]
    .map(([key, a]) => ({
      key: key === "" ? null : key,
      ...a,
      conversion_bps: bp(a.completed, a.views),
    }))
    .sort((a, b) => b.views - a.views || String(a.key).localeCompare(String(b.key)));

/**
 * Checkout traffic over `[from, to)`: views, completions and revenue by channel, visitor
 * country, device and browser, and the median time on each step. `sessionWhere` is the
 * report's condition on the `s` checkout session; `revenueOf` converts a paid first invoice.
 */
export async function checkoutTracking(
  tx: Tx,
  input: {
    businessId: string;
    from: Date;
    to: Date;
    sessionWhere: SQL;
    filter: VisitFilter;
    revenueOf: (minor: number, currency: string, at: Date) => number | null;
  },
): Promise<CheckoutTracking> {
  const s = sql.raw("s");
  const where = sql`sv.business_id = ${input.businessId}::uuid and sv.surface = 'checkout'
    and sv.viewed_at >= ${ts(input.from)}::timestamptz and sv.viewed_at < ${ts(input.to)}::timestamptz
    and ${input.sessionWhere} ${visitConds(input.filter)}`;
  const rows = (await tx.execute(sql`
    select sv.referrer_host, sv.utm_source, sv.utm_medium, sv.utm_campaign,
           sv.country::text as country, sv.device_category as device, sv.browser,
           (s.completed_at is not null) as done,
           fi.status as inv_status, fi.total_minor::text as total_minor, fi.currency::text as currency,
           coalesce(fi.paid_at, fi.created_at) as inv_at
    from storefront_visits sv
    join checkout_sessions s on s.id = sv.checkout_session_id
    ${checkoutInvoiceJoin(s, "fi")}
    where ${where}`)) as unknown as Array<{
    referrer_host: string | null;
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
    country: string | null;
    device: string | null;
    browser: string | null;
    done: boolean;
    inv_status: string | null;
    total_minor: string | null;
    currency: string | null;
    inv_at: Date | string | null;
  }>;
  const steps = (await tx.execute(sql`
    select st.key as step, count(*)::int as visits,
           percentile_cont(0.5) within group (order by st.value::bigint) as median
    from storefront_visits sv
    join checkout_sessions s on s.id = sv.checkout_session_id,
         jsonb_each_text(sv.step_ms) st
    where ${where}
    group by 1 order by 2 desc`)) as unknown as Array<{
    step: string;
    visits: number;
    median: number | string | null;
  }>;

  const channels = new Map<string, ChannelRow>();
  const countries = new Map<string, Acc>();
  const devices = new Map<string, Acc>();
  const browsers = new Map<string, Acc>();
  let completed = 0;
  for (const r of rows) {
    const revenue =
      r.done && r.inv_status === "paid" && r.currency && r.inv_at != null
        ? (input.revenueOf(Number(r.total_minor ?? 0), r.currency, new Date(r.inv_at)) ?? 0)
        : 0;
    if (r.done) completed += 1;
    const src = {
      referrerHost: r.referrer_host,
      utmSource: r.utm_source,
      utmMedium: r.utm_medium,
      utmCampaign: r.utm_campaign,
    };
    const channel = channelOf(src);
    const source = sourceOf(src);
    const medium = mediumOf(src);
    const key = [channel, source, medium, src.utmCampaign ?? ""].join("|");
    const c = channels.get(key) ?? {
      key,
      channel,
      source,
      medium,
      campaign: src.utmCampaign,
      views: 0,
      completed: 0,
      conversion_bps: null,
      revenue_minor: 0,
    };
    c.views += 1;
    if (r.done) c.completed += 1;
    c.revenue_minor += revenue;
    c.conversion_bps = bp(c.completed, c.views);
    channels.set(key, c);
    add(countries, r.country ?? "", r.done, revenue);
    add(devices, r.device ?? "", r.done, revenue);
    add(browsers, r.browser ?? "", r.done, revenue);
  }
  return {
    since: await trackingSince(tx, input.businessId, "checkout"),
    views: rows.length,
    completed,
    channels: [...channels.values()].sort(
      (a, b) => b.revenue_minor - a.revenue_minor || b.views - a.views,
    ),
    countries: rowsOf(countries),
    devices: rowsOf(devices),
    browsers: rowsOf(browsers),
    step_time: steps.map((r) => ({
      step: r.step,
      visits: r.visits,
      median_ms: Math.round(Number(r.median ?? 0)),
    })),
  };
}

export interface Counted {
  key: string | null;
  visits: number;
}
export interface PortalTracking {
  since: string | null;
  /** Tracked visits in the window: the base of every share below. */
  visits: number;
  /** Visits that showed each section for at least `SECTION_SEEN_MS`. */
  sections: Array<{ section: string; visits: number }>;
  countries: Counted[];
  devices: Counted[];
  browsers: Counted[];
  pdf_downloads: number;
  visits_with_pdf: number;
}

/** Portal traffic over `[from, to)`. `sessionWhere` is the report's condition on `ps`. */
export async function portalTracking(
  tx: Tx,
  input: { businessId: string; from: Date; to: Date; sessionWhere: SQL; filter: VisitFilter },
): Promise<PortalTracking> {
  const base = sql`
    with v as (
      select sv.country::text as country, sv.device_category as device, sv.browser,
             sv.step_ms, sv.pdf_downloads
      from storefront_visits sv
      join portal_sessions ps on ps.id = sv.portal_session_id
      where sv.business_id = ${input.businessId}::uuid and sv.surface = 'portal'
        and sv.viewed_at >= ${ts(input.from)}::timestamptz and sv.viewed_at < ${ts(input.to)}::timestamptz
        and ${input.sessionWhere} ${visitConds(input.filter)}
    )`;
  const by = async (col: SQL): Promise<Counted[]> =>
    (
      (await tx.execute(
        sql`${base} select ${col} as k, count(*)::int as n from v group by 1 order by 2 desc, 1`,
      )) as unknown as Array<{ k: string | null; n: number }>
    ).map((r) => ({ key: r.k, visits: r.n }));
  const [t] = (await tx.execute(sql`${base}
    select count(*)::int as visits, coalesce(sum(pdf_downloads), 0)::int as pdf,
           (count(*) filter (where pdf_downloads > 0))::int as with_pdf
    from v`)) as unknown as Array<{ visits: number; pdf: number; with_pdf: number }>;
  const sections = (await tx.execute(sql`${base}
    select st.key as section, count(*)::int as visits
    from v, jsonb_each_text(v.step_ms) st
    where st.value::bigint >= ${SECTION_SEEN_MS}
    group by 1 order by 2 desc`)) as unknown as Array<{ section: string; visits: number }>;
  return {
    since: await trackingSince(tx, input.businessId, "portal"),
    visits: t?.visits ?? 0,
    sections,
    countries: await by(sql`country`),
    devices: await by(sql`device`),
    browsers: await by(sql`browser`),
    pdf_downloads: t?.pdf ?? 0,
    visits_with_pdf: t?.with_pdf ?? 0,
  };
}
