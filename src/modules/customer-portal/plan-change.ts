/**
 * Portal plan changes (storefront Phase 2): plan, seats and add-ons, priced before the
 * customer confirms.
 *
 * What a customer may pick: each product's own "show in portal" flag
 * (`products.enabled_in_portal`). What they may do: `storefront_config` (allow_plan_changes,
 * seat_changes, allow_addon_changes, shorter_period, change_statuses). Timing, the gate and
 * proration: `resolveChangePolicy` (subscriptions/change-policy.ts), shared with every
 * other source. The preview and the apply run the same diff, and the apply refuses a total
 * that moved since the preview.
 */
import { and, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { businesses, prices, products, subscriptionItems, subscriptions } from "@db/schema";
import { notDeleted } from "@/modules/subscriptions/deleted-sql";
import { resolveStorefrontConfig } from "@/modules/checkout/storefront-config";
import {
  listApplicableAddonsForPlan,
  resolveMandatoryAttachedItems,
} from "@/modules/catalog/service";
import {
  changeDirection,
  directionOfItemEdit,
  resolveChangePolicy,
  resetTermForPolicy,
  type ChangeDirection,
  type ChangeTiming,
} from "@/modules/subscriptions/change-policy";
import { estimateChange } from "@/modules/subscriptions/estimate";
import { resolveLifecycleConfig } from "@/modules/subscriptions/lifecycle-config";
import { creditHandlingFor } from "@/modules/subscriptions/downgrade-credit";
import { QUOTE_MOVED_MESSAGE, quoteOf, quotedInstant } from "@/modules/subscriptions/price-quote";
import {
  isInvoiceImmediately,
  resolveUnbilledChargesConfig,
} from "@/modules/subscriptions/unbilled-charges-config";
import {
  changeSubscription,
  type ItemAdd,
  type ItemChange,
} from "@/modules/subscriptions/proration";
import {
  cancelScheduledChange,
  listScheduledChanges,
  scheduleChange,
} from "@/modules/subscriptions/scheduled-changes";

export class PortalChangeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "PortalChangeError";
  }
}

export interface PortalCtx {
  organizationId: string;
  businessId: string;
  customerId: string;
}

export interface PortalChangeRequest {
  /** price public id of the plan to move to. Absent = keep the plan. */
  plan?: string;
  /** New quantity of a per-unit plan. */
  seats?: number;
  /** Add-on quantities; 0 removes. Add-ons not named stay as they are. */
  addons?: Array<{ price: string; quantity: number }>;
  timing?: ChangeTiming;
  /** Where the credit goes; only when the business lets the customer select. */
  credit_handling?: "credit_balance" | "refund";
}

type PriceRow = typeof prices.$inferSelect;

const MONTHS: Record<string, number> = { day: 12 / 365, week: 12 / 52, month: 1, year: 12 };
const monthsOf = (p: PriceRow) => (MONTHS[p.interval ?? "month"] ?? 1) * (p.intervalCount || 1);
/** Recurring amount per month in minor units; a usage price counts as 0. */
const monthly = (p: PriceRow, quantity: number) =>
  p.type === "recurring" && p.amountMinor != null
    ? (Number(p.amountMinor) * (p.model === "flat" ? 1 : quantity)) / monthsOf(p)
    : 0;

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
    const offered = await tx
      .select({ price: prices, product: products })
      .from(prices)
      .innerJoin(products, eq(products.id, prices.productId))
      .where(
        and(
          eq(prices.businessId, ctx.businessId),
          eq(prices.active, true),
          eq(prices.type, "recurring"),
          eq(prices.currency, sub.currency),
          eq(products.active, true),
          eq(products.enabledInPortal, true),
          inArray(products.kind, ["plan", "addon"]),
        ),
      );
    return { sub, biz: biz!, items, offered };
  });
}

type Loaded = Awaited<ReturnType<typeof load>>;

