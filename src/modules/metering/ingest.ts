import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { withTenant, type Tx } from "@/platform/db";
import { stampNow } from "@/platform/clock";
import { createLogger } from "@/platform/logger";
import {
  MAX_AMOUNT_MAGNITUDE,
  MAX_USAGE_DECIMALS,
  tryParseFixed12,
  withinMaxMagnitude,
} from "@/platform/fixed";
import { meters } from "@db/schema";
import { JsonNumber, parseJsonExact, propertiesJson, propertyText } from "./json-source";
import { resolveUsageKeys } from "./meters";
import { ensureUsageMonth, monthStart } from "./partitions";
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
import { bumpRollupVersion, upsertRollups } from "./rollup-sql";
import { markDirtyOnIngest } from "@/modules/usage-controls/dirty";

const log = createLogger("metering.ingest");

/** Events per batch request. */
export const MAX_BATCH = 500;
export const MAX_PROPERTIES = 50;
export const MAX_PROPERTIES_BYTES = 8 * 1024;
/** Accepted timestamp range around "now" (Decision 4). Dedup rows live as long. */
export const MAX_BACKDATE_MS = 35 * 86_400_000;
export const MAX_AHEAD_MS = 5 * 60_000;

/** RFC 3339 with `Z` or an offset. No epoch numbers, no bare dates. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([Zz]|[+-]\d{2}:\d{2})$/;

const propertyValue = z.union([z.string().max(1024), z.boolean(), z.instanceof(JsonNumber)]);
const decimalInput = z.union([z.string().max(64), z.instanceof(JsonNumber)]);

/** One usage event as the API takes it. Numbers arrive as `JsonNumber` (see json-source.ts). */
export const usageEventInput = z.object({
  key: z.string().min(1).max(255),
  customer: z.string().min(1).max(255),
  event_name: z.string().min(1).max(255),
  timestamp: z
    .string()
    .regex(RFC3339, "Send an RFC 3339 timestamp with Z or an offset, e.g. 2026-11-01T10:00:00Z")
    .optional(),
  properties: z
    .record(z.string().min(1).max(255), propertyValue)
    .refine((p) => Object.keys(p).length <= MAX_PROPERTIES, {
      message: `Send at most ${MAX_PROPERTIES} properties`,
    })
    .optional(),
  amount: decimalInput.optional(),
  cost: decimalInput.optional(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "Send a 3-letter ISO currency code")
    .optional(),
});
export type UsageEventInput = z.infer<typeof usageEventInput>;

export const usageBatchInput = z.object({
  events: z.array(z.unknown()).min(1).max(MAX_BATCH),
});

export type EventErrorCode =
  | "invalid_request"
  | "timestamp_too_old"
  | "timestamp_in_future"
  | "invalid_value";

export interface EventError {
  code: EventErrorCode;
  message: string;
}

export interface IngestResult {
  index: number;
  key: string | null;
  status: "created" | "duplicate" | "error";
  error?: EventError;
}

/** A validated event, ready to store. */
interface ReadyEvent {
  index: number;
  key: string;
  customerKey: string;
  eventName: string;
  /** As sent (or `stampNow`), so Postgres keeps every microsecond. */
  timestamp: string;
  at: Date;
  propertiesJson: string;
  amount: string | null;
  cost: string | null;
  currency: string | null;
}

const err = (code: EventErrorCode, message: string): EventError => ({ code, message });

const TOO_OLD = err(
  "timestamp_too_old",
  "We could not record the event. Its timestamp is more than 35 days in the past. Send events within 35 days.",
);
const IN_FUTURE = err(
  "timestamp_in_future",
  "We could not record the event. Its timestamp is more than 5 minutes in the future. Check the clock of the system that sends events.",
);

const decimalText = (v: string | JsonNumber | undefined): string | undefined =>
  v === undefined ? undefined : v instanceof JsonNumber ? v.text : v;

type ActiveMeter = Pick<
  typeof meters.$inferSelect,
  "key" | "eventName" | "aggregation" | "valueProperty" | "recurring" | "filters"
