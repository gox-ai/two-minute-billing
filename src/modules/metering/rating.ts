import { eq } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { prices, subscriptionItems } from "@db/schema";
import {
  isMeteredPrice,
  rateMeteredQuantity,
  snapshotPrice,
  type PriceSnapshot,
  type RatedTier,
} from "@/modules/catalog/pricing";
import type { UsageWindow } from "@/modules/subscriptions/usage-window";
import { measureMetered } from "./measure";
import type { Level } from "./levels";

export type { UsageWindow };

/** One metered item rated over one window. Invoicing, settlement and the usage views share it. */
export type MeteredRating = {
  itemId: string;
  pricePublicId: string;
  quantity: bigint;
  billableQuantity: bigint;
  amountMinor: bigint;
  unitAmountMinor: bigint;
  tiers: RatedTier[];
  level: Level | null;
};

/** Measure, then price: the one path from usage records to a rated amount. */
export async function rateMeteredItem(
  tx: Tx,
  input: {
    item: {
      id: string;
      subscriptionId: string;
      freeQuantity: number | null;
      priceSnapshot: PriceSnapshot;
    };
    window: UsageWindow;
  },
): Promise<MeteredRating> {
  const snap = input.item.priceSnapshot;
  const measured = await measureMetered(tx, {
    source: { kind: "item", itemId: input.item.id },
    snapshot: snap,
    window: input.window,
  });
  const rated = rateMeteredQuantity({
    snapshot: snap,
    itemFreeQuantity: input.item.freeQuantity,
    quantity: measured.quantity,
  });
  return {
    itemId: input.item.id,
    pricePublicId: snap.publicId,
    quantity: measured.quantity,
    billableQuantity: rated.billableQuantity,
    amountMinor: rated.amountMinor,
    unitAmountMinor: rated.unitAmountMinor,
    tiers: rated.tiers ?? [],
    level: measured.level,
  };
}

/** Every live metered item of one subscription, rated over `window` (no minimum, no tax). */
export async function rateSubscriptionUsage(
  organizationId: string,
  subscriptionId: string,
  window: UsageWindow,
): Promise<MeteredRating[]> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({ item: subscriptionItems, price: prices })
      .from(subscriptionItems)
      .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
      .where(eq(subscriptionItems.subscriptionId, subscriptionId))
      .orderBy(subscriptionItems.createdAt, subscriptionItems.id);
    const out: MeteredRating[] = [];
    for (const { item, price } of rows) {
      const snap = (item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(price);
      if (!isMeteredPrice(snap)) continue;
      out.push(
        await rateMeteredItem(tx, {
          item: { ...item, priceSnapshot: snap },
          window,
        }),
      );
    }
    return out;
  });
}

/**
 * The `rating` stored on a usage line: how it was measured and priced. JSON-safe (numbers
 * for quantities and minor units; both fit, since a line quantity is an integer column).
 */
export function lineRating(snap: PriceSnapshot, r: MeteredRating, freeQuantity: number) {
  return {
    model: snap.model,
    aggregation: snap.usageAggregation ?? "sum",
    recurring: snap.usageRecurring === true,
    time_unit: snap.usageTimeUnit ?? null,
    quantity: Number(r.quantity),
    free_quantity: freeQuantity,
    billable_quantity: Number(r.billableQuantity),
    tiers: r.tiers.map((t) => ({
      from: Number(t.from),
      to: t.to == null ? null : Number(t.to),
      units: Number(t.units),
      unit_amount_minor: Number(t.unitAmountMinor),
      flat_amount_minor: Number(t.flatAmountMinor),
      amount_minor: Number(t.amountMinor),
    })),
    level: r.level
      ? {
          carried_in: Number(r.level.carriedIn),
          closing: Number(r.level.closing),
          peak: Number(r.level.peak),
        }
      : null,
  };
}
export type LineRating = ReturnType<typeof lineRating>;
