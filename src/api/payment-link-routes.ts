import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { config } from "@/platform/config";
import { AUTH_WINDOW_MS } from "@/platform/rate-limit";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { getProductByPublicId } from "@/modules/catalog/service";
import { CheckoutError } from "@/modules/checkout/service";
import {
  createPaymentLink,
  getPaymentLink,
  getPricingPage,
  listPaymentLinks,
  openPaymentLink,
  updatePaymentLink,
  type PaymentLinkView,
} from "@/modules/checkout/payment-links";
import { LIMITS, redirectUrl } from "./limits";
import { badRequest, notFound, refusedByRateLimit, requirePerm, resolveBusiness } from "./helpers";
import { parseRequest } from "./strict-params";

const itemBody = z.object({
  price: z.string().max(LIMITS.id).min(1),
  quantity: z.number().int().nonnegative().max(LIMITS.quantity).optional(),
  /** The buyer may choose a quantity between these (both absent = fixed). */
  min_quantity: z.number().int().nonnegative().max(LIMITS.quantity).optional(),
  max_quantity: z.number().int().positive().max(LIMITS.quantity).optional(),
  /** The buyer may remove this line, or leave it out. */
  optional: z.boolean().optional(),
});

const createBody = z.object({
  name: z.string().min(1).max(200),
  items: z.array(itemBody).min(1).max(20),
  show_on_pricing_page: z.boolean().optional(),
  redirect_url: redirectUrl().optional(),
  cancel_url: redirectUrl().optional(),
});

const updateBody = z.object({
  name: z.string().min(1).max(200).optional(),
  active: z.boolean().optional(),
  show_on_pricing_page: z.boolean().optional(),
  redirect_url: redirectUrl().nullable().optional(),
  cancel_url: redirectUrl().nullable().optional(),
});

function serialize(l: PaymentLinkView) {
  return {
    object: "payment_link",
    id: l.id,
    name: l.name,
    active: l.active,
    mode: l.mode,
    show_on_pricing_page: l.showOnPricingPage,
    redirect_url: l.redirectUrl,
    cancel_url: l.cancelUrl,
    url: l.url,
    items: l.items.map((i) => ({
      price: i.price,
      quantity: i.quantity,
      min_quantity: i.minQuantity,
      max_quantity: i.maxQuantity,
      optional: i.optional,
    })),
    opens: l.opens,
    completions: l.completions,
    created_at: l.createdAt.toISOString(),
  };
}

