/**
 * Usage reads for credits (design G3 §6): rated unbilled usage, one meter's usage this period,
 * the live subscription for a meter. Read-only; the invoice is the final truth.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import type { LineSlice } from "./planner";
import { prices, subscriptionItems, subscriptions } from "@db/schema";
import { isMeteredPrice, snapshotPrice, type PriceSnapshot } from "@/modules/catalog/pricing";
import { FOLD_GRACE_MS, peekMeterCutoff, rateMeterItem } from "@/modules/metering/meter-rating";
import { rateMeteredItem } from "@/modules/metering/rating";
import { formatFixed12 } from "@/platform/fixed";
import {
  heldUsageWindow,
  usageWindowForNextInvoice,
  type UsageWindow,
} from "@/modules/subscriptions/usage-window";

/** Subscriptions whose usage an invoice will bill or whose features apply now. */
export const LIVE_SUBSCRIPTION_STATUSES = ["active", "in_trial"] as const;

type SubRow = typeof subscriptions.$inferSelect;
type ItemRow = typeof subscriptionItems.$inferSelect;

export interface MeteredItem {
  sub: SubRow;
  item: ItemRow;
  priceId: string;
  snap: PriceSnapshot;
}

/** Metered items on the customer's live subscriptions, optionally for one meter or currency. */
export async function liveMeteredItems(
  tx: Tx,
  input: { customerId: string; meterId?: string; currency?: string },
): Promise<MeteredItem[]> {
  const rows = await tx
    .select({ sub: subscriptions, item: subscriptionItems, price: prices })
    .from(subscriptionItems)
    .innerJoin(subscriptions, eq(subscriptionItems.subscriptionId, subscriptions.id))
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .where(
      and(
        eq(subscriptions.customerId, input.customerId),
        inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
        sql`${subscriptions.deletedAt} is null`,
        input.currency ? eq(subscriptions.currency, input.currency.toUpperCase()) : undefined,
        input.meterId ? eq(prices.meterId, input.meterId) : undefined,
      ),
    )
    .orderBy(subscriptionItems.createdAt, subscriptionItems.id);
  return rows
    .map((r) => ({
      sub: r.sub,
      item: r.item,
      priceId: r.price.id,
      snap: (r.item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(r.price),
    }))
    .filter((r) => (input.meterId ? r.snap.meter?.id === input.meterId : isMeteredPrice(r.snap)));
}

/** The D2 matching rule: the first live subscription with an item billed from this meter. */
export async function liveSubscriptionForMeter(
  tx: Tx,
  customerId: string,
  meterId: string,
): Promise<{ sub: SubRow; item: ItemRow; priceId: string; snap: PriceSnapshot } | null> {
  const [first] = await liveMeteredItems(tx, { customerId, meterId });
  return first ?? null;
}

export interface UnbilledUsageLine {
  subscriptionItemId: string;
  priceId: string;
  pricePublicId: string;
  meterId: string | null;
  window: { start: Date; end: Date };
  closed: boolean;
  /** Decimal string. */
  quantity: string;
  amountMinor: bigint;
  /** Split at reset-window grant edges (G3b), set by the balance. */
  slices?: LineSlice[];
  /** The closed window of a held invoice (usage grace), not the current period. */
  held?: true;
}

/**
 * Rated usage no invoice has billed yet, pre-tax, per item: the window the next invoice
 * bills, rated through the invoice's own path up to now. `cutoffAt` (real clock) limits
 * meter events to those received before it; default = every event received so far.
 */
export async function ratedUnbilledUsage(
  tx: Tx,
  input: {
    customerId: string;
    currency: string;
    asOf: Date;
    meterId?: string;
    cutoffAt?: Date;
    /** Already loaded by the caller for the same customer, meter and currency. */
    items?: MeteredItem[];
  },
): Promise<UnbilledUsageLine[]> {
  const items = input.items ?? (await liveMeteredItems(tx, input));
  const out: UnbilledUsageLine[] = [];
  // During a usage grace a held invoice still bills the closed window: rate it too, so the
  // balance draws the closing grants and does not hide the new term's usage.
  const windows = new Map<string, Array<UsageWindow & { held?: true }>>();
  for (const r of items) {
    let ws = windows.get(r.sub.id);
    if (!ws) {
      const held = await heldUsageWindow(tx, r.sub.id);
      const next = await usageWindowForNextInvoice(tx, r.sub);
      ws = [];
      if (held) ws.push({ start: held.start, end: held.end, held: true });
      if (next) ws.push({ start: next.start, end: next.end });
      windows.set(r.sub.id, ws);
    }
    for (const w of ws) {
      const line = await rateUnbilledWindow(tx, input, r, w);
      out.push(w.held ? { ...line, held: true } : line);
    }
  }
  return out;
}

async function rateUnbilledWindow(
  tx: Tx,
  input: { customerId: string; asOf: Date; cutoffAt?: Date },
  r: MeteredItem,
  w: UsageWindow,
): Promise<UnbilledUsageLine> {
  const end = new Date(
    Math.max(w.start.getTime(), Math.min(input.asOf.getTime(), w.end.getTime())),
  );
  const closed = end.getTime() >= w.end.getTime();
  if (r.snap.meter) {
    const peek = await peekMeterCutoff(tx, {
      businessId: r.sub.businessId,
      customerId: input.customerId,
      meterId: r.snap.meter.id,
    });
    // A cutoff `at` past now + the grace reads every event received so far.
    const at = input.cutoffAt
      ? new Date(input.cutoffAt.getTime() + FOLD_GRACE_MS)
      : new Date(Date.now() + FOLD_GRACE_MS + 1_000);
    const rated = await rateMeterItem(tx, {
      item: { ...r.item, priceSnapshot: r.snap },
      subscription: { customerId: input.customerId, currency: r.sub.currency },
      window: { start: w.start, end },
      cutoff: { ...peek, at },
    });
    const lines = rated.lines.filter((l) => !l.late);
    const qty = lines.reduce((a, l) => a + l.quantity, 0n);
    return {
      subscriptionItemId: r.item.id,
      priceId: r.priceId,
      pricePublicId: r.snap.publicId,
      meterId: r.snap.meter.id,
      window: { start: w.start, end },
      closed,
      quantity: formatFixed12(qty),
      amountMinor: lines.reduce((a, l) => a + l.amountMinor, 0n),
    };
  }
  const rated = await rateMeteredItem(tx, {
    item: { ...r.item, priceSnapshot: r.snap },
    window: { start: w.start, end: w.end },
  });
  return {
    subscriptionItemId: r.item.id,
    priceId: r.priceId,
    pricePublicId: r.snap.publicId,
    meterId: null,
    window: { start: w.start, end: w.end },
    closed,
    quantity: formatFixed12(rated.quantity),
    amountMinor: rated.amountMinor,
  };
}

/** Money for one meter's unbilled usage, Σ over the customer's live items. */
export async function ratedMeterUsageMinor(
  tx: Tx,
  input: { customerId: string; currency: string; meterId: string; asOf: Date; cutoffAt?: Date },
): Promise<bigint> {
  const lines = await ratedUnbilledUsage(tx, input);
  return lines.reduce((a, l) => a + l.amountMinor, 0n);
}

/** Meter ids the customer's live subscriptions bill from (for the access-check lookups). */
export async function liveMeterIds(tx: Tx, customerId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ meterId: prices.meterId })
    .from(subscriptionItems)
    .innerJoin(subscriptions, eq(subscriptionItems.subscriptionId, subscriptions.id))
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .where(
      and(
        eq(subscriptions.customerId, customerId),
        inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
        isNotNull(prices.meterId),
      ),
    );
  return rows.map((r) => r.meterId!);
}
