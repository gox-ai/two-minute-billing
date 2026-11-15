import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { paymentAttempts, transactions } from "@db/schema";
import type { NormalizedProviderEvent } from "@/providers/types";

/**
 * The span of the record a gateway event is about, so the calls made while handling it join
 * that record's "Request/response logs". The attempt that holds the object's id first, then the
 * transaction. Null when nothing matches or the ids match more than one span.
 */
export async function spanForProviderEvent(
  ev: Pick<NormalizedProviderEvent, "providerIntentId" | "providerChargeId" | "gatewayIntentId">,
  businessId: string | null,
): Promise<string | null> {
  const ids = [
    ...new Set([ev.providerIntentId, ev.gatewayIntentId, ev.providerChargeId].filter(Boolean)),
  ] as string[];
  if (ids.length === 0) return null;
  const attempts = await systemDb
    .selectDistinct({ spanId: paymentAttempts.spanId })
    .from(paymentAttempts)
    .where(
      and(
        inArray(paymentAttempts.idAtGateway, ids),
        isNotNull(paymentAttempts.spanId),
        ...(businessId ? [eq(paymentAttempts.businessId, businessId)] : []),
      ),
    )
    .limit(2);
  if (attempts.length) return attempts.length === 1 ? attempts[0]!.spanId : null;
  const txns = await systemDb
    .selectDistinct({ spanId: transactions.spanId })
    .from(transactions)
    .where(
      and(
        inArray(transactions.idAtGateway, ids),
        isNotNull(transactions.spanId),
        ...(businessId ? [eq(transactions.businessId, businessId)] : []),
      ),
    )
    .limit(2);
  return txns.length === 1 ? txns[0]!.spanId : null;
}
