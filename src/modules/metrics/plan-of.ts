import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { subscriptionInScope, type BookScope } from "./book-scope";

/**
 * Which plan a subscription is on.
 *
 * ONE rule, in one place, because three screens already answered this question and one of
 * them answered it differently: the subscriptions list resolves
 * `items.find(product_kind === 'plan') ?? items[0]`, the plan-mix panel used to take
 * `items[0]` from a query with no `ORDER BY` — so "first" was whatever Postgres returned,
 * and an add-on coming back first filed the whole subscription under the add-on.
 *
 * The rule: the first item whose product is `kind='plan'`; failing that, the first item at
 * all, so a charges-only subscription still lands somewhere rather than vanishing from a
 * breakdown whose total has to match the count above it. Null when it has no items.
 */
export async function resolvePlanProductId(tx: Tx, subscriptionId: string): Promise<string | null> {
  // Delegates so there is ONE query and one rule. A separate single-row implementation is
  // how the batch path and this one would eventually disagree about what "first" means.
  return (await resolvePlanProductIds(tx, [subscriptionId])).get(subscriptionId) ?? null;
}

/**
 * The same rule, for many subscriptions.
 *
 * The rule runs in SQL (`DISTINCT ON`, plan items first, then the oldest item), so one row per
 * subscription reaches Node. The ids travel as ONE array parameter, so a chunk is not limited
 * by the 65,534 bind parameters a statement allows. A subscription with no items is absent
 * from the result rather than mapped to null, so a caller can tell "no plan" from "not asked".
 *
 * For (nearly) a whole book use `resolveBusinessPlanProductIds`: at 1.2M subscriptions the
 * id-list path was 2,397 queries and 128 s of database time for one day's metrics (D4.5).
 */
export async function resolvePlanProductIds(
  tx: Tx,
  subscriptionIds: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(subscriptionIds)];
  for (let i = 0; i < ids.length; i += 10_000) {
    const list = `{${ids.slice(i, i + 10_000).join(",")}}`;
    for (const r of await planRows(tx, sql`si.subscription_id = any(${list}::uuid[])`))
      out.set(r.subscription_id, r.product_id);
  }
  return out;
}

/** The plan of every subscription in the business, or in one slice of it, in one query. */
export async function resolveBusinessPlanProductIds(
  tx: Tx,
  businessId: string,
  scope?: BookScope | null,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const where = sql`si.business_id = ${businessId} and ${subscriptionInScope(sql`si.subscription_id`, businessId, scope)}`;
  for (const r of await planRows(tx, where)) out.set(r.subscription_id, r.product_id);
  return out;
}

// Ordered by item id within a subscription: the oldest item is the one the subscription was
// created with, which is the plan in every ordinary shape.
const planRows = async (tx: Tx, where: SQL) =>
  (await tx.execute(sql`
    select distinct on (si.subscription_id)
           si.subscription_id::text as subscription_id, p.product_id::text as product_id
    from subscription_items si
    join prices p on p.id = si.price_id
    join products pr on pr.id = p.product_id
    where ${where}
    order by si.subscription_id, (pr.kind = 'plan') desc, si.id`)) as unknown as Array<{
    subscription_id: string;
    product_id: string;
  }>;