/** How an add-on attaches to one plan, for the portal. Limits bind customers, not staff. */
interface AddonRule {
  mandatory: boolean;
  min: number | null;
  max: number | null;
  step: number;
  canChangeQuantity: boolean;
  defaultQuantity: number;
}

/** The add-ons that apply to a plan product (attached, differential or "every plan"), by add-on product public id. */
async function addonRules(ctx: PortalCtx, planProductId: string): Promise<Map<string, AddonRule>> {
  const rows = await listApplicableAddonsForPlan(ctx.organizationId, ctx.businessId, planProductId);
  return new Map(
    rows
      .filter((r) => r.kind === "addon")
      .map((r) => [
        r.addon,
        {
          mandatory: r.applicability === "mandatory",
          min: r.config.minQuantity,
          max: r.config.maxQuantity,
          step: r.config.quantityStep,
          canChangeQuantity: r.config.customerCanChangeQuantity,
          defaultQuantity: r.config.defaultQuantity,
        },
      ]),
  );
}

/** Why a customer may not set this add-on quantity, or null. */
function addonQuantityError(name: string, q: number, r: AddonRule): string | null {
  const min = r.min ?? 1;
  const off = q < min || (r.max != null && q > r.max) || (q - min) % r.step !== 0;
  if (!off) return null;
  const steps = r.step > 1 ? `, in steps of ${r.step}` : "";
  return r.max != null
    ? `Enter a quantity from ${min} to ${r.max} for ${name}${steps}.`
    : `Enter a quantity of ${min} or more for ${name}${steps}.`;
}

/** Seat limits of a per-unit plan price: its own portal limits, else the business's. */
function seatLimits(p: PriceRow, cfg: ReturnType<typeof resolveStorefrontConfig>) {
  return { min: p.portalMinQuantity ?? cfg.seatMin ?? 1, max: p.portalMaxQuantity ?? cfg.seatMax };
}

function shorterAllowed(l: Loaded, cfg: ReturnType<typeof resolveStorefrontConfig>, now: Date) {
  if (cfg.shorterPeriod === "always") return true;
  if (cfg.shorterPeriod === "never") return false;
  const started = l.sub.startedAt ?? l.sub.createdAt;
  return now.getTime() - started.getTime() >= 365 * 86_400_000;
}

/** Why this subscription cannot change at all, or null. */
function unavailable(l: Loaded, cfg: ReturnType<typeof resolveStorefrontConfig>): string | null {
  if (!cfg.allowPlanChanges)
    return "This account does not offer plan changes here. Contact us to change your plan.";
  if (l.sub.cancelAtPeriodEnd)
    return "This subscription is set to cancel. Keep the subscription first, then change the plan.";
  if (!cfg.changeStatuses.includes(l.sub.status))
    return "You cannot change this subscription in its current status. Contact us to change your plan.";
  return null;
}

