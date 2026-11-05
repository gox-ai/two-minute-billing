// Typed fetchers for Comments — the per-record notes box, shown on invoices,
// credit notes, customers and subscriptions alike.
// Server-only. Shapes mirror src/api/comment-routes.ts.
import { apiGet, apiWrite } from "@/lib/api";

interface List<T> {
  object: "list";
  data: T[];
  total: number;
}

/** Record types a comment can hang off — mirrors the backend enum. */
export const COMMENT_RESOURCE_TYPES = [
  "invoice",
  "credit_note",
  "customer",
  "subscription",
  "product",
  "price",
  "coupon",
  "coupon_set",
  "product_group",
] as const;
export type CommentResourceType = (typeof COMMENT_RESOURCE_TYPES)[number];

export interface Comment {
  object: "comment";
  id: string;
  resource_type: CommentResourceType;
  resource_id: string;
  author: string;
  body: string;
  created_at: string;
  updated_at: string;
}

/**
 * Every comment on one record, oldest first. Not paginated by design — a record
 * accumulates a handful of notes, not thousands (see the route's own note).
 */
export function listComments(biz: string, resourceType: CommentResourceType, resourceId: string) {
  const q = new URLSearchParams({ resource_type: resourceType, resource_id: resourceId });
  return apiGet<List<Comment>>(`/v1/businesses/${biz}/comments?${q}`);
}

export function createComment(
  biz: string,
  resourceType: CommentResourceType,
  resourceId: string,
  body: string,
) {
  return apiWrite(`/v1/businesses/${biz}/comments`, {
    resource_type: resourceType,
    resource_id: resourceId,
    body,
  });
}

export function deleteComment(biz: string, id: string) {
  return apiWrite(`/v1/businesses/${biz}/comments/${id}`, undefined, "DELETE");
}
