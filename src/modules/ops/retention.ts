import { eq, sql, type SQL } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { organizationRetention, retentionDefaults } from "@db/schema";

const log = createLogger("ops.retention");

/**
 * The nightly retention sweep (D17): log-style rows past their period are removed so storage
 * grows with customers, not with time. Money records (invoices, credit notes, ledger,
 * transactions, subscriptions, customers) are never in scope.
 *
 * Staff set a mode and periods per organization in the back-office; anything unset follows
 * `retention_defaults`. `dry_run` only counts and records what `on` would remove.
 */
export type RetentionMode = "off" | "dry_run" | "on";

export const RETENTION_MODES: readonly RetentionMode[] = ["off", "dry_run", "on"];

/** The settings one organization runs with. A period of 0 keeps that data forever. */
export interface OrgRetention {
  mode: RetentionMode;
  eventsDays: number;
  webhookDeliveriesDays: number;
  gatewayLogsDays: number;
  emailBodyDays: number;
  idempotencyHours: number;
  /** API request log. These apply whatever the mode: the log never grows without end. */
  apiLogWritesDays: number;
  apiLogReadsDays: number;
}

type Defaults = typeof retentionDefaults.$inferSelect;
type Own = Pick<
  typeof organizationRetention.$inferSelect,
  | "mode"
  | "eventsDays"
  | "webhookDeliveriesDays"
  | "gatewayLogsDays"
  | "emailBodyDays"
  | "idempotencyHours"
  | "apiLogWritesDays"
  | "apiLogReadsDays"
>;

/** An organization's own setting over the defaults, column by column. */
export function effectiveRetention(defaults: Defaults, own: Own | null | undefined): OrgRetention {
  return {
    mode: (own?.mode ?? defaults.mode) as RetentionMode,
    eventsDays: own?.eventsDays ?? defaults.eventsDays,
    webhookDeliveriesDays: own?.webhookDeliveriesDays ?? defaults.webhookDeliveriesDays,
    gatewayLogsDays: own?.gatewayLogsDays ?? defaults.gatewayLogsDays,
    emailBodyDays: own?.emailBodyDays ?? defaults.emailBodyDays,
    idempotencyHours: own?.idempotencyHours ?? defaults.idempotencyHours,
    apiLogWritesDays: own?.apiLogWritesDays ?? defaults.apiLogWritesDays,
    apiLogReadsDays: own?.apiLogReadsDays ?? defaults.apiLogReadsDays,
  };
}

/** The defaults row, created with the column defaults when it is missing (a reset truncates it). */
export async function retentionDefaultsRow(): Promise<Defaults> {
  const [found] = await systemDb.select().from(retentionDefaults).limit(1);
  if (found) return found;
  await systemDb.insert(retentionDefaults).values({ id: true }).onConflictDoNothing();
  const [row] = await systemDb.select().from(retentionDefaults).limit(1);
  return row!;
}

/** Rows per statement: short transactions, no long row locks. */
export const RETENTION_BATCH = 5_000;
/** Wall-clock budget for one sweep; whatever is left waits for the next night. */
export const RETENTION_BUDGET_MS = 15 * 60_000;

const DAY_MS = 86_400_000;

/** `now` minus a period, or null when the period keeps the data forever. */
const cutoff = (now: Date, ms: number): Date | null =>
  ms > 0 ? new Date(now.getTime() - ms) : null;

/**
 * One kind of data to remove. `count` is `select count(*)` over the rows past the period;
 * `remove` acts on at most `limit` of them and returns one row per row it acted on.
 */
interface Dataset {
  key: string;
  count: SQL;
  remove: (limit: number) => SQL;
}

const rowCount = (r: unknown): number =>
  Array.isArray(r) ? r.length : ((r as { rows?: unknown[] }).rows?.length ?? 0);

