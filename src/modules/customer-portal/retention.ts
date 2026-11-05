/**
 * The portal cancel flow (storefront Phase 3): a reason, then offers, then the cancel.
 *
 * Every offer is a real engine action: a pause (with a resume date), a move to a cheaper plan
 * (scheduled for the term end, or now in a trial), a coupon, or a link to the merchant. All of
 * it is per-business (`storefront_config.cancel_reason` + `retention_*`); unset = today's flow
 * (an optional reason, no offers). The cancel itself is never hidden behind an offer.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { formatMoney } from "@/platform/currency";
import { businessWallClock } from "@/platform/clock";
import {
  businesses,
  prices,
  products,
  retentionEvents,
  subscriptionItems,
  subscriptions,
} from "@db/schema";
import { notDeleted } from "@/modules/subscriptions/deleted-sql";
import {
  fixedChargeMinor,
  isMeteredPrice,
  ratableForItem,
  ratableFromSnapshot,
  snapshotPrice,
  type PriceSnapshot,
  type RatablePrice,
} from "@/modules/catalog/pricing";
import { resolveStorefrontConfig } from "@/modules/checkout/storefront-config";
import { resolveOfferedReasons } from "@/modules/reason-codes/service";
import { findCouponByCode, applyCouponToSubscription } from "@/modules/coupons/service";
import {
  listApplicableAddonsForPlan,
  resolveMandatoryAttachedItems,
} from "@/modules/catalog/service";
import { pauseSubscriptionWithOptions } from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { listScheduledChanges, scheduleChange } from "@/modules/subscriptions/scheduled-changes";
import { PortalChangeError, type PortalCtx } from "./plan-change";

export type RetentionOffer = "pause" | "downgrade" | "discount" | "contact";

const MONTH_MS = 30 * 86_400_000;

async function load(ctx: PortalCtx, subPublicId: string) {
  return withTenant(ctx.organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.publicId, subPublicId),
          eq(subscriptions.businessId, ctx.businessId),
          eq(subscriptions.customerId, ctx.customerId),
          notDeleted(),
        ),
      )
      .limit(1);
    if (!sub) throw new PortalChangeError(`No such subscription: ${subPublicId}`, 404);
    const [biz] = await tx
      .select()
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId))
      .limit(1);
    const items = await tx
      .select({ item: subscriptionItems, price: prices, product: products })
      .from(subscriptionItems)
      .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
      .innerJoin(products, eq(products.id, prices.productId))
      .where(eq(subscriptionItems.subscriptionId, sub.id));
    const [tookOffer] = await tx
      .select({ id: retentionEvents.id })
      .from(retentionEvents)
      .where(
        and(
          eq(retentionEvents.customerId, ctx.customerId),
          eq(retentionEvents.kind, "offer_accepted"),
        ),
      )
      .limit(1);
    return { sub, biz: biz!, items, tookOffer: !!tookOffer };
  });
}

type Loaded = Awaited<ReturnType<typeof load>>;

/** The cheaper plan a downgrade offer names, when it is a real option for this subscription. */
async function downgradeTarget(ctx: PortalCtx, l: Loaded, pricePublicId: string | null) {
  if (!pricePublicId) return null;
  const planItem = l.items.find((r) => r.product.kind === "plan");
  if (!planItem || planItem.price.publicId === pricePublicId) return null;
  const [row] = await withTenant(ctx.organizationId, (tx) =>
    tx
      .select({ price: prices, product: products })
      .from(prices)
      .innerJoin(products, eq(products.id, prices.productId))
      .where(
        and(
          eq(prices.businessId, ctx.businessId),
          eq(prices.publicId, pricePublicId),
          eq(prices.active, true),
          eq(prices.type, "recurring"),
          eq(prices.currency, l.sub.currency),
          eq(products.kind, "plan"),
        ),
      )
      .limit(1),
  );
  if (!row || row.price.amountMinor == null) return null;
  // The engine adds the cheaper plan's mandatory add-ons and drops auto-included ones it
  // does not require. Both are named in the change, and the offer's price includes the adds.
  const required = new Set(
    (await listApplicableAddonsForPlan(ctx.organizationId, ctx.businessId, row.product.id))
      .filter((a) => a.applicability === "mandatory")
      .map((a) => a.addon),
  );
  const removes = l.items
    .filter(
      (r) =>
        r.product.kind === "addon" &&
        (r.item.metadata as { auto_included?: string } | null)?.auto_included === "mandatory" &&
        !required.has(r.product.publicId),
    )
    .map((r) => r.item.publicId);
  const mandatory = await withTenant(ctx.organizationId, (tx) =>
    resolveMandatoryAttachedItems(tx, {
      businessId: ctx.businessId,
      planProductIds: [row.product.id],
      currency: l.sub.currency,
      interval: l.sub.billingPeriodUnit,
      intervalCount: l.sub.billingPeriod ?? 1,
      existingProductIds: l.items
        .filter((r) => !removes.includes(r.item.publicId))
        .map((r) => (r.item.id === planItem.item.id ? row.product.id : r.price.productId)),
    }),
  ).then((ms) => ms.filter((m) => !m.chargeOnce));
  // The price is what the first renewal after the switch bills, before tax and discounts:
  // the new plan, every add-on the subscription keeps, and every one the plan brings. Each
  // line is rated the way the renewal rates it. A line we cannot state as one fixed amount
  // on the plan's period (metered, or another period) means the offer is not made.
  const lines: Array<{ snap: PriceSnapshot; ratable: RatablePrice; qty: number; name?: string }> =
    [];
  for (const r of l.items) {
    if (removes.includes(r.item.publicId)) continue;
    if (r.item.id === planItem.item.id) {
      const snap = snapshotPrice(row.price);
      lines.push({ snap, ratable: ratableFromSnapshot(snap, null), qty: r.item.quantity });
      continue;
    }
    const snap = (r.item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(r.price);
    if (snap.type !== "recurring") continue; // a one-time charge does not renew
    lines.push({
      snap,
      ratable: ratableForItem(r.item, r.price),
      qty: r.item.quantity,
      name: r.product.externalName ?? r.product.name,
    });
  }
  const broughtNames = await withTenant(ctx.organizationId, (tx) =>
    mandatory.length
      ? tx
          .select({ id: products.id, name: products.name, externalName: products.externalName })
          .from(products)
          .where(
            inArray(
              products.id,
              mandatory.map((m) => m.addonProductId),
            ),
          )
      : Promise.resolve([]),
  );
  for (const m of mandatory) {
    const snap = snapshotPrice(
      m.price,
      m.differentialAmountMinor ?? undefined,
      m.differentialTiers ?? undefined,
    );
    const n = broughtNames.find((b) => b.id === m.addonProductId);
    lines.push({
      snap,
      ratable: ratableFromSnapshot(snap, null),
      qty: m.quantity,
      name: n ? (n.externalName ?? n.name) : undefined,
    });
  }
  const statable = lines.every(
    (x) =>
      !isMeteredPrice(x.snap) &&
      x.snap.interval === row.price.interval &&
      (x.snap.intervalCount ?? 1) === (row.price.intervalCount ?? 1),
  );
  if (!statable) return null;
  const totalMinor = lines.reduce(
    (sum, x) => sum + Number(fixedChargeMinor(x.snap, x.ratable, x.qty)),
    0,
  );
  return {
    planItem,
    ...row,
    totalMinor,
    /** Every add-on the subscription carries after the switch, priced into `totalMinor`. */
    includes: lines.flatMap((x) => (x.name ? [x.name] : [])),
    adds: mandatory.map((m) => ({
      priceId: m.price.publicId,
      quantity: m.quantity,
      autoIncluded: true,
      billingCycles: m.billingCycles,
    })),
    removes,
  };
}

/** "30% off on your next 3 payments", from the coupon itself. */
function couponSummary(c: NonNullable<Awaited<ReturnType<typeof findCouponByCode>>>): string {
  const off =
    c.percentOffBps != null
      ? `${c.percentOffBps / 100}% off`
      : c.amountOffMinor != null && c.currency
        ? `${formatMoney(Number(c.amountOffMinor), c.currency)} off`
        : "A discount";
  const when =
    c.durationType === "forever"
      ? "on every payment"
      : c.durationType === "once"
        ? "on your next payment"
        : c.durationInPeriods
          ? `on your next ${c.durationInPeriods} payments`
          : "";
  return when ? `${off} ${when}` : off;
}

export async function getCancelFlow(ctx: PortalCtx, subPublicId: string) {
  const l = await load(ctx, subPublicId);
  const cfg = resolveStorefrontConfig(l.biz);
  if (!cfg.allowCancelSubscription)
    throw new PortalChangeError(
      "This account does not offer cancellation here. Contact us to cancel.",
      403,
    );
  const reasons =
    cfg.cancelReason === "off"
      ? []
      : (
          await resolveOfferedReasons(
            ctx.organizationId,
            ctx.businessId,
            "subscription_cancellation",
          )
        ).reasons;
  const canOffer =
    l.sub.status !== "cancelled" &&
    !l.sub.cancelAtPeriodEnd &&
    !(cfg.retentionOfferOnce && l.tookOffer);
  const offers: Array<Record<string, unknown>> = [];
  if (canOffer && cfg.retentionPause && l.sub.status === "active") {
    offers.push({
      offer: "pause",
      months: cfg.retentionPauseMonths,
      customer_chooses: cfg.retentionPauseChoice && cfg.retentionPauseMonths != null,
    });
  }
  // A plan change already scheduled (a downgrade taken earlier) is not offered again.
  const changeScheduled = (await listScheduledChanges(ctx.organizationId, l.sub.id)).some(
    (c) => c.type === "change" && c.status === "scheduled",
  );
  const target =
    canOffer && !changeScheduled
      ? await downgradeTarget(ctx, l, cfg.retentionDowngradePrice)
      : null;
  if (target) {
    offers.push({
      offer: "downgrade",
      plan: target.product.externalName ?? target.product.name,
      // The plan plus the mandatory add-ons it brings: what the customer will pay.
      amount_minor: target.totalMinor,
      includes: target.includes,
      interval: target.price.interval,
      interval_count: target.price.intervalCount,
      starts: l.sub.status === "in_trial" || !l.sub.currentPeriodEnd ? "now" : "end_of_term",
      starts_at: l.sub.status === "in_trial" ? null : l.sub.currentPeriodEnd,
    });
  }
  if (canOffer && cfg.retentionCoupon) {
    const c = await findCouponByCode({
      organizationId: ctx.organizationId,
      businessId: ctx.businessId,
      code: cfg.retentionCoupon,
    });
    if (c && c.active) offers.push({ offer: "discount", summary: couponSummary(c) });
  }
  if (canOffer && cfg.retentionContactUrl) {
    offers.push({ offer: "contact", url: cfg.retentionContactUrl });
  }
  return {
    object: "portal_cancel_flow" as const,
    currency: l.sub.currency,
    reason: cfg.cancelReason,
    reasons,
    offers,
    // A paused subscription ends now (it has no term end); the cancel route does the same.
    timing: l.sub.status === "paused" ? ("immediately" as const) : cfg.cancelTiming,
    period_end: l.sub.currentPeriodEnd,
    status: l.sub.status,
    // "You can undo this until then" is true only when the business lets customers undo.
    can_undo:
      cfg.allowReactivate && cfg.cancelTiming === "end_of_term" && l.sub.status !== "paused",
  };
}

/**
 * The CURRENT pause came from its customer's pause offer, so they may resume it. Read from
 * the pause itself: an offer taken once must not unlock a later pause the business set.
 */
export async function pausedByOffer(
  organizationId: string,
  subscriptionId: string,
): Promise<boolean> {
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select({ status: subscriptions.status, pauseSource: subscriptions.pauseSource })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1),
  );
  return row?.status === "paused" && row.pauseSource === "retention_offer";
}

