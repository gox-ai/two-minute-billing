import { notPlatformOrg } from "@/modules/tenancy/platform-org";
import type { FastifyRequest } from "fastify";
import { lt, and } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { buyerRequestRejections } from "@db/schema";
import { createLogger } from "@/platform/logger";
import { getTraceId } from "@/platform/trace";

const log = createLogger("ops.buyer-rejections");

/** Rows older than this are deleted by `sweepBuyerRejections`. */
export const BUYER_REJECTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const recorded = new WeakSet<FastifyRequest>();

/** Whether this request already has its rejection row (one per refused request). */
export const buyerRejectionRecorded = (req: FastifyRequest): boolean => recorded.has(req);

/**
 * Record a refused request body when it came from a buyer surface; a no-op for every other
 * caller. Fire-and-forget: a failed write is logged and never changes the 400 the buyer gets.
 * `message` and `fields` must already be redacted.
 */
export function recordBuyerRejection(
  req: FastifyRequest | undefined,
  message: string,
  fields: Record<string, string[]>,
): void {
  const portal = req?.portalSession;
  const checkout = req?.checkoutSession;
  if (!req || (!portal && !checkout)) return;
  recorded.add(req);
  const row = {
    surface: portal ? "portal" : "checkout",
    method: req.method,
    route: req.routeOptions?.url ?? req.url.replace(/\?.*$/, ""),
    sessionPublicId: portal?.sessionPublicId ?? checkout!.sessionPublicId,
    organizationId: portal?.organizationId ?? checkout!.organizationId,
    businessId: portal?.businessId ?? checkout!.businessId,
    customerId: portal?.customerId ?? checkout?.resultingCustomerId ?? null,
    message,
    fields,
    traceId: getTraceId() ?? null,
  };
  systemDb
    .insert(buyerRequestRejections)
    .values(row)
    .catch((err: unknown) =>
      log.error("could not record buyer rejection", {
        event: "buyer_rejection_record_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
}

/** Retention. Runs as a clock pass, like the other sweeps. */
export async function sweepBuyerRejections(now: Date): Promise<{ deleted: number }> {
  const deleted = await systemDb
    .delete(buyerRequestRejections)
    .where(
      and(
        lt(
          buyerRequestRejections.createdAt,
          new Date(now.getTime() - BUYER_REJECTION_RETENTION_MS),
        ),
        notPlatformOrg(buyerRequestRejections.organizationId),
      ),
    )
    .returning({ id: buyerRequestRejections.id });
  return { deleted: deleted.length };
}
