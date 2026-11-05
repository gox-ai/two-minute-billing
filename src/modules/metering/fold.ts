import { sql, type SQL } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { scanBusinessFilter } from "@/platform/clock";
import { createLogger } from "@/platform/logger";
import { usageRollupState } from "@db/schema";
import { upsertRollups } from "./rollup-sql";
import { foldBackstop } from "@/modules/usage-controls/dirty";
import {
  bucketOf,
  countsTowardJoined,
  groupValuesOf,
  pgTextArray,
  rowsOf,
  uuidFloor,
  uuidFloorSql,
  uuidMs,
  valueOf,
} from "./usage-sql";

const log = createLogger("metering.fold");

/**
 * Events received less than this long ago are not folded: an ingest transaction may still
 * commit below it (10 s statement timeout), and app and database clocks may differ a little.
 */
export const FOLD_GRACE_MS = 5 * 60_000;
/** Events per fold or backfill transaction. */
export const FOLD_CHUNK = 50_000;
/** Wall-clock budget for one cron run; the rest waits a minute. */
export const FOLD_BUDGET_MS = 45_000;

/**
 * Called inside each fold transaction after its rollups are written (design §6, PR 3
 * alerts and runway). Empty in 1a.
 */
export type FoldHook = (
  tx: Tx,
  input: { businessId: string; customerIds: string[]; watermark: Date },
) => Promise<void>;
const foldHooks: FoldHook[] = [];
export function registerFoldHook(fn: FoldHook): void {
  if (!foldHooks.includes(fn)) foldHooks.push(fn);
}
// Usage controls: the dirty-set backstop (design G5 §3.1).
registerFoldHook(foldBackstop);

/** Rollable meters joined to events `e`; `extra` narrows the events. */
function hitsSql(
  businessId: string,
  extra: SQL,
  meterFilter: SQL = sql`true`,
  backfill = false,
): SQL {
  return sql`
    select e.organization_id, e.business_id, e.customer_id, m.id as meter_id,
      ${bucketOf(sql`e."timestamp"`)} as bucket, ${groupValuesOf("e", sql`m.group_by`)} as gv,
      coalesce(e.currency, '') as cur, e.id, e."timestamp" as ts,
      ${valueOf("e", sql`m.value_property`)} as val, e.amount, e.cost
    from usage_events e
    join meters m on m.business_id = e.business_id and m.event_name = e.event_name
    where e.business_id = ${businessId} and e.customer_id is not null and e.voided_at is null
      and not m.recurring and m.aggregation in ('sum', 'count', 'min', 'max', 'avg', 'last')
      and m.folded_from is not null
      ${backfill ? sql`` : sql`and e.id >= ${uuidFloorSql(sql`m.folded_from`)}`}
      and ${meterFilter}
      and ${countsTowardJoined("e", "m")}
      and ${extra}`;
}

async function dbNowMs(tx: Tx): Promise<number> {
  const [r] = rowsOf<{ ms: string }>(
    await tx.execute(sql`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as ms`),
  );
  return Number(r!.ms);
}

/**
 * Match the business's pending keys: their stored unmatched events get the customer, and
 * those already behind the watermark are folded now (the main pass will not see them).
 */
async function matchPendingKeys(
  tx: Tx,
  businessId: string,
  watermarkMs: number,
): Promise<{ keys: number; matched: number; customers: string[] }> {
  const pending = rowsOf<{ key: string; customer_id: string }>(
    await tx.execute(sql`select key, customer_id from customer_usage_keys
      where business_id = ${businessId} and match_pending for update`),
  );
  if (!pending.length) return { keys: 0, matched: 0, customers: [] };
  const keys = pgTextArray(pending.map((p) => p.key));
  const matched = rowsOf<{ id: string }>(
    await tx.execute(sql`
      update usage_events e set customer_id = k.customer_id, matched_at = now()
      from customer_usage_keys k
      where e.business_id = ${businessId} and e.customer_id is null
        and e.customer_key = any(${keys}::text[])
        and k.business_id = ${businessId} and k.key = e.customer_key
      returning e.id`),
  );
  const behind = matched.map((m) => m.id).filter((id) => uuidMs(id) < watermarkMs);
  let customers: string[] = [];
  if (behind.length)
    customers = await upsertRollups(
      tx,
      businessId,
      hitsSql(
        businessId,
        sql`e.id = any(${`{${behind.join(",")}}`}::uuid[]) and e.id < ${uuidFloor(watermarkMs)}::uuid`,
      ),
    );
  await tx.execute(sql`update customer_usage_keys set match_pending = false
    where business_id = ${businessId} and match_pending and key = any(${keys}::text[])`);
  return { keys: pending.length, matched: matched.length, customers };
}

