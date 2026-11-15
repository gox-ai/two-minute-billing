/**
 * `query_records`: one aggregation over any list the caller can read. The tool reads every
 * matching row through the list route (as the caller, so permissions and RLS hold), then
 * filters, groups and sums server-side; the model gets the figures and a sample, never the
 * rows. Pure parts (`getPath`, `matchesWhere`, `aggregate`) are tested on their own.
 */
import { ToolError, type ToolContext } from "./catalog";
import type { QueryValue } from "./route-call";

export type Row = Record<string, unknown>;
export type MetricOp = "count" | "count_distinct" | "sum" | "avg" | "min" | "max";
export interface Metric {
  op: MetricOp;
  /** Dot path into the row; not needed for count. */
  field?: string;
}

/** `payer.pays_with.type` → the value, through objects and array indexes. */
export function getPath(row: unknown, path: string): unknown {
  let v: unknown = row;
  for (const part of path.split(".")) {
    if (v === null || v === undefined) return undefined;
    if (Array.isArray(v)) v = v[Number(part)];
    else if (typeof v === "object") v = (v as Row)[part];
    else return undefined;
  }
  return v;
}

const same = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b || (a !== null && a !== undefined && String(a) === String(b));

/**
 * `where`: each key a dot path, each value a scalar (equal, strings case-insensitive), a list
 * (one of), or an operator object: `{in, not_in, gt, gte, lt, lte, contains, is_present}`.
 */
export function matchesWhere(row: unknown, where: Record<string, unknown> | undefined): boolean {
  for (const [path, want] of Object.entries(where ?? {})) {
    const v = getPath(row, path);
    if (Array.isArray(want)) {
      if (!want.some((w) => same(v, w))) return false;
    } else if (want && typeof want === "object") {
      const o = want as Row;
      if ("is_present" in o && (v !== null && v !== undefined && v !== "") !== !!o.is_present)
        return false;
      if ("in" in o && !(o.in as unknown[]).some((w) => same(v, w))) return false;
      if ("not_in" in o && (o.not_in as unknown[]).some((w) => same(v, w))) return false;
      if ("contains" in o && !String(v ?? "").toLowerCase().includes(String(o.contains).toLowerCase()))
        return false;
      const n = typeof v === "number" ? v : typeof v === "string" ? v : null;
      for (const [op, test] of [
        ["gt", (x: number | string, y: number | string) => x > y],
        ["gte", (x: number | string, y: number | string) => x >= y],
        ["lt", (x: number | string, y: number | string) => x < y],
        ["lte", (x: number | string, y: number | string) => x <= y],
      ] as const) {
        if (op in o) {
          const y = o[op] as number | string;
          if (n === null || !test(n, typeof n === "number" ? Number(y) : String(y))) return false;
        }
      }
    } else if (!same(v, want)) return false;
  }
  return true;
}

export const metricName = (m: Metric) => (m.op === "count" ? "count" : `${m.op}_${m.field}`);

const GROUPS_MAX = 50;

export interface Aggregated {
  groups: Array<{ key: Record<string, unknown>; count: number } & Record<string, unknown>>;
  totals: Record<string, unknown>;
  /** Groups past the first 50 (largest first), left out. */
  more_groups?: number;
}