>;

const passesFilters = (m: ActiveMeter, props: Record<string, unknown>) =>
  Object.entries(m.filters ?? {}).every(([p, values]) => {
    const t = propertyText(props[p]);
    return t !== null && values.some((v) => String(v) === t);
  });

/** The value checks of every active meter that counts this event (Decision 6). */
function valueIssue(meterList: ActiveMeter[], e: UsageEventInput): EventError | null {
  const props = e.properties ?? {};
  for (const m of meterList) {
    if (m.eventName !== e.event_name || !m.valueProperty || !passesFilters(m, props)) continue;
    const raw = propertyText(props[m.valueProperty]);
    if (raw === null) continue;
    const v = tryParseFixed12(raw);
    if (v === null || !withinMaxMagnitude(v))
      return err(
        "invalid_value",
        `We could not record the event. The property ${m.valueProperty} for the meter ${m.key} must be a number with at most ${MAX_USAGE_DECIMALS} decimal places, from -${MAX_AMOUNT_MAGNITUDE} to ${MAX_AMOUNT_MAGNITUDE}.`,
      );
    const negativeAllowed =
      m.aggregation === "weighted_sum" || (m.aggregation === "sum" && m.recurring);
    if (v < 0n && !negativeAllowed)
      return err(
        "invalid_value",
        `We could not record the event. The property ${m.valueProperty} for the meter ${m.key} must be 0 or more.`,
      );
  }
  return null;
}

/** Schema, window and value checks for one raw event. */
function prepare(
  raw: unknown,
  index: number,
  now: Date,
  meterList: ActiveMeter[],
): { ready: ReadyEvent } | { error: EventError; key: string | null } {
  const keyOf = (r: unknown) =>
    r && typeof r === "object" && typeof (r as { key?: unknown }).key === "string"
      ? (r as { key: string }).key
      : null;
  const parsed = usageEventInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return {
      key: keyOf(raw),
      error: err(
        "invalid_request",
        `We could not record the event. ${where}${issue?.message ?? "The event is not valid."}`,
      ),
    };
  }
  const e = parsed.data;
  const unknownKeys = Object.keys(raw as object).filter((k) => !(k in usageEventInput.shape));
  if (unknownKeys.length)
    return {
      key: e.key,
      error: err("invalid_request", `Unknown parameter: ${unknownKeys.join(", ")}`),
    };
  const at = e.timestamp ? new Date(e.timestamp) : now;
  if (Number.isNaN(at.getTime()))
    return {
      key: e.key,
      error: err(
        "invalid_request",
        "We could not record the event. timestamp: The date does not exist.",
      ),
    };
  if (at.getTime() < now.getTime() - MAX_BACKDATE_MS) return { key: e.key, error: TOO_OLD };
  if (at.getTime() > now.getTime() + MAX_AHEAD_MS) return { key: e.key, error: IN_FUTURE };
  for (const field of ["amount", "cost"] as const) {
    const t = decimalText(e[field]);
    const fixed = t === undefined ? undefined : tryParseFixed12(t);
    if (fixed === null || (fixed !== undefined && !withinMaxMagnitude(fixed)))
      return {
        key: e.key,
        error: err(
          "invalid_value",
          `We could not record the event. The field ${field} must be a number with at most ${MAX_USAGE_DECIMALS} decimal places, from -${MAX_AMOUNT_MAGNITUDE} to ${MAX_AMOUNT_MAGNITUDE}.`,
        ),
      };
  }
  const props = e.properties ?? {};
  const json = propertiesJson(props);
  if (Buffer.byteLength(json, "utf8") > MAX_PROPERTIES_BYTES)
    return {
      key: e.key,
      error: err(
        "invalid_request",
        "We could not record the event. The properties are larger than 8 KB.",
      ),
    };
  const issue = valueIssue(meterList, e);
  if (issue) return { key: e.key, error: issue };
  return {
    ready: {
      index,
      key: e.key,
      customerKey: e.customer,
      eventName: e.event_name,
      timestamp: e.timestamp ?? now.toISOString(),
      at,
      propertiesJson: json,
      amount: decimalText(e.amount) ?? null,
      cost: decimalText(e.cost) ?? null,
      currency: e.currency?.toUpperCase() ?? null,
    },
  };
}

