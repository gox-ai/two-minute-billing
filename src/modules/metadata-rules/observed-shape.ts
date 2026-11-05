// The pure half of `observed.ts`: limits, shapes, and the cut-offs. No database, so it is
// unit-tested.

export const OBSERVED_LIMITS = {
  /** Records read per (business, entity). */
  sampleRows: 5_000,
  /** A key with more distinct values than this gets no values. */
  maxDistinct: 20,
  /** A key with any value longer than this gets no values. */
  maxValueLength: 64,
  /** Values returned per key. */
  topValues: 10,
  /** Keys returned per entity. */
  maxKeys: 200,
  cacheMs: 5 * 60_000,
  cacheEntries: 500,
} as const;

export type ObservedJsonType = "string" | "number" | "boolean" | "object" | "array" | "null";

/** One row of the aggregate query. `kind` says which group the row belongs to. */
export type ObservedRow =
  | { kind: "path"; path: string; rows: number; distinct: number }
  | { kind: "type"; path: string; type: string; rows: number }
  | { kind: "value"; path: string; value: string; rows: number }
  | { kind: "item_value"; path: string; value: string; rows: number }
  | { kind: "item_distinct"; path: string; distinct: number };

export interface ObservedKey {
  path: string;
  /** Records in the sample that hold this path with a non-null value. */
  rows: number;
  /** The JSON type most records hold. */
  type: ObservedJsonType;
  distinct_values: number;
  /** Top values with counts, or null when the key has many or long values. */
  values: Array<{ value: string | number | boolean; rows: number }> | null;
  /** For an array key: the top item values, under the same cut-offs. */
  item_values: Array<{ value: string | number | boolean; rows: number }> | null;
}

/**
 * The aggregate rows → the API shape. Pure, so the cut-offs are unit-tested.
 * A `value` row carries the JSON text of a scalar (`"gs"`, `150`, `true`).
 */
export function shapeObserved(input: ObservedRow[]): ObservedKey[] {
  const paths = new Map<string, { rows: number; distinct: number }>();
  const types = new Map<string, Map<string, number>>();
  const values = new Map<string, Array<{ value: string; rows: number }>>();
  const items = new Map<string, Array<{ value: string; rows: number }>>();
  const itemDistinct = new Map<string, number>();

  for (const r of input) {
    if (r.kind === "path") paths.set(r.path, { rows: r.rows, distinct: r.distinct });
    else if (r.kind === "type") {
      const m = types.get(r.path) ?? new Map<string, number>();
      m.set(r.type, (m.get(r.type) ?? 0) + r.rows);
      types.set(r.path, m);
    } else if (r.kind === "value") values.set(r.path, [...(values.get(r.path) ?? []), r]);
    else if (r.kind === "item_value") items.set(r.path, [...(items.get(r.path) ?? []), r]);
    else itemDistinct.set(r.path, r.distinct);
  }

  const out: ObservedKey[] = [];
  for (const [path, p] of paths) {
    const t = [...(types.get(path) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]);
    const nonNull = t.filter(([k]) => k !== "null").reduce((s, [, n]) => s + n, 0);
    if (nonNull === 0) continue;
    const type = (t.find(([k]) => k !== "null")?.[0] ?? "null") as ObservedJsonType;
    out.push({
      path,
      rows: nonNull,
      type,
      distinct_values: p.distinct,
      values: pickValues(values.get(path), p.distinct),
      item_values:
        type === "array" ? pickValues(items.get(path), itemDistinct.get(path) ?? Infinity) : null,
    });
  }
  return out
    .sort((a, b) => b.rows - a.rows || a.path.localeCompare(b.path))
    .slice(0, OBSERVED_LIMITS.maxKeys);
}

/**
 * Values only when the key has few distinct values and EVERY one of them is a short scalar.
 * The query returns only short scalars, so a shortfall against `distinct` means some value was
 * long or not a scalar — and then none are returned.
 */
function pickValues(
  rows: Array<{ value: string; rows: number }> | undefined,
  distinct: number,
): ObservedKey["values"] {
  if (!rows || distinct > OBSERVED_LIMITS.maxDistinct || rows.length !== distinct) return null;
  return [...rows]
    .sort((a, b) => b.rows - a.rows || a.value.localeCompare(b.value))
    .slice(0, OBSERVED_LIMITS.topValues)
    .map((r) => ({ value: JSON.parse(r.value) as string | number | boolean, rows: r.rows }));
}
