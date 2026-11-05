import { and, desc, eq, gte, inArray, isNull, lt, ne, sql, exists } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { businessWallClock } from "@/platform/clock";
import { createLogger } from "@/platform/logger";
import {
  prices,
  products,
  subscriptionItems,
  subscriptions,
  unbilledCharges,
  usageRecords,
} from "@db/schema";
import {
  isMeteredPrice,
  meteredGrowth,
  meteredPriceSql,
  minimumTrueUp,
  rateMeteredQuantity,
  ratableFromSnapshot,
  snapshotPrice,
  type PriceSnapshot,
  type RatedTier,
} from "@/modules/catalog/pricing";
import { rateMeteredItem } from "@/modules/metering/rating";
import {
  FOLD_GRACE_MS,
  groupRecord,
  peekMeterCutoff,
  rateMeterItem,
  type LineCost,
  type MeterItemRating,
  type SegmentCite,
} from "@/modules/metering/meter-rating";
import { listKeyOf, priceListResolver } from "@/modules/metering/price-list-rating";
import { rateMeterCombination, resolveMeterRate } from "@/modules/catalog/pricing";
import { currencyExponent } from "@/platform/currency";
import { formatFixed12, roundFixed12 } from "@/platform/fixed";
import { measureMetered } from "@/modules/metering/measure";
import { previewInvoiceFromLines, USAGE_SETTLEMENT } from "@/modules/invoicing/service";
import { publicRating } from "@/modules/invoicing/serialize";
import { addInterval, type Interval } from "./interval";
import { usageWindowForNextInvoice, type NextInvoiceUsageWindow } from "./usage-window";
import { projectQuantity, projectionSpan, type ProjectionMethod } from "./usage-projection";

const log = createLogger("subscriptions.current-usage");

/**
 * Usage so far in the window the next invoice bills, rated as that invoice rates it, plus
 * tax. Read-only, nothing stored. Discounts and credits are not applied: the exact next
 * invoice is `estimateRenewal({ includeUsageSoFar: true })`.
 */
export interface CurrentUsageItem {
  itemPublicId: string;
  pricePublicId: string;
  name: string;
  model: string;
  aggregation: string;
  quantity: bigint;
  freeQuantity: number;
  billableQuantity: bigint;
  amountMinor: bigint;
  unitAmountMinor: bigint;
  minimumAmountMinor: number | null;
  tiers: RatedTier[];
  projection: {
    quantity: bigint;
    amountMinor: bigint;
    minimumTrueUpMinor: bigint;
    method: ProjectionMethod;
  } | null;
  /** Meter items: usage so far per value combination (Fixed12 quantities). */
  combinations?: CombinationUsage[];
  /** Model values billed at the default rate: no list price and no cost of yours. */
  unpricedModels?: string[];
  /** The same as list keys, where the meter names a token type: what a cost row would set. */
  unpricedKeys?: Array<{ provider: string | null; model: string; tokenType: string }>;
}

export interface CombinationUsage {
  group: Record<string, string>;
  quantity: bigint;
  amountMinor: bigint;
  /** Where the rate came from; null for a price that is not on the model price list. */
  priceSource: string | null;
  segments: SegmentCite[];
  cost: LineCost | null;
  projection: { quantity: bigint; amountMinor: bigint; method: ProjectionMethod } | null;
}

/** Usage already rated by an early settlement (item removed, term reset): the next invoice bills it. */
export interface SettledUsageCharge {
  chargePublicId: string;
  pricePublicId: string | null;
  name: string;
  description: string;
  quantity: number;
  amountMinor: bigint;
  periodStart: Date | null;
  periodEnd: Date | null;
}

interface TaxedTotals {
  subtotalMinor: bigint;
  taxMinor: bigint;
  taxLines: Array<{ label: string; amountMinor: bigint }>;
  totalMinor: bigint;
}