/**
 * Hooks run inside the ingest transaction, after the event insert (design §6, "PR 3
 * on-arrival checks"). Empty in 1a.
 */
export type IngestHook = (
  tx: Tx,
  input: {
    businessId: string;
    events: Array<{ id: string; customerId: string | null; eventName: string; timestamp: string }>;
  },
) => Promise<void>;
const ingestHooks: IngestHook[] = [];
export function registerIngestHook(fn: IngestHook): void {
  if (!ingestHooks.includes(fn)) ingestHooks.push(fn);
}

/** Active meters of a business that count events with these names (for the value checks). */
async function activeMetersFor(
  tx: Tx,
  businessId: string,
  events: unknown[],
): Promise<ActiveMeter[]> {
  const names = [
    ...new Set(
      events.flatMap((r) =>
        r && typeof r === "object" && typeof (r as { event_name?: unknown }).event_name === "string"
          ? [(r as { event_name: string }).event_name]
          : [],
      ),
    ),
  ];
  if (!names.length) return [];
  return tx
    .select({
      key: meters.key,
      eventName: meters.eventName,
      aggregation: meters.aggregation,
      valueProperty: meters.valueProperty,
      recurring: meters.recurring,
      filters: meters.filters,
    })
    .from(meters)
    .where(
      and(
        eq(meters.businessId, businessId),
        eq(meters.status, "active"),
        inArray(meters.eventName, names),
      ),
    );
}

function prepareAll(
  events: unknown[],
  now: Date,
  meterList: ActiveMeter[],
): { results: IngestResult[]; ready: ReadyEvent[] } {
  const results: IngestResult[] = new Array(events.length);
  const ready: ReadyEvent[] = [];
  events.forEach((raw, index) => {
    const p = prepare(raw, index, now, meterList);
    if ("ready" in p) ready.push(p.ready);
    else results[index] = { index, key: p.key, status: "error", error: p.error };
  });
  return { results, ready };
}

