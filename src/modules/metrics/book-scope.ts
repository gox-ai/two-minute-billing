import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/platform/db";

/**
 * A slice of one business's book by customer id, `[lo, hi)`; null is unbounded (D4.5).
 *
 * Every subscription and every ledger row lands in exactly ONE slice, and all of a customer's
 * subscriptions land in the same one. So a per-subscription sum or a per-account count over the
 * slices adds up to the whole book, and a 1M-subscription book never sits in memory at once.
 */
export interface BookScope {
  lo: string | null;
  hi: string | null;
}

/** Customers per slice. A business with no more than this is one slice, read unscoped. */
export const SLICE_CUSTOMERS = 20_000;

/** `col` (a customer id) inside `scope`, as SQL; always true when there is no scope. */
export function inScope(col: SQL, scope?: BookScope | null): SQL {
  const parts: SQL[] = [];
  if (scope?.lo != null) parts.push(sql`${col} >= ${scope.lo}::uuid`);
  if (scope?.hi != null) parts.push(sql`${col} < ${scope.hi}::uuid`);
  return parts.length === 0 ? sql`true` : sql.join(parts, sql` and `);
}

/** `subscription_id` column inside `scope`: its subscription's customer is in the slice. */
export function subscriptionInScope(col: SQL, businessId: string, scope?: BookScope | null): SQL {
  if (scope == null || (scope.lo == null && scope.hi == null)) return sql`true`;
  return sql`${col} in (select s.id from subscriptions s where s.business_id = ${businessId} and ${inScope(sql`s.customer_id`, scope)})`;
}

/**
 * The business's book cut into slices of `perSlice` customers, in id order. One unscoped slice
 * (`null`) when it has no more than that, so a small book reads exactly as it always has.
 */
export async function bookScopes(
  tx: Tx,
  businessId: string,
  perSlice: number = SLICE_CUSTOMERS,
): Promise<Array<BookScope | null>> {
  const rows = (await tx.execute(sql`
    select id::text as id from (
      select id, row_number() over (order by id) as rn from customers where business_id = ${businessId}
    ) t
    where rn > 1 and (rn - 1) % ${perSlice}::int = 0
    order by id`)) as unknown as Array<{ id: string }>;
  if (rows.length === 0) return [null];
  const bounds = rows.map((r) => r.id);
  return [null, ...bounds].map((lo, i) => ({ lo, hi: bounds[i] ?? null }));
}