export async function registerPaymentLinkRoutes(app: FastifyInstance) {
  // ── Operator ─────────────────────────────────────────────────────────────────
  app.post(
    "/v1/businesses/:biz/payment_links",
    {
      preHandler: [authenticate, requirePerm("payments:collect"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const link = await createPaymentLink({
          organizationId: req.organization!.id,
          businessId: business.id,
          name: parsed.data.name,
          items: parsed.data.items.map((i) => ({
            price: i.price,
            ...(i.quantity !== undefined ? { quantity: i.quantity } : {}),
            ...(i.min_quantity !== undefined ? { minQuantity: i.min_quantity } : {}),
            ...(i.max_quantity !== undefined ? { maxQuantity: i.max_quantity } : {}),
            ...(i.optional !== undefined ? { optional: i.optional } : {}),
          })),
          ...(parsed.data.show_on_pricing_page !== undefined
            ? { showOnPricingPage: parsed.data.show_on_pricing_page }
            : {}),
          ...(parsed.data.redirect_url ? { redirectUrl: parsed.data.redirect_url } : {}),
          ...(parsed.data.cancel_url ? { cancelUrl: parsed.data.cancel_url } : {}),
        });
        return reply.code(201).send(serialize(link));
      } catch (e) {
        if (e instanceof CheckoutError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/payment_links",
    { preHandler: [authenticate, requirePerm("payments:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as { product?: string; include_archived?: string };
      let productId: string | undefined;
      if (q.product) {
        const product = await getProductByPublicId(req.organization!.id, business.id, q.product);
        if (!product) return notFound(reply, `No such product: ${q.product}`);
        productId = product.id;
      }
      const links = await listPaymentLinks({
        organizationId: req.organization!.id,
        businessId: business.id,
        ...(productId ? { productId } : {}),
        includeArchived: q.include_archived === "true",
      });
      return { object: "list", data: links.map(serialize), has_more: false };
    },
  );

  app.get(
    "/v1/businesses/:biz/payment_links/:plink",
    { preHandler: [authenticate, requirePerm("payments:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { plink } = req.params as { plink: string };
      const link = await getPaymentLink(req.organization!.id, business.id, plink);
      if (!link) return notFound(reply, `No such payment link: ${plink}`);
      return serialize(link);
    },
  );

  app.patch(
    "/v1/businesses/:biz/payment_links/:plink",
    {
      preHandler: [authenticate, requirePerm("payments:collect"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { plink } = req.params as { plink: string };
      const parsed = parseRequest(updateBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const link = await updatePaymentLink({
          organizationId: req.organization!.id,
          businessId: business.id,
          linkPublicId: plink,
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
          ...(parsed.data.show_on_pricing_page !== undefined
            ? { showOnPricingPage: parsed.data.show_on_pricing_page }
            : {}),
          ...(parsed.data.redirect_url !== undefined
            ? { redirectUrl: parsed.data.redirect_url }
            : {}),
          ...(parsed.data.cancel_url !== undefined ? { cancelUrl: parsed.data.cancel_url } : {}),
        });
        if (!link) return notFound(reply, `No such payment link: ${plink}`);
        return serialize(link);
      } catch (e) {
        if (e instanceof CheckoutError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // ── Public ───────────────────────────────────────────────────────────────────
  // No credential: the link id is published on the merchant's site. Each open mints a
  // checkout session, so it is limited per address like every other public write.
  app.post("/checkout/v1/links/:plink/open", async (req, reply) => {
    if (
      await refusedByRateLimit(req, reply, {
        scope: "payment_link_open",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_PAYMENT_LINK_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    const { plink } = req.params as { plink: string };
    try {
      const session = await openPaymentLink(plink);
      if (!session) return notFound(reply, "This payment link is not available");
      return reply.code(201).send({
        object: "checkout_session",
        id: session.publicId,
        token: session.token,
        url: session.url ?? null,
        expires_at: session.expiresAt.toISOString(),
      });
    } catch (e) {
      // A price archived or changed since the link was made: the link cannot be sold as is.
      if (e instanceof CheckoutError) return badRequest(reply, e.message);
      throw e;
    }
  });

  app.get("/checkout/v1/pricing/:biz", async (req, reply) => {
    if (
      await refusedByRateLimit(req, reply, {
        scope: "pricing_page",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_PAYMENT_LINK_PER_IP * 4 }],
        windowMs: AUTH_WINDOW_MS,
      })
    )
      return;
    const { biz } = req.params as { biz: string };
    const page = await getPricingPage(biz);
    if (!page) return notFound(reply, "This pricing page is not available");
    return {
      object: "pricing_page",
      business: {
        name: page.business.name,
        livemode: page.business.livemode,
        logo_url: page.business.logoUrl,
        brand_color: page.business.brandColor,
      },
      links: page.links.map((l) => ({
        id: l.id,
        name: l.name,
        mode: l.mode,
        description: l.description,
        image_url: l.imageUrl,
        price: {
          amount: l.price.amount,
          currency: l.price.currency,
          amount_minor: l.price.amountMinor,
          interval: l.price.interval,
          interval_count: l.price.intervalCount,
        },
      })),
      // Shown with no checkout: the business's own sign-up is the way in.
      display_plans: page.displayPlans.map((p) => ({
        name: p.name,
        description: p.description,
        currency: p.currency,
        amount_minor: p.amountMinor,
        interval: p.interval,
        limit_minor: p.limitMinor,
      })),
    };
  });
}
