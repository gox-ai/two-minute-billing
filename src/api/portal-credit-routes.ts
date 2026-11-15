/**
 * Portal credits (design G3 §7): the buyer's balance per unit, grants with expiry, the last 50
 * transactions, and "Buy credits" — the business's active pack prices, opened as the purchase
 * checkout pinned to this customer, inside the top-up limits.
 */
import { grantRenewsAt } from "@/modules/credits/balance";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { businessWallClock } from "@/platform/clock";
import { authenticatePortal } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { withTenant } from "@/platform/db";
import {
  businesses,
  creditAutoTopups,
  creditGrantMovements,
  creditGrants,
  creditUnits,
  customers,
  invoices,
  paymentMethods,
  prices,
  products,
  type PriceGrantsCredit,
} from "@db/schema";
import { liveBalance, liveAt } from "@/modules/credits/balance";
import {
  addCheckoutCoupon,
  assertCouponUsableAtCheckout,
  CheckoutError,
  createCheckoutSession,
  resolveCheckoutSession,
} from "@/modules/checkout/service";
import { packAwareLineAmount } from "@/modules/catalog/pricing";
import {
  AutoTopupError,
  autoTopupCanCharge,
  portalUnitTopups,
  setAutoTopupStatus,
} from "@/modules/usage-controls/auto-topup";
import { CouponError } from "@/modules/coupons/service";
import { previewInvoiceFromLines } from "@/modules/invoicing/service";
import { config } from "@/platform/config";
import { AUTH_WINDOW_MS } from "@/platform/rate-limit";
import type { FastifyReply, FastifyRequest } from "fastify";
import { badRequest, notFound, refusedByRateLimit } from "./helpers";
import { LIMITS } from "./limits";
import { parseRequest } from "./strict-params";

const purchaseBody = z.object({
  price: z.string().min(1).max(100),
  quantity: z.number().int().min(1).max(1000).optional(),
  /** A code the buyer typed. Needs `allow_customer_coupons`. */
  coupon: z.string().trim().min(1).max(LIMITS.code).optional(),
});

type PortalCtx = NonNullable<FastifyRequest["portalSession"]>;

const couponRefusal = (reply: FastifyReply, message: string) =>
  reply.code(400).send({ error: { type: "invalid_request_error", message } });

/**
 * Price one pack purchase as the invoice will raise it, with the buyer's coupon: the
 * checkout's coupon checks, then the invoice preview (per-buyer limit, currency, item match).
 * Null = no such pack. A refusal throws `CheckoutError` or `CouponError`.
 */
async function quotePack(ctx: PortalCtx, pricePublicId: string, quantity: number, coupon?: string) {
  const price = await withTenant(ctx.organizationId, async (tx) => {
    const [p] = await tx
      .select({
        price: prices,
        name: sql<string>`coalesce(${prices.externalName}, ${products.name})`,
      })
      .from(prices)
      .innerJoin(products, eq(products.id, prices.productId))
      .where(and(eq(prices.businessId, ctx.businessId), eq(prices.publicId, pricePublicId)))
      .limit(1);
    return p && p.price.active && p.price.grantsCredit?.kind === "pack" ? p : null;
  });
  if (!price) return null;
  const currency = price.price.currency;
  if (coupon)
    await assertCouponUsableAtCheckout({
      organizationId: ctx.organizationId,
      businessId: ctx.businessId,
      code: coupon,
      currency,
      customerId: ctx.customerId,
      items: { priceIds: [price.price.id], addonsMayFollow: false },
    });
  // The line the purchase checkout raises.
  const amountMinor = packAwareLineAmount(price.price, quantity);
  const p = await previewInvoiceFromLines({
    organizationId: ctx.organizationId,
    businessId: ctx.businessId,
    customerId: ctx.customerId,
    currency,
    lines: [
      { description: price.name, amountMinor, priceId: price.price.id, quantity, kind: "one_time" },
    ],
    ...(coupon ? { coupons: [coupon] } : {}),
  });
  return { currency, amountMinor, preview: p };
}

/** The buyer's coupon gates: the business allows entry, and tries are rate limited. */
async function refuseCouponEntry(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: PortalCtx,
): Promise<boolean> {
  const [biz] = await withTenant(ctx.organizationId, (tx) =>
    tx
      .select({ allowed: businesses.allowCustomerCoupons })
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId))
      .limit(1),
  );
  if (!biz?.allowed) {
    reply.code(403).send({
      error: {
        type: "invalid_request_error",
        message: "This account does not accept coupon codes",
      },
    });
    return true;
  }
  return refusedByRateLimit(
    req,
    reply,
    {
      scope: "portal_credit_coupon",
      keys: [
        {
          kind: "resource",
          value: ctx.customerId,
          limit: config.RATE_LIMIT_COUPON_TRIES_PER_SESSION,
        },
        { kind: "ip", value: req.ip, limit: config.RATE_LIMIT_COUPON_TRIES_PER_IP },
      ],
      windowMs: AUTH_WINDOW_MS,
    },
    "You tried too many coupon codes. Wait 15 minutes and try again.",
  );
}

