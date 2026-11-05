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
  creditGrantMovements,
  creditGrants,
  creditUnits,
  customers,
  invoices,
  prices,
  products,
  type PriceGrantsCredit,
} from "@db/schema";
import { liveBalance, liveAt } from "@/modules/credits/balance";
import { CheckoutError, createCheckoutSession } from "@/modules/checkout/service";
import { badRequest, notFound } from "./helpers";
import { parseRequest } from "./strict-params";

const purchaseBody = z.object({
  price: z.string().min(1).max(100),
  quantity: z.number().int().min(1).max(1000).optional(),
});

type Unit = { key: string; name: string; pluralName: string; decimals: number };

export async function registerPortalCreditRoutes(app: FastifyInstance) {
  app.get("/portal/v1/credits", { preHandler: authenticatePortal }, async (req) => {
    const ctx = req.portalSession!;
    return withTenant(ctx.organizationId, async (tx) => {
      const [row] = await tx
        .select({
          cfg: businesses.creditConfig,
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
          })),
        });
        for (const g of bal.grants) {
          if (!liveAt(g, now) || g.faceLeft <= 0n) continue;
          const u = g.unitId ? unitById.get(g.unitId) : undefined;
          const v = unitView(u, currency);
          grants.push({
            id: g.publicId,
            currency,
            unit: v.unit,
            unit_name: v.name,
            unit_plural_name: v.plural_name,
            decimals: v.decimals,
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
          createdAt: creditGrantMovements.createdAt,
          invoiceNumber: invoices.number,
        })
        .from(creditGrantMovements)
        .innerJoin(creditGrants, eq(creditGrants.id, creditGrantMovements.grantId))
        .leftJoin(invoices, eq(invoices.id, creditGrantMovements.invoiceId))
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
        transactions: moves.map((m) => ({
          id: m.id,
          kind: m.kind,
          currency: m.currency,
          face_minor: Number(m.face),
          created_at: m.createdAt.toISOString(),
          invoice_number: m.invoiceNumber ?? null,
        })),
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
      };
    });
  });

  app.post(
    "/portal/v1/credits/purchase",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const parsed = parseRequest(purchaseBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const pack = await withTenant(ctx.organizationId, async (tx) => {
        const [p] = await tx
          .select({ id: prices.id, gc: prices.grantsCredit, active: prices.active })
          .from(prices)
          .where(and(eq(prices.businessId, ctx.businessId), eq(prices.publicId, parsed.data.price)))
          .limit(1);
        const [c] = await tx
          .select({ publicId: customers.publicId })
          .from(customers)
          .where(eq(customers.id, ctx.customerId))
          .limit(1);
        return p && p.active && p.gc?.kind === "pack" ? { customer: c!.publicId } : null;
      });
      if (!pack) return notFound(reply, `No such credit pack: ${parsed.data.price}`);
      try {
        const ref = await createCheckoutSession({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          mode: "purchase",
          priceId: parsed.data.price,
          quantity: parsed.data.quantity ?? 1,
          customerId: pack.customer,
        });
        if (!ref.url)
          return reply.code(503).send({
            error: {
              type: "api_error",
              message: "We could not open the checkout. The checkout address is not configured.",
            },
          });
        return { url: ref.url };
      } catch (e) {
        if (e instanceof CheckoutError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );
}