export interface FoldStep {
  /** The watermark after this step. */
  watermark: Date;
  folded: number;
  caughtUp: boolean;
}

/**
 * One fold transaction for one business: pending keys, then up to `FOLD_CHUNK` events
 * received in [watermark, now − grace), matched where their key now exists, folded into
 * every rollable meter in one scan. The watermark moves to the chunk's end.
 */
export async function foldBusinessStep(input: {
  organizationId: string;
  businessId: string;
  graceMs?: number;
  chunk?: number;
}): Promise<FoldStep | null> {
  const grace = input.graceMs ?? FOLD_GRACE_MS;
  const chunk = input.chunk ?? FOLD_CHUNK;
  return withTenant(input.organizationId, async (tx) => {
    await tx.execute(sql`set local statement_timeout = '120s'`);
    const [state] = rowsOf<{ watermark: Date }>(
      await tx.execute(sql`select watermark from usage_rollup_state
        where business_id = ${input.businessId} for update`),
    );
    if (!state) return null;
    const fromMs = new Date(state.watermark).getTime();
    const pending = await matchPendingKeys(tx, input.businessId, fromMs);
    const limitMs = (await dbNowMs(tx)) - grace;
    if (limitMs <= fromMs) {
      if (pending.customers.length)
        for (const hook of foldHooks)
          await hook(tx, {
            businessId: input.businessId,
            customerIds: pending.customers,
            watermark: new Date(fromMs),
          });
      return { watermark: new Date(fromMs), folded: 0, caughtUp: true };
    }
    const lo = uuidFloor(fromMs);
    let toMs = limitMs;
    const [cut] = rowsOf<{ id: string }>(
      await tx.execute(sql`
        select id from usage_events
        where business_id = ${input.businessId} and id >= ${lo}::uuid
          and id < ${uuidFloor(limitMs)}::uuid
        order by id offset ${chunk} limit 1`),
    );
    // The chunk ends on a millisecond edge, so "id-time < watermark" stays exact.
    if (cut && uuidMs(cut.id) > fromMs) toMs = uuidMs(cut.id);
    const hi = uuidFloor(toMs);
    await tx.execute(sql`
      update usage_events e set customer_id = k.customer_id, matched_at = now()
      from customer_usage_keys k
      where e.business_id = ${input.businessId} and e.customer_id is null
        and e.id >= ${lo}::uuid and e.id < ${hi}::uuid
        and k.business_id = ${input.businessId} and k.key = e.customer_key`);
    const customers = await upsertRollups(
      tx,
      input.businessId,
      hitsSql(input.businessId, sql`e.id >= ${lo}::uuid and e.id < ${hi}::uuid`),
    );
    const [counted] = rowsOf<{ n: number }>(
      await tx.execute(sql`select count(*)::int as n from usage_events
        where business_id = ${input.businessId} and id >= ${lo}::uuid and id < ${hi}::uuid`),
    );
    const watermark = new Date(toMs);
    await tx.execute(sql`update usage_rollup_state
      set watermark = ${watermark.toISOString()}::timestamptz, updated_at = now()
      where business_id = ${input.businessId}`);
    const touched = [...new Set([...customers, ...pending.customers])];
    for (const hook of foldHooks)
      await hook(tx, { businessId: input.businessId, customerIds: touched, watermark });
    return { watermark, folded: counted?.n ?? 0, caughtUp: toMs === limitMs };
  });
}

/**
 * One backfill transaction for one meter created after events: folds up to `FOLD_CHUNK`
 * older events, newest first, and lowers `folded_from` to the chunk's start. When nothing
 * older is left it sets `backfilled_at`; until then reads of the meter go raw.
 */
