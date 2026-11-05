/**
 * The `usage_alerts` tick pass (design G5 §5): resolves triggered alert states whose period
 * ended (`period_ended`), then once a day catches up limit tiers from recent payments and
 * runs the registered daily steps (the auto top-up lead-time re-check). Database only.
 */
import { sql } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { config } from "@/platform/config";
import { currentClockScope } from "@/platform/clock";
import { createLogger } from "@/platform/logger";
import { emitEvent } from "@/modules/events/emit";
import { catchUpTiers } from "./limits";

const log = createLogger("usage-controls.alerts-pass");

/** A once-a-day step of the pass. Returns how many rows it acted on. */
export type DailyStep = (now: Date) => Promise<number>;
const dailySteps: Array<{ name: string; fn: DailyStep }> = [];
export function registerUsageAlertsDailyStep(name: string, fn: DailyStep): void {
  const at = dailySteps.findIndex((s) => s.name === name);
  if (at >= 0) dailySteps[at] = { name, fn };
  else dailySteps.push({ name, fn });
}

/** The business filter of the clock scope, as raw SQL on a `business_id` column. */
function scopeSql(col: string) {
  const s = currentClockScope();
  if (s?.onlyBusinessId) return sql`and ${sql.raw(col)} = ${s.onlyBusinessId}::uuid`;
  if (s?.excludeBusinessIds?.length)
    return sql`and not (${sql.raw(col)} = any(${`{${s.excludeBusinessIds.join(",")}}`}::uuid[]))`;
  return sql``;
}

interface EndedState {
  id: string;
  organization_id: string;
  business_id: string;
  alert_public_id: string;
  kind: string;
  scope: string;
  interval: string | null;
  currency: string | null;
  customer_public_id: string | null;
  subscription_public_id: string | null;
  threshold: string;
  period_key: Date;
}

/**
 * Triggered, unresolved states whose period is over: the current period start is computed in
 * SQL per alert (business zone; a `period` alert from its subscription's term).
 */
async function endedStates(now: Date, limit: number): Promise<EndedState[]> {
  const at = now.toISOString();
  const tz = sql`coalesce(b.timezone, 'UTC')`;
  const local = sql`(${at}::timestamptz at time zone ${tz})`;
  return (await systemDb.execute(sql`
    select s.id, s.organization_id, s.business_id, a.public_id as alert_public_id, a.kind,
      a.scope, a."interval", a.currency, c.public_id as customer_public_id,
      sub.public_id as subscription_public_id, s.threshold::text as threshold, s.period_key
    from usage_alert_states s
    join usage_alerts a on a.id = s.alert_id
    join businesses b on b.id = s.business_id
    join customers c on c.id = s.customer_id
    left join subscriptions sub
      on sub.id = (case when s.subject_key like 'sub:%' then substr(s.subject_key, 5)::uuid end)
    where s.triggered_at is not null and s.resolved_at is null ${scopeSql("s.business_id")}
      and s.period_key < case
        when a.kind in ('credit_balance', 'credit_runway') or a."interval" = 'month'
          then date_trunc('month', ${local}) at time zone ${tz}
        when a."interval" = 'week' then date_trunc('week', ${local}) at time zone ${tz}
        when a."interval" = 'day' then date_trunc('day', ${local}) at time zone ${tz}
        else coalesce(
          case when sub.id is not null then sub.current_period_start
          else (select x.current_period_start from subscriptions x
            where x.customer_id = s.customer_id and x.status in ('active', 'in_trial')
              and x.current_period_start is not null
            order by x.current_period_end asc limit 1) end,
          '-infinity'::timestamptz)
      end
    order by s.period_key
    limit ${limit}`)) as unknown as EndedState[];
}

async function resolveEnded(tx: Tx, rows: EndedState[], now: Date): Promise<number> {
  let n = 0;
  for (const r of rows) {
    const done = (await tx.execute(sql`
      update usage_alert_states set resolved_at = ${now.toISOString()}::timestamptz,
        resolve_reason = 'period_ended'
      where id = ${r.id} and resolved_at is null returning id`)) as unknown as unknown[];
    if (!done.length) continue;
    await emitEvent(tx, {
      organizationId: r.organization_id,
      businessId: r.business_id,
      type: "usage_alert_resolved",
      data: {
        usage_alert: {
          id: r.alert_public_id,
          kind: r.kind,
          scope: r.scope,
          interval: r.interval,
          currency: r.currency,
        },
        customer: r.customer_public_id,
        subscription: r.subscription_public_id,
        threshold_value: Number(r.threshold),
        period_key: new Date(r.period_key).toISOString(),
        reason: "period_ended",
      },
    });
    n++;
  }
  return n;
}

/** Customers with a succeeded payment in the last 25 h, in businesses that have tiers. */
async function recentPayers(
  now: Date,
  limit: number,
): Promise<Array<{ organization_id: string; business_id: string; customer_id: string }>> {
  return (await systemDb.execute(sql`
    select distinct p.organization_id, p.business_id, p.customer_id
    from events e join payments p on p.business_id = e.business_id and p.public_id = e.resource_id
    where e.type = 'payment_succeeded' and p.status = 'succeeded' and p.customer_id is not null
      ${scopeSql("e.business_id")}
      and e.created_at > ${new Date(now.getTime() - 25 * 3_600_000).toISOString()}::timestamptz
      and exists (select 1 from spend_limit_tiers t where t.business_id = p.business_id and t.active)
    limit ${limit}`)) as unknown as Array<{
    organization_id: string;
    business_id: string;
    customer_id: string;
  }>;
}

let lastDaily: string | null = null;

/** For tests: run the daily part on the next pass. */
export function resetUsageAlertsDaily(): void {
  lastDaily = null;
}

export interface UsageAlertsPassResult {
  resolved: number;
  tiers: number;
  daily: Record<string, number>;
  capped: boolean;
}

export async function runUsageAlertsPass(now: Date): Promise<UsageAlertsPassResult> {
  const limit = config.TICK_SCAN_LIMIT;
  const ended = await endedStates(now, limit);
  const byOrg = new Map<string, EndedState[]>();
  for (const r of ended) byOrg.set(r.organization_id, [...(byOrg.get(r.organization_id) ?? []), r]);
  let resolved = 0;
  for (const [org, rows] of byOrg) {
    try {
      resolved += await withTenant(org, (tx) => resolveEnded(tx, rows, now));
    } catch (e) {
      log.error(e, { event: "usage_alerts_resolve_failed", organizationId: org });
    }
  }

  let tiers = 0;
  const daily: Record<string, number> = {};
  const scoped = !!currentClockScope()?.onlyBusinessId;
  const day = now.toISOString().slice(0, 10);
  // Once a day per process (a travel step always runs it); every step is idempotent.
  if (scoped || lastDaily !== day) {
    if (!scoped) lastDaily = day;
    for (const p of await recentPayers(now, limit)) {
      try {
        tiers += await withTenant(p.organization_id, (tx) =>
          catchUpTiers(tx, {
            organizationId: p.organization_id,
            businessId: p.business_id,
            customerId: p.customer_id,
          }),
        );
      } catch (e) {
        log.error(e, { event: "usage_tier_catch_up_failed", customerId: p.customer_id });
      }
    }
    for (const s of dailySteps) {
      try {
        daily[s.name] = await s.fn(now);
      } catch (e) {
        log.error(e, { event: "usage_alerts_daily_step_failed", step: s.name });
      }
    }
  }
  return { resolved, tiers, daily, capped: ended.length >= limit };
}
