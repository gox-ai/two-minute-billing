/**
 * Portal restart of an ENDED subscription (storefront `allow_restart`).
 *
 * The buyer never restarts in place: the portal mints a reactivating checkout session and the
 * buyer pays the new term on the hosted page. Completion runs `reactivateAndBill` with the
 * charge taken first, so a decline leaves the subscription cancelled.
 *
 * `restartEligibility` is the one rule behind the portal list, the route and the button.
 */
import { and, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { invoices, prices, products, subscriptionItems, subscriptions } from "@db/schema";
import { notDeleted } from "@/modules/subscriptions/deleted-sql";
import { getCustomerById } from "@/modules/customers/service";
import { isAutoCollectOn } from "@/modules/invoicing/service";
import { OPEN_INVOICE_STATUSES } from "@/modules/invoicing/status";
import { createCheckoutSession, type CheckoutItemInput } from "@/modules/checkout/service";
import type { StorefrontConfig } from "@/modules/checkout/storefront-config";
import { estimateReactivate } from "@/modules/subscriptions/estimate";
import { currentItems } from "@/modules/subscriptions/reactivate";

const DAY_MS = 24 * 60 * 60 * 1000;

export type RestartBlock =
  | "not_offered"
  | "not_ended"
  | "window_closed"
  | "open_invoices"
  | "plan_unavailable"
  | "manual_collection";

/** Buyer-facing text per block (ASD-STE100). */
export const RESTART_MESSAGES: Record<RestartBlock, string> = {
  not_offered: "You cannot reactivate this subscription here. Contact us to reactivate it.",
  not_ended: "This subscription has not ended.",
  window_closed:
    "You can no longer reactivate this subscription here. Contact us to reactivate it.",
  open_invoices: "Pay the open invoices of this subscription. Then you can reactivate it.",
  plan_unavailable: "This plan is no longer available. Contact us to reactivate your subscription.",
  manual_collection:
    "We collect payment for this subscription by invoice. Contact us to reactivate it.",
};

export interface RestartEligibility {
  allowed: boolean;
  reason: RestartBlock | null;
  /** Public ids of the unpaid invoices, when they block the restart. */
  openInvoices: string[];
  /** The last instant a restart is offered, or null when there is no limit. */
  closesAt: Date | null;
}

type RestartSub = Pick<
  typeof subscriptions.$inferSelect,
  "id" | "status" | "canceledAt" | "customerId" | "autoCollection"
>;

const blocked = (
  reason: RestartBlock,
  closesAt: Date | null = null,
  openInvoices: string[] = [],
): RestartEligibility => ({ allowed: false, reason, openInvoices, closesAt });

export async function restartEligibility(input: {
  organizationId: string;
  subscription: RestartSub;
  config: StorefrontConfig;
  now: Date;
}): Promise<RestartEligibility> {
  const { organizationId, subscription: sub, config, now } = input;
  if (!config.allowRestart) return blocked("not_offered");
  if (sub.status !== "cancelled") return blocked("not_ended");

  // An end date we do not know cannot be inside a window.
  const closesAt =
    config.restartWindowDays == null
      ? null
      : sub.canceledAt
        ? new Date(sub.canceledAt.getTime() + config.restartWindowDays * DAY_MS)
        : new Date(0);
  if (closesAt && closesAt < now) return blocked("window_closed", closesAt);

  // Pay-first needs a charge; a subscription collected by invoice would restart unpaid.
  const customer = await getCustomerById(organizationId, sub.customerId);
  if (!isAutoCollectOn(sub.autoCollection ?? null, customer?.autoCollection ?? null))
    return blocked("manual_collection", closesAt);

  const lines = await withTenant(organizationId, (tx) =>
    tx
      .select({ priceActive: prices.active, productActive: products.active })
      .from(subscriptionItems)
      .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
      .innerJoin(products, eq(products.id, prices.productId))
      .where(eq(subscriptionItems.subscriptionId, sub.id)),
  );
  if (lines.length === 0 || lines.some((l) => !l.priceActive || !l.productActive))
    return blocked("plan_unavailable", closesAt);

  if (config.restartOpenInvoices === "pay_first") {
    const open = await withTenant(organizationId, (tx) =>
      tx
        .select({ publicId: invoices.publicId })
        .from(invoices)
        .where(
          and(
            eq(invoices.subscriptionId, sub.id),
            inArray(invoices.status, [...OPEN_INVOICE_STATUSES]),
            eq(invoices.writtenOff, false),
          ),
        ),
    );
    if (open.length > 0)
      return blocked(
        "open_invoices",
        closesAt,
        open.map((o) => o.publicId),
      );
  }
  return { allowed: true, reason: null, openInvoices: [], closesAt };
}

export class RestartError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404 | 409 | 500 = 409,
  ) {
    super(message);
    this.name = "RestartError";
  }
}

/**
 * Mint the restart checkout for the portal customer's own subscription. `current` lists the
 * subscription's prices, so the term is billed at today's catalogue price (a custom price on
 * a line is kept); `keep` lists nothing, so the lines keep their frozen price.
 */
