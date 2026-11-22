/**
 * Daily and weekly summaries.
 *
 * Builder: once a business's local day (or Monday-to-Sunday week) has ended, one
 * `notification_digests` row holds its parts, read from the facts tables (transactions,
 * mrr_movements, subscriptions, disputes, invoices, webhook deliveries), never from a cache.
 *
 * Sender (hourly): a member whose `summary_hour` is now in their timezone gets ONE summary
 * across the organization's businesses they follow, on their daily (or weekly) channels, plus a
 * bell row. Destinations with the switch on get parts 1, 2 and 4 per business at 08:00 business
 * time. Each send is deduped per (member or destination, period).
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  businesses,
  notificationDeliveries,
  notificationDigests,
  notifications,
  notificationSettingsOrg,
} from "@db/schema";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { zonedDayStart, zonedDayString } from "@/platform/timezones";
import { rowsOf } from "@/modules/metering/usage-sql";
import { kindDef, type NotificationKind } from "./catalogue";
import { isMerchantAccountError } from "./facts";
import { inQuietHours, localParts, passesFilter, quietEnd } from "./resolve";
import { settingsForUsers } from "./service";
import {
  activeDestinations,
  liveBusinesses,
  loadMembers,
  pushSubscriptionsOf,
  type LiveBusiness,
  type Member,
} from "./recipients";
import { baseUrl, type DeliveryPayload } from "./groups";
import {
  renderDestinationSummary,
  renderMemberSummary,
  type MemberPart,
  type SummaryItem,
} from "./digest-text";

export type Period = "daily" | "weekly";

export interface Money {
  count: number;
  /** Minor units per currency. */
  totals: Record<string, number>;
}

export interface NeedsAction {
  kind: NotificationKind;
  count: number;
  totals: Record<string, number>;
  /** Dashboard path of the filtered list. */
  url: string;
}

/** The stored `notification_digests.parts`. The contract the summary page renders. */
export interface DigestParts {
  version: 1;
  business: { id: string; name: string; timezone: string };
  period: Period;
  /** Local dates; `end` is exclusive. */
  start: string;
  end: string;
  /** Part 1. Only items with a count. */
  needs_action: NeedsAction[];
  /** Part 2. `previous`: the same weekday last week (daily) or the week before (weekly). */
  figures: {
    collected: Money & { previous: Money };
    failed: Money & { previous: Money };
    refunded: Money & { previous: Money };
    /** Weekly only: payments that succeeded after an earlier failure on the same invoice. */
    recovered?: Money;
    new_subscriptions: { count: number; previous: number };
    cancelled: { count: number; previous: number; reasons: Record<string, number> };
    mrr: {
      change: Record<string, number>;
      by_reason: Record<string, Record<string, number>>;
      /** Weekly only: the level at the start and the end of the week. */
      start?: Record<string, number>;
      end?: Record<string, number>;
    };
  };
  /** Part 4: the next 7 days from the build time. */
  coming_up: {
    renewals: number;
    trials_ending: number;
    invoices_due: Money;
    cards_expiring: number;
  };
  /** Anything happened or needs action. */
  active: boolean;
}

const DAY_MS = 86_400_000;

