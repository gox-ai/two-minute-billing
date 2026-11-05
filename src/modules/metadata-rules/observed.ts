import { sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import type { MetadataRuleEntity } from "./check";
import {
  OBSERVED_LIMITS,
  shapeObserved,
  type ObservedKey,
  type ObservedRow,
} from "./observed-shape";

export * from "./observed-shape";

/**
 * Metadata keys a business already uses, for the editor's suggestions and the "Suggested from
 * your data" list. Read from the most recent `OBSERVED_LIMITS.sampleRows` records only, and cached, so a page
 * load never scans a large table.
 *
 * Values are returned only for a key with few, short values. A key with many values is an id or
 * free text, and its values never leave the database.
 */

// ── query + cache ─────────────────────────────────────────────────────────────

const TABLE: Record<MetadataRuleEntity, string> = {
  customer: "customers",
  subscription: "subscriptions",
};

const cache = new Map<string, { at: number; data: ObservedKey[] }>();

/** Drop every cached entry. For tests. */
export function clearObservedCache() {
  cache.clear();
}

/**
 * Observed keys for one business and entity: top-level keys and one level of nesting under
 * object values. Cached per (business, entity) for `cacheMs`.
 */
export async function observedMetadataKeys(
  organizationId: string,
  businessId: string,
  entity: MetadataRuleEntity,
  now: number = Date.now(),
): Promise<ObservedKey[]> {
  const cacheKey = `${businessId}:${entity}`;
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < OBSERVED_LIMITS.cacheMs) return hit.data;

  const table = sql.raw(TABLE[entity]);
  const deleted = entity === "subscription" ? sql`and deleted_at is null` : sql``;
  const L = OBSERVED_LIMITS;
  const rows = await withTenant(organizationId, async (tx) => {
    const res = (await tx.execute(sql`
      with recent as (
        select metadata from ${table}
        where business_id = ${businessId} ${deleted} and jsonb_typeof(metadata) = 'object'
        order by created_at desc
        limit ${L.sampleRows}
      ),
      pairs as (
        select e.k as path, e.v from recent, jsonb_each(recent.metadata) e(k, v)
        union all
        select e.k || '.' || c.k, c.v
        from recent, jsonb_each(recent.metadata) e(k, v),
             jsonb_each(case when jsonb_typeof(e.v) = 'object' then e.v else '{}'::jsonb end) c(k, v)
      ),
      scalars as (
        select path, v from pairs
        where jsonb_typeof(v) in ('string', 'number', 'boolean') and length(v #>> '{}') <= ${L.maxValueLength}
      ),
      items as (
        select p.path, i.v from pairs p, jsonb_array_elements(p.v) i(v) where jsonb_typeof(p.v) = 'array'
      ),
      path_stats as (
        select path, count(*) filter (where jsonb_typeof(v) <> 'null')::int as n,
               count(distinct v) filter (where jsonb_typeof(v) <> 'null')::int as d
        from pairs group by path
      ),
      item_stats as (select path, count(distinct v)::int as d from items group by path)
      select 'path' as kind, path, n as rows, d as distinct, null::text as type, null::text as value
        from path_stats
      union all
      select 'type', path, count(*)::int, null, jsonb_typeof(v), null from pairs group by path, jsonb_typeof(v)
      union all
      select 'value', s.path, count(*)::int, null, null, s.v::text
        from scalars s join path_stats ps using (path)
        where ps.d <= ${L.maxDistinct} group by s.path, s.v
      union all
      select 'item_distinct', path, null, d, null, null from item_stats
      union all
      select 'item_value', i.path, count(*)::int, null, null, i.v::text
        from items i join item_stats st using (path)
        where st.d <= ${L.maxDistinct}
          and jsonb_typeof(i.v) in ('string', 'number', 'boolean')
          and length(i.v #>> '{}') <= ${L.maxValueLength}
        group by i.path, i.v
    `)) as unknown as Array<{
      kind: ObservedRow["kind"];
      path: string;
      rows: number | null;
      distinct: number | null;
      type: string | null;
      value: string | null;
    }>;
    return res;
  });

  const data = shapeObserved(
    rows.map((r): ObservedRow => {
      switch (r.kind) {
        case "path":
          return { kind: "path", path: r.path, rows: r.rows ?? 0, distinct: r.distinct ?? 0 };
        case "type":
          return { kind: "type", path: r.path, type: r.type ?? "null", rows: r.rows ?? 0 };
        case "value":
          return { kind: "value", path: r.path, value: r.value ?? "null", rows: r.rows ?? 0 };
        case "item_value":
          return { kind: "item_value", path: r.path, value: r.value ?? "null", rows: r.rows ?? 0 };
        default:
          return { kind: "item_distinct", path: r.path, distinct: r.distinct ?? 0 };
      }
    }),
  );

  if (cache.size >= OBSERVED_LIMITS.cacheEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey, { at: now, data });
  return data;
}