export async function getChangeOptions(ctx: PortalCtx, subPublicId: string) {
  const l = await load(ctx, subPublicId);
  const cfg = resolveStorefrontConfig(l.biz);
  const now = new Date();
  const planItem = l.items.find((r) => r.product.kind === "plan");
  const planMonthly = planItem ? monthly(planItem.price, planItem.item.quantity) : 0;
  const shorterOk = shorterAllowed(l, cfg, now);
  const why = unavailable(l, cfg);
  const seatsOn = !!planItem && planItem.price.model === "per_unit" && cfg.seatChanges !== "off";
  const scheduled = (await listScheduledChanges(ctx.organizationId, l.sub.id)).find(
    (c) => c.type === "change" && c.status === "scheduled",
  );
  const policyFor = (direction: ChangeDirection) =>
    resolveChangePolicy({ business: l.biz, subscription: l.sub, direction, source: "portal" });
  const [up, down] = await Promise.all([policyFor("upgrade"), policyFor("downgrade")]);
  const plans = l.offered
    .filter((o) => o.product.kind === "plan")
    .filter(
      (o) =>
        o.price.id === planItem?.price.id ||
        !planItem ||
        shorterOk ||
        monthsOf(o.price) >= monthsOf(planItem.price),
    )
    .map((o) => {
      const current = o.price.id === planItem?.price.id;
      return {
        price: o.price.publicId,
        name: o.product.externalName ?? o.product.name,
        description: o.product.description,
        amount_minor: o.price.amountMinor == null ? null : Number(o.price.amountMinor),
        model: o.price.model,
        interval: o.price.interval,
        interval_count: o.price.intervalCount,
        current,
        direction: current
          ? ("same" as const)
          : changeDirection(
              planMonthly,
              monthly(o.price, planItem?.item.quantity ?? 1),
              planItem ? { before: monthsOf(planItem.price), after: monthsOf(o.price) } : undefined,
            ),
      };
    });
  if (planItem && !plans.some((p) => p.current))
    plans.unshift({
      price: planItem.price.publicId,
      name: planItem.product.externalName ?? planItem.product.name,
      description: planItem.product.description,
      amount_minor: planItem.price.amountMinor == null ? null : Number(planItem.price.amountMinor),
      model: planItem.price.model,
      interval: planItem.price.interval,
      interval_count: planItem.price.intervalCount,
      current: true,
      direction: "same",
    });
  // Each listed plan's add-on rules, so the page can follow the plan the customer selects.
  const planProductByPrice = new Map<string, string>(
    [...l.offered, ...(planItem ? [planItem] : [])]
      .filter((o) => o.product.kind === "plan")
      .map((o) => [o.price.publicId, o.product.id]),
  );
  const rulesByProduct = new Map<string, Map<string, AddonRule>>();
  if (cfg.allowAddonChanges)
    for (const productId of new Set(plans.map((p) => planProductByPrice.get(p.price)!)))
      rulesByProduct.set(productId, await addonRules(ctx, productId));
  const rulesFor = (addonProductPublicId: string) =>
    Object.fromEntries(
      plans.flatMap((p) => {
        const r = rulesByProduct.get(planProductByPrice.get(p.price)!)?.get(addonProductPublicId);
        return r
          ? [
              [
                p.price,
                {
                  mandatory: r.mandatory,
                  min: r.min,
                  max: r.max,
                  step: r.step,
                  can_change_quantity: r.canChangeQuantity,
                  default_quantity: r.defaultQuantity,
                },
              ],
            ]
          : [];
      }),
    );
  const addonOffers = cfg.allowAddonChanges
    ? l.offered.filter((o) => o.product.kind === "addon")
    : [];
  const addonIds = new Set(addonOffers.map((o) => o.price.id));
  const addons = [
    ...addonOffers.map((o) => {
      const on = l.items.find((r) => r.price.id === o.price.id);
      return {
        price: o.price.publicId,
        name: o.product.externalName ?? o.product.name,
        amount_minor: o.price.amountMinor == null ? null : Number(o.price.amountMinor),
        interval: o.price.interval,
        interval_count: o.price.intervalCount,
        quantity: on?.item.quantity ?? 0,
        item: on?.item.publicId ?? null,
        /** Per plan price: how it attaches. Absent = not available on that plan. */
        rules: rulesFor(o.product.publicId),
      };
    }),
    // An add-on the customer already has but the merchant no longer shows: they may still remove it.
    ...(cfg.allowAddonChanges
      ? l.items
          .filter((r) => r.product.kind === "addon" && !addonIds.has(r.price.id))
          .map((r) => ({
            price: r.price.publicId,
            name: r.product.externalName ?? r.product.name,
            amount_minor: r.price.amountMinor == null ? null : Number(r.price.amountMinor),
            interval: r.price.interval,
            interval_count: r.price.intervalCount,
            quantity: r.item.quantity,
            item: r.item.publicId,
            rules: rulesFor(r.product.publicId),
            remove_only: true,
          }))
      : []),
  ];
  return {
    object: "portal_change_options" as const,
    allowed: why === null,
    unavailable_reason: why,
    currency: l.sub.currency,
    current_period_end: l.sub.currentPeriodEnd,
    trial_end: l.sub.status === "in_trial" ? l.sub.trialEnd : null,
    plans,
    seats: seatsOn
      ? {
          item: planItem!.item.publicId,
          current: planItem!.item.quantity,
          ...seatLimits(planItem!.price, cfg),
          /** Per per-unit plan price, when the customer switches plan. */
          by_plan: Object.fromEntries(
            [...l.offered, planItem!]
              .filter((o) => o.product.kind === "plan" && o.price.model === "per_unit")
              .map((o) => [o.price.publicId, seatLimits(o.price, cfg)]),
          ),
          decrease_allowed: cfg.seatChanges === "both",
        }
      : null,
    addons,
    timing: {
      upgrade: { options: up.timings, default: up.defaultTiming, blocked: up.blocked },
      downgrade: { options: down.timings, default: down.defaultTiming, blocked: down.blocked },
    },
    scheduled_change: scheduled
      ? {
          id: scheduled.publicId,
          effective_at: scheduled.effectiveAt,
          can_cancel: cfg.allowCancelScheduledChange,
        }
      : null,
  };
}

