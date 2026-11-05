/**
 * Skipped renewals. A skip names one upcoming renewal boundary; at that boundary the clock
 * advances the period without charging its recurring items (`renewSubscription`), and the
 * fixed term does not count it. Metered usage and pending one-time charges still bill.
 */
import { and, asc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { scanBusinessFilter } from "@/platform/clock";
import { publicId } from "@/platform/ids";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { usesPendingInvoices } from "@/modules/invoicing/pending";
import { meteredPriceSql } from "@/modules/catalog/pricing";
import {
  businesses,
  invoices,
  prices,
  renewalSkips,
  scheduledChanges,
  subscriptionItems,
  subscriptions,
} from "@db/schema";
import { advancePeriod, SubscriptionError, type Interval } from "./service";
import { billingModeFor, normalizeTermEnd, type BillingMode } from "./billing-mode";
import { auditSubscription, subscriptionSnapshot } from "./audit";

/** How many upcoming renewals can be skipped ahead. */
export const SKIP_HORIZON = 12;
/**
 * Skips and undos close this long before the renewal. The pre-debit notice a mandate debit
 * needs goes out 48 h ahead, so an undo can never produce a debit nobody was told about.
 */
export const SKIP_CUTOFF_MS = 48 * 60 * 60 * 1000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export type SkipSource = "api" | "dashboard" | "portal";
type Sub = typeof subscriptions.$inferSelect;
type SkipRow = typeof renewalSkips.$inferSelect;

export interface UpcomingRenewal {
  renewalAt: Date;
  skip: SkipRow | null;
  /** Why this renewal cannot be skipped or unskipped now; null when it can. */
  locked: "cutoff" | null;
}

/** Why this subscription cannot skip at all, or null. */
function unskippableReason(sub: Sub, bizPending: boolean): string | null {
  if (sub.deletedAt) return "This subscription is deleted.";
  if (sub.status === "in_trial") return "A subscription in trial has no renewal to skip yet.";
  if (sub.status !== "active") return `A ${sub.status} subscription has no renewal to skip.`;
  if (sub.cancelAtPeriodEnd) return "This subscription cancels at the end of its term.";
  if (usesPendingInvoices(sub.createPendingInvoices, bizPending))
    return "Subscriptions billed by pending invoices cannot skip a renewal.";
  if (!sub.currentPeriodEnd) return "This subscription has no renewal date.";
  return null;
}

async function loadSubscription(tx: Tx, subscriptionId: string): Promise<Sub> {
  const [sub] = await tx
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);
  if (!sub) throw new SubscriptionError("We could not find this subscription.");
  return sub;
}

async function bizPendingDefault(tx: Tx, businessId: string): Promise<boolean> {
  const [b] = await tx
    .select({ pending: businesses.createPendingInvoices })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return b?.pending ?? false;
}

/** The first instant a scheduled cancel or pause stops renewals, if any. */
async function firstStop(tx: Tx, sub: Sub): Promise<Date | null> {
  const [row] = await tx
    .select({ at: scheduledChanges.effectiveAt })
    .from(scheduledChanges)
    .where(
      and(
        eq(scheduledChanges.subscriptionId, sub.id),
        eq(scheduledChanges.status, "scheduled"),
        inArray(scheduledChanges.type, ["cancel", "pause"]),
      ),
    )
    .orderBy(asc(scheduledChanges.effectiveAt))
    .limit(1);
  const stops = [row?.at, sub.cancelScheduledAt].filter((d): d is Date => d != null);
  return stops.length ? new Date(Math.min(...stops.map((d) => d.getTime()))) : null;
}

/** Live (scheduled or applied) skips of one subscription, oldest first. */
async function liveSkips(tx: Tx, subscriptionId: string): Promise<SkipRow[]> {
  return tx
    .select()
    .from(renewalSkips)
    .where(
      and(
        eq(renewalSkips.subscriptionId, subscriptionId),
        inArray(renewalSkips.status, ["scheduled", "applied"]),
      ),
    )
    .orderBy(asc(renewalSkips.renewalAt));
}

/**
 * The next renewals the clock will run, in order: up to `SKIP_HORIZON`, stopping at the
 * term's last cycle and at the first scheduled cancel or pause. A skipped boundary does not
 * use up a fixed-term cycle, so each skip pushes the last renewal one cycle out.
 */