/** Store validated events in the caller's transaction. Their partitions must exist. */
async function storeReady(
  tx: Tx,
  input: { organizationId: string; businessId: string },
  ready: ReadyEvent[],
  results: IngestResult[],
): Promise<IngestResult[]> {
  // The first of a key in this request is stored; later ones are duplicates of it.
  const first = new Map<string, ReadyEvent>();
  for (const r of ready) if (!first.has(r.key)) first.set(r.key, r);
  const unique = [...first.values()];

  await tx.execute(sql`set local statement_timeout = '10s'`);
  const customerIds = await resolveUsageKeys(tx, input.businessId, [
    ...new Set(unique.map((r) => r.customerKey)),
  ]);
  const fresh = rowsOf<{ key: string; event_id: string }>(
    await tx.execute(sql`
      insert into usage_event_dedup (organization_id, business_id, key, event_id, event_timestamp)
      select ${input.organizationId}::uuid, ${input.businessId}::uuid, u.k, public.uuid_v7(), u.t
      from unnest(${pgTextArray(unique.map((r) => r.key))}::text[],
                  ${pgTextArray(unique.map((r) => r.timestamp))}::timestamptz[]) as u(k, t)
      on conflict (business_id, key) do nothing
      returning key, event_id`),
  );
  const idOf = new Map(fresh.map((f) => [f.key, f.event_id]));
  const rows = unique.filter((r) => idOf.has(r.key));
  if (rows.length) {
    const col = (f: (r: ReadyEvent) => string | null) => pgTextArray(rows.map(f));
    await tx.execute(sql`
      insert into usage_events (id, organization_id, business_id, customer_id, customer_key,
        event_name, properties, "timestamp", key, amount, cost, currency)
      select u.id::uuid, ${input.organizationId}::uuid, ${input.businessId}::uuid, u.cid::uuid,
        u.ckey, u.name, u.props::jsonb, u.ts::timestamptz, u.key, u.amount::numeric,
        u.cost::numeric, u.cur
      from unnest(
        ${col((r) => idOf.get(r.key)!)}::text[],
        ${col((r) => customerIds.get(r.customerKey) ?? null)}::text[],
        ${col((r) => r.customerKey)}::text[],
        ${col((r) => r.eventName)}::text[],
        ${col((r) => r.propertiesJson)}::text[],
        ${col((r) => r.timestamp)}::text[],
        ${col((r) => r.key)}::text[],
        ${col((r) => r.amount)}::text[],
        ${col((r) => r.cost)}::text[],
        ${col((r) => r.currency)}::text[]
      ) as u(id, cid, ckey, name, props, ts, key, amount, cost, cur)`);
    for (const hook of ingestHooks)
      await hook(tx, {
        businessId: input.businessId,
        events: rows.map((r) => ({
          id: idOf.get(r.key)!,
          customerId: customerIds.get(r.customerKey) ?? null,
          eventName: r.eventName,
          timestamp: r.timestamp,
        })),
      });
    // Usage controls: one insert-only dirty mark per customer, when the business has any.
    await markDirtyOnIngest(tx, {
      businessId: input.businessId,
      customerIds: rows.map((r) => customerIds.get(r.customerKey)),
    });
  }
  const created = new Set(rows.map((r) => r.key));
  const claimed = new Set<string>();
  for (const r of ready) {
    const isNew = created.has(r.key) && !claimed.has(r.key);
    if (isNew) claimed.add(r.key);
    results[r.index] = { index: r.index, key: r.key, status: isNew ? "created" : "duplicate" };
  }
  return results;
}

/**
 * Validate, dedup and store usage events, one transaction for the whole request. An
 * accepted event is committed before the answer; a repeat of a key is `duplicate` whatever
 * its timestamp or values. Results are in input order.
 */
export async function ingestUsageEvents(input: {
  organizationId: string;
  businessId: string;
  events: unknown[];
}): Promise<IngestResult[]> {
  const now = stampNow(input.businessId);
  const meterList = await withTenant(input.organizationId, (tx) =>
    activeMetersFor(tx, input.businessId, input.events),
  );
  const { results, ready } = prepareAll(input.events, now, meterList);
  if (!ready.length) return results;
  // Partitions follow the business clock, so a month may not exist yet.
  for (const m of new Set(ready.map((r) => monthStart(r.at).getTime())))
    await ensureUsageMonth(new Date(m));
  return withTenant(input.organizationId, (tx) => storeReady(tx, input, ready, results));
}

/**
 * `ingestUsageEvents` inside the caller's transaction (a credit-hold capture). Call
 * `ensureUsageMonthsFor` first, outside any transaction: adding a partition locks the parent.
 */
export async function ingestUsageEventsTx(
  tx: Tx,
  input: { organizationId: string; businessId: string; events: unknown[] },
): Promise<IngestResult[]> {
  const now = stampNow(input.businessId);
  const meterList = await activeMetersFor(tx, input.businessId, input.events);
  const { results, ready } = prepareAll(input.events, now, meterList);
  if (!ready.length) return results;
  return storeReady(tx, input, ready, results);
}

/** The partitions `ingestUsageEventsTx` writes to, made before its transaction opens. */
export async function ensureUsageMonthsFor(businessId: string, events: unknown[]): Promise<void> {
  const now = stampNow(businessId);
  for (const raw of events) {
    const ts = (raw as { timestamp?: unknown } | null)?.timestamp;
    const at = typeof ts === "string" && !Number.isNaN(Date.parse(ts)) ? new Date(ts) : now;
    await ensureUsageMonth(monthStart(at));
  }
}

// ── Reading stored events ──────────────────────────────────────────────────────────────