export interface CurrentUsageView {
  subscriptionPublicId: string;
  currency: string;
  asOf: Date;
  window: NextInvoiceUsageWindow | null;
  items: CurrentUsageItem[];
  settled: SettledUsageCharge[];
  totals: TaxedTotals;
  projection: (TaxedTotals & { minimumTrueUpMinor: bigint }) | null;
  /** Usage recorded in a trial: units only, since no invoice bills it. */
  trial: {
    start: Date;
    end: Date;
    items: Array<{ itemPublicId: string; pricePublicId: string; name: string; quantity: bigint }>;
  } | null;
}

type ItemRow = {
  item: typeof subscriptionItems.$inferSelect;
  price: typeof prices.$inferSelect;
  productName: string;
};

const itemName = (r: { price: typeof prices.$inferSelect; productName: string | null }) =>
  r.price.externalName ?? r.productName ?? r.price.publicId;

export async function currentUsage(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  includeProjection?: boolean;
  /** Where the read came from, for the timing log. */
  surface?: string;
}): Promise<CurrentUsageView | null> {
  const t0 = Date.now();
  // Simulated on a time-travelled business, on every surface (the portal resolves no pin).
  const asOf = await businessWallClock(input.businessId);
  const loaded = await withTenant(input.organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.id, input.subscriptionId),
          eq(subscriptions.businessId, input.businessId),
        ),
      )
      .limit(1);
    if (!sub) return null;
    const rows = (
      await tx
        .select({ item: subscriptionItems, price: prices, productName: products.name })
        .from(subscriptionItems)
        .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
        .innerJoin(products, eq(prices.productId, products.id))
        .where(eq(subscriptionItems.subscriptionId, sub.id))
        .orderBy(subscriptionItems.createdAt, subscriptionItems.id)
    )
      .map((r) => ({
        ...r,
        snap: (r.item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(r.price),
      }))
      .filter((r) => isMeteredPrice(r.snap));
    const window = await usageWindowForNextInvoice(tx, sub);
    const items = window
      ? await rateItems(tx, rows, window, asOf, !!input.includeProjection, sub)
      : [];
    const settled = await settledCharges(tx, sub.id);
    const trial =
      sub.status === "in_trial" && rows.length > 0 ? await trialUnits(tx, sub, rows) : null;
    const records = window ? await recordCount(tx, rows, window) : 0;
    return { sub, window, items, settled, trial, records };
  });
  if (!loaded) return null;
  const { sub, window, items, settled, trial } = loaded;

  const taxCtx = {
    organizationId: input.organizationId,
    businessId: input.businessId,
    customerId: sub.customerId,
    subscriptionId: sub.id,
    currency: sub.currency,
  };
  const settledLines = settled.map((c) => ({ priceId: c.priceId, amountMinor: c.amountMinor }));
  const totals = await taxed(taxCtx, [
    ...items.map((i) => ({ priceId: i.priceId, amountMinor: i.view.amountMinor })),
    ...settledLines,
  ]);
  // Null before 10% of the window: every item then has no projection.
  const projected =
    input.includeProjection && items.length > 0 && items.every((i) => i.view.projection != null);
  let projection: CurrentUsageView["projection"] = null;
  if (projected && window) {
    const lines = items.flatMap((i) => [
      { priceId: i.priceId, amountMinor: i.view.projection!.amountMinor },
      { priceId: i.priceId, amountMinor: i.view.projection!.minimumTrueUpMinor },
    ]);
    projection = {
      ...(await taxed(taxCtx, [...lines, ...settledLines])),
      minimumTrueUpMinor: items.reduce((s, i) => s + i.view.projection!.minimumTrueUpMinor, 0n),
    };
  }

  log.info("current usage computed", {
    event: "current_usage_computed",
    surface: input.surface ?? "api",
    subscription: sub.publicId,
    items: items.length,
    rows: loaded.records,
    duration_ms: Date.now() - t0,
  });
  return {
    subscriptionPublicId: sub.publicId,
    currency: sub.currency,
    asOf,
    window,
    items: items.map((i) => i.view),
    settled: settled.map((c) => c.view),
    totals,
    projection,
    trial,
  };
}

