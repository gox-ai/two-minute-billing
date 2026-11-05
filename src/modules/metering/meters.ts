import { and, asc, eq, gt, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { emitEvent } from "@/modules/events/emit";
import { bumpRollupVersion } from "./rollup-sql";
import { buildEventData } from "@/modules/events/registry";
import { customers, customerUsageKeys, meters } from "@db/schema";
import {
  isRollable,
  METER_AGGREGATIONS,
  pgTextArray,
  rowsOf,
  type MeterAggregation,
  type MeterShape,
} from "./usage-sql";

const log = createLogger("metering.meters");

export type Meter = typeof meters.$inferSelect;

/** A meter request we refuse (400). */
export class MeterRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeterRuleError";
  }
}

/** A meter change we refuse because of its state (409). */
export class MeterConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeterConflictError";
  }
}

export interface MeterDefinition {
  name: string;
  eventName: string;
  aggregation: MeterAggregation;
  valueProperty?: string | null;
  uniqueProperty?: string | null;
  recurring?: boolean;
  timeUnit?: "hour" | "day" | null;
  filters?: Record<string, Array<string | number | boolean>>;
  groupBy?: string[];
  /** 0457: the model price list key of each combination. Null = not mapped. */
  priceList?: MeterPriceListMap | null;
  /** 0457: currency of event cost for events that name none. Null = the price's currency. */
  costCurrency?: string | null;
  /** 0475: event properties a spend limit may name, each value limited on its own. */
  limitDimensions?: string[];
}

export interface MeterPriceListMap {
  provider?: string;
  provider_key?: string;
  model_key?: string;
  token_type?: string;
  token_type_key?: string;
}

/** The catalog id family (GUIDE §2 rule 5): unique per business, immutable. */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "meter";

const MAX_GROUP_BY = 5;
const MAX_FILTERS = 20;
/** `meters_limit_dimensions_ck` (0475). */
const MAX_LIMIT_DIMENSIONS = 3;

/** The rules a meter definition must meet. Mirrors the CHECKs in 0450, in our words. */
export function meterDefinitionIssue(d: MeterDefinition): string | null {
  if (!METER_AGGREGATIONS.includes(d.aggregation))
    return `We could not save the meter. The aggregation must be one of ${METER_AGGREGATIONS.join(", ")}.`;
  const valueless = d.aggregation === "count" || d.aggregation === "unique";
  if (!valueless && !d.valueProperty)
    return `We could not save the meter. The ${d.aggregation} aggregation needs a value_property.`;
  if (valueless && d.valueProperty)
    return `We could not save the meter. The ${d.aggregation} aggregation does not read a value_property. Remove it.`;
  if ((d.aggregation === "unique") !== !!d.uniqueProperty)
    return d.aggregation === "unique"
      ? "We could not save the meter. The unique aggregation needs a unique_property."
      : "We could not save the meter. Only the unique aggregation takes a unique_property.";
  if ((d.aggregation === "weighted_sum") !== !!d.timeUnit)
    return d.aggregation === "weighted_sum"
      ? "We could not save the meter. The weighted_sum aggregation needs a time_unit: hour or day."
      : "We could not save the meter. Only the weighted_sum aggregation takes a time_unit.";
  if (d.recurring && !["sum", "last", "max", "unique"].includes(d.aggregation))
    return "We could not save the meter. Only sum, last, max and unique meters can be recurring.";
  const groupBy = d.groupBy ?? [];
  if (groupBy.length > MAX_GROUP_BY)
    return `We could not save the meter. group_by takes at most ${MAX_GROUP_BY} properties.`;
  if (new Set(groupBy).size !== groupBy.length)
    return "We could not save the meter. group_by names a property more than once.";
  const filters = d.filters ?? {};
  if (Object.keys(filters).length > MAX_FILTERS)
    return `We could not save the meter. filters takes at most ${MAX_FILTERS} properties.`;
  for (const [p, values] of Object.entries(filters))
    if (!Array.isArray(values) || values.length === 0)
      return `We could not save the meter. The filter on ${p} needs at least one value.`;
  const dims = d.limitDimensions ?? [];
  if (dims.length > MAX_LIMIT_DIMENSIONS)
    return `We could not save the meter. limit_dimensions takes at most ${MAX_LIMIT_DIMENSIONS} properties.`;
  if (new Set(dims).size !== dims.length)
    return "We could not save the meter. limit_dimensions names a property more than once.";
  return d.priceList ? priceListIssue(d.priceList, groupBy) : null;
}

