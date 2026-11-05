/**
 * "This subscription has not been deleted", as one named condition.
 *
 * Soft delete only works if EVERY path that can reach a subscription applies the same
 * filter — the lookups, the lists, and above all the billing-clock scans, because a
 * deleted-but-scanned subscription would keep invoicing a customer who is no longer
 * supposed to exist. A forgotten filter fails silently and in the direction that costs
 * money, so the predicate is a shared symbol rather than an inline `isNull` repeated at
 * thirty call sites: it can be grepped, and a new scan that omits it is visibly missing
 * something rather than merely written differently.
 *
 * A leaf module (it imports the schema and nothing else) for the same reason
 * `status-sql.ts` is one — clock modules and service modules both need it.
 */
import { isNull, type SQL } from "drizzle-orm";
import { subscriptions } from "@db/schema";

export const notDeleted = (): SQL => isNull(subscriptions.deletedAt) as SQL;