/** Rate each metered item over the window, through the invoice's own path. */
async function rateItems(
  tx: Tx,
  rows: Array<ItemRow & { snap: PriceSnapshot }>,
  window: NextInvoiceUsageWindow,
  asOf: Date,
  includeProjection: boolean,
  sub: { businessId: string; customerId: string; currency: string },
): Promise<Array<{ priceId: string; view: CurrentUsageItem }>> {
  const span = includeProjection ? projectionSpan(window, asOf) : null;
  const out: Array<{ priceId: string; view: CurrentUsageItem }> = [];
  for (const row of rows) {
    const { item, snap } = row;
    if (snap.meter) {
      out.push({
        priceId: row.price.id,
        view: await meterItemSoFar(tx, row, sub, window, asOf, span),
      });
      continue;
    }
    const growth = meteredGrowth(snap);
    // A time-weighted level accrues with time: so far ends now, not at window end.
    const soFar =
      growth === "time_weighted"
        ? {
            start: window.start,
            end: new Date(
              Math.max(window.start.getTime(), Math.min(asOf.getTime(), window.end.getTime())),
            ),
          }
        : window;
    const rated = await rateMeteredItem(tx, {
      item: { ...item, priceSnapshot: snap },
      window: soFar,
    });
    let projection: CurrentUsageItem["projection"] = null;
    if (span) {
      const full =
        growth === "time_weighted"
          ? (
              await measureMetered(tx, {
                source: { kind: "item", itemId: item.id },
                snapshot: snap,
                window,
              })
            ).quantity
          : undefined;
      const p = projectQuantity({
        growth,
        quantity: rated.quantity,
        span,
        fullWindowQuantity: full,
      });
      const amount = rateMeteredQuantity({
        snapshot: snap,
        itemFreeQuantity: item.freeQuantity,
        quantity: p.quantity,
      }).amountMinor;
      projection = {
        quantity: p.quantity,
        amountMinor: amount,
        minimumTrueUpMinor: windowMinimumTrueUp(snap, amount, window),
        method: p.method,
      };
    }
    out.push({
      priceId: row.price.id,
      view: {
        itemPublicId: item.publicId,
        pricePublicId: snap.publicId,
        name: itemName(row),
        model: snap.model,
        aggregation: snap.usageAggregation ?? "sum",
        quantity: rated.quantity,
        freeQuantity: ratableFromSnapshot(snap, item.freeQuantity).freeQuantity ?? 0,
        billableQuantity: rated.billableQuantity,
        amountMinor: rated.amountMinor,
        unitAmountMinor: rated.unitAmountMinor,
        minimumAmountMinor: snap.minimumAmountMinor ?? null,
        tiers: rated.tiers,
        projection,
      },
    });
  }
  return out;
}

/**
 * A meter item's usage so far, exact up to now (no fold grace): the item's total and one row
 * per value combination with its segments and, with `span`, a projection (U2 rules).
 */