/** Datasets of one organization under its settings; a period of 0 contributes none. */
export function orgDatasets(orgId: string, p: OrgRetention, now: Date): Dataset[] {
  const out: Dataset[] = [];
  const businesses = sql`(select b.id from businesses b where b.organization_id = ${orgId})`;

  const deliveries = cutoff(now, p.webhookDeliveriesDays * DAY_MS);
  // A delivery the delivery period still keeps, or one still being retried.
  const keptDelivery = deliveries
    ? sql`(d.status = 'pending' or d.created_at >= ${deliveries.toISOString()}::timestamptz)`
    : sql`true`;

  if (deliveries) {
    const where = sql`d.organization_id = ${orgId} and d.status in ('delivered', 'failed')
      and d.created_at < ${deliveries.toISOString()}::timestamptz`;
    out.push({
      key: "webhook_deliveries",
      count: sql`select count(*)::int as n from webhook_deliveries d where ${where}`,
      remove: (limit) => sql`delete from webhook_deliveries where id in (
        select d.id from webhook_deliveries d where ${where} limit ${limit}) returning 1`,
    });
  }

  const events = cutoff(now, p.eventsDays * DAY_MS);
  if (events) {
    // Deliveries cascade from their event, so an event outlives every delivery still kept.
    // Deliveries run first, so a dry run counts the same rows `on` deletes.
    const where = sql`e.organization_id = ${orgId} and e.created_at < ${events.toISOString()}::timestamptz
      and not exists (select 1 from webhook_deliveries d where d.event_id = e.id and ${keptDelivery})`;
    out.push({
      key: "events",
      count: sql`select count(*)::int as n from events e where ${where}`,
      remove: (limit) => sql`delete from events where id in (
        select e.id from events e where ${where} limit ${limit}) returning 1`,
    });
  }

  const gateway = cutoff(now, p.gatewayLogsDays * DAY_MS);
  if (gateway) out.push(...gatewayDatasets((col) => sql`${col} in ${businesses}`, gateway));

  const emails = cutoff(now, p.emailBodyDays * DAY_MS);
  if (emails) {
    // The record of who, what and when stays with the money records; only the body goes.
    const where = sql`m.organization_id = ${orgId} and m.status <> 'pending' and m.body_removed_at is null
      and m.created_at < ${emails.toISOString()}::timestamptz`;
    out.push({
      key: "email_bodies",
      count: sql`select count(*)::int as n from email_messages m where ${where}`,
      remove: (limit) => sql`update email_messages set body_html = '', body_text = '',
          body_removed_at = ${now.toISOString()}::timestamptz
        where id in (select m.id from email_messages m where ${where} limit ${limit}) returning 1`,
    });
  }

  const keys = cutoff(now, p.idempotencyHours * 3_600_000);
  if (keys) {
    // Finished keys only: `in_progress` and `side_effects` belong to `reapStaleIdempotencyKeys`.
    const where = sql`k.organization_id = ${orgId} and k.status in ('completed', 'failed')
      and k.created_at < ${keys.toISOString()}::timestamptz`;
    out.push({
      key: "idempotency_keys",
      count: sql`select count(*)::int as n from idempotency_keys k where ${where}`,
      remove: (limit) => sql`delete from idempotency_keys where id in (
        select k.id from idempotency_keys k where ${where} limit ${limit}) returning 1`,
    });
  }
  return out;
}

/** The API request log: write requests and read requests, each past its own period. */
export function apiLogDatasets(orgId: string, p: OrgRetention, now: Date): Dataset[] {
  const out: Dataset[] = [];
  for (const [kind, days] of [
    ["write", p.apiLogWritesDays],
    ["read", p.apiLogReadsDays],
  ] as const) {
    const before = cutoff(now, days * DAY_MS);
    if (!before) continue;
    const where = sql`l.organization_id = ${orgId} and l.kind = ${kind}
      and l.created_at < ${before.toISOString()}::timestamptz`;
    out.push({
      key: `api_log_${kind}s`,
      count: sql`select count(*)::int as n from api_request_logs l where ${where}`,
      remove: (limit) => sql`delete from api_request_logs where id in (
        select l.id from api_request_logs l where ${where} limit ${limit}) returning 1`,
    });
  }
  return out;
}

/**
 * Outbound gateway calls and inbound gateway webhooks whose business `owned` accepts.
 * A webhook row is stripped, never deleted: its (gateway, business, event id) key is the
 * dedup that refuses a replayed delivery, so it must outlive the period. The body, headers,
 * normalized event and error text go; the key, type, outcome and times stay.
 */
function gatewayDatasets(owned: (businessId: SQL) => SQL, before: Date): Dataset[] {
  const at = before.toISOString();
  const calls = sql`${owned(sql`g.business_id`)} and g.created_at < ${at}::timestamptz`;
  const hooks = sql`${owned(sql`p.business_id`)} and p.received_at < ${at}::timestamptz
    and (p.payload is not null or p.headers is not null or p.normalized is not null
         or p.error is not null)`;
  return [
    {
      key: "gateway_calls",
      count: sql`select count(*)::int as n from gateway_request_logs g where ${calls}`,
      remove: (limit) => sql`delete from gateway_request_logs where id in (
        select g.id from gateway_request_logs g where ${calls} limit ${limit}) returning 1`,
    },
    {
      key: "gateway_webhooks",
      count: sql`select count(*)::int as n from provider_events p where ${hooks}`,
      remove: (limit) => sql`update provider_events
        set payload = null, headers = null, normalized = null, error = null
        where id in (select p.id from provider_events p where ${hooks} limit ${limit}) returning 1`,
    },
  ];
}