/** Group by dot paths and compute the metrics per group and overall. Pure. */
export function aggregate(
  rows: Row[],
  spec: { group_by?: string[]; metrics?: Metric[] },
): Aggregated {
  const groupBy = spec.group_by ?? [];
  const metrics = spec.metrics?.length ? spec.metrics : [{ op: "count" as const }];
  type Acc = { key: Record<string, unknown>; count: number; m: Map<string, Accum> };
  type Accum = { sum: number; n: number; min: number; max: number; distinct: Set<string> };
  const fresh = (): Accum => ({ sum: 0, n: 0, min: Infinity, max: -Infinity, distinct: new Set() });
  const feed = (a: Map<string, Accum>, r: Row) => {
    for (const m of metrics) {
      if (m.op === "count") continue;
      const acc = a.get(metricName(m)) ?? fresh();
      a.set(metricName(m), acc);
      const v = getPath(r, m.field ?? "");
      if (m.op === "count_distinct") {
        if (v !== null && v !== undefined && v !== "") acc.distinct.add(String(v));
        continue;
      }
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
      if (!Number.isFinite(n)) continue;
      acc.sum += n;
      acc.n++;
      acc.min = Math.min(acc.min, n);
      acc.max = Math.max(acc.max, n);
    }
  };
  const out = (count: number, a: Map<string, Accum>) => {
    const o: Record<string, unknown> = { count };
    for (const m of metrics) {
      if (m.op === "count") continue;
      const acc = a.get(metricName(m)) ?? fresh();
      o[metricName(m)] =
        m.op === "count_distinct"
          ? acc.distinct.size
          : acc.n === 0
            ? null
            : m.op === "sum"
              ? acc.sum
              : m.op === "avg"
                ? Math.round((acc.sum / acc.n) * 100) / 100
                : m.op === "min"
                  ? acc.min
                  : acc.max;
    }
    return o;
  };
  const groups = new Map<string, Acc>();
  const all = fresh();
  const allMap = new Map<string, Accum>();
  for (const r of rows) {
    feed(allMap, r);
    if (!groupBy.length) continue;
    const key: Record<string, unknown> = {};
    for (const g of groupBy) {
      const v = getPath(r, g);
      key[g] = v === undefined ? null : v;
    }
    const id = JSON.stringify(key);
    const acc = groups.get(id) ?? { key, count: 0, m: new Map() };
    acc.count++;
    feed(acc.m, r);
    groups.set(id, acc);
  }
  void all;
  const firstSum = metrics.find((m) => m.op === "sum");
  const rank = (g: Record<string, unknown>) =>
    firstSum ? ((g[metricName(firstSum)] as number | null) ?? 0) : (g.count as number);
  const list = [...groups.values()]
    .map((g) => ({ key: g.key, ...out(g.count, g.m) }))
    .sort((a, b) => rank(b) - rank(a));
  return {
    groups: list.slice(0, GROUPS_MAX) as Aggregated["groups"],
    totals: out(rows.length, allMap),
    ...(list.length > GROUPS_MAX ? { more_groups: list.length - GROUPS_MAX } : {}),
  };
}

export interface QueryInput {
  resource: string;
  filters?: Record<string, QueryValue>;
  where?: Record<string, unknown>;
  group_by?: string[];
  metrics?: Metric[];
  sample?: number;
  max_rows?: number;
}

export const ROWS_DEFAULT = 2000;
export const ROWS_MAX = 5000;
const PAGE = 100;
const TIME_BUDGET_MS = 8000;

/**
 * Read every matching row of `resource` (paged, as the caller), optionally join payers, then
 * filter with `where`, group and compute. `complete` is false when the row or time budget cut
 * the read: the figures then cover the rows read.
 */
export async function queryRecords(
  ctx: ToolContext,
  a: QueryInput,
  join?: (rows: Row[]) => Promise<Row[]>,
): Promise<Row> {
  const maxRows = Math.min(a.max_rows ?? ROWS_DEFAULT, ROWS_MAX);
  const rows: Row[] = [];
  let cursor: string | undefined;
  let complete = true;
  const t0 = performance.now();
  let pages = 0;
  for (;;) {
    const r = await ctx.get(a.resource, {
      ...a.filters,
      limit: Math.min(PAGE, maxRows - rows.length),
      ...(cursor ? { starting_after: cursor } : {}),
    });
    if (r.status < 200 || r.status >= 300) {
      const err = (r.body as { error?: { message?: string } } | null)?.error?.message;
      throw new ToolError(
        `We could not read ${a.resource}. ${err ?? `The API answered ${r.status}.`}`,
        r.status,
      );
    }
    const body = r.body as { data?: unknown; has_more?: boolean; next_cursor?: string | null };
    if (!body || !Array.isArray(body.data))
      throw new ToolError(
        `We could not query ${a.resource}: it is not a list. Give a list path such as subscriptions, invoices, transactions or customers/cus_…/credit_grants.`,
      );
    rows.push(...(body.data as Row[]));
    pages++;
    if (!body.has_more || !body.next_cursor) break;
    if (rows.length >= maxRows || performance.now() - t0 > TIME_BUDGET_MS) {
      complete = false;
      break;
    }
    cursor = body.next_cursor;
  }
  const joined = join ? await join(rows) : rows;
  const kept = joined.filter((r) => matchesWhere(r, a.where));
  const agg = aggregate(kept, { group_by: a.group_by, metrics: a.metrics });
  const sample = Math.max(0, Math.min(a.sample ?? 3, 10));
  return {
    resource: a.resource,
    rows_read: rows.length,
    rows_matched: kept.length,
    pages,
    complete,
    ...(complete
      ? {}
      : {
          note: `Stopped at ${rows.length} rows (${maxRows} allowed, ${TIME_BUDGET_MS / 1000} s): the figures cover those rows only. Narrow the filters, or raise max_rows.`,
        }),
    ...(a.group_by?.length ? { group_by: a.group_by } : {}),
    groups: agg.groups,
    totals: agg.totals,
    ...(agg.more_groups ? { more_groups: agg.more_groups } : {}),
    sample: kept.slice(0, sample),
  };
}