/** A price list mapping reads its keys from the group values, so each key must be grouped. */
function priceListIssue(m: MeterPriceListMap, groupBy: readonly string[]): string | null {
  if (m.provider != null && m.provider_key != null)
    return "We could not save the meter. Set provider or provider_key in price_list, not both.";
  if ((m.token_type == null) === (m.token_type_key == null))
    return "We could not save the meter. Set token_type or token_type_key in price_list.";
  for (const k of [m.provider_key, m.model_key ?? "model", m.token_type_key])
    if (k != null && !groupBy.includes(k))
      return `We could not save the meter. price_list reads ${k}, so add ${k} to group_by.`;
  return null;
}

export function toMeterShape(m: Meter): MeterShape {
  return {
    id: m.id,
    businessId: m.businessId,
    eventName: m.eventName,
    aggregation: m.aggregation,
    valueProperty: m.valueProperty,
    uniqueProperty: m.uniqueProperty,
    recurring: m.recurring,
    filters: m.filters ?? {},
    groupBy: m.groupBy ?? [],
    foldedFrom: m.foldedFrom,
    backfilledAt: m.backfilledAt,
  };
}

/**
 * The fold state row, created on the business's first meter, locked and read. Its watermark
 * starts at the database clock: everything received earlier reaches a meter through its
 * backfill. Locked so a meter change and a fold chunk cannot interleave: a meter's
 * `folded_from` must be the watermark the next chunk starts from.
 */
export async function ensureRollupState(
  tx: Tx,
  organizationId: string,
  businessId: string,
): Promise<Date> {
  await tx.execute(sql`
    insert into usage_rollup_state (business_id, organization_id, watermark)
    values (${businessId}, ${organizationId},
            to_timestamp(floor(extract(epoch from clock_timestamp()) * 1000) / 1000))
    on conflict (business_id) do nothing`);
  const [row] = rowsOf<{ watermark: Date }>(
    await tx.execute(
      sql`select watermark from usage_rollup_state where business_id = ${businessId} for update`,
    ),
  );
  return new Date(row!.watermark);
}

export function serializeMeter(m: Meter) {
  return {
    object: "meter" as const,
    id: m.key,
    name: m.name,
    event_name: m.eventName,
    aggregation: m.aggregation,
    value_property: m.valueProperty,
    unique_property: m.uniqueProperty,
    recurring: m.recurring,
    time_unit: m.timeUnit,
    filters: m.filters ?? {},
    group_by: m.groupBy ?? [],
    limit_dimensions: m.limitDimensions ?? [],
    price_list: m.priceList ?? null,
    cost_currency: m.costCurrency ?? null,
    status: m.status,
    created_at: m.createdAt.toISOString(),
    updated_at: m.updatedAt.toISOString(),
    resource_version: m.resourceVersion,
  };
}

const meterEventData = (type: "meter_created" | "meter_updated" | "meter_archived", m: Meter) =>
  buildEventData(type, serializeMeter(m), m.resourceVersion);

