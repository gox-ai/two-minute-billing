/**
 * Price-change preview (design G5 § 3.8): a POST-shaped read. It re-rates each customer's last
 * closed period under a draft rate card and writes nothing.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import {
  PREVIEW_PAGE_SIZE,
  RatePreviewError,
  diffBps,
  previewRateChange,
  type RateDraft,
} from "@/modules/usage-controls/rate-change-preview";
import { badRequest, notFound, requirePerm, resolveBusiness } from "./helpers";
import { parseRequest } from "./strict-params";

const meterTier = z.object({
  up_to: z.string().max(60).nullable(),
  unit_amount_decimal: z.string().max(60),
  flat_amount_minor: z.number().int().nonnegative().optional(),
});
const classicTier = z.object({
  upToMinor: z.number().int().positive().nullable(),
  unitAmountMinor: z.number().int().nonnegative().optional(),
  flatAmountMinor: z.number().int().nonnegative().optional(),
  rateBps: z.number().int().nonnegative().max(1_000_000).optional(),
});
const body = z.object({
  unit_amount_decimal: z.string().max(60).nullable().optional(),
  quantity_divisor: z
    .union([z.string().regex(/^\d{1,18}$/), z.number().int().positive()])
    .optional(),
  tiers: z.union([z.array(meterTier).min(1), z.array(classicTier).min(1)]).optional(),
  rates: z
    .array(
      z.object({
        match: z.record(z.string(), z.string().max(255)),
        unit_amount_decimal: z.string().max(60).optional(),
        tiers: z.array(meterTier).min(1).optional(),
      }),
    )
    .max(500)
    .optional(),
  amount_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(PREVIEW_PAGE_SIZE).optional(),
  starting_after: z.string().max(100).optional(),
});

export async function registerRateChangePreviewRoutes(app: FastifyInstance) {
  app.post(
    "/v1/businesses/:biz/prices/:price/rate_change_preview",
    { preHandler: [authenticate, requirePerm("usage_controls:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(body, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const d = parsed.data;
      const draft: RateDraft = {
        ...(d.unit_amount_decimal !== undefined
          ? { unitAmountDecimal: d.unit_amount_decimal }
          : {}),
        ...(d.quantity_divisor !== undefined
          ? { quantityDivisor: String(d.quantity_divisor) }
          : {}),
        ...(d.tiers !== undefined ? { tiers: d.tiers } : {}),
        ...(d.rates
          ? {
              rates: d.rates.map((r) => ({
                match: r.match,
                unitAmountDecimal: r.unit_amount_decimal ?? null,
                tiers: r.tiers,
              })),
            }
          : {}),
        ...(d.amount_minor !== undefined ? { amountMinor: d.amount_minor } : {}),
      };
      const pricePublicId = (req.params as { price: string }).price;
      let preview;
      try {
        preview = await previewRateChange({
          organizationId: req.organization!.id,
          businessId: business.id,
          pricePublicId,
          draft,
        });
      } catch (e) {
        if (!(e instanceof RatePreviewError)) throw e;
        if (e.status === 404) return notFound(reply, e.message);
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: `We could not preview the change. ${e.message}`,
            ...(e.param ? { param: e.param } : {}),
          },
        });
      }
      // Largest increase first; ties by customer id, so pages are stable.
      const rows = preview.rows
        .map((r) => ({ ...r, diff: r.newMinor - r.oldMinor }))
        .sort((a, b) =>
          a.diff === b.diff ? a.customer.localeCompare(b.customer) : a.diff > b.diff ? -1 : 1,
        );
      const start = d.starting_after
        ? rows.findIndex((r) => r.customer === d.starting_after) + 1
        : 0;
      const limit = d.limit ?? PREVIEW_PAGE_SIZE;
      const page = rows.slice(start, start + limit);
      const oldTotal = rows.reduce((a, r) => a + r.oldMinor, 0n);
      const newTotal = rows.reduce((a, r) => a + r.newMinor, 0n);
      const hasMore = start + limit < rows.length;
      return {
        object: "rate_change_preview",
        price: preview.price,
        currency: preview.currency,
        basis: "last_closed_period",
        totals: {
          customers: rows.length,
          old_minor: Number(oldTotal),
          new_minor: Number(newTotal),
          diff_minor: Number(newTotal - oldTotal),
          diff_bps: diffBps(oldTotal, newTotal),
        },
        customers_without_usage: preview.withoutUsage,
        truncated: preview.truncated,
        data: page.map((r) => ({
          customer: r.customer,
          customer_name: r.customerName,
          subscriptions: r.subscriptions,
          period_start: r.period.start?.toISOString() ?? null,
          period_end: r.period.end?.toISOString() ?? null,
          old_minor: Number(r.oldMinor),
          new_minor: Number(r.newMinor),
          diff_minor: Number(r.diff),
          diff_bps: diffBps(r.oldMinor, r.newMinor),
        })),
        has_more: hasMore,
        next_cursor: hasMore ? (page.at(-1)?.customer ?? null) : null,
      };
    },
  );
}
