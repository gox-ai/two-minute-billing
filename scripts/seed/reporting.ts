/** Rebuild reporting for a seeded business, quiet its historical outbox, and summarise it. */
import { sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { bulkFillMetricDays, bulkFillCoarseGrains } from "@/modules/metrics/daily/bulk-fill";
import { invalidateSeriesCache } from "@/modules/metrics/daily/series-cache";
import { refreshMovementSummary } from "@/modules/metrics/reports/movement-matview";
import { zonedDayString } from "@/platform/timezones";

/** Calendar days from `from` through yesterday (business-local). */
function daysBetween(from: Date, timezone: string | null): string[] {
  const out: string[] = [];
  const d = new Date(`${zonedDayString(from, timezone)}T00:00:00.000Z`);
  const today = zonedDayString(new Date(), timezone);
  while (d.toISOString().slice(0, 10) < today) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * metric_daily (day + coarse grains) for every simulated day. Movements were written live by
 * the engine, so they are not backfilled.
 */
export async function rebuildReporting(input: {
  organizationId: string;
  businessId: string;
  timezone: string | null;
  genesis: Date;
}): Promise<{ days: number; metricRows: number }> {
  const days = daysBetween(input.genesis, input.timezone);
  const now = new Date();
  const fill = await bulkFillMetricDays({
    organizationId: input.organizationId,
    businessId: input.businessId,
    grain: "day",
    days,
    write: true,
    now,
    timezone: input.timezone,
  });
  const coarse = await bulkFillCoarseGrains({
    organizationId: input.organizationId,
    businessId: input.businessId,
    days,
    write: true,
    now,
    timezone: input.timezone,
  });
  invalidateSeriesCache(input.businessId);
  return { days: days.length, metricRows: fill.rows + coarse.rows };
}

export async function refreshMovements(): Promise<void> {
  await refreshMovementSummary();
}

/**
 * Mail the history "sent" to fictional customers must never go out. Pending rows are
 * closed as `skipped` (the outbox's own terminal state for a message deliberately not
 * sent), so a worker started later — or an SMTP transport configured later — sends none
 * of it. Webhooks need nothing: a seeded business has no endpoints, so no deliveries exist.
 */
export async function skipHistoricalMail(businessId: string): Promise<number> {
  const rows = (await systemDb.execute(sql`
    update email_messages
    set status = 'skipped', next_attempt_at = null,
        last_error = 'Seeded history — never sent.'
    where business_id = ${businessId}::uuid and status = 'pending'
    returning id
  `)) as unknown as unknown[];
  return rows.length;
}

export interface BizSummary {
  customers: number;
  subs: Record<string, number>;
  invoices: Record<string, number>;
  payments: number;
  mrr: string;
}

export async function summarise(businessId: string): Promise<BizSummary> {
  const q = async <T>(x: ReturnType<typeof sql>) => (await systemDb.execute(x)) as unknown as T[];
  const [c] = await q<{ n: number }>(
    sql`select count(*)::int n from customers where business_id = ${businessId}::uuid`,
  );
  const subs = await q<{ status: string; n: number }>(sql`
    select case when status = 'active' and (cancel_at_period_end or cancel_scheduled_at is not null)
                then 'non_renewing' else status end as status, count(*)::int n
    from subscriptions where business_id = ${businessId}::uuid group by 1 order by 1`);
  const inv = await q<{ status: string; n: number }>(sql`
    select status, count(*)::int n from invoices where business_id = ${businessId}::uuid group by 1 order by 1`);
  const [p] = await q<{ n: number }>(sql`
    select count(*)::int n from payments where business_id = ${businessId}::uuid and status = 'succeeded'`);
  const mrr = await q<{ currency: string; mrr: string }>(sql`
    select currency, coalesce(sum(mrr), 0)::bigint mrr from subscriptions
    where business_id = ${businessId}::uuid and status = 'active' group by 1`);
  return {
    customers: c!.n,
    subs: Object.fromEntries(subs.map((x) => [x.status, x.n])),
    invoices: Object.fromEntries(inv.map((x) => [x.status, x.n])),
    payments: p!.n,
    mrr:
      mrr
        .map(
          (m) =>
            `${(Number(m.mrr) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} ${m.currency}`,
        )
        .join(", ") || "0",
  };
}