export async function createMeter(input: {
  organizationId: string;
  businessId: string;
  key?: string;
  definition: MeterDefinition;
}): Promise<Meter> {
  const d = input.definition;
  const issue = meterDefinitionIssue(d);
  if (issue) throw new MeterRuleError(issue);
  const key = input.key ?? slugify(d.name);
  if (!SLUG_RE.test(key))
    throw new MeterRuleError(
      "We could not save the meter. The id must start with a letter or digit and use only letters, digits, '.', '_' and '-' (at most 100 characters).",
    );
  return withTenant(input.organizationId, async (tx) => {
    const [taken] = await tx
      .select({ id: meters.id })
      .from(meters)
      .where(and(eq(meters.businessId, input.businessId), eq(meters.key, key)))
      .limit(1);
    if (taken)
      throw new MeterConflictError(
        `We could not create the meter. The id ${key} is already used. Use a different id.`,
      );
    const watermark = await ensureRollupState(tx, input.organizationId, input.businessId);
    const shape = { aggregation: d.aggregation, recurring: d.recurring ?? false };
    const [m] = await tx
      .insert(meters)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        key,
        name: d.name,
        eventName: d.eventName,
        aggregation: d.aggregation,
        valueProperty: d.valueProperty ?? null,
        uniqueProperty: d.uniqueProperty ?? null,
        recurring: d.recurring ?? false,
        timeUnit: d.timeUnit ?? null,
        filters: d.filters ?? {},
        groupBy: d.groupBy ?? [],
        limitDimensions: d.limitDimensions ?? [],
        priceList: d.priceList ?? null,
        costCurrency: d.costCurrency ?? null,
        foldedFrom: watermark,
        // A raw-read meter has nothing to backfill.
        backfilledAt: isRollable(shape) ? null : watermark,
      })
      .returning();
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "meter_created",
      data: meterEventData("meter_created", m!),
    });
    return m!;
  });
}

export async function getMeterByKey(
  tx: Tx,
  businessId: string,
  key: string,
): Promise<Meter | null> {
  const [m] = await tx
    .select()
    .from(meters)
    .where(and(eq(meters.businessId, businessId), eq(meters.key, key)))
    .limit(1);
  return m ?? null;
}

export async function getMeter(
  organizationId: string,
  businessId: string,
  key: string,
): Promise<Meter | null> {
  return withTenant(organizationId, (tx) => getMeterByKey(tx, businessId, key));
}