async function record(
  ctx: PortalCtx,
  subscriptionId: string,
  event: {
    kind: "offer_accepted" | "cancelled";
    offer?: RetentionOffer;
    reasonCode?: string;
    offersShown?: boolean;
  },
) {
  await withTenant(ctx.organizationId, (tx) =>
    tx.insert(retentionEvents).values({
      organizationId: ctx.organizationId,
      businessId: ctx.businessId,
      customerId: ctx.customerId,
      subscriptionId,
      kind: event.kind,
      offer: event.offer ?? null,
      reasonCode: event.reasonCode ?? null,
      offersShown: event.offersShown ?? false,
    }),
  );
}

/** Advisory-lock namespace for one customer's offer acceptance. */
const OFFER_LOCK_NS = 7406;

/**
 * Take an offer from the cancel flow. Refuses an offer the flow did not make.
 *
 * The check, the action and the record run under one per-customer lock, so parallel
 * requests cannot each take an offer when the business allows one.
 */
export async function acceptRetentionOffer(
  ctx: PortalCtx,
  subPublicId: string,
  input: { offer: RetentionOffer; months?: number; reasonCode?: string },
) {
  return withTenant(ctx.organizationId, async (lockTx) => {
    await lockTx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${ctx.customerId}::text, ${OFFER_LOCK_NS}))`,
    );
    return acceptRetentionOfferLocked(ctx, subPublicId, input);
  });
}

async function acceptRetentionOfferLocked(
  ctx: PortalCtx,
  subPublicId: string,
  input: { offer: RetentionOffer; months?: number; reasonCode?: string },
) {
  const flow = await getCancelFlow(ctx, subPublicId);
  const made = flow.offers.find((o) => o.offer === input.offer);
  if (!made) throw new PortalChangeError("This offer is not available. Reload the page.", 409);
  const l = await load(ctx, subPublicId);
  const cfg = resolveStorefrontConfig(l.biz);
  const now = await businessWallClock(ctx.businessId);
  let result: Record<string, unknown> = {};

  if (input.offer === "pause") {
    const max = cfg.retentionPauseMonths;
    let months = max;
    if (max != null && cfg.retentionPauseChoice && input.months !== undefined) {
      if (!Number.isInteger(input.months) || input.months < 1 || input.months > max)
        throw new PortalChangeError(`Select a pause from 1 to ${max} months.`);
      months = input.months;
    }
    const r = await pauseSubscriptionWithOptions({
      organizationId: ctx.organizationId,
      businessId: ctx.businessId,
      subscriptionId: l.sub.id,
      now,
      source: "retention_offer",
      ...(months != null ? { resumeDate: new Date(now.getTime() + months * MONTH_MS) } : {}),
    });
    result = { status: r.subscription.status, resume_scheduled_at: r.resumeScheduledAt };
  } else if (input.offer === "downgrade") {
    const target = await downgradeTarget(ctx, l, cfg.retentionDowngradePrice);
    if (!target) throw new PortalChangeError("This offer is not available. Reload the page.", 409);
    const change = [{ itemId: target.planItem.item.publicId, newPriceId: target.price.publicId }];
    if (l.sub.status === "in_trial" || !l.sub.currentPeriodEnd) {
      await changeSubscription({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        subscriptionId: l.sub.id,
        now,
        changes: change,
        adds: target.adds,
        removes: target.removes,
        refuseUnrequestedItems: true,
      });
      result = { starts: "now" };
    } else {
      const row = await scheduleChange({
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        subscriptionId: l.sub.id,
        type: "change",
        effectiveAt: l.sub.currentPeriodEnd,
        changes: change,
        adds: target.adds,
        removes: target.removes,
      });
      result = {
        starts: "end_of_term",
        scheduled_change: row.publicId,
        effective_at: row.effectiveAt,
      };
    }
  } else if (input.offer === "discount") {
    await applyCouponToSubscription({
      organizationId: ctx.organizationId,
      businessId: ctx.businessId,
      subscriptionId: l.sub.id,
      code: cfg.retentionCoupon!,
      now,
    });
    // The description only: the code itself would let the customer apply it again later.
    result = { summary: (made as { summary?: string }).summary ?? null };
  } else {
    result = { url: cfg.retentionContactUrl };
  }

  await record(ctx, l.sub.id, {
    kind: "offer_accepted",
    offer: input.offer,
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
  });
  return { object: "portal_retention_offer" as const, offer: input.offer, ...result };
}

/** A cancellation from the flow, for the saves report. Called after the cancel succeeded. */
export async function recordPortalCancellation(
  ctx: PortalCtx,
  subscriptionId: string,
  input: { reasonCode?: string; offersShown: boolean },
) {
  await record(ctx, subscriptionId, {
    kind: "cancelled",
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    offersShown: input.offersShown,
  });
}