export async function backfillMeterStep(input: {
  organizationId: string;
  businessId: string;
  meterId: string;
  chunk?: number;
}): Promise<{ done: boolean; folded: number }> {
  const chunk = input.chunk ?? FOLD_CHUNK;
  return withTenant(input.organizationId, async (tx) => {
    await tx.execute(sql`set local statement_timeout = '120s'`);
    await tx.execute(sql`select 1 from usage_rollup_state
      where business_id = ${input.businessId} for update`);
    const [m] = rowsOf<{
      event_name: string;
      folded_from: Date | null;
      backfilled_at: Date | null;
    }>(
      await tx.execute(sql`select event_name, folded_from, backfilled_at from meters
        where id = ${input.meterId} and business_id = ${input.businessId}`),
    );
    if (!m || m.backfilled_at || !m.folded_from) return { done: true, folded: 0 };
    const ffMs = new Date(m.folded_from).getTime();
    const [cut] = rowsOf<{ id: string }>(
      await tx.execute(sql`
        select id from usage_events
        where business_id = ${input.businessId} and event_name = ${m.event_name}
          and customer_id is not null and voided_at is null and id < ${uuidFloor(ffMs)}::uuid
        order by id desc offset ${chunk - 1} limit 1`),
    );
    const loMs = cut && uuidMs(cut.id) < ffMs ? uuidMs(cut.id) : 0;
    await upsertRollups(
      tx,
      input.businessId,
      hitsSql(
        input.businessId,
        sql`e.id >= ${uuidFloor(loMs)}::uuid and e.id < ${uuidFloor(ffMs)}::uuid`,
        sql`m.id = ${input.meterId}`,
        true,
      ),
    );
    const done = loMs === 0;
    await tx.execute(sql`update meters
      set folded_from = ${new Date(loMs).toISOString()}::timestamptz,
          backfilled_at = ${done ? sql`now()` : sql`null`}
      where id = ${input.meterId}`);
    return { done, folded: 0 };
  });
}

/** Rollable meters still waiting for their backfill. */
async function metersToBackfill(businessId: string): Promise<string[]> {
  const rows = rowsOf<{ id: string }>(
    await systemDb.execute(sql`select id from meters
      where business_id = ${businessId} and backfilled_at is null
        and not recurring and aggregation in ('sum', 'count', 'min', 'max', 'avg', 'last')
      order by created_at`),
  );
  return rows.map((r) => r.id);
}

/** Fold one business until it is caught up, then run its backfills. */
export async function foldBusiness(input: {
  organizationId: string;
  businessId: string;
  graceMs?: number;
  chunk?: number;
  deadline?: number;
}): Promise<{ folded: number; caughtUp: boolean }> {
  const deadline = input.deadline ?? Number.POSITIVE_INFINITY;
  let folded = 0;
  for (;;) {
    const step = await foldBusinessStep(input);
    if (!step) return { folded, caughtUp: true };
    folded += step.folded;
    if (step.caughtUp) break;
    if (Date.now() >= deadline) return { folded, caughtUp: false };
  }
  for (const meterId of await metersToBackfill(input.businessId)) {
    for (;;) {
      const r = await backfillMeterStep({ ...input, meterId });
      if (r.done) break;
      if (Date.now() >= deadline) return { folded, caughtUp: false };
    }
  }
  return { folded, caughtUp: true };
}

/**
 * The `usage_fold` cron: every business with meters, oldest watermark first, within the
 * budget. Honours the clock scope, so a real run skips time-travelled businesses and a
 * travel step folds only its own.
 */
export async function runUsageFold(
  opts: { graceMs?: number; budgetMs?: number } = {},
): Promise<{ businesses: number; folded: number; complete: boolean }> {
  const deadline = Date.now() + (opts.budgetMs ?? FOLD_BUDGET_MS);
  const scope = scanBusinessFilter(usageRollupState.businessId);
  const list = await systemDb
    .select({
      businessId: usageRollupState.businessId,
      organizationId: usageRollupState.organizationId,
    })
    .from(usageRollupState)
    .where(scope)
    .orderBy(usageRollupState.watermark);
  let folded = 0;
  let complete = true;
  for (const b of list) {
    if (Date.now() >= deadline) {
      complete = false;
      break;
    }
    try {
      const r = await foldBusiness({ ...b, graceMs: opts.graceMs, deadline });
      folded += r.folded;
      complete &&= r.caughtUp;
    } catch (e) {
      complete = false;
      log.error(e, { event: "usage_fold_failed", business_id: b.businessId });
    }
  }
  if (folded > 0)
    log.info("usage folded", { event: "usage_fold", businesses: list.length, folded });
  return { businesses: list.length, folded, complete };
}
