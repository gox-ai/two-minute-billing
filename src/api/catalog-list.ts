import type { FastifyReply, FastifyRequest } from "fastify";
import type { CatalogPageRequest } from "@/modules/catalog/paging";
import type { FilterSpec, ListPage } from "@/platform/list-query";
import { kindsFromSpecs, opsFromSpecs } from "@/platform/list-query";
import { listResponse, parseListQuery, type ParsedListQuery } from "./helpers";

const FIELD_OP_KEY_RE = /^[a-z][a-z0-9_]*\[[a-z_]+\]$/;

/**
 * Catalog and coupon lists page only when asked to: without `limit` or `starting_after`
 * they return the whole set in the plain `{ object, data }` envelope (the dashboard relies
 * on it).
 */
export function wantsPage(req: FastifyRequest): boolean {
  const q = (req.query ?? {}) as Record<string, unknown>;
  return q.limit != null || q.starting_after != null;
}

/**
 * Does the request use the list grammar at all — paging, `q`, `sort_by` or a `field[op]`
 * filter? Without any of it a list keeps its legacy path (unknown keys ignored).
 */
export function wantsListQuery(req: FastifyRequest): boolean {
  if (wantsPage(req)) return true;
  return Object.keys((req.query ?? {}) as Record<string, unknown>).some(
    (k) => k === "q" || k === "sort_by[asc]" || k === "sort_by[desc]" || FIELD_OP_KEY_RE.test(k),
  );
}

/**
 * Parse the list grammar against a column map; null after a 400 reply. Without paging
 * params the request is `unbounded`: every matching row, filtered and sorted.
 */
export function catalogPageQuery(
  req: FastifyRequest,
  reply: FastifyReply,
  allow: {
    specs: Record<string, FilterSpec>;
    sortFields: readonly string[];
    /** The list's flat params, honoured alongside the grammar. */
    bareParams?: readonly string[];
  },
): CatalogPageRequest | null {
  const q = parseListQuery(req, reply, {
    filterOps: opsFromSpecs(allow.specs),
    filterKinds: kindsFromSpecs(allow.specs),
    sortFields: allow.sortFields,
    bareParams: allow.bareParams,
  });
  if (!q) return null;
  // A list grammar that also supplies an explicit offset is honoured as-is.
  const offset = (q as ParsedListQuery & { offset?: number }).offset;
  return {
    filters: q.filters,
    search: q.search,
    sortField: q.sortField,
    sortDesc: q.sortDesc,
    limit: q.limit,
    startingAfter: q.startingAfter,
    offset,
    unbounded: !wantsPage(req) && offset == null,
  };
}

/** The paged envelope when the caller paged, else today's `{ object, data }`. */
export function catalogListEnvelope<T, U>(
  page: CatalogPageRequest,
  result: ListPage<T>,
  serialize: (row: T) => U,
) {
  return page.unbounded
    ? { object: "list" as const, data: result.data.map(serialize) }
    : listResponse(result, serialize);
}
