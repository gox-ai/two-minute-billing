/**
 * Late usage after a cancellation (`billing_rules_config.late_usage_invoices`, opt-in): usage
 * of an invoiced period that arrives after a cancelled subscription's last invoice, while no
 * live subscription of the customer bills the meter, goes on one more invoice.
 *
 *  - Raised once the oldest unbilled late event was received `wait_hours` ago (24 unset;
 *    event ids are uuid_v7 from the DB clock at ingest), so a burst lands on one invoice.
 *    Under a business's test-clock pin the rule counts as met: real receive times mean
 *    nothing against a simulated clock.
 *  - At most one per `min_interval_hours` per customer (24 unset) on the business clock. The
 *    origin token `lui:<customer>:<business-day>` (plus the slot of the interval when it is
 *    shorter than a day) makes a race or a re-run one invoice.
 *  - Late lines only, re-rated at each period's stored pricing (`lateOnly` plan). Below the
 *    business's minimum for the currency nothing is raised and the pointer stays: the usage
 *    waits for more, or for a new subscription that takes the meter.
 *  - DB only. Collection is handed to the collect pump; one attempt, never dunned.
 */
import { eq, sql } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { config as appConfig } from "@/platform/config";
import {
  activeClockPin,
  businessNow,
  localDatePartsInTz,
  scanBusinessFilter,
} from "@/platform/clock";
import { createLogger } from "@/platform/logger";
import { getTraceId } from "@/platform/trace";
import { customerMeterBilling, customers, subscriptions } from "@db/schema";
import { FOLD_GRACE_MS } from "@/modules/metering/meter-rating";
import { countsAsUsage, countsTowardJoined, rowsOf, uuidFloor } from "@/modules/metering/usage-sql";
import {
  commitSubscriptionPeriodInvoice,
  isAutoCollectOn,
  planSubscriptionPeriodInvoice,
} from "@/modules/invoicing/service";
import { resolveBillingRulesConfig } from "./billing-rules-config";
import type { TickError } from "./renewal";

const log = createLogger("late-usage-invoices");

const HOUR_MS = 3_600_000;
/** Events older than 35 days are refused at ingest; a day of slack. */
const LATE_HORIZON = sql`interval '36 days'`;
/** A row judged with nothing to raise is scanned again at most this often (real clock). */
const RESCAN = sql`interval '1 hour'`;

export interface LateUsagePassResult {
  raised: number;
  /** Late usage below the business's minimum, left to wait. */
  waiting: number;
  capped: boolean;
  errors: TickError[];
}

interface Row {
  organization_id: string;
  business_id: string;
  customer_id: string;
  meter_id: string;
  subscription_id: string;
  sub_created_at: string;
  usage_through: string;
  cutoff_at: string;
  late_checked_at: string | null;
}

interface Scanned extends Row {
  n: number;
  oldest: Date | null;
  newest: Date | null;
}

/** The `late_usage_invoices` pass of the billing clock. */
export async function runLateUsageInvoices(now: Date): Promise<LateUsagePassResult> {
  void now;
  const out: LateUsagePassResult = { raised: 0, waiting: 0, capped: false, errors: [] };
  const limit = appConfig.TICK_SCAN_LIMIT;
  const pinned = activeClockPin()?.businessId ?? null;
  const scope = scanBusinessFilter(customerMeterBilling.businessId);
  // Customers with a row whose owner is cancelled, in a business with the setting on, due a scan.
  const due = rowsOf<{ organization_id: string; business_id: string; customer_id: string }>(
    await systemDb.execute(sql`
      select distinct customer_meter_billing.organization_id,
        customer_meter_billing.business_id, customer_meter_billing.customer_id
      from customer_meter_billing
      join subscriptions s on s.id = customer_meter_billing.subscription_id
      join businesses b on b.id = customer_meter_billing.business_id
      where (b.billing_rules_config -> 'late_usage_invoices' ->> 'enabled') = 'true'
        and (s.status = 'cancelled' or s.deleted_at is not null)
        and customer_meter_billing.usage_through is not null
        and customer_meter_billing.cutoff_at is not null
        and customer_meter_billing.usage_through > now() - ${LATE_HORIZON}
        and (customer_meter_billing.late_checked_at is null
             or customer_meter_billing.late_checked_at < now() - ${RESCAN}
             ${pinned ? sql`or customer_meter_billing.business_id = ${pinned}` : sql``})
        ${scope ? sql`and ${scope}` : sql``}
      order by customer_meter_billing.business_id, customer_meter_billing.customer_id
      limit ${limit + 1}`),
  );
  if (due.length > limit) out.capped = true;
  for (const c of due.slice(0, limit)) {
    try {
      const r = await lateUsageForCustomer(c);
      if (r === "raised") out.raised++;
      else if (r === "waiting") out.waiting++;
    } catch (e) {
      out.errors.push({
        organization: c.organization_id,
        business: c.business_id,
        step: "late_usage_invoices",
        message: e instanceof Error ? e.message : String(e),
      });
      log.error(e as Error, { event: "late_usage_invoice_failed", customer: c.customer_id });
    }
  }
  return out;
}

