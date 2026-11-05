/**
 * `apiSubscriptionStatus`, expressed in SQL — for WHERE clauses and aggregates that
 * have to agree with the status the API prints.
 *
 * ── WHY IT IS ITS OWN FILE ───────────────────────────────────────────────────────
 * Same reasoning as `customers/name-sql.ts`: two modules need the expression and a
 * direct import between their `service.ts` files would close a cycle
 * (`subscriptions/service` already reads `customers/name-sql`). Lifting the SQL into a
 * leaf module that imports nothing but the schema keeps ONE definition reachable from
 * both.
 *
 * `non_renewing` is DERIVED at the API boundary and is a value `subscriptions.status`
 * never holds. Anything that groups or counts by the stored column therefore disagrees
 * with the pill the list renders — which is exactly the bug the subscriptions filter
 * had before this expression existed: `status[is]=non_renewing` matched nothing while
 * the list showed "Non-renewing" on those very rows.
 *
 * ⚠️ `apiSubscriptionStatus` in `serialize.ts` is the AUTHORITY. This is its twin and
 * the two must move together.
 */
import { sql } from "drizzle-orm";
import { subscriptions } from "@db/schema";

export const apiStatusSql = sql`(CASE
    WHEN ${subscriptions.status} = 'active'
     AND (${subscriptions.cancelAtPeriodEnd}
       OR ${subscriptions.cancelScheduledAt} IS NOT NULL
       OR ${subscriptions.remainingBillingCycles} = 0)
    THEN 'non_renewing'
    ELSE ${subscriptions.status}
  END)`;