/** The request as engine operations, validated against what the portal offers. */
async function plan(ctx: PortalCtx, subPublicId: string, req: PortalChangeRequest, at?: Date) {
  const l = await load(ctx, subPublicId);
  const cfg = resolveStorefrontConfig(l.biz);
  const why = unavailable(l, cfg);
  if (why) throw new PortalChangeError(why, 403);
  const now = at ?? new Date();
  const planItem = l.items.find((r) => r.product.kind === "plan");
  const changes: ItemChange[] = [];
  const adds: ItemAdd[] = [];
  const removes: string[] = [];
  const priceByPublic = new Map(l.offered.map((o) => [o.price.publicId, o]));
  const after = new Map(
    l.items.map((r) => [r.item.publicId, { price: r.price, q: r.item.quantity }]),
  );

  if (req.plan !== undefined || req.seats !== undefined) {
    if (!planItem) throw new PortalChangeError("This subscription has no plan to change.");
    let newPrice: PriceRow | undefined;
    if (req.plan !== undefined && req.plan !== planItem.price.publicId) {
      const o = priceByPublic.get(req.plan);
      if (!o || o.product.kind !== "plan")
        throw new PortalChangeError("Select a plan from the list.");
      if (monthsOf(o.price) < monthsOf(planItem.price) && !shorterAllowed(l, cfg, now))
        throw new PortalChangeError(
          cfg.shorterPeriod === "never"
            ? "You cannot move to a shorter billing period here."
            : "You can move to a shorter billing period after 12 months.",
        );
      newPrice = o.price;
    }
    let newQuantity: number | undefined;
    if (req.seats !== undefined && req.seats !== planItem.item.quantity) {
      const model = (newPrice ?? planItem.price).model;
      if (model !== "per_unit" || cfg.seatChanges === "off")
        throw new PortalChangeError("You cannot change the number of seats here.");
      if (req.seats < planItem.item.quantity && cfg.seatChanges !== "both")
        throw new PortalChangeError(
          "You can add seats here, but not remove them. Contact us to remove seats.",
        );
      const { min, max } = seatLimits(newPrice ?? planItem.price, cfg);
      if (!Number.isInteger(req.seats) || req.seats < min || (max != null && req.seats > max))
        throw new PortalChangeError(
          max != null
            ? `Enter a number of seats from ${min} to ${max}.`
            : `Enter at least ${min} seat${min === 1 ? "" : "s"}.`,
        );
      newQuantity = req.seats;
    } else if (newPrice?.model === "per_unit") {
      // A plan with its own seat limits binds the seats the customer brings to it.
      const q = planItem.item.quantity;
      const lo = newPrice.portalMinQuantity;
      const hi = newPrice.portalMaxQuantity;
      if ((lo != null && q < lo) || (hi != null && q > hi))
        throw new PortalChangeError(
          `This plan needs ${hi != null ? `${lo ?? 1} to ${hi}` : `${lo} or more`} seats. Change the number of seats first.`,
        );
    }
    if (newPrice || newQuantity !== undefined) {
      changes.push({
        itemId: planItem.item.publicId,
        ...(newPrice ? { newPriceId: newPrice.publicId } : {}),
        ...(newQuantity !== undefined ? { newQuantity } : {}),
      });
      after.set(planItem.item.publicId, {
        price: newPrice ?? planItem.price,
        q: newQuantity ?? planItem.item.quantity,
      });
    }
  }

  // Add-on rules of the plan the subscription ends up on.
  const finalPlan = changes.find((c) => c.itemId === planItem?.item.publicId)?.newPriceId;
  const finalPlanProductId = finalPlan
    ? priceByPublic.get(finalPlan)!.product.id
    : planItem?.product.id;
  const rules = finalPlanProductId
    ? await addonRules(ctx, finalPlanProductId)
    : new Map<string, AddonRule>();
  const planName = (finalPlan ? priceByPublic.get(finalPlan)!.product : planItem?.product) ?? null;
  const onPlan = planName ? (planName.externalName ?? planName.name) : "your plan";

  for (const a of req.addons ?? []) {
    if (!cfg.allowAddonChanges) throw new PortalChangeError("You cannot change add-ons here.");
    if (!Number.isInteger(a.quantity) || a.quantity < 0 || a.quantity > 100000)
      throw new PortalChangeError("Enter a whole number of 0 or more for each add-on.");
    const on = l.items.find((r) => r.price.publicId === a.price && r.product.kind === "addon");
    const product = on?.product ?? priceByPublic.get(a.price)?.product;
    const rule = product ? rules.get(product.publicId) : undefined;
    const name = product ? (product.externalName ?? product.name) : "this add-on";
    if (on) {
      if (a.quantity === on.item.quantity) continue;
      if (a.quantity === 0) {
        if (rule?.mandatory)
          throw new PortalChangeError(`${name} is included with ${onPlan}. You cannot remove it.`);
        removes.push(on.item.publicId);
        after.delete(on.item.publicId);
      } else {
        // An add-on the portal does not offer (hidden, archived, not on this plan): remove only.
        if (!priceByPublic.has(on.price.publicId) || !rule)
          throw new PortalChangeError(
            `You cannot change the quantity of ${name} here. You can remove it.`,
          );
        // A plan switch may reset a fixed quantity to the new plan's own quantity.
        const reset = !!finalPlan && a.quantity === rule.defaultQuantity;
        if (!rule.canChangeQuantity && !reset)
          throw new PortalChangeError(`You cannot change the quantity of ${name} here.`);
        const bad = addonQuantityError(name, a.quantity, rule);
        if (bad) throw new PortalChangeError(bad);
        changes.push({ itemId: on.item.publicId, newQuantity: a.quantity });
        after.set(on.item.publicId, { price: on.price, q: a.quantity });
      }
      continue;
    }
    if (a.quantity === 0) continue;
    const o = priceByPublic.get(a.price);
    if (!o || o.product.kind !== "addon")
      throw new PortalChangeError("Select an add-on from the list.");
    if (!rule) throw new PortalChangeError(`${name} is not available on ${onPlan}.`);
    if (!rule.canChangeQuantity && a.quantity !== rule.defaultQuantity)
      throw new PortalChangeError(`You cannot change the quantity of ${name} here.`);
    const bad = rule.canChangeQuantity ? addonQuantityError(name, a.quantity, rule) : null;
    if (bad) throw new PortalChangeError(bad);
    adds.push({ priceId: o.price.publicId, quantity: a.quantity });
    after.set(`add:${o.price.publicId}`, { price: o.price, q: a.quantity });
  }

  // Name every item the engine would add or remove on its own (CAT-3), so the preview
  // prices it and the apply (`refuseUnrequestedItems`) books exactly what was shown.
  if (planItem && finalPlanProductId) {
    const autoIncluded = (r: Loaded["items"][number]) =>
      (r.item.metadata as { auto_included?: string } | null)?.auto_included === "mandatory";
    for (const r of l.items) {
      if (r.product.kind !== "addon" || removes.includes(r.item.publicId)) continue;
      if (autoIncluded(r)) {
        // The engine removes an auto-included add-on the final plan does not require.
        if (!rules.get(r.product.publicId)?.mandatory) {
          removes.push(r.item.publicId);
          after.delete(r.item.publicId);
        }
      } else if (finalPlan && rules.get(r.product.publicId)?.canChangeQuantity === false) {
        // The new plan sets this add-on's quantity: reset it there, priced in the preview.
        const fixed = rules.get(r.product.publicId)!.defaultQuantity;
        const q = after.get(r.item.publicId)?.q ?? r.item.quantity;
        if (q !== fixed) {
          const i = changes.findIndex((c) => c.itemId === r.item.publicId);
          if (i >= 0) changes[i] = { ...changes[i]!, newQuantity: fixed };
          else changes.push({ itemId: r.item.publicId, newQuantity: fixed });
          after.set(r.item.publicId, { price: r.price, q: fixed });
        }
      } else if (finalPlan && !rules.has(r.product.publicId)) {
        throw new PortalChangeError(
          `${r.product.externalName ?? r.product.name} is not available on ${onPlan}. ${
            cfg.allowAddonChanges ? "Remove it first." : "Contact us to change your plan."
          }`,
        );
      }
    }
    // The mandatory add-ons the final plan brings, picked by the engine's own resolver.
    const postProductIds = [
      ...l.items
        .filter((r) => !removes.includes(r.item.publicId))
        .map((r) => (r.item.id === planItem.item.id ? finalPlanProductId : r.price.productId)),
      ...adds.map((a) => priceByPublic.get(a.priceId)!.price.productId),
    ];
    const mandatory = await withTenant(ctx.organizationId, (tx) =>
      resolveMandatoryAttachedItems(tx, {
        businessId: ctx.businessId,
        planProductIds: [finalPlanProductId],
        currency: l.sub.currency,
        interval: l.sub.billingPeriodUnit,
        intervalCount: l.sub.billingPeriod ?? 1,
        existingProductIds: postProductIds,
      }),
    );
    for (const m of mandatory) {
      if (m.chargeOnce) continue; // not added on a change; the engine skips it too
      adds.push({
        priceId: m.price.publicId,
        quantity: m.quantity,
        autoIncluded: true,
        billingCycles: m.billingCycles,
      });
      after.set(`add:${m.price.publicId}`, { price: m.price, q: m.quantity });
    }
  }

  if (changes.length + adds.length + removes.length === 0)
    throw new PortalChangeError("Select a change first.");
  const afterMonthly = [...after.values()].reduce((s, v) => s + monthly(v.price, v.q), 0);
  const newPlanPrice = planItem ? after.get(planItem.item.publicId)?.price : undefined;
  // The engine's rating, as the API and checkout use: tiered, volume, snapshot and
  // differential prices count at what they bill. It decides the gate, timing and proration.
  const direction = await withTenant(ctx.organizationId, (tx) =>
    directionOfItemEdit(tx, l.sub, { changes, adds, removes }),
  );
  const policy = await resolveChangePolicy({
    business: l.biz,
    subscription: l.sub,
    direction,
    source: "portal",
  });
  if (policy.blocked) throw new PortalChangeError(policy.blocked.message, 409);
  const timing =
    req.timing && policy.timings.includes(req.timing) ? req.timing : policy.defaultTiming;
  if (req.timing && !policy.timings.includes(req.timing))
    throw new PortalChangeError(
      timing === "now"
        ? "This change starts now. You cannot schedule it for the end of the term here."
        : "This change starts at the end of the term. You cannot start it now here.",
    );
  if (timing === "end_of_term" && !l.sub.currentPeriodEnd)
    throw new PortalChangeError("This subscription has no term end to schedule the change for.");
  const prorate = direction === "downgrade" ? policy.prorate.downgrade : policy.prorate.upgrade;
  // The business rule for the term: the portal never sends its own `reset_term`.
  const resetTerm = resetTermForPolicy(
    policy,
    direction,
    Boolean(planItem && newPlanPrice && newPlanPrice.id !== planItem.price.id),
  );
  // `downgrade_credit`: the customer selects only when the business lets them.
  const creditRule = resolveLifecycleConfig(l.biz).downgradeCredit;
  if (req.credit_handling && creditRule !== "customer_chooses")
    throw new PortalChangeError("You cannot select where the credit goes here.");
  const creditHandling = creditHandlingFor(creditRule, req.credit_handling);
  // One answer for the preview and the apply: the portal setting, else the business rule.
  const invoiceImmediately =
    policy.invoiceImmediately ?? isInvoiceImmediately(resolveUnbilledChargesConfig(l.biz).onChange);
  return {
    l,
    changes,
    adds,
    removes,
    direction,
    policy,
    timing,
    prorate,
    resetTerm,
    creditRule,
    creditHandling,
    invoiceImmediately,
    afterMonthly,
    now,
  };
}

