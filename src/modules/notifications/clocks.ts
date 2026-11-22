/**
 * The hourly clock (`notification_clock`): facts nothing emits an event for. Each fact enqueues
 * once, through its `dedupe_key`; live businesses only, time-travelled ones left out. What one
 * run finds for one (business, kind) goes out as one message: several new facts become one queue
 * row with `payload.items`, each fact's key kept by a `done` marker row.
 *  - dispute_evidence_due: 72 h, then 24 h, before `disputes.evidence_due_by`.
 *  - invoice_overdue: the due date passed 1 to 25 hours ago and an amount is still due.
 *  - large_renewal: yearly-or-longer active subscriptions, 30 d, then 7 d, before renewal.
 *  - webhook_failing: one per endpoint whose deliveries reached `failed` in the hour window.
 */
import { sql } from "drizzle-orm";
import { notificationQueue } from "@db/schema";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { invoiceOutstanding } from "@/modules/invoicing/service";
import { rowsOf } from "@/modules/metering/usage-sql";
import type { NotificationKind } from "./catalogue";
import { enqueueNotification } from "./enqueue";
import type { NotificationPayload } from "./facts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface ClockScope {
  onlyBusinessId?: string;
  excludeBusinessIds?: string[];
}

interface Fact {
  organizationId: string;
  businessId: string;
  kind: NotificationKind;
  dedupeKey: string;
  payload: NotificationPayload;
}

export const topOfHour = (at: Date) => new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);

/** The scope as SQL on `alias.business_id`, plus live businesses only. */
function liveScope(alias: string, scope: ClockScope) {
  const col = sql.raw(`${alias}.business_id`);
  const parts = [
    sql`exists (select 1 from businesses b where b.id = ${col} and b.livemode = 'live' and b.status = 'active')`,
  ];
  if (scope.onlyBusinessId) parts.push(sql`${col} = ${scope.onlyBusinessId}::uuid`);
  if (scope.excludeBusinessIds?.length)
    parts.push(sql`${col} <> all(${`{${scope.excludeBusinessIds.join(",")}}`}::uuid[])`);
  return sql.join(parts, sql` and `);
}

export async function evidenceDueFacts(now: Date, scope: ClockScope = {}): Promise<Fact[]> {
  const rows = rowsOf<{
    id: string;
    public_id: string;
    organization_id: string;
    business_id: string;
    due: Date | string;
  }>(
    await systemDb.execute(sql`
      select d.id, d.public_id, d.organization_id, d.business_id, d.evidence_due_by as due
      from disputes d
      where d.status = 'needs_response'
        and d.evidence_due_by > ${now.toISOString()}::timestamptz
        and d.evidence_due_by <= ${new Date(now.getTime() + 72 * HOUR_MS).toISOString()}::timestamptz
        and ${liveScope("d", scope)}`),
  );
  return rows.map((r) => {
    const mark = new Date(r.due).getTime() - now.getTime() <= DAY_MS ? "24h" : "72h";
    return {
      organizationId: r.organization_id,
      businessId: r.business_id,
      kind: "dispute_evidence_due",
      dedupeKey: `clock:dispute_evidence_due:${r.id}:${mark}`,
      payload: { record: { type: "dispute", id: r.public_id } },
    };
  });
}

export async function overdueFacts(hour: Date, scope: ClockScope = {}): Promise<Fact[]> {
  // An hour of slack lets the due pass collect an auto-charged invoice first; 24 more hours
  // of reach cover a missed run. The dedupe key keeps each invoice to one.
  const rows = rowsOf<{
    id: string;
    public_id: string;
    organization_id: string;
    business_id: string;
    currency: string;
    amount_due_minor: string | null;
    total_minor: string;
  }>(
    await systemDb.execute(sql`
      select i.id, i.public_id, i.organization_id, i.business_id, i.currency,
        i.amount_due_minor, i.total_minor
      from invoices i
      where i.status in ('posted', 'payment_due', 'not_paid') and not i.written_off
        and i.due_date >= ${new Date(hour.getTime() - 25 * HOUR_MS).toISOString()}::timestamptz
        and i.due_date < ${new Date(hour.getTime() - HOUR_MS).toISOString()}::timestamptz
        and ${liveScope("i", scope)}
      order by i.due_date`),
  );
  const out: Fact[] = [];
  for (const r of rows) {
    const { remainingMinor } = await withTenant(r.organization_id, (tx) =>
      invoiceOutstanding(tx, {
        id: r.id,
        amountDueMinor: r.amount_due_minor == null ? null : BigInt(r.amount_due_minor),
        totalMinor: BigInt(r.total_minor),
      }),
    );
    if (remainingMinor <= 0n) continue;
    out.push({
      organizationId: r.organization_id,
      businessId: r.business_id,
      kind: "invoice_overdue",
      dedupeKey: `clock:invoice_overdue:${r.id}`,
      payload: {
        record: { type: "invoice", id: r.public_id },
        facts: { amountMinor: Number(remainingMinor), currency: r.currency },
      },
    });
  }
  return out;
}