export interface StoredEventRow {
  id: string;
  key: string;
  customer_key: string;
  customer_public_id: string | null;
  event_name: string;
  properties_text: string;
  timestamp: Date;
  amount: string | null;
  cost: string | null;
  currency: string | null;
  matched_at: Date | null;
  voided_at: Date | null;
  void_reason: string | null;
}

export const storedEventColumns = sql`e.id, e.key, e.customer_key, c.public_id as customer_public_id,
  e.event_name, e.properties::text as properties_text, e."timestamp", e.amount::text as amount,
  e.cost::text as cost, e.currency, e.matched_at, e.voided_at, e.void_reason`;

/** A usage event as the API shows it. `id` is the event's key: events have no other public id. */
export function serializeUsageEvent(
  r: StoredEventRow,
  extra: { meters?: string[]; flags?: string[] } = {},
) {
  return {
    object: "usage_event" as const,
    id: r.key,
    key: r.key,
    customer: r.customer_public_id,
    customer_key: r.customer_key,
    event_name: r.event_name,
    timestamp: new Date(r.timestamp).toISOString(),
    created_at: new Date(uuidMs(r.id)).toISOString(),
    properties: parseJsonExact(r.properties_text) as Record<string, unknown>,
    amount: r.amount,
    cost: r.cost,
    currency: r.currency,
    status: r.voided_at ? "voided" : r.customer_public_id ? "matched" : "unmatched",
    meters: extra.meters ?? [],
    flags: extra.flags ?? [],
    voided_at: r.voided_at ? new Date(r.voided_at).toISOString() : null,
    void_reason: r.void_reason,
  };
}

/** The stored event for a key: through its dedup row, or by timestamp once that is purged. */
export async function findStoredEvent(
  tx: Tx,
  businessId: string,
  key: string,
  timestamp?: string,
): Promise<StoredEventRow | null> {
  let ts = timestamp ?? null;
  if (!ts) {
    const [d] = rowsOf<{ t: Date }>(
      await tx.execute(sql`select event_timestamp as t from usage_event_dedup
        where business_id = ${businessId} and key = ${key}`),
    );
    if (!d) return null;
    ts = new Date(d.t).toISOString();
  }
  const [row] = rowsOf<StoredEventRow>(
    await tx.execute(sql`
      select ${storedEventColumns} from usage_events e
      left join customers c on c.id = e.customer_id
      where e.business_id = ${businessId} and e.key = ${key} and e."timestamp" = ${ts}::timestamptz`),
  );
  return row ?? null;
}

// ── Void ───────────────────────────────────────────────────────────────────────────────

export class UsageEventNotFoundError extends Error {
  constructor(key: string, needsTimestamp: boolean) {
    super(
      needsTimestamp
        ? `No such usage event: ${key}. For an event received more than 35 days ago, send its timestamp too.`
        : `No such usage event: ${key}`,
    );
    this.name = "UsageEventNotFoundError";
  }
}

export class UsageEventBilledError extends Error {
  constructor() {
    super(
      "We could not void the event. An invoice already bills its period. Issue a credit note instead.",
    );
    this.name = "UsageEventBilledError";
  }
}

/**
 * Void one event. Kept on record; refused once a finalized invoice bills its period (its
 * timestamp is before an owner's `usage_through`). A folded event's buckets are re-read
 * from the remaining events: a negative row cannot undo a min, max or last.
 */