type Planned = Awaited<ReturnType<typeof plan>>;

async function price(ctx: PortalCtx, p: Planned) {
  const nextRecurring = {
    monthly_minor: Math.round(p.afterMonthly),
    currency: p.l.sub.currency,
  };
  if (p.timing === "end_of_term") {
    return {
      due_today: null,
      total_minor: 0,
      effective_at: p.l.sub.currentPeriodEnd,
      next_recurring: nextRecurring,
    };
  }
  const est = await estimateChange({
    organizationId: ctx.organizationId,
    businessId: ctx.businessId,
    subscriptionId: p.l.sub.id,
    now: p.now,
    changes: p.changes,
    adds: p.adds.map((a) => ({ priceId: a.priceId, quantity: a.quantity })),
    removes: p.removes,
    prorate: p.prorate,
    resetTerm: p.resetTerm,
    ...(p.creditRule === "customer_chooses" ? { creditChoice: p.creditHandling } : {}),
  });
  // Deferred by the business rule: the charge joins the next invoice, nothing is due today.
  const due = p.invoiceImmediately ? (est.amount_due_minor ?? est.total_minor) : 0;
  return {
    due_today: {
      lines: est.lines,
      tax_minor: est.tax_minor,
      total_minor: est.total_minor,
      amount_due_minor: due,
      credit_minor: est.credit_note_total_minor ?? 0,
      // `downgrade_credit: refund` (or the customer's selection): paid back, not kept.
      refunded_minor: est.refunded_to_payment_method_minor ?? 0,
      immediate_charge: p.invoiceImmediately && est.immediate_charge,
      added_to_next_invoice: !p.invoiceImmediately,
    },
    total_minor: due,
    effective_at: p.now,
    next_recurring: nextRecurring,
  };
}