async function meterItemSoFar(
  tx: Tx,
  row: ItemRow & { snap: PriceSnapshot },
  sub: { businessId: string; customerId: string; currency: string },
  window: NextInvoiceUsageWindow,
  asOf: Date,
  span: { elapsedMs: bigint; lengthMs: bigint } | null,
): Promise<CurrentUsageItem> {
  const { item, snap } = row;
  const peek = await peekMeterCutoff(tx, {
    businessId: sub.businessId,
    customerId: sub.customerId,
    meterId: snap.meter!.id,
  });
  // A cutoff past now + the grace reads every event received so far.
  const cutoff = { ...peek, at: new Date(Date.now() + FOLD_GRACE_MS + 1_000) };
  const end = new Date(
    Math.max(window.start.getTime(), Math.min(asOf.getTime(), window.end.getTime())),
  );
  const rated = await rateMeterItem(tx, {
    item: { ...item, priceSnapshot: snap },
    subscription: sub,
    window: { start: window.start, end },
    cutoff,
  });
  const lines = rated.lines.filter((l) => !l.late);
  const sum = (f: (l: (typeof lines)[number]) => bigint) => lines.reduce((a, l) => a + f(l), 0n);
  const combinations = await meterCombinations(tx, rated, snap, sub.currency, lines, {
    end,
    windowEnd: window.end,
    span,
  });
  const modelKey = rated.meter.priceList?.model_key ?? "model";
  const unpriced = [
    ...new Set(
      combinations
        .filter((c) => c.priceSource === "default_rate" && c.group[modelKey])
        .map((c) => c.group[modelKey]!),
    ),
  ].sort();
  let projection: CurrentUsageItem["projection"] = null;
  if (span && combinations.every((c) => c.projection)) {
    const amount = combinations.reduce((a, c) => a + c.projection!.amountMinor, 0n);
    projection = {
      quantity: roundFixed12(combinations.reduce((a, c) => a + c.projection!.quantity, 0n)),
      amountMinor: amount,
      minimumTrueUpMinor: windowMinimumTrueUp(snap, amount, window),
      method: combinations.some((c) => c.projection!.method === "linear") ? "linear" : "held_level",
    };
  }
  return {
    itemPublicId: item.publicId,
    pricePublicId: snap.publicId,
    name: itemName(row),
    model: snap.model,
    aggregation: snap.usageAggregation ?? "sum",
    quantity: roundFixed12(sum((l) => l.quantity)),
    freeQuantity: rated.pricing.free_quantity,
    billableQuantity: roundFixed12(sum((l) => l.billableQuantity)),
    amountMinor: sum((l) => l.amountMinor),
    unitAmountMinor: 0n,
    minimumAmountMinor: snap.minimumAmountMinor ?? null,
    tiers: [],
    projection,
    combinations,
    unpricedModels: unpriced,
    unpricedKeys: unpricedKeys(rated.meter, combinations, snap.currency || sub.currency),
  };
}

/** The list key of each default-rate combination, once; none where no token type is known. */
function unpricedKeys(
  meter: MeterItemRating["meter"],
  combinations: CombinationUsage[],
  currency: string,
): NonNullable<CurrentUsageItem["unpricedKeys"]> {
  const out = new Map<string, NonNullable<CurrentUsageItem["unpricedKeys"]>[number]>();
  for (const c of combinations) {
    if (c.priceSource !== "default_rate") continue;
    const k = listKeyOf(meter, c.group, currency);
    if (!k) continue;
    const key = { provider: k.provider ?? null, model: k.model, tokenType: k.tokenType };
    out.set(JSON.stringify(key), key);
  }
  return [...out.values()].sort((a, b) =>
    `${a.model} ${a.tokenType}`.localeCompare(`${b.model} ${b.tokenType}`),
  );
}

/**
 * One row per combination from the rated lines (a combination has one line per segment).
 * Projection (U2): a summed or counted quantity extends linearly, other levels hold; an
 * event-amount or event-cost price extends its amount; a rate card rates the projected
 * QUANTITY; the model price list prices the remaining quantity on the dated list over the
 * remaining time, pro rata by time across any future change. Nothing below 10 % elapsed.
 */