type Outcome = "raised" | "waiting" | "none";

async function lateUsageForCustomer(c: {
  organization_id: string;
  business_id: string;
  customer_id: string;
}): Promise<Outcome> {
  const { organization_id: organizationId, business_id: businessId } = c;
  const loaded = await withTenant(organizationId, async (tx) => {
    const [clock] = rowsOf<{ at: string }>(await tx.execute(sql`select clock_timestamp() at`));
    const dbNow = new Date(clock!.at);
    const rows = rowsOf<Row>(
      await tx.execute(sql`
        select cmb.organization_id, cmb.business_id, cmb.customer_id, cmb.meter_id,
          cmb.subscription_id, s.created_at sub_created_at, cmb.usage_through, cmb.cutoff_at,
          cmb.late_checked_at
        from customer_meter_billing cmb
        join subscriptions s on s.id = cmb.subscription_id
        where cmb.business_id = ${businessId} and cmb.customer_id = ${c.customer_id}
          and (s.status = 'cancelled' or s.deleted_at is not null)
          and cmb.usage_through is not null and cmb.cutoff_at is not null
          and cmb.usage_through > now() - ${LATE_HORIZON}`),
    );
    const scanned: Scanned[] = [];
    for (const r of rows) scanned.push({ ...r, ...(await unbilledLate(tx, r)) });
    const [biz] = rowsOf<{ billing_rules_config: unknown; timezone: string | null }>(
      await tx.execute(
        sql`select billing_rules_config, timezone from businesses where id = ${businessId}`,
      ),
    );
    return { dbNow, scanned, biz };
  });
  const { dbNow, scanned, biz } = loaded;
  const rules = resolveBillingRulesConfig({ billingRulesConfig: biz?.billing_rules_config });
  if (!rules.lateUsageInvoices.enabled) return "none";
  // What arrived before this instant has been seen; a later event may still be committing.
  const horizon = new Date(dbNow.getTime() - FOLD_GRACE_MS);
  const mark = (meterIds: string[]) =>
    meterIds.length === 0
      ? Promise.resolve()
      : withTenant(organizationId, (tx) =>
          tx.execute(sql`
            update customer_meter_billing set late_checked_at = ${horizon.toISOString()}::timestamptz
            where customer_id = ${c.customer_id}
              and meter_id in (${sql.join(
                meterIds.map((m) => sql`${m}::uuid`),
                sql`, `,
              )})`),
        ).then(() => undefined);

  await mark(scanned.filter((r) => r.n === 0).map((r) => r.meter_id));
  const live = scanned.filter((r) => r.n > 0);
  const fresh = live.filter(
    (r) => !r.late_checked_at || (r.newest && r.newest >= new Date(r.late_checked_at)),
  );
  // Nothing new since the last judgement: still waiting, rescan in an hour.
  if (fresh.length === 0) {
    await mark(live.map((r) => r.meter_id));
    return live.length > 0 ? "waiting" : "none";
  }

  const travelled = activeClockPin()?.businessId === businessId;
  const oldest = Math.min(...live.map((r) => r.oldest!.getTime()));
  const { waitHours, minIntervalHours } = rules.lateUsageInvoices;
  if (!travelled && oldest > dbNow.getTime() - waitHours * HOUR_MS) return "none";

  const bizNow = businessNow(businessId);
  const raisedToday = await withTenant(organizationId, async (tx) => {
    const [x] = rowsOf<{ one: number }>(
      await tx.execute(sql`
        select 1 one from invoices
        where business_id = ${businessId} and customer_id = ${c.customer_id}
          and purpose = 'late_usage'
          and created_at > ${new Date(bizNow.getTime() - minIntervalHours * HOUR_MS).toISOString()}::timestamptz
        limit 1`),
    );
    return !!x;
  });
  if (raisedToday) return "none";

  // One subscription a day: the oldest with newly arrived usage. Its waiting meters ride along.
  const subId = [...fresh].sort(
    (a, b) =>
      new Date(a.sub_created_at).getTime() - new Date(b.sub_created_at).getTime() ||
      a.subscription_id.localeCompare(b.subscription_id),
  )[0]!.subscription_id;
  const meterIds = live.filter((r) => r.subscription_id === subId).map((r) => r.meter_id);
  const day = localDatePartsInTz(bizNow, biz?.timezone || "UTC");
  const slot =
    minIntervalHours < 24 ? `:${Math.floor(bizNow.getTime() / (minIntervalHours * HOUR_MS))}` : "";
  const originToken = `lui:${c.customer_id}:${day.year}-${String(day.month + 1).padStart(2, "0")}-${String(day.day).padStart(2, "0")}${slot}`;

  const ctx = await withTenant(organizationId, async (tx) => {
    const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subId));
    const [cus] = await tx
      .select({ ac: customers.autoCollection })
      .from(customers)
      .where(eq(customers.id, c.customer_id));
    return sub ? { sub, autoCollect: isAutoCollectOn(sub.autoCollection, cus?.ac) } : null;
  });
  if (!ctx) return "none";
  const { sub, autoCollect } = ctx;
  const input = {
    organizationId,
    businessId,
    subscription: sub,
    periodStart: bizNow,
    periodEnd: bizNow,
    usagePeriod: { start: bizNow, end: bizNow },
    lateOnly: { originToken, meterIds },
  };
  const minimum = rules.lateUsageInvoices.minimum[sub.currency.toUpperCase()];
  const billable = (p: { lines: unknown[]; subtotal: bigint }) =>
    p.lines.length > 0 && p.subtotal > 0n && (minimum == null || p.subtotal >= BigInt(minimum));

  // A preview peeks: it neither takes nor burns a cutoff.
  const preview = await planSubscriptionPeriodInvoice({
    ...input,
    preview: { excludePendingCharges: true, ignoreCreditBalances: true },
  });
  if (!billable(preview)) {
    await mark(meterIds);
    return preview.lines.length > 0 && preview.subtotal > 0n ? "waiting" : "none";
  }
  const plan = await planSubscriptionPeriodInvoice(input);
  if (plan.mode !== "finalize" || !billable(plan)) {
    await mark(meterIds);
    return "waiting";
  }
  const inner = plan.inTx;
  plan.inTx = async (tx, inv) => {
    await inner?.(tx, inv);
    // A row a live subscription took since the scan bills on that subscription instead.
    const [own] = rowsOf<{ n: number }>(
      await tx.execute(sql`
        select count(*)::int n from customer_meter_billing
        where customer_id = ${c.customer_id} and subscription_id = ${subId}
          and meter_id in (${sql.join(
            meterIds.map((m) => sql`${m}::uuid`),
            sql`, `,
          )})`),
    );
    if ((own?.n ?? 0) !== meterIds.length) throw new MeterTakenError();
    await tx.execute(sql`
      update customer_meter_billing set late_checked_at = ${horizon.toISOString()}::timestamptz
      where customer_id = ${c.customer_id}
        and meter_id in (${sql.join(
          meterIds.map((m) => sql`${m}::uuid`),
          sql`, `,
        )})`);
    // One attempt, by the collect pump; no gateway call in the tick.
    if (autoCollect && inv.status === "payment_due")
      await tx.execute(sql`
        update invoices set collect_due_at = now(), collect_trace_id = ${getTraceId() ?? null}
        where id = ${inv.id}`);
  };
  try {
    await commitSubscriptionPeriodInvoice(plan, { collect: false });
    return "raised";
  } catch (e) {
    if (e instanceof MeterTakenError) return "none";
    const x = e as {
      code?: string;
      constraint?: string;
      cause?: { code?: string; constraint_name?: string };
    };
    const name = String(x?.constraint ?? x?.cause?.constraint_name ?? "");
    if ((x?.code ?? x?.cause?.code) === "23505" && name.includes("invoices_origin_token_uq"))
      return "none";
    throw e;
  }
}

