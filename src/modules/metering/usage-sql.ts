import { sql, type SQL } from "drizzle-orm";

/** Rollup bucket width. Every timezone's day edge falls on a 15-minute edge. */
export const BUCKET_MS = 15 * 60_000;

/** Bucket origin; `date_bin` and `floor15` must agree. */
export const BUCKET_ORIGIN = "2000-01-01T00:00:00Z";

/** A plain decimal: what a stored property must look like to count as a meter value. */
export const DECIMAL_TEXT_RE = "^-?[0-9]+(\\.[0-9]+)?$";

export type MeterAggregation =
  | "sum"
  | "count"
  | "min"
  | "max"
  | "avg"
  | "last"
  | "unique"
  | "weighted_sum";

export const METER_AGGREGATIONS: readonly MeterAggregation[] = [
  "sum",
  "count",
  "min",
  "max",
  "avg",
  "last",
  "unique",
  "weighted_sum",
];

/** The meter fields every reader and writer needs. */
export interface MeterShape {
  id: string;
  businessId: string;
  eventName: string;
  aggregation: string;
  valueProperty: string | null;
  uniqueProperty: string | null;
  recurring: boolean;
  filters: Record<string, Array<string | number | boolean>>;
  groupBy: string[];
  foldedFrom: Date | null;
  backfilledAt: Date | null;
}

/**
 * Folded into rollups. Unique, recurring and weighted_sum read raw: they need distinct keys
 * or event order.
 */
export function isRollable(m: Pick<MeterShape, "aggregation" | "recurring">): boolean {
  return !m.recurring && ["sum", "count", "min", "max", "avg", "last"].includes(m.aggregation);
}

/** True when the meter reads a numeric property. */
export function needsValue(m: Pick<MeterShape, "aggregation">): boolean {
  return m.aggregation !== "count" && m.aggregation !== "unique";
}

/** The lowest uuid_v7 with this millisecond: `id >= uuidFloor(ms)` ⇔ id-time ≥ ms. */
export function uuidFloor(ms: number): string {
  const h = Math.max(0, Math.floor(ms)).toString(16).padStart(12, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-0000-0000-000000000000`;
}

/** The millisecond a uuid_v7 was made at (receive time). */
export function uuidMs(id: string): number {
  return parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

/** `uuidFloor` of a timestamptz in SQL. */
export function uuidFloorSql(ts: SQL): SQL {
  return sql`(lpad(to_hex(floor(extract(epoch from ${ts}) * 1000)::bigint), 12, '0') || '00000000000000000000')::uuid`;
}

export function floor15(ms: number): number {
  return Math.floor(ms / BUCKET_MS) * BUCKET_MS;
}

export function ceil15(ms: number): number {
  return Math.ceil(ms / BUCKET_MS) * BUCKET_MS;
}

export const iso = (d: Date | number): string => new Date(d).toISOString();

/** `date_bin` of a timestamp onto the bucket grid. */
export function bucketOf(ts: SQL): SQL {
  return sql`date_bin('15 minutes', ${ts}, ${BUCKET_ORIGIN}::timestamptz)`;
}

/** The meter's value for event `e`, or NULL when the property is absent or not a plain decimal. */
export function valueOf(e: string, valueProperty: SQL): SQL {
  const p = sql`(${sql.raw(e)}.properties ->> ${valueProperty})`;
  return sql`case when ${p} ~ ${DECIMAL_TEXT_RE} then ${p}::numeric end`;
}

/**
 * Event `e` passes every filter: each listed property has one of its values. Compared as
 * text, so `4` and `"4"` are the same value.
 */
export function filtersPass(e: string, filters: SQL): SQL {
  return sql`not exists (
    select 1 from jsonb_each(${filters}) f
    where not exists (
      select 1 from jsonb_array_elements_text(f.value) v
      where v = ${sql.raw(e)}.properties ->> f.key))`;
}

/** Group values of event `e` in `group_by` order; a missing property reads as ''. */
export function groupValuesOf(e: string, groupBy: SQL): SQL {
  return sql`array(select coalesce(${sql.raw(e)}.properties ->> g.name, '')
    from unnest(${groupBy}::text[]) with ordinality g(name, ord) order by g.ord)`;
}

/** Event `e` counts toward a meter whose definition is given as SQL values. */
export function countsToward(
  e: string,
  m: { eventName: SQL; filters: SQL; valueProperty: SQL; uniqueProperty: SQL; aggregation: SQL },
): SQL {
  const ev = sql.raw(e);
  return sql`${ev}.event_name = ${m.eventName}
    and ${filtersPass(e, m.filters)}
    and (${m.aggregation} in ('count', 'unique')
         or (${ev}.properties ->> ${m.valueProperty}) ~ ${DECIMAL_TEXT_RE})
    and (${m.aggregation} <> 'unique' or (${ev}.properties ->> ${m.uniqueProperty}) is not null)`;
}

/** `countsToward` for one loaded meter, with its definition bound as parameters. */
export function countsTowardMeter(e: string, m: MeterShape): SQL {
  return countsToward(e, {
    eventName: sql`${m.eventName}`,
    filters: sql`${JSON.stringify(m.filters ?? {})}::jsonb`,
    valueProperty: sql`${m.valueProperty ?? ""}::text`,
    uniqueProperty: sql`${m.uniqueProperty ?? ""}::text`,
    aggregation: sql`${m.aggregation}::text`,
  });
}

/** `countsToward` against a joined `meters` row aliased `m`. */
export function countsTowardJoined(e: string, m: string): SQL {
  const mm = sql.raw(m);
  return countsToward(e, {
    eventName: sql`${mm}.event_name`,
    filters: sql`${mm}.filters`,
    valueProperty: sql`coalesce(${mm}.value_property, '')`,
    uniqueProperty: sql`coalesce(${mm}.unique_property, '')`,
    aggregation: sql`${mm}.aggregation`,
  });
}

/**
 * A Postgres array literal for a `${…}::text[]` parameter. A JS array bound directly goes
 * over as a scalar ("malformed array literal"), so it is spelled out here. NULL stays NULL.
 */
export function pgTextArray(values: ReadonlyArray<string | null>): string {
  const q = (v: string | null) =>
    v === null ? "NULL" : `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `{${values.map(q).join(",")}}`;
}

/** Rows from `tx.execute`. */
export const rowsOf = <T>(r: unknown): T[] => r as T[];