async function meterCombinations(
  tx: Tx,
  rated: MeterItemRating,
  snap: PriceSnapshot,
  subCurrency: string,
  lines: MeterItemRating["lines"],
  t: { end: Date; windowEnd: Date; span: { elapsedMs: bigint; lengthMs: bigint } | null },
): Promise<CombinationUsage[]> {
  const meter = rated.meter;
  const currency = snap.currency || subCurrency;
  const byGroup = new Map<string, { group: string[]; lines: typeof lines }>();
  for (const l of lines) {
    if (l.quantity === 0n && l.amountMinor === 0n) continue;
    const k = JSON.stringify(l.group);
    const e = byGroup.get(k) ?? { group: l.group, lines: [] };
    e.lines.push(l);
    byGroup.set(k, e);
  }
  const additive =
    !meter.recurring && (meter.aggregation === "sum" || meter.aggregation === "count");
  const source = snap.amountSource ?? "rate";
  const listed = source === "model_price_list";
  const resolver = listed ? priceListResolver({ tx, meter, snap, currency }) : null;
  const out: CombinationUsage[] = [];
  for (const { group, lines: ls } of byGroup.values()) {
    const g = groupRecord(meter.groupBy, group);
    const quantity = ls.reduce((a, l) => a + l.quantity, 0n);
    const amount = ls.reduce((a, l) => a + l.amountMinor, 0n);
    const segments = ls.flatMap((l) => (l.segment?.cite ? [l.segment.cite] : []));
    const costs = ls.map((l) => l.cost ?? null);
    const cost: LineCost | null = costs.every((c) => c)
      ? costs.some((c) => c!.minor == null)
        ? (costs.find((c) => c!.minor == null) as LineCost)
        : {
            minor: costs.reduce((a, c) => a + c!.minor!, 0n),
            basis: costs.every((c) => c!.basis === costs[0]!.basis) ? costs[0]!.basis : "mixed",
          }
      : null;
    let projection: CombinationUsage["projection"] = null;
    if (t.span) {
      const { elapsedMs, lengthMs } = t.span;
      const linear = additive || meter.aggregation === "weighted_sum";
      const pq = projectQuantity({ growth: linear ? "additive" : "level", quantity, span: t.span });
      // Real cost first bills money as it is reported: linear on the amount, like event_cost.
      if (source === "event_amount" || source === "event_cost" || source === "event_cost_or_list") {
        const pa =
          elapsedMs >= lengthMs ? amount : (amount * lengthMs + elapsedMs - 1n) / elapsedMs;
        projection = { quantity: pq.quantity, amountMinor: pa, method: "linear" };
      } else if (listed && resolver) {
        const remaining = pq.quantity - quantity;
        let pa = amount;
        if (remaining > 0n && t.end.getTime() < t.windowEnd.getTime()) {
          const segs = await resolver({ group: g }, { start: t.end, end: t.windowEnd });
          const totalMs = BigInt(t.windowEnd.getTime() - t.end.getTime());
          let left = remaining;
          segs.forEach((s, i) => {
            const share =
              i === segs.length - 1
                ? left
                : (remaining * BigInt(s.end.getTime() - s.start.getTime())) / totalMs;
            left -= share;
            pa += rateMeterCombination({
              model: "usage",
              amountSource: "rate",
              quantity: share,
              freeQuantity: 0,
              rate: s.rate,
              quantityDivisor: s.quantityDivisor ?? BigInt(snap.quantityDivisor ?? "1"),
              markupPercent: s.markupPercent ?? null,
              currencyExponent: currencyExponent(currency),
            }).amountMinor;
          });
        }
        projection = { quantity: pq.quantity, amountMinor: pa, method: pq.method };
      } else {
        const r = rateMeterCombination({
          model: snap.model,
          amountSource: "rate",
          quantity: pq.quantity,
          freeQuantity: rated.pricing.free_quantity,
          rate: resolveMeterRate(snap, g),
          quantityDivisor: BigInt(snap.quantityDivisor ?? "1"),
          packageSize: snap.packageSize,
          currencyExponent: currencyExponent(currency),
        });
        projection = { quantity: pq.quantity, amountMinor: r.amountMinor, method: pq.method };
      }
    }
    out.push({
      group: g,
      quantity,
      amountMinor: amount,
      priceSource: segments.some((c) => c.price_source === "default_rate")
        ? "default_rate"
        : (segments[0]?.price_source ?? null),
      segments,
      cost,
      projection,
    });
  }
  return out;
}