/** Usage dedup rows are kept as long as an event may be backdated (35 days). */
export const USAGE_DEDUP_DAYS = 35;
export const USAGE_DEDUP_BATCH = 10_000;

export function usageDedupDataset(now: Date): Dataset {
  const where = sql`u.created_at < ${new Date(now.getTime() - USAGE_DEDUP_DAYS * DAY_MS).toISOString()}::timestamptz`;
  return {
    key: "usage_event_dedup",
    count: sql`select count(*)::int as n from usage_event_dedup u where ${where}`,
    remove: (limit) => sql`delete from usage_event_dedup where (business_id, key) in (
      select u.business_id, u.key from usage_event_dedup u where ${where} limit ${limit}) returning 1`,
  };
}

/** Platform data, which belongs to no organization, under the defaults. */
export function platformDatasets(d: Defaults, now: Date): Dataset[] {
  const out: Dataset[] = [];
  const ticks = cutoff(now, d.clockTicksDays * DAY_MS);
  if (ticks) {
    const where = sql`t.started_at < ${ticks.toISOString()}::timestamptz`;
    out.push({
      key: "clock_ticks",
      count: sql`select count(*)::int as n from clock_ticks t where ${where}`,
      remove: (limit) => sql`delete from clock_ticks where id in (
        select t.id from clock_ticks t where ${where} limit ${limit}) returning 1`,
    });
  }
  const results = cutoff(now, d.invariantResultsDays * DAY_MS);
  if (results) {
    // The latest result of each check stays, however old: it is the check's current state.
    const where = sql`r.ran_at < ${results.toISOString()}::timestamptz
      and r.id not in (select distinct on (check_key) id from ops_invariant_results
                       order by check_key, ran_at desc)`;
    out.push({
      key: "invariant_results",
      count: sql`select count(*)::int as n from ops_invariant_results r where ${where}`,
      remove: (limit) => sql`delete from ops_invariant_results where id in (
        select r.id from ops_invariant_results r where ${where} limit ${limit}) returning 1`,
    });
  }
  // Gateway logs with no business, or one that no longer exists, follow the default period.
  const gateway = cutoff(now, d.gatewayLogsDays * DAY_MS);
  if (gateway)
    out.push(
      ...gatewayDatasets(
        (col) =>
          sql`(${col} is null or not exists (select 1 from businesses b where b.id = ${col}))`,
        gateway,
      ),
    );
  return out;
}

/**
 * Count (`dry_run`) or remove (`on`) every dataset, in batches, until the deadline.
 * Returns the rows counted or acted on per dataset, and whether the deadline cut it short.
 */
async function runDatasets(
  mode: Exclude<RetentionMode, "off">,
  datasets: Dataset[],
  deadline: number,
  batch: number,
): Promise<{ counts: Record<string, number>; complete: boolean }> {
  const counts: Record<string, number> = {};
  for (const ds of datasets) {
    if (Date.now() >= deadline) return { counts, complete: false };
    if (mode === "dry_run") {
      const [r] = (await systemDb.execute(ds.count)) as unknown as Array<{ n: number }>;
      counts[ds.key] = r?.n ?? 0;
      continue;
    }
    let n = 0;
    for (;;) {
      const done = rowCount(await systemDb.execute(ds.remove(batch)));
      n += done;
      if (done < batch) break;
      if (Date.now() >= deadline) {
        counts[ds.key] = n;
        return { counts, complete: false };
      }
    }
    counts[ds.key] = n;
  }
  return { counts, complete: true };
}

export interface RetentionSweepResult {
  organizations: Record<RetentionMode, number>;
  /** Rows removed (`on`) or that would be removed (`dry_run`), per dataset. */
  removed: Record<string, number>;
  wouldRemove: Record<string, number>;
  /** False when the budget ran out; the rest waits for the next run. */
  complete: boolean;
}

/**
 * The nightly sweep. Platform data first, then every organization, least recently swept
 * first, so one cut short by the budget is first in line the next night.
 */