export async function largeRenewalFacts(now: Date, scope: ClockScope = {}): Promise<Fact[]> {
  // The expected amount is the last invoice's total: what the renewal bills again.
  const rows = rowsOf<{
    id: string;
    public_id: string;
    organization_id: string;
    business_id: string;
    currency: string;
    period_end: Date | string;
    last_total: string | null;
  }>(
    await systemDb.execute(sql`
      select s.id, s.public_id, s.organization_id, s.business_id, s.currency,
        s.current_period_end as period_end,
        (select i.total_minor::text from invoices i
          where i.subscription_id = s.id and i.status not in ('voided', 'pending', 'draft')
          order by i.created_at desc limit 1) as last_total
      from subscriptions s
      where s.status = 'active' and s.deleted_at is null and s.cancel_scheduled_at is null
        and (s.billing_period_unit = 'year'
             or (s.billing_period_unit = 'month' and coalesce(s.billing_period, 1) >= 12))
        and s.current_period_end > ${now.toISOString()}::timestamptz
        and s.current_period_end <= ${new Date(now.getTime() + 30 * DAY_MS).toISOString()}::timestamptz
        and ${liveScope("s", scope)}`),
  );
  return rows.map((r) => {
    const end = new Date(r.period_end);
    const mark = end.getTime() - now.getTime() <= 7 * DAY_MS ? "7d" : "30d";
    return {
      organizationId: r.organization_id,
      businessId: r.business_id,
      kind: "large_renewal",
      dedupeKey: `clock:large_renewal:${r.id}:${end.toISOString().slice(0, 10)}:${mark}`,
      payload: {
        record: { type: "subscription", id: r.public_id },
        facts: {
          dueAt: end.toISOString(),
          ...(r.last_total != null
            ? { amountMinor: Number(r.last_total), currency: r.currency }
            : {}),
        },
      },
    };
  });
}

/** Deliveries whose last attempt started 1 to 2 hours back (the `failed` write lands up to ~90 s later). */
export async function webhookFailingFacts(hour: Date, scope: ClockScope = {}): Promise<Fact[]> {
  const start = new Date(hour.getTime() - 2 * HOUR_MS);
  const end = new Date(hour.getTime() - HOUR_MS);
  const rows = rowsOf<{
    endpoint_id: string;
    public_id: string;
    organization_id: string;
    business_id: string;
    failed: number;
  }>(
    await systemDb.execute(sql`
      select e.id as endpoint_id, e.public_id, d.organization_id, d.business_id, count(*)::int as failed
      from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
      where d.status = 'failed' and d.business_id is not null
        and d.last_attempt_at >= ${start.toISOString()}::timestamptz
        and d.last_attempt_at < ${end.toISOString()}::timestamptz
        and ${liveScope("d", scope)}
      group by e.id, e.public_id, d.organization_id, d.business_id`),
  );
  return rows.map((r) => ({
    organizationId: r.organization_id,
    businessId: r.business_id,
    kind: "webhook_failing",
    dedupeKey: `clock:webhook_failing:${r.endpoint_id}:${r.business_id}:${start.toISOString()}`,
    payload: {
      record: { type: "webhook_endpoint", id: r.public_id },
      facts: { failedCount: r.failed },
    },
  }));
}

/** One run for the hour `at` falls in. Returns how many facts were new. */
export async function runNotificationClocks(
  at: Date,
  scope: ClockScope = {},
): Promise<{ found: number; enqueued: number }> {
  const hour = topOfHour(at);
  const facts = [
    ...(await evidenceDueFacts(at, scope)),
    ...(await overdueFacts(hour, scope)),
    ...(await largeRenewalFacts(at, scope)),
    ...(await webhookFailingFacts(hour, scope)),
  ];
  const groups = new Map<string, Fact[]>();
  for (const f of facts) {
    const k = `${f.organizationId}|${f.businessId}|${f.kind}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  let enqueued = 0;
  for (const list of groups.values())
    enqueued += await withTenant(list[0]!.organizationId, (tx) => enqueueRun(tx, list));
  return { found: facts.length, enqueued };
}

/** One (business, kind) of a run: one queue row for the facts not sent before. */
async function enqueueRun(tx: Tx, list: Fact[]): Promise<number> {
  const first = list[0]!;
  const row = { organizationId: first.organizationId, businessId: first.businessId };
  if (list.length === 1)
    return (await enqueueNotification(tx, {
      ...row,
      kinds: [first.kind],
      dedupeKey: first.dedupeKey,
      payload: first.payload,
    }))
      ? 1
      : 0;
  const fresh: Fact[] = [];
  for (const f of list) {
    const marker = await tx
      .insert(notificationQueue)
      .values({
        ...row,
        dedupeKey: f.dedupeKey,
        kinds: [f.kind],
        payload: f.payload as Record<string, unknown>,
        status: "done",
      })
      .onConflictDoNothing({ target: notificationQueue.dedupeKey })
      .returning({ id: notificationQueue.id });
    if (marker.length) fresh.push(f);
  }
  if (fresh.length === 0) return 0;
  await enqueueNotification(tx, {
    ...row,
    kinds: [first.kind],
    dedupeKey: `clock_run:${fresh[0]!.dedupeKey}`,
    payload: { items: fresh.map((f) => f.payload) },
  });
  return fresh.length;
}
