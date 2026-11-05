import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { customers, paymentMethods, subscriptions } from "@db/schema";

/** Statuses that will still be charged. A scheduled cancellation is excluded below. */
const CHARGEABLE_STATUSES = ["future", "in_trial", "active", "paused"];

/**
 * Does this payment method pay for a live, auto-collected subscription? The card-expiry
 * mails say "the card we charge for your subscription", which is false for a former
 * customer's card or a spare one nothing charges.
 *
 * "Pays for" = pinned as the subscription's method, or the subscription pins none and
 * the card is in the customer's collection order (primary or backup).
 */
export async function paysForLiveSubscription(
  tx: Tx,
  businessId: string,
  paymentMethodPublicId: string,
): Promise<boolean> {
  const [pm] = await tx
    .select({
      id: paymentMethods.id,
      customerId: paymentMethods.customerId,
      role: paymentMethods.role,
    })
    .from(paymentMethods)
    .where(
      and(
        eq(paymentMethods.businessId, businessId),
        eq(paymentMethods.publicId, paymentMethodPublicId),
      ),
    )
    .limit(1);
  if (!pm) return false;
  const inCollectionOrder = pm.role !== "none";
  const rows = await tx
    .select({
      pinned: subscriptions.defaultPaymentMethodId,
      subAc: subscriptions.autoCollection,
      cusAc: customers.autoCollection,
    })
    .from(subscriptions)
    .innerJoin(customers, eq(customers.id, subscriptions.customerId))
    .where(
      and(
        eq(subscriptions.customerId, pm.customerId),
        inArray(subscriptions.status, CHARGEABLE_STATUSES),
        eq(subscriptions.cancelAtPeriodEnd, false),
        isNull(subscriptions.cancelScheduledAt),
        inCollectionOrder
          ? or(
              eq(subscriptions.defaultPaymentMethodId, pm.id),
              isNull(subscriptions.defaultPaymentMethodId),
            )
          : eq(subscriptions.defaultPaymentMethodId, pm.id),
      ),
    );
  return rows.some((r) => (r.subAc ?? r.cusAc ?? "on") === "on");
}
