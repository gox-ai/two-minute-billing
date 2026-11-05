import type { BillingMode } from "./billing-mode";
import { supportsMonthlyUsage, type Interval } from "./interval";
import { advancePeriod } from "./service";
import { freshSegments } from "./commitment";

/**
 * Monthly usage billing inside a longer term. The term `[T0, Tn)` is cut into monthly
 * sub-periods at `B_k = advancePeriod(T0, month, k)`; each `B_k` strictly inside the term
 * raises an invoice for the usage since the cursor. The term end stays the renewal's.
 */

export { supportsMonthlyUsage } from "./interval";

/**
 * The first boundary strictly after `after` and strictly before `termEnd`, else `termEnd`.
 * Each boundary is computed from the term start, so a 31st anchor does not drift.
 */
export function nextSubPeriodEnd(
  termStart: Date,
  termEnd: Date,
  after: Date,
  anchorDay: number | null | undefined,
  mode: BillingMode,
): Date {
  for (let k = 1; k < 1200; k++) {
    const b = advancePeriod(termStart, "month" as Interval, k, anchorDay, mode);
    if (b.getTime() >= termEnd.getTime()) return termEnd;
    if (b.getTime() > after.getTime()) return b;
  }
  return termEnd;
}

/**
 * The sub-period columns for a term that starts at `termStart`. Null when monthly usage
 * billing is off or the term is too short. The cursor moves to the term start: callers
 * bill or settle the usage before it (renewal, skip, term reset) or start a fresh term.
 */
export function subPeriodFields(
  sub: {
    billUsageMonthly: boolean;
    billingPeriodUnit: string | null;
    billingPeriod: number | null;
    billingAnchorDay: number | null;
  },
  termStart: Date | null,
  termEnd: Date | null,
  mode: BillingMode,
): { currentSubPeriodStart: Date | null; currentSubPeriodEnd: Date | null } {
  if (
    !sub.billUsageMonthly ||
    !termStart ||
    !termEnd ||
    !supportsMonthlyUsage(sub.billingPeriodUnit, sub.billingPeriod)
  )
    return { currentSubPeriodStart: null, currentSubPeriodEnd: null };
  return {
    currentSubPeriodStart: termStart,
    currentSubPeriodEnd: nextSubPeriodEnd(
      termStart,
      termEnd,
      termStart,
      sub.billingAnchorDay,
      mode,
    ),
  };
}

/** A sub-period boundary is due: inside the term, reached, and not the term end. */
export function subPeriodDue(
  sub: {
    status: string;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    currentSubPeriodEnd: Date | null;
  },
  now: Date,
): boolean {
  return (
    sub.status === "active" &&
    sub.currentSubPeriodEnd != null &&
    sub.currentPeriodEnd != null &&
    sub.currentSubPeriodEnd.getTime() <= now.getTime() &&
    sub.currentSubPeriodEnd.getTime() < sub.currentPeriodEnd.getTime()
  );
}

/** Every column a new term resets: the sub-period and the commitment segments. */
export function newTermFields(
  sub: Parameters<typeof subPeriodFields>[0] & { commitmentAmountMinor: bigint | null },
  termStart: Date | null,
  termEnd: Date | null,
  mode: BillingMode,
) {
  return {
    ...subPeriodFields(sub, termStart, termEnd, mode),
    commitmentSegments: freshSegments(sub.commitmentAmountMinor, termStart),
  };
}
