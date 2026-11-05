import { reportableCustomer } from "./reportable";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { mrrMovements } from "@db/schema";
import { zonedDayString } from "@/platform/timezones";
import { inScope, subscriptionInScope, type BookScope } from "./book-scope";

/**
 * The per-subscription and per-customer keys behind the `billing_interval`, `plan_at_start`
 * and `signup_cohort` metric dimensions. One definition each, shared by the stock and the
 * movement writers so a slice cannot mean one thing on MRR and another on its movements.
 */

export const BILLING_INTERVALS = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "semiannual",
  "annual",
  "multi_year",
  "other",
] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const BILLING_INTERVAL_LABELS: Record<BillingInterval | "none", string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Every 6 months",
  annual: "Annual",
  multi_year: "Multi-year",
  other: "Other cadence",
  none: "Not set",
};

/**
 * A subscription's cadence as one closed key. Reads the length, not just the unit: 12
 * months is annual and 3 months is quarterly, however the plan was entered. A null unit is
 * `none`; a null count is 1, the same default the MRR re-rate applies.
 */
export function billingIntervalOf(
  count: number | null | undefined,
  unit: string | null | undefined,
): BillingInterval | "none" {
  if (!unit) return "none";
  const n = count ?? 1;
  const months = unit === "month" ? n : unit === "year" ? n * 12 : null;
  if (months != null) {
    if (months === 1) return "monthly";
    if (months === 3) return "quarterly";
    if (months === 6) return "semiannual";
    if (months === 12) return "annual";
    if (months > 12 && months % 12 === 0) return "multi_year";
    return "other";
  }
  const days = unit === "day" ? n : unit === "week" ? n * 7 : null;
  if (days === 1) return "daily";
  if (days === 7) return "weekly";
  return "other";
}

/**
 * Each subscription's plan when it started: the plan on its EARLIEST ledger row that
 * carries one. The ledger stores the plan at the moment money moved and items do not keep
 * history, so this is the only reconstructible answer. Subscriptions absent here have no
 * plan-bearing movement; callers fall back to the current plan (`resolvePlanProductIds`).
 */
export async function loadPlanAtStart(
  tx: Tx,
  businessId: string,
  /** Only a slice of the book, or only these subscriptions: the same answer for each one. */
  only: { scope?: BookScope | null; subscriptionIds?: readonly string[] } = {},
): Promise<Map<string, string>> {
  const rows = await tx
    .selectDistinctOn([mrrMovements.subscriptionId], {
      subscriptionId: mrrMovements.subscriptionId,
      planProductId: mrrMovements.planProductId,
    })
    .from(mrrMovements)
    .where(
      and(
        and(eq(mrrMovements.businessId, businessId), reportableCustomer(mrrMovements.customerId)),
        isNotNull(mrrMovements.planProductId),
        subscriptionInScope(sql`${mrrMovements.subscriptionId}`, businessId, only.scope),
        only.subscriptionIds
          ? sql`${mrrMovements.subscriptionId} = any(${`{${only.subscriptionIds.join(",")}}`}::uuid[])`
          : undefined,
      ),
    )
    .orderBy(mrrMovements.subscriptionId, asc(mrrMovements.occurredAt), asc(mrrMovements.id));
  return new Map(rows.map((r) => [r.subscriptionId, r.planProductId!]));
}

/**
 * When each customer first started paying: their earliest ledger row that RAISED MRR, across
 * every subscription they hold. A customer with none has never paid and is absent.
 */
export async function loadFirstPaidAt(
  tx: Tx,
  businessId: string,
  /** Only a slice of the book, or only these customers: the same answer for each one. */
  only: { scope?: BookScope | null; customerIds?: readonly string[] } = {},
): Promise<Map<string, Date>> {
  const rows = await tx
    .select({
      customerId: mrrMovements.customerId,
      first: sql<Date>`min(${mrrMovements.occurredAt})`
        .mapWith(mrrMovements.occurredAt)
        .as("first"),
    })
    .from(mrrMovements)
    // Literal zero: a bigint bind cannot be JSON-keyed by the backfill cache.
    .where(
      and(
        and(eq(mrrMovements.businessId, businessId), reportableCustomer(mrrMovements.customerId)),
        sql`${mrrMovements.deltaMinor} > 0`,
        inScope(sql`${mrrMovements.customerId}`, only.scope),
        only.customerIds
          ? sql`${mrrMovements.customerId} = any(${`{${only.customerIds.join(",")}}`}::uuid[])`
          : undefined,
      ),
    )
    .groupBy(mrrMovements.customerId);
  return new Map(rows.map((r) => [r.customerId, r.first]));
}

/**
 * The `signup_cohort` key — `YYYY-MM` of the first payment in the business's calendar, or
 * `none` when the customer had not paid by `at` (a stock read before they converted).
 */
export function signupCohortOf(
  firstPaidAt: Date | undefined,
  zone?: string | null,
  at?: Date,
): string {
  if (!firstPaidAt || (at && firstPaidAt > at)) return "none";
  return zonedDayString(firstPaidAt, zone).slice(0, 7);
}