function renewalBoundaries(
  sub: Sub,
  mode: BillingMode,
  skipped: ReadonlySet<number>,
  stop: Date | null,
): Date[] {
  const out: Date[] = [];
  const unit = (sub.billingPeriodUnit ?? "month") as Interval;
  const count = sub.billingPeriod ?? 1;
  let remaining = sub.remainingBillingCycles;
  let at = sub.currentPeriodEnd!;
  while (out.length < SKIP_HORIZON) {
    if (remaining === 0) break; // this boundary cancels instead of renewing
    if (stop && at >= stop) break;
    out.push(at);
    if (remaining != null && !skipped.has(at.getTime())) remaining -= 1;
    at = advancePeriod(at, unit, count, sub.billingAnchorDay, mode);
  }
  return out;
}

async function upcomingIn(tx: Tx, sub: Sub, now: Date): Promise<UpcomingRenewal[]> {
  if (unskippableReason(sub, await bizPendingDefault(tx, sub.businessId))) return [];
  const mode = await billingModeFor(tx, sub.businessId);
  const skips = (await liveSkips(tx, sub.id)).filter((s) => s.status === "scheduled");
  const byTime = new Map(skips.map((s) => [s.renewalAt.getTime(), s]));
  const boundaries = renewalBoundaries(sub, mode, new Set(byTime.keys()), await firstStop(tx, sub));
  return boundaries.map((renewalAt) => ({
    renewalAt,
    skip: byTime.get(renewalAt.getTime()) ?? null,
    locked: renewalAt.getTime() - now.getTime() < SKIP_CUTOFF_MS ? "cutoff" : null,
  }));
}

export async function listUpcomingRenewals(
  organizationId: string,
  subscriptionId: string,
  now: Date,
): Promise<UpcomingRenewal[]> {
  return withTenant(organizationId, async (tx) =>
    upcomingIn(tx, await loadSubscription(tx, subscriptionId), now),
  );
}

/** Every skip of a subscription (history included), newest renewal first. */
export async function listRenewalSkips(
  organizationId: string,
  subscriptionId: string,
): Promise<Array<SkipRow & { invoicePublicId: string | null }>> {
  return withTenant(organizationId, (tx) =>
    tx
      .select({ skip: renewalSkips, invoicePublicId: invoices.publicId })
      .from(renewalSkips)
      .leftJoin(invoices, eq(invoices.id, renewalSkips.invoiceId))
      .where(eq(renewalSkips.subscriptionId, subscriptionId))
      .orderBy(sql`${renewalSkips.renewalAt} desc`)
      .then((rows) => rows.map((r) => ({ ...r.skip, invoicePublicId: r.invoicePublicId }))),
  );
}

/** The API shape of one skip. */
export function serializeRenewalSkip(
  row: SkipRow & { invoicePublicId?: string | null },
  subscriptionPublicId: string,
) {
  return {
    object: "renewal_skip" as const,
    id: row.publicId,
    subscription: subscriptionPublicId,
    renewal_at: row.renewalAt,
    status: row.status,
    source: row.source,
    invoice: row.invoicePublicId ?? null,
    applied_at: row.appliedAt,
    cancelled_at: row.cancelledAt,
    created_at: row.createdAt,
  };
}

/** What a serialized subscription says about its skips. */
export interface RenewalSkipView {
  /** Scheduled skip dates still ahead, oldest first. */
  skipped: Date[];
  /** The next renewal that charges: the first upcoming boundary not skipped. */
  nextBillingAt: Date | null;
}

/**
 * Skip views per subscription, for serializing `skipped_renewals` and `next_billing_at`.
 * Subscriptions with no scheduled skip are left out: their next billing is the term end.
 */
