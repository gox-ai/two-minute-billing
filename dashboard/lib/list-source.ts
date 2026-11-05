import type { ListFetchResult, ListQuery, ListServerFilter } from "@/components/patterns/list-page";

/**
 * Turn a page's `searchParams` into `ListPage`'s `initialFilters`, so a deep link
 * such as `…/transactions?status=failure` actually narrows the list.
 *
 * Call it in the SERVER component and pass the result down — the field ids must
 * match `filterFields` ids on that list (`ListPage` drops any that don't, so a
 * hand-typed param can never reach the endpoint as an unknown column).
 *
 * Type-only import above, so this module stays a plain (non-client) module and
 * server components can call it.
 */
/**
 * Operators a URL may name in the `field[op]=value` form. Deliberately the date
 * three plus `is`: a hand-typed `amount_minor[gt]` has no caller and widening
 * this is how a URL starts reaching operators a list never offered.
 */
const URL_OPS = ["is", "on", "after", "before"] as const;

export function urlFilters(
  params: Record<string, string | string[] | undefined>,
  /** URL param name → list field id. Pass `true` when they're the same. */
  fields: Record<string, string | true>,
): ListServerFilter[] {
  const out: ListServerFilter[] = [];
  const one = (raw: string | string[] | undefined) => (Array.isArray(raw) ? raw[0] : raw);

  // The generic, repeatable form the list itself writes back to the address bar:
  // `?filter=status:in:active,in_trial&filter=mrr:gte:500000`. Same grammar as
  // `/api/lists/<entity>`'s own `filter` param and as a stored view's filter set, which
  // is what makes a link the operator copies mean exactly what they were looking at.
  //
  // Deliberately NOT restricted to `URL_OPS`: this form is what the UI produces, so the
  // whole operator vocabulary is legal here. `ListPage` still drops any field its
  // `filterFields` does not offer and any operator the field does not support, so a
  // hand-typed one cannot reach the endpoint as an unknown column.
  const raw = params.filter;
  for (const entry of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    const [field, op, ...rest] = entry.split(":");
    // The value may itself contain ':' (a timestamp, a URL) — only the first two
    // separators are structural.
    if (field && op) out.push({ field, op, value: rest.join(":") });
  }

  for (const [param, field] of Object.entries(fields)) {
    const id = field === true ? param : field;
    const value = one(params[param]);
    // A blank `?status=` is not a filter — it would 400 or match nothing.
    if (value) out.push({ field: id, op: "is", value });

    // `?created_at[after]=2026-07-31` — the same syntax the engine's own list API
    // takes, so a URL copied from an API call narrows the screen identically.
    // Both bounds of a range are separate params and both land as filter rows,
    // which is what makes a month window ("2 Filters") visible and clearable
    // rather than a hidden narrowing.
    for (const op of URL_OPS) {
      const v = one(params[`${param}[${op}]`]);
      if (v) out.push({ field: id, op, value: v });
    }
  }
  return out;
}

/** The engine counts a list's total up to here and stops (`total_capped`); show "10,000+". */
export const LIST_TOTAL_CAP = 10_000;

/** The envelope every `/api/lists/<entity>` handler returns. */
export interface ListPagePayload<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
  total: number | null;
  /** Optional per-page side data (e.g. the customers list's subscriptions). */
  [extra: string]: unknown;
}

/**
 * Build the `fetchPage` for a `ListPage` in server mode: it turns the current
 * view (search / sort / segment + builder filters / cursor) into query params for
 * `/api/lists/<entity>`, which proxies to the engine so the org API key stays
 * server-side.
 *
 * `onPayload` sees the raw envelope, for lists whose columns need side data
 * loaded with the page (the customers list hydrates Subscription Info that way).
 */
export function makeListSource<T>(
  entity: string,
  /** Omit for an org-wide list that isn't scoped to one business (e.g. the org-level audit log). */
  biz: string | undefined,
  opts?: {
    pageSize?: number;
    /** Extra fixed params (e.g. `{ customer: 'cus_…' }` for a scoped list). */
    params?: Record<string, string | undefined>;
    onPayload?: (payload: ListPagePayload<T>, isFirstPage: boolean) => void;
  },
): (q: ListQuery) => Promise<ListFetchResult<T>> {
  return async (q) => {
    const sp = new URLSearchParams({ limit: String(q.limit ?? opts?.pageSize ?? 50) });
    if (biz) sp.set("biz", biz);
    if (q.cursor) sp.set("starting_after", q.cursor);
    if (q.search) sp.set("q", q.search);
    if (q.sort) sp.set("sort", `${q.sort.desc ? "-" : ""}${q.sort.field}`);
    for (const f of q.filters) sp.append("filter", `${f.field}:${f.op}:${f.value}`);
    for (const [k, v] of Object.entries(opts?.params ?? {})) if (v) sp.set(k, v);

    const res = await fetch(`/api/lists/${entity}?${sp.toString()}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    const json = (await res.json()) as ListPagePayload<T>;
    opts?.onPayload?.(json, !q.cursor);
    return {
      rows: json.data,
      total: json.total,
      hasMore: json.has_more,
      nextCursor: json.next_cursor,
    };
  };
}