export async function voidUsageEvent(input: {
  organizationId: string;
  businessId: string;
  key: string;
  timestamp?: string;
  reason?: string | null;
}): Promise<StoredEventRow> {
  return withTenant(input.organizationId, async (tx) => {
    // The fold's lock: a bucket is never rewritten while a chunk folds into it.
    const [state] = rowsOf<{ watermark: Date }>(
      await tx.execute(sql`select watermark from usage_rollup_state
        where business_id = ${input.businessId} for update`),
    );
    const ev = await findStoredEvent(tx, input.businessId, input.key, input.timestamp);
    if (!ev) throw new UsageEventNotFoundError(input.key, !input.timestamp);
    if (ev.voided_at) return ev;
    const at = new Date(ev.timestamp).toISOString();
    const evWhere = sql`e.business_id = ${input.businessId} and e.key = ${input.key}
      and e."timestamp" = ${at}::timestamptz`;
    const [billed] = rowsOf<{ x: number }>(
      await tx.execute(sql`
        select 1 as x from usage_events e
        join meters m on m.business_id = e.business_id and m.event_name = e.event_name
        join customer_meter_billing b on b.customer_id = e.customer_id and b.meter_id = m.id
        where ${evWhere} and ${countsTowardJoined("e", "m")}
          and b.usage_through is not null and b.usage_through > e."timestamp"
        limit 1`),
    );
    if (billed) throw new UsageEventBilledError();

    // Buckets the event was folded into, read before it is voided.
    const watermarkUuid = state ? uuidFloor(new Date(state.watermark).getTime()) : null;
    const affected =
      ev.customer_public_id && watermarkUuid
        ? rowsOf<{
            meter_id: string;
            customer_id: string;
            bucket: Date;
            gv: string[];
            cur: string;
          }>(
            await tx.execute(sql`
              select m.id as meter_id, e.customer_id, ${bucketOf(sql`e."timestamp"`)} as bucket,
                ${groupValuesOf("e", sql`m.group_by`)} as gv, coalesce(e.currency, '') as cur
              from usage_events e
              join meters m on m.business_id = e.business_id and m.event_name = e.event_name
              where ${evWhere} and e.customer_id is not null
                and not m.recurring and m.aggregation in ('sum', 'count', 'min', 'max', 'avg', 'last')
                and e.id >= ${uuidFloorSql(sql`m.folded_from`)} and e.id < ${watermarkUuid}::uuid
                and ${countsTowardJoined("e", "m")}`),
          )
        : [];

    await tx.execute(sql`
      update usage_events e set voided_at = ${stampNow(input.businessId).toISOString()}::timestamptz,
        void_reason = ${input.reason ?? null}
      where ${evWhere}`);

    if (affected.length) await bumpRollupVersion(tx, input.businessId);
    for (const a of affected) {
      const bucket = new Date(a.bucket).toISOString();
      const gv = pgTextArray(a.gv);
      await tx.execute(sql`
        delete from usage_rollups
        where business_id = ${input.businessId} and customer_id = ${a.customer_id}
          and meter_id = ${a.meter_id} and bucket_start = ${bucket}::timestamptz
          and group_values = ${gv}::text[] and currency = ${a.cur}`);
      await upsertRollups(
        tx,
        input.businessId,
        sql`select e.organization_id, e.business_id, e.customer_id, m.id as meter_id,
            ${bucketOf(sql`e."timestamp"`)} as bucket, ${groupValuesOf("e", sql`m.group_by`)} as gv,
            coalesce(e.currency, '') as cur, e.id, e."timestamp" as ts,
            ${valueOf("e", sql`m.value_property`)} as val, e.amount, e.cost
          from usage_events e join meters m on m.id = ${a.meter_id}
          where e.business_id = ${input.businessId} and e.customer_id = ${a.customer_id}
            and e.event_name = m.event_name and e.voided_at is null
            and e."timestamp" >= ${bucket}::timestamptz
            and e."timestamp" < ${bucket}::timestamptz + interval '15 minutes'
            and e.id >= ${uuidFloorSql(sql`m.folded_from`)} and e.id < ${watermarkUuid}::uuid
            and coalesce(e.currency, '') = ${a.cur}
            and ${groupValuesOf("e", sql`m.group_by`)} = ${gv}::text[]
            and ${countsTowardJoined("e", "m")}`,
      );
    }
    log.info("usage event voided", {
      event: "usage_event_voided",
      rebuilt_buckets: affected.length,
    });
    return (await findStoredEvent(tx, input.businessId, input.key, at))!;
  });
}