export async function listMeters(input: {
  organizationId: string;
  businessId: string;
  limit: number;
  startingAfter?: string;
  status?: "active" | "archived";
}): Promise<{ data: Meter[]; hasMore: boolean }> {
  return withTenant(input.organizationId, async (tx) => {
    const rows = await tx
      .select()
      .from(meters)
      .where(
        and(
          eq(meters.businessId, input.businessId),
          input.startingAfter ? gt(meters.key, input.startingAfter) : undefined,
          input.status ? eq(meters.status, input.status) : undefined,
        ),
      )
      .orderBy(asc(meters.key))
      .limit(input.limit + 1);
    return { data: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
  });
}

/**
 * Used = a price bills from it, or an event counts toward it. After that only `name` may
 * change: a changed definition would re-read history differently from what was billed.
 */
export async function meterIsUsed(tx: Tx, m: Meter): Promise<boolean> {
  const [row] = rowsOf<{ used: boolean }>(
    await tx.execute(sql`
      select exists (select 1 from prices p where p.business_id = ${m.businessId} and p.meter_id = ${m.id})
          or exists (select 1 from usage_events e
                     where e.business_id = ${m.businessId} and e.event_name = ${m.eventName}
                       and e.voided_at is null) as used`),
  );
  return row?.used === true;
}

const DEFINITION_FIELDS: Array<[keyof MeterDefinition, string]> = [
  ["eventName", "event_name"],
  ["aggregation", "aggregation"],
  ["valueProperty", "value_property"],
  ["uniqueProperty", "unique_property"],
  ["recurring", "recurring"],
  ["timeUnit", "time_unit"],
  ["filters", "filters"],
  ["groupBy", "group_by"],
];

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function updateMeter(input: {
  organizationId: string;
  businessId: string;
  key: string;
  patch: Partial<MeterDefinition>;
}): Promise<Meter | null> {
  return withTenant(input.organizationId, async (tx) => {
    const [m] = await tx
      .select()
      .from(meters)
      .where(and(eq(meters.businessId, input.businessId), eq(meters.key, input.key)))
      .for("update")
      .limit(1);
    if (!m) return null;
    const current: MeterDefinition = {
      name: m.name,
      eventName: m.eventName,
      aggregation: m.aggregation as MeterAggregation,
      valueProperty: m.valueProperty,
      uniqueProperty: m.uniqueProperty,
      recurring: m.recurring,
      timeUnit: m.timeUnit as "hour" | "day" | null,
      filters: m.filters ?? {},
      groupBy: m.groupBy ?? [],
      priceList: m.priceList ?? null,
      costCurrency: m.costCurrency ?? null,
      limitDimensions: m.limitDimensions ?? [],
    };
    const changed = DEFINITION_FIELDS.filter(
      ([f]) => input.patch[f] !== undefined && !same(input.patch[f], current[f]),
    );
    if (changed.length && (await meterIsUsed(tx, m)))
      throw new MeterConflictError(
        `You cannot change ${changed[0]![1]} on this meter. It has usage. Create a new meter.`,
      );
    const next: MeterDefinition = { ...current };
    for (const [k, v] of Object.entries(input.patch))
      if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    const issue = meterDefinitionIssue(next);
    if (issue) throw new MeterRuleError(issue);
    // These change no count, so they may change after the meter has usage.
    const mappingChanged =
      !same(next.priceList, current.priceList) ||
      !same(next.costCurrency, current.costCurrency) ||
      !same(next.limitDimensions, current.limitDimensions);
    if (!changed.length && next.name === m.name && !mappingChanged) return m;
    const rollableNow = isRollable({ aggregation: next.aggregation, recurring: !!next.recurring });
    // A new definition folds from scratch: rollups go, and the backfill covers everything.
    const restart = changed.length
      ? await ensureRollupState(tx, input.organizationId, input.businessId)
      : null;
    const [u] = await tx
      .update(meters)
      .set({
        name: next.name,
        eventName: next.eventName,
        aggregation: next.aggregation,
        valueProperty: next.valueProperty ?? null,
        uniqueProperty: next.uniqueProperty ?? null,
        recurring: next.recurring ?? false,
        timeUnit: next.timeUnit ?? null,
        filters: next.filters ?? {},
        groupBy: next.groupBy ?? [],
        priceList: next.priceList ?? null,
        costCurrency: next.costCurrency ?? null,
        limitDimensions: next.limitDimensions ?? [],
        ...(restart ? { foldedFrom: restart, backfilledAt: rollableNow ? null : restart } : {}),
      })
      .where(eq(meters.id, m.id))
      .returning();
    if (restart) {
      await tx.execute(
        sql`delete from usage_rollups where business_id = ${m.businessId} and meter_id = ${m.id}`,
      );
      await bumpRollupVersion(tx, m.businessId);
    }
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "meter_updated",
      data: meterEventData("meter_updated", u!),
    });
    return u!;
  });
}

export async function archiveMeter(input: {
  organizationId: string;
  businessId: string;
  key: string;
}): Promise<Meter | null> {
  return withTenant(input.organizationId, async (tx) => {
    const m = await getMeterByKey(tx, input.businessId, input.key);
    if (!m) return null;
    if (m.status === "archived") return m;
    const [live] = rowsOf<{ sub: string }>(
      await tx.execute(sql`
        select s.public_id as sub from prices p
        join subscription_items si on si.price_id = p.id
        join subscriptions s on s.id = si.subscription_id
        where p.business_id = ${m.businessId} and p.meter_id = ${m.id} and s.status <> 'cancelled'
        limit 1`),
    );
    if (live)
      throw new MeterConflictError(
        `We could not archive the meter. The subscription ${live.sub} has a price that bills from it. Remove that price first.`,
      );
    // A price with no subscription yet can still be sold, so it holds the meter too.
    const [priced] = rowsOf<{ price: string }>(
      await tx.execute(sql`
        select public_id as price from prices
        where business_id = ${m.businessId} and meter_id = ${m.id} and active
        order by created_at limit 1`),
    );
    if (priced)
      throw new MeterConflictError(
        `We could not archive the meter. The price ${priced.price} bills from it. Archive that price first.`,
      );
    const [u] = await tx
      .update(meters)
      .set({ status: "archived" })
      .where(eq(meters.id, m.id))
      .returning();
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "meter_archived",
      data: meterEventData("meter_archived", u!),
    });
    log.info("meter archived", { event: "meter_archived", meter: m.key });
    return u!;
  });
}

