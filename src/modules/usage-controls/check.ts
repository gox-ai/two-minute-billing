/**
 * The `usage_controls_check` cron (design G5 §3.7 "When it is checked"): every minute, on its
 * own queue `usage_controls`. Claims the dirty set oldest first and, per claimed customer in
 * one tenant transaction, evaluates spend-limit states, alerts and every registered step
 * (threshold invoicing). No network call. A failed customer is marked dirty again.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { config } from "@/platform/config";
import { scanBusinessFilter, stampNow } from "@/platform/clock";
import { createLogger } from "@/platform/logger";
import { usageControlCursors, usageControlDirty } from "@db/schema";
import { markDirty } from "./dirty";
import { evaluateLimitStates } from "./limits";
import { evaluateCustomerAlerts } from "./alerts";
import { businessTimeZone, newRateCache, type RateCache } from "./measure";

const log = createLogger("usage-controls.check");

export interface ClaimedCustomer {
  customerId: string;
  organizationId: string;
  businessId: string;
  markedAt: Date;
}

/**
 * Claim up to `limit` marks, oldest first (DELETE … RETURNING; SKIP LOCKED so two runs never
 * claim one mark). An ingest that saw an existing mark and commits after this is caught by
 * the next fast mark or the fold backstop.
 */
export async function claimDirty(
  limit: number = config.TICK_SCAN_LIMIT,
): Promise<ClaimedCustomer[]> {
  // systemDb: the dirty set spans organizations; each customer is evaluated under withTenant.
  const scope = scanBusinessFilter(usageControlDirty.businessId);
  const pick = systemDb
    .select({ id: usageControlDirty.customerId })
    .from(usageControlDirty)
    .where(scope)
    .orderBy(asc(usageControlDirty.markedAt))
    .limit(limit)
    .for("update", { skipLocked: true });
  const rows = await systemDb
    .delete(usageControlDirty)
    .where(inArray(usageControlDirty.customerId, pick))
    .returning();
  return rows
    .map((r) => ({
      customerId: r.customerId,
      organizationId: r.organizationId,
      businessId: r.businessId,
      markedAt: r.markedAt,
    }))
    .sort((a, b) => a.markedAt.getTime() - b.markedAt.getTime());
}

/** A step run for each claimed customer, inside its tenant transaction (threshold invoicing). */
export type UsageControlStep = (
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    now: Date;
    tz: string;
    cache: RateCache;
  },
) => Promise<void>;
const steps: Array<{ name: string; fn: UsageControlStep }> = [];

/** Register a step of the on-arrival check. Idempotent per name. */
export function registerUsageControlStep(name: string, fn: UsageControlStep): void {
  const at = steps.findIndex((s) => s.name === name);
  if (at >= 0) steps[at] = { name, fn };
  else steps.push({ name, fn });
}

/** Evaluate one customer now: limit states, alerts, registered steps; then the cursor. */
export async function evaluateCustomer(c: Omit<ClaimedCustomer, "markedAt">): Promise<number> {
  return withTenant(c.organizationId, async (tx) => {
    const now = stampNow(c.businessId);
    const tz = await businessTimeZone(tx, c.businessId);
    const cache = newRateCache();
    const ctx = { ...c, now, tz, cache };
    let events = await evaluateLimitStates(tx, ctx);
    events += await evaluateCustomerAlerts(tx, ctx);
    for (const s of steps) await s.fn(tx, ctx);
    await tx
      .insert(usageControlCursors)
      .values({
        customerId: c.customerId,
        organizationId: c.organizationId,
        businessId: c.businessId,
        evaluatedAt: now,
      })
      .onConflictDoUpdate({ target: usageControlCursors.customerId, set: { evaluatedAt: now } });
    return events;
  });
}

export interface CheckResult {
  claimed: number;
  evaluated: number;
  failed: number;
  events: number;
  /** The claim hit its limit: more marks wait for the next run. */
  capped: boolean;
  /** Age of the oldest claimed mark, ms (how far behind the check is). */
  oldestMarkAgeMs: number | null;
}

/** One run of the cron: claim, evaluate each customer, re-mark failures. */
export async function runUsageControlsCheck(opts: { limit?: number } = {}): Promise<CheckResult> {
  const limit = opts.limit ?? config.TICK_SCAN_LIMIT;
  const claimed = await claimDirty(limit);
  let evaluated = 0;
  let failed = 0;
  let events = 0;
  for (const c of claimed) {
    try {
      events += await evaluateCustomer(c);
      evaluated++;
    } catch (e) {
      failed++;
      log.error(e, { event: "usage_controls_check_failed", customerId: c.customerId });
      try {
        await withTenant(c.organizationId, (tx) =>
          markDirty(tx, { businessId: c.businessId, customerIds: [c.customerId] }),
        );
      } catch (e2) {
        log.error(e2, { event: "usage_controls_remark_failed", customerId: c.customerId });
      }
    }
  }
  const oldest = claimed[0]?.markedAt ?? null;
  const result: CheckResult = {
    claimed: claimed.length,
    evaluated,
    failed,
    events,
    capped: claimed.length >= limit,
    oldestMarkAgeMs: oldest ? Math.max(0, Date.now() - oldest.getTime()) : null,
  };
  if (claimed.length)
    log.info("usage controls checked", { event: "usage_controls_checked", ...result });
  return result;
}

/** Customers whose last evaluation is older than `before` (back-office, tests). */
export async function staleCursors(tx: Tx, businessId: string, before: Date): Promise<string[]> {
  const rows = await tx
    .select({ c: usageControlCursors.customerId })
    .from(usageControlCursors)
    .where(
      and(
        eq(usageControlCursors.businessId, businessId),
        sql`${usageControlCursors.evaluatedAt} < ${before.toISOString()}::timestamptz`,
      ),
    );
  return rows.map((r) => r.c);
}
