import { and, eq, sql } from "drizzle-orm";
import { customerMeterBilling, meters, prices, subscriptionItems, subscriptions } from "@db/schema";
import type { Tx } from "@/platform/db";
import { applyMeterPricing, loadMeterPricing, type PriceSnapshot } from "@/modules/catalog/pricing";

/** A second live subscription tried to bill a meter the customer already pays through. */
export class MeterBillingConflictError extends Error {
  readonly statusCode = 409;
  readonly errorType = "invalid_request_error";
  constructor(
    readonly ownerPublicId: string,
    readonly meterKey: string,
  ) {
    super(
      `We could not add the price. The subscription ${ownerPublicId} already bills the meter ${meterKey} for this customer. Change that subscription instead.`,
    );
    this.name = "MeterBillingConflictError";
  }
}

/**
 * Run on every attach path, in its transaction, after the items are written: freeze each meter
 * price's meter and rate card onto its item snapshot, then take `customer_meter_billing` for
 * each meter. One live subscription per customer bills a meter; a row whose owner is cancelled,
 * deleted or no longer has a price on the meter passes to this subscription, with its billing
 * pointer, so late usage of old periods follows the customer.
 */
export async function syncMeterBilling(tx: Tx, subscriptionId: string): Promise<void> {
  const rows = await tx
    .select({ item: subscriptionItems, price: prices, sub: subscriptions })
    .from(subscriptionItems)
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .innerJoin(subscriptions, eq(subscriptionItems.subscriptionId, subscriptions.id))
    .where(
      and(eq(subscriptionItems.subscriptionId, subscriptionId), sql`${prices.meterId} is not null`),
    );
  if (rows.length === 0) return;
  const sub = rows[0]!.sub;

  const unfrozen = rows.filter((r) => !(r.item.priceSnapshot as PriceSnapshot | null)?.meter);
  if (unfrozen.length > 0) {
    const pricing = await loadMeterPricing(
      tx,
      unfrozen.map((r) => r.price),
    );
    for (const { item, price } of unfrozen) {
      const mp = pricing.get(price.id);
      const snap = item.priceSnapshot as PriceSnapshot | null;
      if (!mp || !snap) continue;
      await tx
        .update(subscriptionItems)
        .set({ priceSnapshot: applyMeterPricing(snap, price, mp) })
        .where(eq(subscriptionItems.id, item.id));
    }
  }

  const meterIds = [...new Set(rows.map((r) => r.price.meterId!))].sort();
  for (const meterId of meterIds) {
    const [taken] = await tx
      .insert(customerMeterBilling)
      .values({
        customerId: sub.customerId,
        meterId,
        organizationId: sub.organizationId,
        businessId: sub.businessId,
        subscriptionId: sub.id,
      })
      .onConflictDoNothing()
      .returning({ meterId: customerMeterBilling.meterId });
    if (taken) continue;
    const [row] = await tx
      .select({ subscriptionId: customerMeterBilling.subscriptionId })
      .from(customerMeterBilling)
      .where(
        and(
          eq(customerMeterBilling.customerId, sub.customerId),
          eq(customerMeterBilling.meterId, meterId),
        ),
      )
      .for("update");
    const owner = row?.subscriptionId;
    if (owner === sub.id) continue;
    if (owner) {
      const [live] = (await tx.execute(sql`
        select s.public_id from subscriptions s
        where s.id = ${owner} and s.status <> 'cancelled' and s.deleted_at is null
          and exists (select 1 from subscription_items si join prices p on p.id = si.price_id
                      where si.subscription_id = s.id and p.meter_id = ${meterId})`)) as unknown as Array<{
        public_id: string;
      }>;
      if (live) {
        const [m] = await tx
          .select({ key: meters.key })
          .from(meters)
          .where(eq(meters.id, meterId))
          .limit(1);
        throw new MeterBillingConflictError(live.public_id, m?.key ?? meterId);
      }
    }
    await tx
      .update(customerMeterBilling)
      .set({ subscriptionId: sub.id, updatedAt: sql`app_now()` })
      .where(
        and(
          eq(customerMeterBilling.customerId, sub.customerId),
          eq(customerMeterBilling.meterId, meterId),
        ),
      );
  }
}
