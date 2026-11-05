// Typed fetchers for saved list views. Server-only — reached from the browser through
// `/api/list-views`, so the org key stays server-side.
import { apiGet, apiWrite } from "@/lib/api";

/** One `field[op]=value` triple, the same grammar the list API and the URL use. */
export interface ListViewFilter {
  field: string;
  op: string;
  value: string;
}

export interface ListView {
  object: "list_view";
  id: string;
  entity: string;
  name: string;
  /** Dashboard user email, or an API key public id. Only the owner may edit or delete. */
  owner: string;
  /** Whether the requesting operator owns it — the engine's verdict, see its serializer. */
  is_mine: boolean;
  visibility: "private" | "everyone";
  filters: ListViewFilter[];
  search: string | null;
  sort_field: string | null;
  sort_desc: boolean | null;
  /** Column ids the view hides; null = the list's own defaults. */
  hidden_columns: string[] | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

interface ListViewsPayload {
  object: "list";
  data: ListView[];
  total: number;
}

/**
 * Every view visible to the signed-in operator on one list: their own, plus everything
 * the organization shares.
 *
 * `biz` is omitted for the two org-level lists (the `/audit` activity log, the billing
 * clock) — the engine stores a NULL business for those rather than guessing one.
 */
export function listListViews(entity: string, biz?: string) {
  const qs = new URLSearchParams({ entity });
  if (biz) qs.set("business", biz);
  return apiGet<ListViewsPayload>(`/v1/list_views?${qs.toString()}`);
}

export interface ListViewDraft {
  name: string;
  visibility?: "private" | "everyone";
  filters?: ListViewFilter[];
  search?: string | null;
  sort_field?: string | null;
  sort_desc?: boolean | null;
  hidden_columns?: string[] | null;
  is_default?: boolean;
}

export function createListView(entity: string, biz: string | undefined, draft: ListViewDraft) {
  return apiWrite(
    "/v1/list_views",
    { entity, ...(biz ? { business: biz } : {}), ...draft },
    "POST",
  );
}

/**
 * Patch a view. Fields left OFF the draft are untouched; a field set to `null` is
 * cleared. Renaming must not blank the sort the view carries, which is why the two
 * cases stay distinguishable all the way to the engine.
 */
export function updateListView(id: string, draft: Partial<ListViewDraft>) {
  return apiWrite(`/v1/list_views/${id}`, draft, "PATCH");
}

export function duplicateListView(id: string, name?: string) {
  return apiWrite(`/v1/list_views/${id}/duplicate`, name ? { name } : {}, "POST");
}

export function deleteListView(id: string) {
  return apiWrite(`/v1/list_views/${id}`, {}, "DELETE");
}