class MeterTakenError extends Error {
  constructor() {
    super("A live subscription took the meter while the late-usage invoice was planned.");
    this.name = "MeterTakenError";
  }
}

/**
 * The row's late events not yet billed, as `lateLines` finds them: received after the last
 * cutoff (less the fold grace), or matched to the customer after it. Arrival = the later of
 * receive (the uuid_v7 time) and match.
 */
async function unbilledLate(
  tx: Tx,
  r: Row,
): Promise<{ n: number; oldest: Date | null; newest: Date | null }> {
  const cutoff = new Date(r.cutoff_at);
  const [x] = rowsOf<{ n: number; oldest: string | null; newest: string | null }>(
    await tx.execute(sql`
      select count(*)::int n, min(a) oldest, max(a) newest from (
        select greatest(
          to_timestamp(('x' || lpad(substr(replace(e.id::text, '-', ''), 1, 12), 16, '0'))::bit(64)::bigint / 1000.0),
          coalesce(e.matched_at, '-infinity'::timestamptz)) a
        from usage_events e join meters m on m.id = ${r.meter_id}
        where e.business_id = ${r.business_id} and e.customer_id = ${r.customer_id}
          and ${countsAsUsage("e")} and ${countsTowardJoined("e", "m")}
          and e.timestamp < ${r.usage_through}::timestamptz
          and ((e.id >= ${uuidFloor(cutoff.getTime() - FOLD_GRACE_MS)}::uuid
                and e.timestamp > ${cutoff.toISOString()}::timestamptz - ${LATE_HORIZON})
               or e.matched_at >= ${cutoff.toISOString()}::timestamptz)
      ) late`),
  );
  return {
    n: x?.n ?? 0,
    oldest: x?.oldest ? new Date(x.oldest) : null,
    newest: x?.newest ? new Date(x.newest) : null,
  };
}
