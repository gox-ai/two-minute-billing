import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import {
  invoices,
  prices,
  products,
  subscriptionItems,
  subscriptions,
  unbilledCharges,
} from "@db/schema";
import {
  isMeteredPrice,
  minimumTrueUp,
  priceLabel,
  snapshotPrice,
  type PriceSnapshot,
} from "@/modules/catalog/pricing";
import { rateMeteredItem } from "@/modules/metering/rating";
import {
  commitMeterRating,
  meterLineDescription,
  meterLineRatingJson,
  rateMeterItem,
  takeMeterCutoff,
} from "@/modules/metering/meter-rating";
import { USAGE_SETTLEMENT, UsageQuantityTooLargeError } from "@/modules/invoicing/service";
import { addInterval, type Interval } from "./interval";
import { usageWindowStart } from "./usage-window";
import { billedOnInterims, netMeterLines } from "@/modules/usage-controls/interim-lines";

/**
 * Bill the open usage window of metered items that stop measuring before their period ends:
 * item removal, term reset, immediate cancel. Each item is rated over
 * `[usageWindowStart, until)` and queued as a `usage_settlement` unbilled charge (plus a
 * prorated minimum-spend true-up), which the next invoice bills as a usage line.
 *
 * Skipped without a term (trial usage is not billed) and while a pending invoice is open
 * (its close re-measures the window).
 */
export async function settleMeteredUsage(
  tx: Tx,
  sub: Pick<
    typeof subscriptions.$inferSelect,
    "id" | "organizationId" | "businessId" | "customerId" | "currency" | "currentPeriodStart"
  >,
  itemIds: readonly string[],
  until: Date,
): Promise<Array<typeof unbilledCharges.$inferSelect>> {
  if (itemIds.length === 0 || sub.currentPeriodStart == null) return [];
  const [pending] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.subscriptionId, sub.id), eq(invoices.status, "pending")))
    .limit(1);
  if (pending) return [];

  const rows = await tx
    .select({ item: subscriptionItems, price: prices, productName: products.name })
    .from(subscriptionItems)
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .innerJoin(products, eq(prices.productId, products.id))
    .where(
      and(
        eq(subscriptionItems.subscriptionId, sub.id),
        inArray(subscriptionItems.id, [...itemIds]),
      ),
    )
    .orderBy(subscriptionItems.createdAt, subscriptionItems.id);

  const charges: Array<typeof unbilledCharges.$inferInsert> = [];
  // Threshold invoicing: what interim invoices already billed in the open window.
  const billed = await billedOnInterims(tx, sub.id, { start: sub.currentPeriodStart, end: until });
  const meterCommits: Array<Awaited<ReturnType<typeof rateMeterItem>>> = [];
  for (const { item, price, productName } of rows) {
    const snap = (item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(price);
    if (!isMeteredPrice(snap)) continue;
    const w = await usageWindowStart(tx, item.id);
    if (!w || w.start.getTime() >= until.getTime()) continue;
    const window = { start: w.start, end: until };
    if (snap.meter) {
      // Cut at the removal: one charge per combination (each carries its line rating), and the
      // pointer moves to `until`, so the next invoice neither drops nor repeats this usage.
      const cutoff = await takeMeterCutoff(tx, {
        organizationId: sub.organizationId,
        businessId: sub.businessId,
        customerId: sub.customerId,
        meterId: snap.meter.id,
        subscriptionId: sub.id,
      });
      const rated = await rateMeterItem(tx, {
        item: { ...item, priceSnapshot: snap },
        subscription: { customerId: sub.customerId, currency: sub.currency },
        window,
        cutoff,
      });
      meterCommits.push(rated);
      const prior = billed.get(item.id);
      const netted = prior ? netMeterLines(rated, prior) : null;
      const label = priceLabel(price, { name: productName });
      let windowAmount = 0n;
      for (const [i, line] of rated.lines.entries()) {
        charges.push({
          organizationId: sub.organizationId,
          businessId: sub.businessId,
          subscriptionId: sub.id,
          currency: sub.currency,
          priceId: price.id,
          entityType: USAGE_SETTLEMENT,
          periodStart: line.window.start,
          periodEnd: line.window.end,
          publicId: publicId("uch"),
          description: meterLineDescription(label, rated, line),
          amountMinor: line.amountMinor,
          quantity: 1,
          rating: {
            ...meterLineRatingJson(snap, rated, line, i === 0),
            // Moved to the line's cost columns when the charge is invoiced.
            ...(line.cost
              ? {
                  settlement_cost: {
                    minor: line.cost.minor != null ? String(line.cost.minor) : null,
                    basis: line.cost.basis,
                  },
                }
              : {}),
          },
        });
        if (!line.late) windowAmount += line.amountMinor + (netted?.taken.get(line) ?? 0n);
      }
      const trueUp =
        snap.minimumAmountMinor != null && snap.interval
          ? minimumTrueUp(
              BigInt(snap.minimumAmountMinor),
              windowAmount,
              window.end.getTime() - window.start.getTime(),
              addInterval(window.start, snap.interval as Interval, snap.intervalCount).getTime() -
                window.start.getTime(),
            )
          : 0n;
      if (trueUp > 0n)
        charges.push({
          organizationId: sub.organizationId,
          businessId: sub.businessId,
          subscriptionId: sub.id,
          currency: sub.currency,
          priceId: price.id,
          entityType: USAGE_SETTLEMENT,
          periodStart: window.start,
          periodEnd: window.end,
          publicId: publicId("uch"),
          description: `Minimum spend adjustment: ${label}`,
          amountMinor: trueUp,
          quantity: 1,
        });
      continue;
    }
    const rated = await rateMeteredItem(tx, { item: { ...item, priceSnapshot: snap }, window });
    const base = {
      organizationId: sub.organizationId,
      businessId: sub.businessId,
      subscriptionId: sub.id,
      currency: sub.currency,
      priceId: price.id,
      entityType: USAGE_SETTLEMENT,
      periodStart: window.start,
      periodEnd: window.end,
    };
    if (rated.quantity > 2_147_483_647n)
      throw new UsageQuantityTooLargeError(snap.publicId, rated.quantity);
    const before = billed.get(item.id);
    const net = rated.amountMinor - (before?.amountMinor ?? 0n);
    const netQty = rated.quantity - (before?.quantity ?? 0n);
    if (net > 0n)
      charges.push({
        ...base,
        publicId: publicId("uch"),
        description: `usage (${snap.publicId}) ${netQty > 0n ? netQty : 0n} units`,
        amountMinor: net,
        quantity: Number(netQty > 0n ? netQty : 0n),
      });
    if (snap.minimumAmountMinor != null && snap.type !== "one_time" && snap.interval) {
      const fullEnd = addInterval(window.start, snap.interval as Interval, snap.intervalCount);
      const trueUp = minimumTrueUp(
        BigInt(snap.minimumAmountMinor),
        rated.amountMinor,
        window.end.getTime() - window.start.getTime(),
        fullEnd.getTime() - window.start.getTime(),
      );
      if (trueUp > 0n)
        charges.push({
          ...base,
          publicId: publicId("uch"),
          description: `Minimum spend adjustment: ${priceLabel(price, { name: productName })}`,
          amountMinor: trueUp,
          quantity: 1,
        });
    }
  }
  if (meterCommits.length)
    await commitMeterRating(tx, {
      organizationId: sub.organizationId,
      businessId: sub.businessId,
      pointers: meterCommits.map((r) => r.pointer),
      levels: meterCommits.flatMap((r) => r.levels),
    });
  if (charges.length === 0) return [];
  return tx.insert(unbilledCharges).values(charges).returning();
}