// ── Customer usage keys ─────────────────────────────────────────────────────────────────

export type UsageKey = typeof customerUsageKeys.$inferSelect;

export class UsageKeyConflictError extends Error {
  constructor(key: string) {
    super(
      `We could not add the usage key. The key ${key} belongs to another customer. Remove it from that customer first.`,
    );
    this.name = "UsageKeyConflictError";
  }
}

export function serializeUsageKey(k: UsageKey, customerPublicId: string) {
  return {
    object: "usage_key" as const,
    key: k.key,
    customer: customerPublicId,
    created_at: k.createdAt.toISOString(),
  };
}

/**
 * Attach a key. Unmatched events stored under it are matched by the next fold pass, which
 * `match_pending` asks for in this same transaction.
 */
export async function addUsageKey(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  key: string;
}): Promise<UsageKey> {
  return withTenant(input.organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(customerUsageKeys)
      .where(
        and(
          eq(customerUsageKeys.businessId, input.businessId),
          eq(customerUsageKeys.key, input.key),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.customerId !== input.customerId) throw new UsageKeyConflictError(input.key);
      return existing;
    }
    const [row] = await tx
      .insert(customerUsageKeys)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customerId,
        key: input.key,
        matchPending: true,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new UsageKeyConflictError(input.key);
    return row;
  });
}

export async function listUsageKeys(
  organizationId: string,
  businessId: string,
  customerId: string,
): Promise<UsageKey[]> {
  return withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(customerUsageKeys)
      .where(
        and(
          eq(customerUsageKeys.businessId, businessId),
          eq(customerUsageKeys.customerId, customerId),
        ),
      )
      .orderBy(asc(customerUsageKeys.createdAt), asc(customerUsageKeys.key)),
  );
}

/** Remove a key. Events already matched through it stay matched. */
export async function removeUsageKey(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  key: string;
}): Promise<UsageKey | null> {
  return withTenant(input.organizationId, async (tx) => {
    const rows = await tx
      .delete(customerUsageKeys)
      .where(
        and(
          eq(customerUsageKeys.businessId, input.businessId),
          eq(customerUsageKeys.customerId, input.customerId),
          eq(customerUsageKeys.key, input.key),
        ),
      )
      .returning();
    return rows[0] ?? null;
  });
}

/**
 * Customer ids for a set of usage keys, in one query: attached keys, then our own `cus_…`
 * ids. Keys with no customer are absent from the map.
 */
export async function resolveUsageKeys(
  tx: Tx,
  businessId: string,
  keys: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!keys.length) return out;
  const rows = rowsOf<{ key: string; customer_id: string; rank: number }>(
    await tx.execute(sql`
      select k.key, k.customer_id, 1 as rank from customer_usage_keys k
      where k.business_id = ${businessId} and k.key = any(${pgTextArray(keys)}::text[])
      union all
      select c.public_id as key, c.id as customer_id, 2 as rank from ${customers} c
      where c.business_id = ${businessId} and c.public_id = any(${pgTextArray(keys)}::text[])`),
  );
  for (const r of rows.sort((a, b) => a.rank - b.rank))
    if (!out.has(r.key)) out.set(r.key, r.customer_id);
  return out;
}