/** The minimum-spend true-up the invoice adds for this window (`addMinimumTrueUp`). */
function windowMinimumTrueUp(
  snap: PriceSnapshot,
  amountMinor: bigint,
  window: { start: Date; end: Date },
): bigint {
  if (snap.minimumAmountMinor == null || snap.type === "one_time" || !snap.interval) return 0n;
  const fullEnd = addInterval(window.start, snap.interval as Interval, snap.intervalCount);
  return minimumTrueUp(
    BigInt(snap.minimumAmountMinor),
    amountMinor,
    window.end.getTime() - window.start.getTime(),
    fullEnd.getTime() - window.start.getTime(),
  );
}

async function settledCharges(tx: Tx, subscriptionId: string) {
  const rows = await tx
    .select({ charge: unbilledCharges, price: prices, productName: products.name })
    .from(unbilledCharges)
    .leftJoin(prices, eq(unbilledCharges.priceId, prices.id))
    .leftJoin(products, eq(prices.productId, products.id))
    .where(
      and(
        eq(unbilledCharges.subscriptionId, subscriptionId),
        eq(unbilledCharges.status, "pending"),
        eq(unbilledCharges.entityType, USAGE_SETTLEMENT),
      ),
    )
    .orderBy(unbilledCharges.createdAt, unbilledCharges.id);
  // The invoice bills a settlement as a usage line only with its price (`planSubscriptionPeriodInvoice`).
  return rows
    .filter((r) => r.price != null)
    .map(({ charge, price, productName }) => ({
      priceId: price!.id,
      amountMinor: charge.amountMinor,
      view: {
        chargePublicId: charge.publicId,
        pricePublicId: price!.publicId,
        name: itemName({ price: price!, productName }),
        description: charge.description,
        quantity: charge.quantity,
        amountMinor: charge.amountMinor,
        periodStart: charge.periodStart,
        periodEnd: charge.periodEnd,
      } satisfies SettledUsageCharge,
    }));
}

async function trialUnits(
  tx: Tx,
  sub: typeof subscriptions.$inferSelect,
  rows: Array<ItemRow & { snap: PriceSnapshot }>,
): Promise<CurrentUsageView["trial"]> {
  const start = sub.trialStart ?? sub.startedAt ?? sub.createdAt;
  const end = sub.trialEnd;
  if (!end) return null;
  const items = [];
  for (const row of rows) {
    const m = await measureMetered(tx, {
      source: { kind: "item", itemId: row.item.id },
      snapshot: row.snap,
      window: { start, end },
    });
    items.push({
      itemPublicId: row.item.publicId,
      pricePublicId: row.snap.publicId,
      name: itemName(row),
      quantity: m.quantity,
    });
  }
  return { start, end, items };
}

/** Records read for the view, for the timing log (the cost that grows). */
async function recordCount(
  tx: Tx,
  rows: Array<{ item: { id: string } }>,
  window: { start: Date; end: Date },
): Promise<number> {
  if (rows.length === 0) return 0;
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(usageRecords)
    .where(
      and(
        inArray(
          usageRecords.subscriptionItemId,
          rows.map((r) => r.item.id),
        ),
        gte(usageRecords.timestamp, window.start),
        lt(usageRecords.timestamp, window.end),
      ),
    );
  return r?.n ?? 0;
}

/** Tax on the usage lines alone, with the customer's real tax resolution and no credit drawn. */
async function taxed(
  ctx: {
    organizationId: string;
    businessId: string;
    customerId: string;
    subscriptionId: string;
    currency: string;
  },
  lines: Array<{ priceId: string; amountMinor: bigint }>,
): Promise<TaxedTotals> {
  const billed = lines.filter((l) => l.amountMinor !== 0n);
  if (billed.length === 0) return { subtotalMinor: 0n, taxMinor: 0n, taxLines: [], totalMinor: 0n };
  const p = await previewInvoiceFromLines({
    ...ctx,
    lines: billed.map((l) => ({
      description: "usage",
      priceId: l.priceId,
      amountMinor: l.amountMinor,
    })),
    balances: { promotional: 0n, refundable: 0n, excess: 0n },
  });
  return {
    subtotalMinor: p.subtotalMinor,
    taxMinor: p.taxMinor,
    taxLines: p.taxLines.map((t) => ({ label: t.description, amountMinor: t.amountMinor })),
    totalMinor: p.totalMinor,
  };
}

