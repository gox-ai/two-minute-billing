import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { businessTimezone } from "@/platform/business-tz";
import {
  clampLimit,
  countExpr,
  filterConditions,
  keysetCondition,
  opsFromSpecs,
  kindsFromSpecs,
  pageOrder,
  parseCursor,
  toPage,
  type FilterSpec,
  type ListFilter,
  type ListPage,
} from "@/platform/list-query";
import { publicId } from "@/platform/ids";
import { currentEventContext } from "@/platform/event-context";
import {
  comments,
  coupons,
  couponSets,
  creditNotes,
  customers,
  invoices,
  prices,
  productGroups,
  products,
  subscriptions,
} from "@db/schema";
import { createLogger } from "@/platform/logger";

const log = createLogger("comments");

/**
 * Operator notes on a billing record — the "Comments" box shown on invoices,
 * credit notes, customers, subscriptions, products and prices.
 *
 * Intentionally NOT evented and NOT ledgered: a comment is human annotation, not
 * domain state, so no webhook subscriber should react to one. It IS scoped and
 * authored, so it is auditable by inspection.
 */
export class CommentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommentError";
  }
}

/**
 * Raised when the record a comment would hang off does not exist in this business.
 * A subclass of `CommentError` so existing catch sites still see a comment error, but
 * distinguishable so the route can answer 404 rather than 400 — the caller named a
 * resource, and the resource is what is missing.
 */
export class CommentResourceNotFoundError extends CommentError {
  constructor(resourceType: string, resourceId: string) {
    super(`No such ${resourceType}: ${resourceId}`);
    this.name = "CommentResourceNotFoundError";
  }
}

/**
 * Record types a comment may hang off — mirrors `audit_logs.resource_type`.
 *
 * `product`/`price` joined the original four for the catalog detail screens, then
 * `coupon`/`coupon_set`/`product_group`.
 */
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

/**
 * Where each resource type's public id lives.
 *
 * The table stays FK-free on purpose (README: the target table varies by type), so
 * "does this record exist, in THIS business?" has to be a lookup — and it has to happen,
 * or `resource_id` is a free-text field that silently accepts a typo and produces a note
 * nobody will ever see again. One `select 1` per create, inside the tenant transaction so
 * RLS scopes it as well as the explicit `business_id` predicate does.
 */
const RESOURCE_TABLES = {
  invoice: { table: invoices, id: invoices.publicId },
  credit_note: { table: creditNotes, id: creditNotes.publicId },
  customer: { table: customers, id: customers.publicId },
  subscription: { table: subscriptions, id: subscriptions.publicId },
  product: { table: products, id: products.publicId },
  price: { table: prices, id: prices.publicId },
  // A coupon's code IS its public id.
  coupon: { table: coupons, id: coupons.code },
  coupon_set: { table: couponSets, id: couponSets.publicId },
  product_group: { table: productGroups, id: productGroups.publicId },
} as const satisfies Record<CommentResourceType, unknown>;

type CommentRow = typeof comments.$inferSelect;

export function serializeComment(c: CommentRow) {
  return {
    object: "comment",
    id: c.publicId,
    resource_type: c.resourceType,
    resource_id: c.resourceId,
    author: c.author,
    body: c.body,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

/**
 * Who is writing. Falls back to the ambient event context for the same reason
 * `emitEvent` does — the caller should not have to thread it — and to 'system'
 * only when there genuinely is no context (scripts, seeds).
 */
function resolveAuthor(explicit?: string | null): string {
  return explicit ?? currentEventContext()?.actor ?? "system";
}

/** Every comment on one record, oldest first (a conversation reads downward). */
export async function listComments(
  organizationId: string,
  businessId: string,
  resourceType: CommentResourceType,
  resourceId: string,
): Promise<CommentRow[]> {
  return withTenant(organizationId, async (tx) =>
    tx
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.businessId, businessId),
          eq(comments.resourceType, resourceType),
          eq(comments.resourceId, resourceId),
        ),
      )
      .orderBy(asc(comments.createdAt)),
  );
}

/** One comment by id, or null when it does not exist in this business. */
export async function getComment(
  organizationId: string,
  businessId: string,
  commentPublicId: string,
): Promise<CommentRow | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(comments)
      .where(and(eq(comments.businessId, businessId), eq(comments.publicId, commentPublicId)))
      .limit(1);
    return row ?? null;
  });
}

const LIST_FILTERS: Record<string, FilterSpec> = {
  created_at: { column: comments.createdAt, kind: "date" },
};
export const COMMENT_FILTER_OPS = opsFromSpecs(LIST_FILTERS);
export const COMMENT_FILTER_KINDS = kindsFromSpecs(LIST_FILTERS);
export const COMMENT_SORT_FIELDS = ["created_at"] as const;

