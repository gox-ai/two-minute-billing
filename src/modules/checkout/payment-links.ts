import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { config } from "@/platform/config";
import {
  businesses,
  checkoutSessions,
  paymentLinkItems,
  paymentLinks,
  prices,
  products,
} from "@db/schema";
import { getPriceByPublicId } from "@/modules/catalog/service";
import { formatMoney } from "@/platform/currency";
import {
  CheckoutError,
  createCheckoutSession,
  isDisplayOnly,
  type CheckoutSessionRef,
} from "./service";

/**
 * Reusable payment links (E2). A link is a saved item list anyone may open; each open mints
 * a fresh checkout session, so the one-buyer rules a session enforces still hold. The mode
 * follows the price rule: any recurring price makes it a subscription checkout, otherwise a
 * one-time purchase.
 */

export interface PaymentLinkItemInput {
  price: string; // price public id
  quantity?: number;
  /** E3: the buyer may set a quantity between these. Both absent = fixed. */
  minQuantity?: number;
  maxQuantity?: number;
  /** E3: the buyer may remove this line, or leave it out. */
  optional?: boolean;
}

export interface PaymentLinkView {
  id: string;
  name: string;
  active: boolean;
  mode: "create" | "purchase";
  showOnPricingPage: boolean;
  redirectUrl: string | null;
  cancelUrl: string | null;
  url: string | null;
  items: Array<{
    price: string;
    quantity: number;
    minQuantity: number | null;
    maxQuantity: number | null;
    optional: boolean;
  }>;
  /** Checkouts opened from this link, and how many completed. */
  opens: number;
  completions: number;
  createdAt: Date;
}

const linkUrl = (id: string) => {
  const base = config.PORTAL_BASE_URL?.replace(/\/$/, "");
  return base ? `${base}/buy/${id}` : null;
};

function checkUrl(field: string, url: string | undefined | null) {
  if (url == null) return;
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:"))
    throw new CheckoutError(`${field} must be an http(s) URL`);
}

/** Subscription if any price recurs, else a one-time purchase. */
function modeOf(rows: Array<{ type: string }>): "create" | "purchase" {
  return rows.some((r) => r.type === "recurring") ? "create" : "purchase";
}