/** Every amount the preview shows, as one value: apply refuses when any of them moved. */
function quoteOfPriced(priced: Awaited<ReturnType<typeof price>>): string {
  const d = priced.due_today;
  return quoteOf([
    priced.total_minor,
    d?.amount_due_minor ?? null,
    d?.total_minor ?? null,
    d?.credit_minor ?? null,
    d?.tax_minor ?? null,
    priced.next_recurring.monthly_minor,
    priced.effective_at ? new Date(priced.effective_at).toISOString() : null,
  ]);
}

export async function previewPortalChange(
  ctx: PortalCtx,
  subPublicId: string,
  req: PortalChangeRequest,
) {
  const p = await plan(ctx, subPublicId, req);
  const priced = await price(ctx, p);
  return {
    object: "portal_change_preview" as const,
    direction: p.direction,
    timing: p.timing,
    timing_options: p.policy.timings,
    // What "now" does with money, so the page can say it for either timing.
    prorate: p.prorate,
    // The change restarts the term today (`plan_change_term`).
    reset_term: p.resetTerm === true,
    // Where a credit from this change goes; two options = the customer selects.
    credit_handling: p.creditHandling,
    credit_handling_options:
      p.creditRule === "customer_chooses" ? ["credit_balance", "refund"] : [p.creditHandling],
    invoice_immediately: p.invoiceImmediately,
    // An added or removed item is always prorated, whatever `prorate` says.
    adds_items: p.adds.length > 0,
    removes_items: p.removes.length > 0,
    currency: p.l.sub.currency,
    trial_end: p.l.sub.status === "in_trial" ? p.l.sub.trialEnd : null,
    ...priced,
    /** Send both back on apply: it re-prices at this instant and books only these amounts. */
    priced_at: p.now.toISOString(),
    quote: quoteOfPriced(priced),
  };
}