export async function renewalSkipViews(
  organizationId: string,
  subs: ReadonlyArray<Sub>,
): Promise<Map<string, RenewalSkipView>> {
  const out = new Map<string, RenewalSkipView>();
  const live = subs.filter((s) => s.currentPeriodEnd != null);
  if (live.length === 0) return out;
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({ subscriptionId: renewalSkips.subscriptionId, renewalAt: renewalSkips.renewalAt })
      .from(renewalSkips)
      .where(
        and(
          inArray(
            renewalSkips.subscriptionId,
            live.map((s) => s.id),
          ),
          eq(renewalSkips.status, "scheduled"),
        ),
      )
      .orderBy(asc(renewalSkips.renewalAt));
    if (rows.length === 0) return out;
    const bySub = new Map<string, Date[]>();
    for (const r of rows)
      bySub.set(r.subscriptionId, [...(bySub.get(r.subscriptionId) ?? []), r.renewalAt]);
    const modes = new Map<string, BillingMode>();
    for (const sub of live) {
      const dates = (bySub.get(sub.id) ?? []).filter((d) => d >= sub.currentPeriodEnd!);
      if (dates.length === 0) continue;
      if (!modes.has(sub.businessId))
        modes.set(sub.businessId, await billingModeFor(tx, sub.businessId));
      const skipped = new Set(dates.map((d) => d.getTime()));
      const boundaries = renewalBoundaries(
        sub,
        modes.get(sub.businessId)!,
        skipped,
        await firstStop(tx, sub),
      );
      // Only skips on a boundary the clock will reach: a re-anchored term leaves old ones behind.
      const real = new Set(boundaries.map((b) => b.getTime()));
      const kept = dates.filter((d) => real.has(d.getTime()));
      if (kept.length === 0) continue;
      const next = boundaries.find((b) => !skipped.has(b.getTime()));
      out.set(sub.id, { skipped: kept, nextBillingAt: next ?? null });
    }
    return out;
  });
}

/** `renewal_at` is the instant the clock renews at, as in `skipped_renewals`. */
function skipEventData(
  type: "subscription_skip_scheduled" | "subscription_scheduled_skip_removed",
  sub: Sub,
  skip: SkipRow,
) {
  return buildEventData(
    type,
    { id: sub.publicId, renewal_skip: skip.publicId, renewal_at: skip.renewalAt },
    sub.resourceVersion,
  );
}

/** Skip one upcoming renewal. `limit` caps live skips per 12 months (the portal's cap). */
export async function skipRenewal(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  renewalAt: Date;
  source: SkipSource;
  now: Date;
  limit?: number | null;
}): Promise<{ subscription: Sub; skip: SkipRow }> {
  return withTenant(input.organizationId, async (tx) => {
    // Locked so two concurrent skips cannot both pass the cap.
    await tx.execute(
      sql`select 1 from subscriptions where id = ${input.subscriptionId} for update`,
    );
    const sub = await loadSubscription(tx, input.subscriptionId);
    const why = unskippableReason(sub, await bizPendingDefault(tx, sub.businessId));
    if (why) throw new SubscriptionError(`We could not skip the renewal. ${why}`);
    const mode = await billingModeFor(tx, sub.businessId);
    // Accept the inclusive term end too (…23:59:59), as a day-anchored read reports it.
    const at = normalizeTermEnd(input.renewalAt, mode);
    const upcoming = await upcomingIn(tx, sub, input.now);
    const target = upcoming.find((u) => u.renewalAt.getTime() === at.getTime());
    if (!target)
      throw new SubscriptionError(
        `We could not skip the renewal. ${input.renewalAt.toISOString()} is not one of the next ` +
          `${SKIP_HORIZON} renewals of this subscription. Use upcoming_renewals to get the dates.`,
      );
    if (target.skip)
      throw new SubscriptionError("We could not skip the renewal. It is already skipped.");
    if (target.locked)
      throw new SubscriptionError(
        "We could not skip the renewal. Skips close 48 hours before the renewal.",
      );
    if (input.limit != null) {
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(renewalSkips)
        .where(
          and(
            eq(renewalSkips.subscriptionId, sub.id),
            inArray(renewalSkips.status, ["scheduled", "applied"]),
            gte(renewalSkips.renewalAt, new Date(input.now.getTime() - YEAR_MS)),
            lt(renewalSkips.renewalAt, new Date(input.now.getTime() + YEAR_MS)),
          ),
        )) as [{ n: number }];
      if (n >= input.limit)
        throw new SubscriptionError(
          `We could not skip the renewal. This subscription can skip ${input.limit} ` +
            `renewal${input.limit === 1 ? "" : "s"} in 12 months.`,
        );
    }
    const before = await subscriptionSnapshot(tx, sub);
    const [skip] = await tx
      .insert(renewalSkips)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        subscriptionId: sub.id,
        publicId: publicId("skip"),
        renewalAt: target.renewalAt,
        source: input.source,
      })
      .returning();
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: sub.businessId,
      type: "subscription_skip_scheduled",
      data: skipEventData("subscription_skip_scheduled", sub, skip!),
    });
    await auditSubscription(tx, {
      organizationId: input.organizationId,
      businessId: sub.businessId,
      action: "subscription.skip_renewal",
      before,
      after: sub,
    });
    return { subscription: sub, skip: skip! };
  });
}