export async function createPaymentLink(input: {
  organizationId: string;
  businessId: string;
  name: string;
  items: PaymentLinkItemInput[];
  showOnPricingPage?: boolean;
  redirectUrl?: string;
  cancelUrl?: string;
}): Promise<PaymentLinkView> {
  const name = input.name.trim();
  if (!name) throw new CheckoutError("A payment link needs a name");
  if (input.items.length === 0) throw new CheckoutError("A payment link needs at least one item");
  checkUrl("redirect_url", input.redirectUrl);
  checkUrl("cancel_url", input.cancelUrl);
  const dupe = input.items.map((i) => i.price).find((p, i, all) => all.indexOf(p) !== i);
  if (dupe) throw new CheckoutError(`The payment link has the same price two times: ${dupe}`);

  const resolved: Array<{
    price: typeof prices.$inferSelect;
    kind: string;
    item: PaymentLinkItemInput;
  }> = [];
  for (const item of input.items) {
    const price = await getPriceByPublicId(input.organizationId, input.businessId, item.price);
    if (!price) throw new CheckoutError(`No such price: ${item.price}`);
    if (price.active === false) throw new CheckoutError(`Price ${item.price} is archived`);
    const quantity = item.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 0)
      throw new CheckoutError(`The quantity for ${item.price} must be a whole number`);
    const { minQuantity: min, maxQuantity: max } = item;
    if (min != null && (!Number.isInteger(min) || min < 0))
      throw new CheckoutError(`min_quantity for ${item.price} must be a whole number`);
    if (max != null && (!Number.isInteger(max) || max < 1))
      throw new CheckoutError(`max_quantity for ${item.price} must be 1 or more`);
    if (min != null && max != null && min > max)
      throw new CheckoutError(`min_quantity for ${item.price} is more than max_quantity`);
    if ((min != null && quantity < min) || (max != null && quantity > max))
      throw new CheckoutError(`The quantity for ${item.price} is outside its limits`);
    // A flat price is one fixed amount whatever the quantity, so "2 ×" would charge for one.
    if (price.model === "flat" && (quantity > 1 || min != null || max != null))
      throw new CheckoutError(
        `${item.price} has a flat price, so its quantity cannot change. To sell more than one, use a per-unit price.`,
      );
    // A line the buyer can neither remove nor buy any of is not a line.
    if (quantity === 0 && !item.optional && (max == null || max === 0))
      throw new CheckoutError(`The quantity for ${item.price} must be 1 or more`);
    const [prod] = await withTenant(input.organizationId, (tx) =>
      tx
        .select({ kind: products.kind, metadata: products.metadata })
        .from(products)
        .where(eq(products.id, price.productId)),
    );
    if (isDisplayOnly(prod?.metadata))
      throw new CheckoutError(
        `${item.price} is shown on the pricing page only. It cannot be sold through a payment link.`,
      );
    resolved.push({ price, kind: prod?.kind ?? "plan", item });
  }
  if (resolved.every((r) => (r.item.quantity ?? 1) === 0))
    throw new CheckoutError("At least one item needs a quantity of 1 or more");
  const currencies = [...new Set(resolved.map((r) => r.price.currency))];
  if (currencies.length > 1)
    throw new CheckoutError(
      `All items must use one currency. The items use: ${currencies.join(", ")}.`,
    );
  const mode = modeOf(resolved.map((r) => r.price));
  // A subscription is built on one plan; recurring add-ons alone cannot start one.
  if (mode === "create" && resolved.filter((r) => r.kind === "plan").length !== 1)
    throw new CheckoutError("A payment link with a recurring price needs exactly one plan");
  if (mode === "create" && resolved.some((r) => r.kind === "plan" && r.item.optional))
    throw new CheckoutError("The plan cannot be optional");

  const id = publicId("plink");
  await withTenant(input.organizationId, async (tx) => {
    const [link] = await tx
      .insert(paymentLinks)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        publicId: id,
        name,
        showOnPricingPage: input.showOnPricingPage ?? false,
        redirectUrl: input.redirectUrl ?? null,
        cancelUrl: input.cancelUrl ?? null,
      })
      .returning({ id: paymentLinks.id });
    await tx.insert(paymentLinkItems).values(
      resolved.map((r, position) => ({
        organizationId: input.organizationId,
        businessId: input.businessId,
        paymentLinkId: link!.id,
        priceId: r.price.id,
        quantity: r.item.quantity ?? 1,
        minQuantity: r.item.minQuantity ?? null,
        maxQuantity: r.item.maxQuantity ?? null,
        optional: r.item.optional ?? false,
        position,
      })),
    );
  });
  return (await getPaymentLink(input.organizationId, input.businessId, id))!;
}

async function viewsFor(
  organizationId: string,
  links: Array<typeof paymentLinks.$inferSelect>,
): Promise<PaymentLinkView[]> {
  if (links.length === 0) return [];
  const ids = links.map((l) => l.id);
  return withTenant(organizationId, async (tx) => {
    const items = await tx
      .select({
        linkId: paymentLinkItems.paymentLinkId,
        price: prices.publicId,
        type: prices.type,
        quantity: paymentLinkItems.quantity,
        minQuantity: paymentLinkItems.minQuantity,
        maxQuantity: paymentLinkItems.maxQuantity,
        optional: paymentLinkItems.optional,
        position: paymentLinkItems.position,
      })
      .from(paymentLinkItems)
      .innerJoin(prices, eq(prices.id, paymentLinkItems.priceId))
      .where(inArray(paymentLinkItems.paymentLinkId, ids))
      .orderBy(paymentLinkItems.position);
    const opens = await tx
      .select({ linkId: checkoutSessions.paymentLinkId, n: count() })
      .from(checkoutSessions)
      .where(inArray(checkoutSessions.paymentLinkId, ids))
      .groupBy(checkoutSessions.paymentLinkId);
    const done = await tx
      .select({ linkId: checkoutSessions.paymentLinkId, n: count() })
      .from(checkoutSessions)
      .where(
        and(inArray(checkoutSessions.paymentLinkId, ids), isNotNull(checkoutSessions.completedAt)),
      )
      .groupBy(checkoutSessions.paymentLinkId);
    return links.map((l) => {
      const mine = items.filter((i) => i.linkId === l.id);
      return {
        id: l.publicId,
        name: l.name,
        active: l.active,
        mode: modeOf(mine),
        showOnPricingPage: l.showOnPricingPage,
        redirectUrl: l.redirectUrl,
        cancelUrl: l.cancelUrl,
        url: linkUrl(l.publicId),
        items: mine.map((i) => ({
          price: i.price,
          quantity: i.quantity,
          minQuantity: i.minQuantity,
          maxQuantity: i.maxQuantity,
          optional: i.optional,
        })),
        opens: Number(opens.find((o) => o.linkId === l.id)?.n ?? 0),
        completions: Number(done.find((o) => o.linkId === l.id)?.n ?? 0),
        createdAt: l.createdAt,
      };
    });
  });
}