export async function applyPortalChange(
  ctx: PortalCtx,
  subPublicId: string,
  req: PortalChangeRequest & { expectedTotalMinor: number; pricedAt?: string; quote?: string },
) {
  // Booked at the preview's instant, so the unused-time credit is the one shown.
  const p = await plan(ctx, subPublicId, req, quotedInstant(req.pricedAt));
  const priced = await price(ctx, p);
  if (
    priced.total_minor !== req.expectedTotalMinor ||
    (req.quote !== undefined && quoteOfPriced(priced) !== req.quote)
  )
    throw new PortalChangeError(QUOTE_MOVED_MESSAGE, 409);
  if (p.timing === "end_of_term") {
    const row = await scheduleChange({
      organizationId: ctx.organizationId,
      businessId: ctx.businessId,
      subscriptionId: p.l.sub.id,
      type: "change",
      effectiveAt: p.l.sub.currentPeriodEnd!,
      changes: p.changes,
      adds: p.adds,
      removes: p.removes,
    });
    return {
      object: "portal_change" as const,
      timing: p.timing,
      scheduled_change: { id: row.publicId, effective_at: row.effectiveAt },
      invoice: null,
    };
  }
  const r = await changeSubscription({
    organizationId: ctx.organizationId,
    businessId: ctx.businessId,
    subscriptionId: p.l.sub.id,
    now: p.now,
    changes: p.changes,
    adds: p.adds,
    removes: p.removes,
    prorate: p.prorate,
    resetTerm: p.resetTerm,
    creditHandling: p.creditHandling,
    invoiceImmediately: p.invoiceImmediately,
    // Book exactly the previewed request; refuse if the engine would add anything unseen.
    refuseUnrequestedItems: true,
  });
  const inv = r.prorationInvoice;
  return {
    object: "portal_change" as const,
    timing: p.timing,
    scheduled_change: null,
    invoice: inv
      ? {
          id: inv.publicId,
          status: inv.status,
          amount_due_minor: Number(inv.amountDueMinor ?? 0),
          currency: inv.currency,
        }
      : null,
    // The refund of this change's credit, when it was refunded or tried.
    credit_refunds: (r.creditRefunds ?? []).map((x) => ({
      credit_note: x.creditNote,
      refunded_minor: x.refundedMinor,
      kept_minor: x.keptMinor,
    })),
  };
}

export async function cancelPortalScheduledChange(ctx: PortalCtx, subPublicId: string) {
  const l = await load(ctx, subPublicId);
  if (!resolveStorefrontConfig(l.biz).allowCancelScheduledChange)
    throw new PortalChangeError(
      "This account does not let you withdraw a scheduled change here. Contact us.",
      403,
    );
  const scheduled = (await listScheduledChanges(ctx.organizationId, l.sub.id)).find(
    (c) => c.type === "change" && c.status === "scheduled",
  );
  if (!scheduled) throw new PortalChangeError("This subscription has no scheduled change.", 404);
  await cancelScheduledChange(ctx.organizationId, ctx.businessId, scheduled.publicId);
  return { object: "portal_scheduled_change" as const, id: scheduled.publicId, canceled: true };
}