type Unit = {
  key: string;
  name: string;
  pluralName: string;
  decimals: number;
  minorPerUnitE12: bigint | null;
};

const autoTopupSwitchBody = z.object({
  unit: z.string().min(1).max(100),
  enabled: z.boolean(),
});

const NO_PAYMENT_METHOD =
  "We could not enable automatic top-up. You have no payment method that we can charge. Add a payment method, then try again.";

/**
 * Per unit of the buyer's automatic top-ups: the packs one run buys, and whether a run has a
 * payment method to charge (`autoTopupCanCharge`, the rule that Enable uses).
 */
async function topupFacts(
  ctx: PortalCtx,
): Promise<Map<string, { packQuantity: number; hasPaymentMethod: boolean }>> {
  const rows = await withTenant(ctx.organizationId, (tx) =>
    tx
      .select({
        unit: creditUnits.key,
        quantity: creditAutoTopups.packQuantity,
        currency: creditAutoTopups.currency,
        pinned: creditAutoTopups.paymentMethodId,
        pinnedStatus: paymentMethods.status,
      })
      .from(creditAutoTopups)
      .innerJoin(creditUnits, eq(creditUnits.id, creditAutoTopups.unitId))
      .leftJoin(paymentMethods, eq(paymentMethods.id, creditAutoTopups.paymentMethodId))
      .where(eq(creditAutoTopups.customerId, ctx.customerId)),
  );
  const out = new Map<string, { packQuantity: number; hasPaymentMethod: boolean }>();
  for (const r of rows)
    out.set(r.unit, {
      packQuantity: r.quantity ?? 1,
      hasPaymentMethod: await autoTopupCanCharge(
        ctx.organizationId,
        ctx.customerId,
        r.pinned,
        r.currency,
      ),
    });
  return out;
}

/** The portal's top-up rows with `pack_quantity` and `has_payment_method` added. */
async function withTopupFacts<T extends { unit: string }>(ctx: PortalCtx, rows: T[]) {
  const facts = rows.length ? await topupFacts(ctx) : new Map();
  return rows.map((t) => {
    const f = facts.get(t.unit);
    return {
      ...t,
      /** Packs one run buys: 1 for a target top-up. */
      pack_quantity: f?.packQuantity ?? 1,
      /** False: a run has no payment method that we can charge. */
      has_payment_method: f?.hasPaymentMethod ?? false,
    };
  });
}