export const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
/** ISO weekday of a local date, 1 = Monday. */
export const isoWeekday = (day: string) => {
  const w = new Date(`${day}T00:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
};

/** The last complete period in the business's zone at `at`. */
export function lastPeriod(at: Date, tz: string, period: Period): { start: string; end: string } {
  const today = zonedDayString(at, tz);
  if (period === "daily") return { start: addDays(today, -1), end: today };
  const monday = addDays(today, 1 - isoWeekday(today));
  return { start: addDays(monday, -7), end: monday };
}

const iso = (d: Date) => d.toISOString();
const range = (start: string, end: string, tz: string) => ({
  from: zonedDayStart(start, tz),
  to: zonedDayStart(end, tz),
});

async function money(tx: Tx, q: ReturnType<typeof sql>): Promise<Money> {
  const rows = rowsOf<{ currency: string; amount: string; n: number }>(await tx.execute(q));
  const out: Money = { count: 0, totals: {} };
  for (const r of rows) {
    out.count += r.n;
    out.totals[r.currency] = Number(r.amount);
  }
  return out;
}

const txns = (bizId: string, type: string, statuses: string[], from: Date, to: Date) => sql`
  select currency, sum(amount_minor)::text as amount, count(*)::int as n
  from transactions
  where business_id = ${bizId} and type = ${type}
    and status = any(${`{${statuses.join(",")}}`}::text[])
    and finalised_at >= ${iso(from)}::timestamptz and finalised_at < ${iso(to)}::timestamptz
  group by currency`;

async function count(tx: Tx, q: ReturnType<typeof sql>): Promise<number> {
  return rowsOf<{ n: number }>(await tx.execute(q))[0]?.n ?? 0;
}

async function mrrLevel(tx: Tx, bizId: string, before: Date): Promise<Record<string, number>> {
  const rows = rowsOf<{ currency: string; amount: string }>(
    await tx.execute(sql`
      select currency, sum(new_mrr_minor)::text as amount from (
        select distinct on (subscription_id) currency, new_mrr_minor
        from mrr_movements
        where business_id = ${bizId} and occurred_at < ${iso(before)}::timestamptz
        order by subscription_id, occurred_at desc, id desc
      ) x group by currency`),
  );
  return Object.fromEntries(rows.map((r) => [r.currency, Number(r.amount)]));
}

/** Compute the parts from the facts. `now` is the build time, for the "coming up" part. */
export async function computeDigest(
  tx: Tx,
  biz: LiveBusiness,
  period: Period,
  start: string,
  now: Date,
): Promise<DigestParts> {
  const days = period === "daily" ? 1 : 7;
  const end = addDays(start, days);
  const { from, to } = range(start, end, biz.timezone);
  const prev = range(addDays(start, -7), addDays(end, -7), biz.timezone);
  const b = `/businesses/${biz.publicId}`;

  const figuresFor = async (f: Date, t: Date) => ({
    collected: await money(tx, txns(biz.id, "payment", ["succeeded"], f, t)),
    failed: await money(tx, txns(biz.id, "payment", ["failed", "late_failed"], f, t)),
    refunded: await money(tx, txns(biz.id, "refund", ["succeeded"], f, t)),
    started: await count(
      tx,
      sql`select count(*)::int as n from subscriptions
        where business_id = ${biz.id} and deleted_at is null
          and coalesce(started_at, created_at) >= ${iso(f)}::timestamptz
          and coalesce(started_at, created_at) < ${iso(t)}::timestamptz
          and status <> 'future'`,
    ),
    cancelled: rowsOf<{ code: string | null; n: number }>(
      await tx.execute(sql`
        select cancel_reason_code as code, count(*)::int as n from subscriptions
        where business_id = ${biz.id} and deleted_at is null
          and canceled_at >= ${iso(f)}::timestamptz and canceled_at < ${iso(t)}::timestamptz
        group by cancel_reason_code`),
    ),
  });
  const cur = await figuresFor(from, to);
  const old = await figuresFor(prev.from, prev.to);
  const reasons: Record<string, number> = {};
  for (const r of cur.cancelled)
    reasons[r.code ?? "other"] = (reasons[r.code ?? "other"] ?? 0) + r.n;
  const sumN = (rs: Array<{ n: number }>) => rs.reduce((s, r) => s + r.n, 0);

  const mrrRows = rowsOf<{ reason: string; currency: string; amount: string }>(
    await tx.execute(sql`
      select reason, currency, sum(delta_minor)::text as amount from mrr_movements
      where business_id = ${biz.id}
        and occurred_at >= ${iso(from)}::timestamptz and occurred_at < ${iso(to)}::timestamptz
      group by reason, currency`),
  );
  const change: Record<string, number> = {};
  const byReason: Record<string, Record<string, number>> = {};
  for (const r of mrrRows) {
    const v = Number(r.amount);
    change[r.currency] = (change[r.currency] ?? 0) + v;
    (byReason[r.reason] ??= {})[r.currency] = v;
  }

  const figures: DigestParts["figures"] = {
    collected: { ...cur.collected, previous: old.collected },
    failed: { ...cur.failed, previous: old.failed },
    refunded: { ...cur.refunded, previous: old.refunded },
    new_subscriptions: { count: cur.started, previous: old.started },
    cancelled: { count: sumN(cur.cancelled), previous: sumN(old.cancelled), reasons },
    mrr: { change, by_reason: byReason },
  };
  if (period === "weekly") {
    figures.recovered = await money(
      tx,
      sql`select t.currency, sum(t.amount_minor)::text as amount, count(*)::int as n
        from transactions t
        where t.business_id = ${biz.id} and t.type = 'payment' and t.status = 'succeeded'
          and t.invoice_id is not null
          and t.finalised_at >= ${iso(from)}::timestamptz and t.finalised_at < ${iso(to)}::timestamptz
          and exists (select 1 from transactions f where f.invoice_id = t.invoice_id
            and f.type = 'payment' and f.status = 'failed' and f.occurred_at < t.occurred_at)
        group by t.currency`,
    );
    figures.mrr.start = await mrrLevel(tx, biz.id, from);
    figures.mrr.end = await mrrLevel(tx, biz.id, to);
  }

  // Part 1: needs action.
  const week = new Date(now.getTime() + 7 * DAY_MS);
  const needs: NeedsAction[] = [];
  const attention = await money(
    tx,
    sql`select currency, sum(amount_minor)::text as amount, count(*)::int as n from transactions
      where business_id = ${biz.id} and type = 'payment' and status in ('needs_attention', 'timeout')
      group by currency`,
  );
  if (attention.count)
    needs.push({ kind: "payment_needs_attention", ...attention, url: `${b}/transactions` });
  const evidence = await money(
    tx,
    sql`select currency, sum(amount_minor)::text as amount, count(*)::int as n from disputes
      where business_id = ${biz.id} and status = 'needs_response'
        and evidence_due_by >= ${iso(now)}::timestamptz and evidence_due_by < ${iso(week)}::timestamptz
      group by currency`,
  );
  if (evidence.count)
    needs.push({ kind: "dispute_evidence_due", ...evidence, url: `${b}/disputes` });
  const exhausted = await count(
    tx,
    sql`select count(*)::int as n from events
      where business_id = ${biz.id} and type = 'invoice_dunning_exhausted'
        and created_at >= ${iso(from)}::timestamptz and created_at < ${iso(to)}::timestamptz`,
  );
  if (exhausted)
    needs.push({ kind: "retries_exhausted", count: exhausted, totals: {}, url: `${b}/invoices` });
  const codes = rowsOf<{ code: string; n: number }>(
    await tx.execute(sql`
      select error_code as code, count(*)::int as n from payment_attempts
      where business_id = ${biz.id} and error_code is not null
        and created_at >= ${iso(from)}::timestamptz and created_at < ${iso(to)}::timestamptz
      group by error_code`),
  );
  const gw = codes.filter((c) => isMerchantAccountError(c.code)).reduce((s, c) => s + c.n, 0);
  if (gw)
    needs.push({ kind: "gateway_attention", count: gw, totals: {}, url: `${b}/settings/gateways` });
  const hooks = await count(
    tx,
    sql`select count(distinct endpoint_id)::int as n from webhook_deliveries
      where business_id = ${biz.id} and status = 'failed'
        and last_attempt_at >= ${iso(from)}::timestamptz and last_attempt_at < ${iso(to)}::timestamptz`,
  );
  if (hooks)
    needs.push({ kind: "webhook_failing", count: hooks, totals: {}, url: "/developer/webhooks" });

  // Part 4: coming up.
  const local = zonedDayString(now, biz.timezone);
  const [y, m] = local.split("-").map(Number) as [number, number];
  const nm = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  const coming_up: DigestParts["coming_up"] = {
    renewals: await count(
      tx,
      sql`select count(*)::int as n from subscriptions
        where business_id = ${biz.id} and status = 'active' and deleted_at is null
          and cancel_scheduled_at is null
          and current_period_end >= ${iso(now)}::timestamptz and current_period_end < ${iso(week)}::timestamptz`,
    ),
    trials_ending: await count(
      tx,
      sql`select count(*)::int as n from subscriptions
        where business_id = ${biz.id} and status = 'in_trial' and deleted_at is null
          and trial_end >= ${iso(now)}::timestamptz and trial_end < ${iso(week)}::timestamptz`,
    ),
    invoices_due: await money(
      tx,
      sql`select currency, sum(coalesce(amount_due_minor, total_minor))::text as amount, count(*)::int as n
        from invoices
        where business_id = ${biz.id} and status in ('posted', 'payment_due') and not written_off
          and due_date >= ${iso(now)}::timestamptz and due_date < ${iso(week)}::timestamptz
        group by currency`,
    ),
    cards_expiring: await count(
      tx,
      sql`select count(*)::int as n from payment_methods
        where business_id = ${biz.id} and type = 'card' and status in ('valid', 'expiring')
          and ((exp_year = ${y} and exp_month = ${m}) or (exp_year = ${nm.y} and exp_month = ${nm.m}))`,
    ),
  };

  const active =
    needs.length > 0 ||
    figures.collected.count + figures.failed.count + figures.refunded.count > 0 ||
    figures.new_subscriptions.count + figures.cancelled.count > 0 ||
    Object.values(change).some((v) => v !== 0);
  return {
    version: 1,
    business: { id: biz.publicId, name: biz.name, timezone: biz.timezone },
    period,
    start,
    end,
    needs_action: needs,
    figures,
    coming_up,
    active,
  };
}

export type DigestRow = typeof notificationDigests.$inferSelect;

/** The stored digest for (business, period, start), built now when missing. */
export async function ensureDigest(
  tx: Tx,
  organizationId: string,
  biz: LiveBusiness,
  period: Period,
  start: string,
  now: Date,
): Promise<DigestRow> {
  return (await ensureDigestBuilt(tx, organizationId, biz, period, start, now)).row;
}

async function ensureDigestBuilt(
  tx: Tx,
  organizationId: string,
  biz: LiveBusiness,
  period: Period,
  start: string,
  now: Date,
): Promise<{ row: DigestRow; built: boolean }> {
  const find = () =>
    tx
      .select()
      .from(notificationDigests)
      .where(
        and(
          eq(notificationDigests.businessId, biz.id),
          eq(notificationDigests.period, period),
          eq(notificationDigests.periodStart, start),
        ),
      )
      .limit(1);
  const [have] = await find();
  if (have) return { row: have, built: false };
  const parts = await computeDigest(tx, biz, period, start, now);
  await tx
    .insert(notificationDigests)
    .values({
      publicId: publicId("nsum"),
      organizationId,
      businessId: biz.id,
      period,
      periodStart: start,
      parts: parts as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing();
  return { row: (await find())[0]!, built: true };
}

export interface DigestScope {
  onlyBusinessId?: string;
  excludeBusinessIds?: string[];
}

async function scopedLiveBusinesses(scope: DigestScope) {
  const rows = await systemDb
    .select({
      id: businesses.id,
      organizationId: businesses.organizationId,
      publicId: businesses.publicId,
      name: businesses.name,
      timezone: businesses.timezone,
    })
    .from(businesses)
    .where(and(eq(businesses.livemode, "live"), eq(businesses.status, "active")));
  const exclude = new Set(scope.excludeBusinessIds ?? []);
  return rows
    .filter((b) => (!scope.onlyBusinessId || b.id === scope.onlyBusinessId) && !exclude.has(b.id))
    .map((b) => ({ ...b, timezone: b.timezone ?? "UTC" }));
}

/** Builder: yesterday's daily, and on Mondays last week's weekly, for every live business. */
export async function runDigestBuilder(
  at: Date,
  scope: DigestScope = {},
): Promise<{ built: number }> {
  let built = 0;
  for (const b of await scopedLiveBusinesses(scope)) {
    const periods: Period[] = ["daily"];
    if (isoWeekday(zonedDayString(at, b.timezone)) === 1) periods.push("weekly");
    for (const p of periods) {
      const { start } = lastPeriod(at, b.timezone, p);
      const r = await withTenant(b.organizationId, (tx) =>
        ensureDigestBuilt(tx, b.organizationId, b, p, start, at),
      );
      if (r.built) built++;
    }
  }
  return { built };
}

/** Destinations read summaries at this local hour. */
export const DESTINATION_SUMMARY_HOUR = 8;

/** Sender: members whose summary hour is now, and destinations at 08:00 business time. */
export async function runDigestSender(
  at: Date,
  scope: DigestScope = {},
): Promise<{ members: number; destinations: number; deliveries: number }> {
  const out = { members: 0, destinations: 0, deliveries: 0 };
  const live = await scopedLiveBusinesses(scope);
  const liveIds = new Set(live.map((b) => b.id));
  const orgs = [...new Set(live.map((b) => b.organizationId))];
  if (orgs.length === 0) return out;

  // Members: one summary per member and organization.
  const settingsRows = await systemDb
    .select({
      organizationId: notificationSettingsOrg.organizationId,
      userId: notificationSettingsOrg.userId,
    })
    .from(notificationSettingsOrg)
    .where(inArray(notificationSettingsOrg.organizationId, orgs));
  const personal = await settingsForUsers([...new Set(settingsRows.map((r) => r.userId))]);
  const due = new Map<string, Array<{ userId: string; periods: Period[] }>>();
  for (const r of settingsRows) {
    const s = personal.get(r.userId)!;
    const p = localParts(at, s.timezone);
    if (p.hour !== s.summary_hour) continue;
    const localDay = zonedDayString(at, s.timezone);
    const periods: Period[] = ["daily"];
    if (isoWeekday(localDay) === s.weekly_day) periods.push("weekly");
    due.set(r.organizationId, [
      ...(due.get(r.organizationId) ?? []),
      { userId: r.userId, periods },
    ]);
  }
  for (const [orgId, list] of due) {
    const r = await withTenant(orgId, (tx) =>
      sendToMembers(tx, orgId, list, at, personal, liveIds),
    );
    out.members += r.members;
    out.deliveries += r.deliveries;
  }

  // Destinations: per business at 08:00 in its zone.
  for (const b of live) {
    if (localParts(at, b.timezone).hour !== DESTINATION_SUMMARY_HOUR) continue;
    const r = await withTenant(b.organizationId, (tx) =>
      sendToDestinations(tx, b.organizationId, b, at),
    );
    out.destinations += r.destinations;
    out.deliveries += r.deliveries;
  }
  return out;
}

type Personal = Awaited<ReturnType<typeof settingsForUsers>>;
type PersonalSettings = NonNullable<ReturnType<Personal["get"]>>;

/** The parts this member may see: each needs-action item and figure by its permission. */
export function partForMember(parts: DigestParts, perms: ReadonlySet<string>): DigestParts {
  const can = (k: string) => perms.has(k);
  const empty = { count: 0, totals: {} };
  const f = parts.figures;
  return {
    ...parts,
    needs_action: parts.needs_action.filter((n) => can(kindDef(n.kind).permission)),
    figures: can("payments:view")
      ? can("subscriptions:view")
        ? f
        : {
            ...f,
            new_subscriptions: { count: 0, previous: 0 },
            cancelled: { count: 0, previous: 0, reasons: {} },
            mrr: { change: {}, by_reason: {} },
          }
      : {
          collected: { ...empty, previous: empty },
          failed: { ...empty, previous: empty },
          refunded: { ...empty, previous: empty },
          ...(can("subscriptions:view")
            ? { new_subscriptions: f.new_subscriptions, cancelled: f.cancelled, mrr: f.mrr }
            : {
                new_subscriptions: { count: 0, previous: 0 },
                cancelled: { count: 0, previous: 0, reasons: {} },
                mrr: { change: {}, by_reason: {} },
              }),
        },
    coming_up: {
      renewals: can("subscriptions:view") ? parts.coming_up.renewals : 0,
      trials_ending: can("subscriptions:view") ? parts.coming_up.trials_ending : 0,
      invoices_due: can("invoices:view") ? parts.coming_up.invoices_due : empty,
      cards_expiring: can("payment_methods:view") ? parts.coming_up.cards_expiring : 0,
    },
  };
}

async function sendToMembers(
  tx: Tx,
  orgId: string,
  list: Array<{ userId: string; periods: Period[] }>,
  at: Date,
  personal: Personal,
  liveIds: Set<string>,
): Promise<{ members: number; deliveries: number }> {
  const out = { members: 0, deliveries: 0 };
  const members = new Map((await loadMembers(tx, orgId)).map((m) => [m.userId, m]));
  const live = (await liveBusinesses(tx, orgId)).filter((b) => liveIds.has(b.id));
  const subs = await pushSubscriptionsOf(
    tx,
    list.map((l) => l.userId),
  );
  for (const { userId, periods } of list) {
    const m = members.get(userId);
    if (!m) continue;
    const s = personal.get(userId)!;
    for (const period of periods) {
      const pref = period === "daily" ? m.daily : m.weekly;
      if (!pref.enabled) continue;
      const made = await sendMemberSummary(
        tx,
        orgId,
        m,
        s,
        period,
        at,
        live,
        subs.get(userId) ?? [],
      );
      if (made >= 0) {
        out.members++;
        out.deliveries += made;
      }
    }
  }
  return out;
}

/** -1: nothing sent (already sent, or empty and the member did not ask for empty days). */
async function sendMemberSummary(
  tx: Tx,
  orgId: string,
  m: Member,
  s: PersonalSettings,
  period: Period,
  at: Date,
  live: LiveBusiness[],
  subs: Array<{ id: string }>,
): Promise<number> {
  const kind = `${period}_summary`;
  const key = `sum:${m.userId}:${orgId}:${period}:${zonedDayString(at, s.timezone)}`;
  const [sent] = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, m.userId),
        eq(notifications.kind, kind),
        sql`${notifications.facts}->>'key' = ${key}`,
      ),
    )
    .limit(1);
  if (sent) return -1;

  const parts: MemberPart[] = [];
  const digestIds: Array<{ business: string; id: string }> = [];
  for (const b of live.filter((x) => passesFilter(m.filter, x.id))) {
    const { start } = lastPeriod(at, b.timezone, period);
    const d = await ensureDigest(tx, orgId, b, period, start, at);
    const p = partForMember(d.parts as unknown as DigestParts, m.permissions);
    const { from, to } = range(p.start, p.end, b.timezone);
    const rows = await tx
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, m.userId),
          eq(notifications.businessId, b.id),
          eq(notifications.timing, "summary"),
          gte(notifications.createdAt, from),
          lt(notifications.createdAt, to),
        ),
      );
    const items: SummaryItem[] = rows.map((r) => ({
      kind: r.kind as NotificationKind,
      title: r.title,
      body: r.body,
      url: r.url,
      amountMinor: r.amountMinor,
      currency: r.currency,
    }));
    parts.push({ parts: p, items, url: `/notifications/summaries/${d.publicId}` });
    digestIds.push({ business: b.publicId, id: d.publicId });
  }
  if (parts.length === 0) return -1;
  const empty = parts.every((p) => !p.parts.active && p.items.length === 0);
  if (empty && !m.sendEmpty) return -1;
  // A business with nothing to report is left out, unless all are empty and the member asked.
  if (!empty)
    for (let i = parts.length - 1; i >= 0; i--)
      if (!parts[i]!.parts.active && parts[i]!.items.length === 0) {
        parts.splice(i, 1);
        digestIds.splice(i, 1);
      }

  const r = renderMemberSummary(parts, {
    period,
    baseUrl: baseUrl(),
    timezone: s.timezone,
    now: at,
  });
  // One digest per business; the page shows the rest from `?also=`.
  const also = digestIds.slice(1).map((d) => d.id);
  const url = also.length ? `${parts[0]!.url}?also=${also.join(",")}` : parts[0]!.url;
  const [n] = await tx
    .insert(notifications)
    .values({
      publicId: publicId("ntf"),
      organizationId: orgId,
      businessId: null,
      userId: m.userId,
      kind,
      tone: "neutral",
      timing: "instant",
      title: r.title,
      body: r.body,
      url,
      record: { type: "summary", id: digestIds[0]!.id },
      facts: { key, summaries: digestIds },
    })
    .returning({ id: notifications.id });

  const base: Omit<DeliveryPayload, "push" | "mail"> = {
    facts: {},
    opts: { timezone: s.timezone },
    count: 1,
    tone: "neutral",
    summary: true,
  };
  const values: Array<typeof notificationDeliveries.$inferInsert> = [];
  const pref = period === "daily" ? m.daily : m.weekly;
  const q = s.quiet;
  const held = q.enabled && inQuietHours(at, s.timezone, q.from, q.to);
  if (pref.channels.includes("push"))
    for (const sub of subs)
      values.push({
        organizationId: orgId,
        channel: "push",
        userId: m.userId,
        pushSubscriptionId: sub.id,
        kind,
        notificationId: n!.id,
        payload: { ...base, push: { ...r.push, url } } as unknown as Record<string, unknown>,
        status: held ? "held" : "pending",
        nextAttemptAt: held ? quietEnd(at, s.timezone, q.to) : at,
        dedupeKey: `${key}:push:${sub.id}`,
      });
  if (pref.channels.includes("email"))
    values.push({
      organizationId: orgId,
      channel: "email",
      userId: m.userId,
      kind,
      notificationId: n!.id,
      payload: { ...base, mail: { to: m.email, ...r.email } } as unknown as Record<string, unknown>,
      nextAttemptAt: at,
      dedupeKey: `${key}:email`,
    });
  if (values.length === 0) return 0;
  const rows = await tx
    .insert(notificationDeliveries)
    .values(values)
    .onConflictDoNothing({ target: notificationDeliveries.dedupeKey })
    .returning({ id: notificationDeliveries.id });
  return rows.length;
}

async function sendToDestinations(
  tx: Tx,
  orgId: string,
  b: LiveBusiness,
  at: Date,
): Promise<{ destinations: number; deliveries: number }> {
  const out = { destinations: 0, deliveries: 0 };
  const dests = (await activeDestinations(tx, orgId)).filter((d) =>
    passesFilter(d.businessFilter, b.id),
  );
  if (dests.length === 0) return out;
  const weekly = isoWeekday(zonedDayString(at, b.timezone)) === 1;
  for (const period of ["daily", "weekly"] as const) {
    if (period === "weekly" && !weekly) continue;
    const want = dests.filter((d) => (period === "daily" ? d.daily : d.weekly));
    if (want.length === 0) continue;
    const { start } = lastPeriod(at, b.timezone, period);
    const d = await ensureDigest(tx, orgId, b, period, start, at);
    const parts = d.parts as unknown as DigestParts;
    if (!parts.active) continue;
    for (const dest of want) {
      const r = renderDestinationSummary(parts, {
        baseUrl: baseUrl(),
        url: `/notifications/summaries/${d.publicId}`,
        hideNames: dest.hideNames,
      });
      const payload: DeliveryPayload = {
        facts: {},
        opts: { timezone: b.timezone },
        count: 1,
        tone: "neutral",
        summary: true,
        ...(dest.type === "chat" ? { chat: r.chat } : { mail: r.email }),
      };
      const rows = await tx
        .insert(notificationDeliveries)
        .values({
          organizationId: orgId,
          businessId: b.id,
          channel: dest.type === "chat" ? "chat" : "outside_email",
          destinationId: dest.id,
          kind: `${period}_summary`,
          payload: payload as unknown as Record<string, unknown>,
          nextAttemptAt: at,
          dedupeKey: `sum:d:${dest.id}:${d.id}`,
        })
        .onConflictDoNothing({ target: notificationDeliveries.dedupeKey })
        .returning({ id: notificationDeliveries.id });
      out.destinations++;
      out.deliveries += rows.length;
    }
  }
  return out;
}