/**
 * A page of comments — business-wide, or scoped to one type / one record. Oldest first
 * unless sorted desc, matching the unpaged per-record list. Keyset on
 * `(created_at, public_id)`.
 */
export async function listCommentsPage(
  organizationId: string,
  businessId: string,
  f: {
    resourceType?: CommentResourceType;
    resourceId?: string;
    filters?: ListFilter[];
    sortDesc?: boolean;
    startingAfter?: string;
    limit?: number;
  } = {},
): Promise<ListPage<CommentRow>> {
  const limit = clampLimit(f.limit);
  const descending = f.sortDesc ?? false;
  return withTenant(organizationId, async (tx) => {
    const conds: SQL[] = [eq(comments.businessId, businessId)];
    if (f.resourceType) conds.push(eq(comments.resourceType, f.resourceType));
    if (f.resourceId) conds.push(eq(comments.resourceId, f.resourceId));
    conds.push(
      ...filterConditions(LIST_FILTERS, f.filters, await businessTimezone(tx, businessId)),
    );

    let total: number | null = null;
    if (!f.startingAfter) {
      const [row] = await tx
        .select({ n: countExpr })
        .from(comments)
        .where(and(...conds));
      total = row?.n ?? 0;
    }

    const { keysetId } = parseCursor(f.startingAfter);
    const pageConds = [...conds];
    if (keysetId) {
      const [cursor] = await tx
        .select({
          createdAt: sql<string>`${comments.createdAt}::text`,
          publicId: comments.publicId,
        })
        .from(comments)
        .where(and(eq(comments.businessId, businessId), eq(comments.publicId, keysetId)))
        .limit(1);
      const seek = keysetCondition(
        comments.createdAt,
        comments.publicId,
        cursor ? { sortValue: cursor.createdAt, tiebreak: cursor.publicId } : undefined,
        descending,
      );
      if (seek) pageConds.push(seek);
    }

    const rows = await tx
      .select()
      .from(comments)
      .where(and(...pageConds))
      .orderBy(...pageOrder(comments.createdAt, comments.publicId, descending, true))
      .limit(limit + 1);
    return toPage(rows, limit, { keyset: true, offset: 0, keyOf: (r) => r.publicId, total });
  });
}

export async function createComment(input: {
  organizationId: string;
  businessId: string;
  resourceType: CommentResourceType;
  resourceId: string;
  body: string;
  author?: string | null;
}): Promise<CommentRow> {
  const body = input.body.trim();
  if (!body) throw new CommentError("Comment body cannot be empty");
  return withTenant(input.organizationId, async (tx) => {
    // The target must exist IN THIS BUSINESS. Cross-business is the case worth naming:
    // without the `business_id` predicate an operator could pin a note to another
    // tenant's invoice id and it would list under theirs on the next read.
    const target = RESOURCE_TABLES[input.resourceType];
    const [found] = await tx
      .select({ one: sql<number>`1` })
      .from(target.table)
      .where(and(eq(target.table.businessId, input.businessId), eq(target.id, input.resourceId)))
      .limit(1);
    if (!found) throw new CommentResourceNotFoundError(input.resourceType, input.resourceId);
    const [row] = await tx
      .insert(comments)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        publicId: publicId("cmt"),
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        author: resolveAuthor(input.author),
        body,
      })
      .returning();
    return row!;
  });
}

/** Edit a note's text. Returns null when it does not exist in this business. */
export async function updateComment(
  organizationId: string,
  businessId: string,
  commentPublicId: string,
  body: string,
): Promise<CommentRow | null> {
  const trimmed = body.trim();
  if (!trimmed) throw new CommentError("Comment body cannot be empty");
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .update(comments)
      // `updated_at`/`resource_version` are bumped by the bump_row_version trigger.
      .set({ body: trimmed })
      .where(and(eq(comments.businessId, businessId), eq(comments.publicId, commentPublicId)))
      .returning();
    return row ?? null;
  });
}

/**
 * Hard-delete a note. Safe to delete for real, unlike every financial record in
 * this system: a comment posts nothing to the ledger and reverses nothing.
 */
export async function deleteComment(
  organizationId: string,
  businessId: string,
  commentPublicId: string,
): Promise<boolean> {
  return withTenant(organizationId, async (tx) => {
    const deleted = await tx
      .delete(comments)
      .where(and(eq(comments.businessId, businessId), eq(comments.publicId, commentPublicId)))
      .returning();
    // A hard delete with no audit row of its own — the log line is the record that
    // the note existed at all.
    log.log("comment deleted", {
      comment: commentPublicId,
      businessId: businessId,
      found: deleted.length > 0,
    });
    return deleted.length > 0;
  });
}