export async function registerPortalCreditRoutes(app: FastifyInstance) {
  app.get("/portal/v1/credits", { preHandler: authenticatePortal }, async (req) => {
    const ctx = req.portalSession!;
    const out = await withTenant(ctx.organizationId, async (tx) => {
      const [row] = await tx
        .select({
          cfg: businesses.creditConfig,
          allowCoupons: businesses.allowCustomerCoupons,
          bizCurrency: businesses.defaultCurrency,
          custCurrency: customers.currency,
          settings: customers.creditSettings,
        })
        .from(customers)
        .innerJoin(businesses, eq(businesses.id, customers.businessId))
        .where(eq(customers.id, ctx.customerId))
        .limit(1);
      const unitRows = await tx
        .select()
        .from(creditUnits)
        .where(eq(creditUnits.businessId, ctx.businessId));
      const unitById = new Map<string, Unit>(unitRows.map((u) => [u.id, u]));
      const unitByKey = new Map<string, Unit>(unitRows.map((u) => [u.key, u]));
      const unitView = (u: Unit | undefined, currency: string) => ({
        unit: u?.key ?? null,
        name: u?.name ?? currency,
        plural_name: u?.pluralName ?? currency,
        decimals: u?.decimals ?? 0,
        // False = the unit has no money value: its credits are not part of the money figure.
        rated: u ? u.minorPerUnitE12 != null : true,
      });

      const curRows = await tx
        .selectDistinct({ currency: creditGrants.currency })
        .from(creditGrants)
        .where(and(eq(creditGrants.customerId, ctx.customerId), eq(creditGrants.status, "active")));
      const currencies = [
        ...new Set(
          [...curRows.map((r) => r.currency), row?.custCurrency ?? row?.bizCurrency ?? null].filter(
            (c): c is string => !!c,
          ),
        ),
      ];
      const now = await businessWallClock(ctx.businessId);
      const balances = [];
      const grants = [];
      for (const currency of currencies) {
        const bal = await liveBalance(tx, {
          customerId: ctx.customerId,
          currency,
          now,
          businessConfig: row?.cfg ?? null,
          customerSettings: row?.settings ?? null,
        });
        const renews = bal.grants
          .filter((g) => liveAt(g, now))
          .map(grantRenewsAt)
          .filter((d): d is string => !!d)
          .sort()[0];
        balances.push({
          currency,
          renews_at: renews ?? null,
          balance_minor: Number(bal.balanceMinor),
          available_minor: Number(bal.availableMinor),
          units: bal.availableUnits.map((u) => ({
            ...unitView(unitByKey.get(u.unit), currency),
            available_amount: Number(u.units),
            // A unit with no money rate: reserved by open holds, and used but not settled yet.
            ...(u.heldUnits !== undefined
              ? {
                  held_amount: Number(u.heldUnits),
                  unsettled_amount: Number(u.unsettledUnits ?? 0n),
                }
              : {}),
          })),
        });
        for (const g of bal.grants) {
          // By units, not face: a grant in a unit with no rate has no face.
          if (!liveAt(g, now) || g.unitsLeft <= 0n) continue;
          const u = g.unitId ? unitById.get(g.unitId) : undefined;
          const v = unitView(u, currency);
          grants.push({
            id: g.publicId,
            currency,
            unit: v.unit,
            unit_name: v.name,
            unit_plural_name: v.plural_name,
            decimals: v.decimals,
            unit_rated: v.rated,
            remaining_amount: Number(g.unitsLeft),
            remaining_face_minor: Number(g.faceLeft),
            category: g.category,
            expires_at: g.expiresAt?.toISOString() ?? null,
            renews_at: grantRenewsAt(g),
          });
        }
      }

      const moves = await tx
        .select({
          id: creditGrantMovements.publicId,
          kind: creditGrantMovements.kind,
          currency: creditGrants.currency,
          face: creditGrantMovements.faceMinor,
          units: creditGrantMovements.units,
          unitId: creditGrants.unitId,
          createdAt: creditGrantMovements.createdAt,
          invoiceNumber: invoices.number,
          settlementId: creditGrantMovements.settlementId,
        })
        .from(creditGrantMovements)
        .innerJoin(creditGrants, eq(creditGrants.id, creditGrantMovements.grantId))
        .leftJoin(invoices, eq(invoices.id, creditGrantMovements.invoiceId))
        // Every unit: a movement of a unit with no rate has units and no money (face 0).
        .where(eq(creditGrantMovements.customerId, ctx.customerId))
        .orderBy(desc(creditGrantMovements.createdAt), desc(creditGrantMovements.id))
        .limit(50);

      const packRows = await tx
        .select({
          publicId: prices.publicId,
          name: sql<string>`coalesce(${prices.externalName}, ${products.name})`,
          currency: prices.currency,
          amountMinor: prices.amountMinor,
          gc: prices.grantsCredit,
        })
        .from(prices)
        .innerJoin(products, eq(products.id, prices.productId))
        .where(
          and(
            eq(prices.businessId, ctx.businessId),
            eq(prices.active, true),
            eq(products.active, true),
            // Only what Buy can sell: a one-time price, not a plan's.
            eq(prices.type, "one_time"),
            ne(products.kind, "plan"),
            sql`${prices.grantsCredit}->>'kind' = 'pack'`,
          ),
        );
      return {
        object: "portal_credits",
        balances,
        grants,
        // Only when the business lets the buyer manage automatic top-up (default: off).
        auto_topups:
          row?.cfg?.portal_auto_topup === true ? await portalUnitTopups(tx, ctx.customerId) : [],
        transactions: moves.map((m) => {
          const v = unitView(m.unitId ? unitById.get(m.unitId) : undefined, m.currency);
          return {
            id: m.id,
            kind: m.kind,
            currency: m.currency,
            face_minor: Number(m.face),
            // The movement in the unit's smallest step (money: minor units), signed.
            units: Number(m.units),
            unit: v.unit,
            unit_name: v.name,
            unit_plural_name: v.plural_name,
            decimals: v.decimals,
            unit_rated: v.rated,
            created_at: m.createdAt.toISOString(),
            invoice_number: m.invoiceNumber ?? null,
            // A draw made by a usage settlement: it has no invoice.
            for_usage: m.settlementId != null,
          };
        }),
        packs: packRows.map((p) => {
          const gc = p.gc as Extract<PriceGrantsCredit, { kind: "pack" }>;
          const v = unitView(gc.unit ? unitByKey.get(gc.unit) : undefined, p.currency);
          return {
            price: p.publicId,
            name: p.name,
            currency: p.currency,
            amount_minor: Number(p.amountMinor ?? 0),
            unit: v.unit,
            unit_name: v.name,
            unit_plural_name: v.plural_name,
            decimals: v.decimals,
            credit_amount: gc.amount,
          };
        }),
        top_up_limits: row?.cfg?.top_up_limits ?? {},
        /** The buyer may enter a coupon code on Buy. */
        allow_coupons: row?.allowCoupons === true,
      };
    });
    return { ...out, auto_topups: await withTopupFacts(ctx, out.auto_topups) };
  });

  /** What one pack purchase costs, with the buyer's coupon: shown before they pay. */
  // The buyer turns an automatic top-up of a unit with no rate on or off. The operator sets
  // what it buys; the business's `credit_config.portal_auto_topup` allows the switch.
  app.post(
    "/portal/v1/credits/auto_topup",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const parsed = parseRequest(autoTopupSwitchBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const [row] = await withTenant(ctx.organizationId, (tx) =>
        tx
          .select({ cfg: businesses.creditConfig, customer: customers.publicId })
          .from(customers)
          .innerJoin(businesses, eq(businesses.id, customers.businessId))
          .where(eq(customers.id, ctx.customerId))
          .limit(1),
      );
      if (!row || row.cfg?.portal_auto_topup !== true)
        return reply.code(403).send({
          error: {
            type: "invalid_request_error",
            message: "You cannot change automatic top-up here. Contact this business.",
          },
        });
      // Our words for the buyer: the engine's refusal speaks of "the customer".
      const facts = parsed.data.enabled ? (await topupFacts(ctx)).get(parsed.data.unit) : null;
      if (facts?.hasPaymentMethod === false) return badRequest(reply, NO_PAYMENT_METHOD);
      try {
        await setAutoTopupStatus({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          customerPublicId: row.customer,
          unitKey: parsed.data.unit,
          status: parsed.data.enabled ? "active" : "disabled",
          reason: "customer",
        });
      } catch (e) {
        if (e instanceof AutoTopupError)
          return e.status === 404 ? notFound(reply, e.message) : badRequest(reply, e.message);
        throw e;
      }
      const [mine] = await withTopupFacts(
        ctx,
        (await withTenant(ctx.organizationId, (tx) => portalUnitTopups(tx, ctx.customerId))).filter(
          (t) => t.unit === parsed.data.unit,
        ),
      );
      return { object: "portal_auto_topup", ...mine };
    },
  );

  app.post("/portal/v1/credits/quote", { preHandler: authenticatePortal }, async (req, reply) => {
    const ctx = req.portalSession!;
    const parsed = parseRequest(purchaseBody, req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { price, quantity = 1, coupon } = parsed.data;
    if (coupon && (await refuseCouponEntry(req, reply, ctx))) return;
    try {
      const q = await quotePack(ctx, price, quantity, coupon);
      if (!q) return notFound(reply, `No such credit pack: ${price}`);
      const p = q.preview;
      return {
        object: "credit_pack_quote",
        price,
        quantity,
        currency: q.currency,
        coupon: coupon ?? null,
        subtotal_minor: Number(q.amountMinor),
        discount_minor: Number(p.discountMinor),
        tax_minor: Number(p.taxMinor),
        total_minor: Number(p.totalMinor),
        amount_due_minor: Number(p.amountDueMinor),
      };
    } catch (e) {
      if (e instanceof CheckoutError || e instanceof CouponError)
        return couponRefusal(reply, e.message);
      throw e;
    }
  });

  app.post(
    "/portal/v1/credits/purchase",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const parsed = parseRequest(purchaseBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { coupon } = parsed.data;
      const quantity = parsed.data.quantity ?? 1;
      if (coupon && (await refuseCouponEntry(req, reply, ctx))) return;
      try {
        // The same checks as the quote, so a code that priced there opens the same checkout.
        if (!(await quotePack(ctx, parsed.data.price, quantity, coupon)))
          return notFound(reply, `No such credit pack: ${parsed.data.price}`);
        const [c] = await withTenant(ctx.organizationId, (tx) =>
          tx
            .select({ publicId: customers.publicId })
            .from(customers)
            .where(eq(customers.id, ctx.customerId))
            .limit(1),
        );
        const ref = await createCheckoutSession({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          mode: "purchase",
          priceId: parsed.data.price,
          quantity,
          customerId: c!.publicId,
        });
        // Entered as on the checkout page: it counts toward the buyer's cap there.
        if (coupon) {
          const session = await resolveCheckoutSession(ref.token);
          if (!session) throw new CheckoutError("We could not open the checkout. Try again.");
          await addCheckoutCoupon(session, coupon);
        }
        if (!ref.url)
          return reply.code(503).send({
            error: {
              type: "api_error",
              message: "We could not open the checkout. The checkout address is not configured.",
            },
          });
        return { url: ref.url };
      } catch (e) {
        if (e instanceof CouponError) return couponRefusal(reply, e.message);
        if (e instanceof CheckoutError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );
}