/** Undo a scheduled skip, so that renewal charges as normal. */
export async function unskipRenewal(input: {
  organizationId: string;
  subscriptionId: string;
  renewalAt: Date;
  now: Date;
}): Promise<{ subscription: Sub; skip: SkipRow }> {
  return withTenant(input.organizationId, async (tx) => {
    const sub = await loadSubscription(tx, input.subscriptionId);
    const mode = await billingModeFor(tx, sub.businessId);
    const at = normalizeTermEnd(input.renewalAt, mode);
    const [skip] = await tx
      .select()
      .from(renewalSkips)
      .where(
        and(
          eq(renewalSkips.subscriptionId, sub.id),
          eq(renewalSkips.renewalAt, at),
          eq(renewalSkips.status, "scheduled"),
        ),
      )
      .limit(1);
    if (!skip)
      throw new SubscriptionError(
        "We could not undo the skip. No renewal on that date is scheduled to be skipped.",
      );
    if (skip.renewalAt.getTime() - input.now.getTime() < SKIP_CUTOFF_MS)
      throw new SubscriptionError(
        "We could not undo the skip. Skips close 48 hours before the renewal.",
      );
    const before = await subscriptionSnapshot(tx, sub);
    const [removed] = await tx
      .update(renewalSkips)
      .set({ status: "cancelled", cancelledAt: input.now })
      .where(and(eq(renewalSkips.id, skip.id), eq(renewalSkips.status, "scheduled")))
      .returning();
    if (!removed)
      throw new SubscriptionError("We could not undo the skip. The renewal already happened.");
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: sub.businessId,
      type: "subscription_scheduled_skip_removed",
      data: skipEventData("subscription_scheduled_skip_removed", sub, removed),
    });
    await auditSubscription(tx, {
      organizationId: input.organizationId,
      businessId: sub.businessId,
      action: "subscription.unskip_renewal",
      before,
      after: sub,
    });
    return { subscription: sub, skip: removed };
  });
}

/** The scheduled skip for exactly this renewal boundary, if any (billing clock). */
export async function scheduledSkipAt(
  tx: Tx,
  subscriptionId: string,
  renewalAt: Date,
): Promise<SkipRow | null> {
  const [row] = await tx
    .select()
    .from(renewalSkips)
    .where(
      and(
        eq(renewalSkips.subscriptionId, subscriptionId),
        eq(renewalSkips.renewalAt, renewalAt),
        eq(renewalSkips.status, "scheduled"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Void scheduled skips whose renewal passed a day ago without them: the subscription was
 * paused, cancelled or re-anchored first, so that boundary will never renew. Clock-wide
 * (admin connection), within the tick's business scope.
 */
export async function voidPassedSkips(now: Date): Promise<number> {
  const rows = await systemDb
    .update(renewalSkips)
    .set({ status: "void", cancelledAt: now })
    .where(
      and(
        eq(renewalSkips.status, "scheduled"),
        lte(renewalSkips.renewalAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)),
        scanBusinessFilter(renewalSkips.businessId),
      ),
    )
    .returning({ id: renewalSkips.id });
  return rows.length;
}

/**
 * For the reminder pass (admin connection): is the renewal at `at` skipped, and will it
 * still debit metered usage? Null when it renews as normal.
 */
export async function skippedRenewal(
  subscriptionId: string,
  at: Date,
): Promise<{ meteredUsage: boolean } | null> {
  const [skip] = await systemDb
    .select({ id: renewalSkips.id })
    .from(renewalSkips)
    .where(
      and(
        eq(renewalSkips.subscriptionId, subscriptionId),
        eq(renewalSkips.renewalAt, at),
        eq(renewalSkips.status, "scheduled"),
      ),
    )
    .limit(1);
  if (!skip) return null;
  const [metered] = await systemDb
    .select({ id: subscriptionItems.id })
    .from(subscriptionItems)
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .where(
      and(
        eq(subscriptionItems.subscriptionId, subscriptionId),
        meteredPriceSql(prices.model, prices.usageAggregation),
      ),
    )
    .limit(1);
  return { meteredUsage: !!metered };
}