export async function getPaymentLink(
  organizationId: string,
  businessId: string,
  linkPublicId: string,
): Promise<PaymentLinkView | null> {
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(paymentLinks)
      .where(and(eq(paymentLinks.businessId, businessId), eq(paymentLinks.publicId, linkPublicId)))
      .limit(1),
  );
  if (!row) return null;
  return (await viewsFor(organizationId, [row]))[0] ?? null;
}

/** Newest first. `product` narrows to links that sell any price of that product. */
export async function listPaymentLinks(input: {
  organizationId: string;
  businessId: string;
  productId?: string;
  includeArchived?: boolean;
}): Promise<PaymentLinkView[]> {
  const rows = await withTenant(input.organizationId, async (tx) => {
    const where = [eq(paymentLinks.businessId, input.businessId)];
    if (!input.includeArchived) where.push(eq(paymentLinks.active, true));
    if (input.productId) {
      const linked = tx
        .select({ id: paymentLinkItems.paymentLinkId })
        .from(paymentLinkItems)
        .innerJoin(prices, eq(prices.id, paymentLinkItems.priceId))
        .where(eq(prices.productId, input.productId));
      where.push(inArray(paymentLinks.id, linked));
    }
    return tx
      .select()
      .from(paymentLinks)
      .where(and(...where))
      .orderBy(desc(paymentLinks.createdAt))
      .limit(200);
  });
  return viewsFor(input.organizationId, rows);
}

export async function updatePaymentLink(input: {
  organizationId: string;
  businessId: string;
  linkPublicId: string;
  name?: string;
  active?: boolean;
  showOnPricingPage?: boolean;
  redirectUrl?: string | null;
  cancelUrl?: string | null;
}): Promise<PaymentLinkView | null> {
  checkUrl("redirect_url", input.redirectUrl);
  checkUrl("cancel_url", input.cancelUrl);
  if (input.name !== undefined && !input.name.trim())
    throw new CheckoutError("A payment link needs a name");
  const set: Partial<typeof paymentLinks.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) set.name = input.name.trim();
  if (input.active !== undefined) set.active = input.active;
  if (input.showOnPricingPage !== undefined) set.showOnPricingPage = input.showOnPricingPage;
  if (input.redirectUrl !== undefined) set.redirectUrl = input.redirectUrl;
  if (input.cancelUrl !== undefined) set.cancelUrl = input.cancelUrl;
  const updated = await withTenant(input.organizationId, (tx) =>
    tx
      .update(paymentLinks)
      .set(set)
      .where(
        and(
          eq(paymentLinks.businessId, input.businessId),
          eq(paymentLinks.publicId, input.linkPublicId),
        ),
      )
      .returning({ id: paymentLinks.id }),
  );
  if (updated.length === 0) return null;
  return getPaymentLink(input.organizationId, input.businessId, input.linkPublicId);
}

/**
 * A visitor opens a link: mint them their own checkout session. Cross-org on `systemDb`
 * because the org is not known until the public id resolves — the same reason the checkout
 * token resolver uses it. Null when the link is unknown or archived.
 */
export async function openPaymentLink(linkPublicId: string): Promise<CheckoutSessionRef | null> {
  const [link] = await systemDb
    .select()
    .from(paymentLinks)
    .where(and(eq(paymentLinks.publicId, linkPublicId), eq(paymentLinks.active, true)))
    .limit(1);
  if (!link) return null;
  const items = await systemDb
    .select({
      price: prices.publicId,
      type: prices.type,
      quantity: paymentLinkItems.quantity,
    })
    .from(paymentLinkItems)
    .innerJoin(prices, eq(prices.id, paymentLinkItems.priceId))
    .where(eq(paymentLinkItems.paymentLinkId, link.id))
    .orderBy(paymentLinkItems.position);
  // Optional lines that start at zero are offered on the page, not sold by default (E3).
  const lines = items.filter((i) => i.quantity > 0);
  return createCheckoutSession({
    organizationId: link.organizationId,
    businessId: link.businessId,
    items: lines.map((i) => ({ price: i.price, quantity: i.quantity })),
    mode: modeOf(items),
    ...(link.redirectUrl ? { redirectUrl: link.redirectUrl } : {}),
    ...(link.cancelUrl ? { cancelUrl: link.cancelUrl } : {}),
    paymentLinkId: link.id,
    createdBy: link.publicId,
  });
}