export async function mintPortalRestartCheckout(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  subscriptionPublicId: string;
  config: StorefrontConfig;
  now: Date;
  returnUrl: string;
  cancelUrl: string;
}): Promise<{ url: string; expiresAt: Date; eligibility: RestartEligibility }> {
  const [sub] = await withTenant(input.organizationId, (tx) =>
    tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.publicId, input.subscriptionPublicId),
          eq(subscriptions.businessId, input.businessId),
          eq(subscriptions.customerId, input.customerId),
          notDeleted(),
        ),
      )
      .limit(1),
  );
  if (!sub) throw new RestartError(`No such subscription: ${input.subscriptionPublicId}`, 404);

  const eligibility = await restartEligibility({
    organizationId: input.organizationId,
    subscription: sub,
    config: input.config,
    now: input.now,
  });
  if (!eligibility.allowed)
    throw new RestartError(
      RESTART_MESSAGES[eligibility.reason!],
      eligibility.reason === "not_offered" ? 403 : 409,
    );

  const ref = await mintRestartSession({
    organizationId: input.organizationId,
    businessId: input.businessId,
    subscription: sub,
    price: input.config.restartPrice,
    returnUrl: input.returnUrl,
    cancelUrl: input.cancelUrl,
  });
  return { url: ref.url, expiresAt: ref.expiresAt, eligibility };
}

/**
 * The restart checkout itself, with no eligibility rule: the portal checks those first; an
 * operator's link or email does not. `current` lists the subscription's prices (today's
 * catalogue price, a custom line price kept); `keep` lists nothing (the frozen prices).
 */
export async function mintRestartSession(input: {
  organizationId: string;
  businessId: string;
  subscription: { id: string; publicId: string };
  price: "current" | "keep";
  returnUrl?: string;
  cancelUrl?: string;
  /** An emailed restart link's lifetime (`portal_email_link_days`). Default: the checkout TTL. */
  ttlMs?: number;
}): Promise<{ url: string; expiresAt: Date }> {
  let items: CheckoutItemInput[] | undefined;
  if (input.price === "current") {
    const rows = await withTenant(input.organizationId, (tx) =>
      tx
        .select({ price: prices.publicId, quantity: subscriptionItems.quantity })
        .from(subscriptionItems)
        .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
        .where(eq(subscriptionItems.subscriptionId, input.subscription.id)),
    );
    items = rows.map((r) => ({ price: r.price, quantity: r.quantity }));
  }
  const ref = await createCheckoutSession({
    organizationId: input.organizationId,
    businessId: input.businessId,
    mode: "change",
    subscriptionId: input.subscription.publicId,
    reactivate: true,
    ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}),
    ...(items ? { items } : {}),
    ...(input.returnUrl ? { redirectUrl: input.returnUrl } : {}),
    ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
  });
  if (!ref.url)
    throw new RestartError("We could not open the reactivation page. Try again later.", 500);
  return { url: ref.url, expiresAt: ref.expiresAt };
}

/**
 * The line set the restart checkout bills, by `restart_price`. `keep`: the items as
 * `currentItems` freezes them (the checkout lists nothing). `current`: today's catalogue
 * price, a custom (overridden) line price kept, which is what the checkout's merge of the
 * listed prices over the subscription's own lines gives.
 */
export async function restartLines(
  organizationId: string,
  subscriptionId: string,
  price: "current" | "keep",
): Promise<Awaited<ReturnType<typeof currentItems>>> {
  if (price === "keep") return currentItems(organizationId, subscriptionId);
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        price: prices.publicId,
        quantity: subscriptionItems.quantity,
        freeQuantity: subscriptionItems.freeQuantity,
        snapshot: subscriptionItems.priceSnapshot,
      })
      .from(subscriptionItems)
      .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
      .where(eq(subscriptionItems.subscriptionId, subscriptionId)),
  );
  return rows.map((r) => {
    const snap = (r.snapshot ?? null) as {
      amountOverridden?: boolean;
      amountMinor?: number | null;
    } | null;
    return {
      price: r.price,
      quantity: r.quantity,
      unitPriceMinor: snap?.amountOverridden && snap.amountMinor != null ? snap.amountMinor : null,
      freeQuantity: r.freeQuantity ?? null,
    };
  });
}

/**
 * The new term a restart bills, before tax and discounts: the same `estimateReactivate`
 * the restart checkout quotes, over the same lines. Null when it cannot be priced.
 */
export async function restartTerm(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  price: "current" | "keep";
  now: Date;
}): Promise<{
  interval: string;
  interval_count: number;
  subtotal_minor: number;
  currency: string;
} | null> {
  try {
    const items = await restartLines(input.organizationId, input.subscriptionId, input.price);
    const est = await estimateReactivate({
      organizationId: input.organizationId,
      businessId: input.businessId,
      subscriptionId: input.subscriptionId,
      items,
      now: input.now,
      termOnly: true,
    });
    const [plan] = await withTenant(input.organizationId, (tx) =>
      tx
        .select({ interval: prices.interval, intervalCount: prices.intervalCount })
        .from(subscriptionItems)
        .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
        .innerJoin(products, eq(products.id, prices.productId))
        .where(
          and(
            eq(subscriptionItems.subscriptionId, input.subscriptionId),
            eq(products.kind, "plan"),
          ),
        )
        .limit(1),
    );
    if (!plan?.interval) return null;
    return {
      interval: plan.interval,
      interval_count: plan.intervalCount || 1,
      subtotal_minor: est.subtotal_minor,
      currency: est.currency,
    };
  } catch {
    return null;
  }
}