// ── Per customer ─────────────────────────────────────────────────────────────

export const CUSTOMER_USAGE_LIMIT = 50;

/**
 * Current usage for each of a customer's subscriptions that has a metered item and a
 * window the next invoice bills. Totals per currency; currencies are never summed together.
 */
export async function currentUsageForCustomer(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  includeProjection?: boolean;
}): Promise<{
  data: CurrentUsageView[];
  hasMore: boolean;
  totals: Array<TaxedTotals & { currency: string; projectedTotalMinor: bigint | null }>;
}> {
  const subs = await withTenant(input.organizationId, (tx) =>
    tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.businessId, input.businessId),
          eq(subscriptions.customerId, input.customerId),
          isNull(subscriptions.deletedAt),
          ne(subscriptions.status, "cancelled"),
          exists(
            tx
              .select({ one: sql`1` })
              .from(subscriptionItems)
              .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
              .where(
                and(
                  eq(subscriptionItems.subscriptionId, subscriptions.id),
                  meteredPriceSql(
                    sql`coalesce(${subscriptionItems.priceSnapshot}->>'model', ${prices.model})`,
                    sql`coalesce(${subscriptionItems.priceSnapshot}->>'usageAggregation', ${prices.usageAggregation})`,
                  ),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
      .limit(CUSTOMER_USAGE_LIMIT + 1),
  );
  const data: CurrentUsageView[] = [];
  for (const s of subs.slice(0, CUSTOMER_USAGE_LIMIT)) {
    const view = await currentUsage({
      organizationId: input.organizationId,
      businessId: input.businessId,
      subscriptionId: s.id,
      includeProjection: input.includeProjection,
      surface: "api_customer",
    });
    if (view?.window) data.push(view);
  }
  const byCurrency = new Map<
    string,
    TaxedTotals & { currency: string; projectedTotalMinor: bigint | null }
  >();
  for (const v of data) {
    const t = byCurrency.get(v.currency) ?? {
      currency: v.currency,
      subtotalMinor: 0n,
      taxMinor: 0n,
      taxLines: [],
      totalMinor: 0n,
      projectedTotalMinor: input.includeProjection ? 0n : null,
    };
    t.subtotalMinor += v.totals.subtotalMinor;
    t.taxMinor += v.totals.taxMinor;
    t.totalMinor += v.totals.totalMinor;
    // One subscription without a projection leaves the currency's projected total unknown.
    t.projectedTotalMinor =
      t.projectedTotalMinor != null && v.projection
        ? t.projectedTotalMinor + v.projection.totalMinor
        : null;
    byCurrency.set(v.currency, t);
  }
  return {
    data,
    hasMore: subs.length > CUSTOMER_USAGE_LIMIT,
    totals: [...byCurrency.values()],
  };
}

// ── Serialization ────────────────────────────────────────────────────────────

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const taxedJson = (t: TaxedTotals) => ({
  subtotal_minor: Number(t.subtotalMinor),
  tax_minor: Number(t.taxMinor),
  tax_lines: t.taxLines.map((l) => ({ label: l.label, amount_minor: Number(l.amountMinor) })),
  total_minor: Number(t.totalMinor),
});

/**
 * The `current_usage` object. `portal` leaves out the ids and the minimum a buyer has no
 * use for.
 */
export function serializeCurrentUsage(
  v: CurrentUsageView,
  opts: { portal?: boolean; showCost?: boolean } = {},
) {
  const portal = opts.portal === true;
  const showCost = !portal && opts.showCost === true;
  return {
    object: "current_usage" as const,
    ...(portal ? {} : { subscription: v.subscriptionPublicId }),
    currency: v.currency,
    as_of: v.asOf.toISOString(),
    window: v.window
      ? {
          start: v.window.start.toISOString(),
          end: v.window.end.toISOString(),
          billed_by: v.window.billedBy,
          ...(portal ? {} : { invoice: v.window.invoiceId }),
        }
      : null,
    items: v.items.map((i) => ({
      ...(portal ? {} : { item: i.itemPublicId, price: i.pricePublicId }),
      name: i.name,
      model: i.model,
      aggregation: i.aggregation,
      quantity: Number(i.quantity),
      free_quantity: i.freeQuantity,
      billable_quantity: Number(i.billableQuantity),
      amount_minor: Number(i.amountMinor),
      unit_amount_minor: Number(i.unitAmountMinor),
      ...(portal ? {} : { minimum_amount_minor: i.minimumAmountMinor }),
      ...(i.tiers.length
        ? {
            tiers: i.tiers.map((t) => ({
              from: Number(t.from),
              to: t.to == null ? null : Number(t.to),
              units: Number(t.units),
              unit_amount_minor: Number(t.unitAmountMinor),
              flat_amount_minor: Number(t.flatAmountMinor),
              amount_minor: Number(t.amountMinor),
            })),
          }
        : {}),
      projected_quantity: i.projection ? Number(i.projection.quantity) : null,
      projected_amount_minor: i.projection ? Number(i.projection.amountMinor) : null,
      projected_minimum_true_up_minor: i.projection
        ? Number(i.projection.minimumTrueUpMinor)
        : null,
      method: i.projection?.method ?? null,
      ...(i.projection ? { estimate: true as const } : {}),
      ...(i.combinations
        ? {
            combinations: i.combinations.map((c) => ({
              group: c.group,
              quantity: formatFixed12(c.quantity),
              amount_minor: Number(c.amountMinor),
              // The buyer sees amounts, never the rate's markup or the rows behind it.
              ...(portal
                ? {}
                : {
                    price_source: c.priceSource,
                    segments: (
                      publicRating({ segments: c.segments }, showCost) as {
                        segments: unknown[];
                      }
                    ).segments,
                  }),
              ...(showCost
                ? {
                    cost_minor: c.cost?.minor != null ? Number(c.cost.minor) : null,
                    cost_basis: c.cost?.basis ?? null,
                  }
                : {}),
              projected_quantity: c.projection ? formatFixed12(c.projection.quantity) : null,
              projected_amount_minor: c.projection ? Number(c.projection.amountMinor) : null,
              method: c.projection?.method ?? null,
              ...(c.projection ? { estimate: true as const } : {}),
            })),
            unpriced_models: i.unpricedModels ?? [],
            unpriced_keys: (i.unpricedKeys ?? []).map((k) => ({
              provider: k.provider,
              model: k.model,
              token_type: k.tokenType,
            })),
          }
        : {}),
    })),
    settled_charges: v.settled.map((c) => ({
      ...(portal ? {} : { id: c.chargePublicId, price: c.pricePublicId }),
      name: c.name,
      description: c.description,
      quantity: c.quantity,
      amount_minor: Number(c.amountMinor),
      period_start: iso(c.periodStart),
      period_end: iso(c.periodEnd),
    })),
    ...taxedJson(v.totals),
    projection: v.projection
      ? {
          ...taxedJson(v.projection),
          minimum_true_up_minor: Number(v.projection.minimumTrueUpMinor),
          estimate: true as const,
        }
      : null,
    discounts_applied: false as const,
    trial: v.trial
      ? {
          start: v.trial.start.toISOString(),
          end: v.trial.end.toISOString(),
          items: v.trial.items.map((i) => ({
            ...(portal ? {} : { item: i.itemPublicId, price: i.pricePublicId }),
            name: i.name,
            quantity: Number(i.quantity),
          })),
        }
      : null,
  };
}

export type CurrentUsageJson = ReturnType<typeof serializeCurrentUsage>;