export async function runRetentionSweep(
  now: Date = new Date(),
  opts: { budgetMs?: number; batch?: number; onlyOrganizationId?: string } = {},
): Promise<RetentionSweepResult> {
  const deadline = Date.now() + (opts.budgetMs ?? RETENTION_BUDGET_MS);
  const batch = opts.batch ?? RETENTION_BATCH;
  const defaults = await retentionDefaultsRow();

  const result: RetentionSweepResult = {
    organizations: { off: 0, dry_run: 0, on: 0 },
    removed: {},
    wouldRemove: {},
    complete: true,
  };
  const tally = (mode: RetentionMode, counts: Record<string, number>) => {
    const into = mode === "on" ? result.removed : result.wouldRemove;
    for (const [k, n] of Object.entries(counts)) into[k] = (into[k] ?? 0) + n;
  };

  const platformMode = defaults.mode as RetentionMode;
  if (platformMode !== "off" && !opts.onlyOrganizationId) {
    const run = await runDatasets(platformMode, platformDatasets(defaults, now), deadline, batch);
    tally(platformMode, run.counts);
    result.complete &&= run.complete;
    await systemDb
      .update(retentionDefaults)
      .set({ lastRunAt: now, lastRunMode: platformMode, lastRun: run.counts })
      .where(eq(retentionDefaults.id, true));
  }

  const orgs = (await systemDb.execute(sql`
    select o.id::text as id, r.mode, r.events_days, r.webhook_deliveries_days,
           r.gateway_logs_days, r.email_body_days, r.idempotency_hours,
           r.api_log_writes_days, r.api_log_reads_days
    from organizations o
    left join organization_retention r on r.organization_id = o.id
    ${opts.onlyOrganizationId ? sql`where o.id = ${opts.onlyOrganizationId}` : sql``}
    order by r.last_run_at asc nulls first, o.id`)) as unknown as Array<{
    id: string;
    mode: string | null;
    events_days: number | null;
    webhook_deliveries_days: number | null;
    gateway_logs_days: number | null;
    email_body_days: number | null;
    idempotency_hours: number | null;
    api_log_writes_days: number | null;
    api_log_reads_days: number | null;
  }>;
  const settings = (o: (typeof orgs)[number]) =>
    effectiveRetention(defaults, {
      mode: o.mode,
      eventsDays: o.events_days,
      webhookDeliveriesDays: o.webhook_deliveries_days,
      gatewayLogsDays: o.gateway_logs_days,
      emailBodyDays: o.email_body_days,
      idempotencyHours: o.idempotency_hours,
      apiLogWritesDays: o.api_log_writes_days,
      apiLogReadsDays: o.api_log_reads_days,
    });

  for (const o of orgs) {
    const p = settings(o);
    result.organizations[p.mode]++;
    if (p.mode === "off") continue;
    if (Date.now() >= deadline) {
      result.complete = false;
      break;
    }
    const run = await runDatasets(p.mode, orgDatasets(o.id, p, now), deadline, batch);
    tally(p.mode, run.counts);
    result.complete &&= run.complete;
    await systemDb
      .insert(organizationRetention)
      .values({ organizationId: o.id, lastRunAt: now, lastRunMode: p.mode, lastRun: run.counts })
      .onConflictDoUpdate({
        target: organizationRetention.organizationId,
        set: { lastRunAt: now, lastRunMode: p.mode, lastRun: run.counts },
      });
    if (!run.complete) break;
  }

  // Usage event dedup rows, in every mode: they only bound the 35-day dedup window
  // (metering/ingest.ts), so they are not data a retention setting keeps.
  if (!opts.onlyOrganizationId && Date.now() < deadline) {
    const run = await runDatasets("on", [usageDedupDataset(now)], deadline, USAGE_DEDUP_BATCH);
    tally("on", run.counts);
    result.complete &&= run.complete;
  }

  // The request log, last: it follows its own periods in every mode, Off and Dry run too.
  for (const o of orgs) {
    const p = settings(o);
    const datasets = apiLogDatasets(o.id, p, now);
    if (!datasets.length) continue;
    if (Date.now() >= deadline) {
      result.complete = false;
      break;
    }
    const run = await runDatasets("on", datasets, deadline, batch);
    tally("on", run.counts);
    result.complete &&= run.complete;
    // Kept beside the org's own run: the back-office shows these as deleted in every mode.
    await systemDb.execute(sql`
      insert into organization_retention (organization_id, last_run_at, last_run_mode, last_run)
      values (${o.id}, ${now.toISOString()}::timestamptz, ${p.mode}, ${JSON.stringify(run.counts)}::jsonb)
      on conflict (organization_id) do update set
        last_run_at = excluded.last_run_at,
        last_run_mode = coalesce(organization_retention.last_run_mode, excluded.last_run_mode),
        last_run = coalesce(organization_retention.last_run, '{}'::jsonb) || excluded.last_run`);
    if (!run.complete) break;
  }

  log.info("retention sweep finished", { event: "retention_sweep", ...result });
  return result;
}