export interface PricingPageView {
  business: {
    name: string;
    livemode: string;
    logoUrl: string | null;
    brandColor: string | null;
  };
  links: Array<{
    id: string;
    name: string;
    mode: "create" | "purchase";
    /** The plan or first item's own description, for the card body. */
    description: string | null;
    /** That product's picture, or null. */
    imageUrl: string | null;
    price: {
      amount: string;
      currency: string;
      amountMinor: number | null;
      interval: string | null;
      intervalCount: number;
    };
  }>;
  /**
   * Plans shown with no checkout (`isDisplayOnly`): one per active price. The page links them to
   * the business's own sign-up, not to a checkout.
   */
  displayPlans: Array<{
    name: string;
    description: string | null;
    currency: string;
    amountMinor: number | null;
    interval: string | null;
    /** The price's `metadata.volume_limit_minor`: how much the plan covers a month. */
    limitMinor: number | null;
  }>;
}

/** The public pricing page: a business's active links marked for it. Null for an unknown business. */
export async function getPricingPage(businessPublicId: string): Promise<PricingPageView | null> {
  const [biz] = await systemDb
    .select()
    .from(businesses)
    .where(eq(businesses.publicId, businessPublicId))
    .limit(1);
  if (!biz) return null;
  const links = await systemDb
    .select()
    .from(paymentLinks)
    .where(
      and(
        eq(paymentLinks.businessId, biz.id),
        eq(paymentLinks.active, true),
        eq(paymentLinks.showOnPricingPage, true),
      ),
    )
    .orderBy(paymentLinks.createdAt);
  const out: PricingPageView["links"] = [];
  for (const l of links) {
    const rows = await systemDb
      .select({ price: prices, kind: products.kind, product: products })
      .from(paymentLinkItems)
      .innerJoin(prices, eq(prices.id, paymentLinkItems.priceId))
      .innerJoin(products, eq(products.id, prices.productId))
      .where(eq(paymentLinkItems.paymentLinkId, l.id))
      .orderBy(paymentLinkItems.position);
    // The card shows what the link is FOR: its plan, else its first line.
    const lead = rows.find((r) => r.kind === "plan") ?? rows[0];
    if (!lead) continue;
    out.push({
      id: l.publicId,
      name: l.name,
      mode: modeOf(rows.map((r) => r.price)),
      description: lead.product.description ?? lead.price.description ?? null,
      imageUrl: lead.product.imageUrl,
      price: {
        amount:
          lead.price.amountMinor != null
            ? formatMoney(lead.price.amountMinor, lead.price.currency)
            : lead.price.currency,
        // Machine-readable beside the display string, for a page that groups or converts.
        currency: lead.price.currency,
        amountMinor: lead.price.amountMinor == null ? null : Number(lead.price.amountMinor),
        interval: lead.price.type === "recurring" ? lead.price.interval : null,
        intervalCount: lead.price.intervalCount,
      },
    });
  }
  const shown = await systemDb
    .select({ price: prices, product: products })
    .from(prices)
    .innerJoin(products, eq(products.id, prices.productId))
    .where(
      and(
        eq(prices.businessId, biz.id),
        eq(prices.active, true),
        eq(products.active, true),
        sql`${products.metadata}->>'pricing_page' = 'display_only'`,
      ),
    )
    .orderBy(prices.createdAt);
  return {
    business: {
      name: biz.name,
      livemode: biz.livemode,
      logoUrl: biz.logoUrl,
      brandColor: biz.brandColor,
    },
    links: out,
    displayPlans: shown.map(({ price, product }) => {
      const limit = (price.metadata as { volume_limit_minor?: unknown } | null)?.volume_limit_minor;
      return {
        name: price.externalName ?? product.name,
        description: price.description ?? product.description ?? null,
        currency: price.currency,
        amountMinor: price.amountMinor == null ? null : Number(price.amountMinor),
        interval: price.type === "recurring" ? price.interval : null,
        limitMinor: limit != null && Number.isFinite(Number(limit)) ? Number(limit) : null,
      };
    }),
  };
}
