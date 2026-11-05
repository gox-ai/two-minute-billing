import { asc, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { meters, priceRates, products, type prices } from "@db/schema";
import type { Tx } from "@/platform/db";
import {
  FIXED12_SCALE,
  divHalfUp,
  fixed12FromInt,
  fixed12FromNumeric,
  formatFixed12,
  mulDivHalfUp,
  parseFixed12,
  tryParseFixed12,
} from "@/platform/fixed";

export interface PriceTier {
  /**
   * Inclusive upper bound; null = the unbounded last tier. A tier starts right after the
   * previous tier's bound (the first at 0), so tiers are contiguous by construction. A
   * quantity for the unit models, a money base in minor units for graduated_percentage.
   */
  upToMinor: number | null;
  unitAmountMinor?: number;
  flatAmountMinor?: number;
  /** graduated_percentage only: the rate on the part of the base inside this tier. */
  rateBps?: number;
}

/** Models rated from a tier list. */
export const TIER_MODELS = new Set(["tiered", "volume", "stairstep", "graduated_percentage"]);
/** Models whose quantity is a money base (minor units), not a count of units. */
export const PERCENT_OF_BASE_MODELS = new Set(["percentage", "graduated_percentage"]);

/** Models that bill measured usage when the price has an aggregation (`usage` always does). */
export const METERABLE_MODELS = new Set([
  "percentage",
  "graduated_percentage",
  "tiered",
  "volume",
  "stairstep",
  "package",
]);

/**
 * Rated in arrears from recorded usage: the usage model, or a meterable model with an
 * aggregation. Without one, those models are a fixed charge on `item.quantity`.
 */
export function isMeteredPrice(p: { model: string; usageAggregation?: string | null }): boolean {
  return p.model === "usage" || (METERABLE_MODELS.has(p.model) && p.usageAggregation != null);
}

/** `isMeteredPrice` in SQL, for queries over a model and an aggregation column or jsonb path. */
export function meteredPriceSql(model: SQL | AnyColumn, aggregation: SQL | AnyColumn): SQL {
  const models = sql.join(
    [...METERABLE_MODELS].map((m) => sql`${m}`),
    sql`, `,
  );
  return sql`(${model} = 'usage' or (${aggregation} is not null and ${model} in (${models})))`;
}

export const USAGE_AGGREGATIONS = [
  "sum",
  "max",
  "last",
  "count",
  "min",
  "avg",
  "unique",
  "weighted_sum",
] as const;
export type UsageAggregation = (typeof USAGE_AGGREGATIONS)[number];
/** Aggregations whose level can carry into the next period. */
export const RECURRING_AGGREGATIONS = new Set(["sum", "last", "max", "unique", "weighted_sum"]);
export type UsageTimeUnit = "hour" | "day";
export const TIME_UNIT_MS: Record<UsageTimeUnit, number> = { hour: 3_600_000, day: 86_400_000 };

/** One broken rule in a price's usage fields, keyed by the API field. */
export interface UsagePricingIssue {
  field: "usage_aggregation" | "usage_recurring" | "usage_time_unit";
  message: string;
}

/**
 * The rules for a price's usage fields. A flat or per-unit price cannot aggregate usage
 * (the usage model does that). A recurring level needs sum, last, max, unique or
 * weighted_sum, and a time unit belongs to weighted_sum only.
 */
export function usagePricingIssues(p: {
  model: string;
  usageAggregation?: string | null;
  usageRecurring?: boolean | null;
  usageTimeUnit?: string | null;
}): UsagePricingIssue[] {
  const issues: UsagePricingIssue[] = [];
  const agg = p.usageAggregation ?? (p.model === "usage" ? "sum" : null);
  if (p.usageAggregation != null && p.model !== "usage" && !METERABLE_MODELS.has(p.model))
    issues.push({
      field: "usage_aggregation",
      message: `A ${p.model} price cannot bill usage. Use the usage model for a price per unit of usage.`,
    });
  if (p.usageRecurring) {
    if (agg == null)
      issues.push({
        field: "usage_recurring",
        message: "Only a price that bills usage can carry the level. Set usage_aggregation.",
      });
    else if (!RECURRING_AGGREGATIONS.has(agg))
      issues.push({
        field: "usage_recurring",
        message: `The ${agg} aggregation cannot carry the level to the next period. Use sum, last, max, unique or weighted_sum.`,
      });
  }
  if (p.usageTimeUnit != null && agg !== "weighted_sum")
    issues.push({
      field: "usage_time_unit",
      message: "A time unit applies only to the weighted_sum aggregation.",
    });
  return issues;
}

/**
 * How a metered quantity grows inside a period, for a projection: `additive` (a running
 * total), `level` (a held level or count) or `time_weighted` (unit-hours accrue at the level).
 */
export function meteredGrowth(
  snapshot: Pick<PriceSnapshot, "model" | "usageAggregation" | "usageRecurring">,
): "additive" | "level" | "time_weighted" {
  const agg = snapshot.usageAggregation ?? "sum";
  if (agg === "weighted_sum") return "time_weighted";
  if (snapshot.usageRecurring) return "level";
  return agg === "sum" || agg === "count" ? "additive" : "level";
}

/** One broken rule in a tier list. `index` null = the list as a whole. */
export interface TierIssue {
  index: number | null;
  field: "upToMinor" | "rateBps" | "unitAmountMinor" | null;
  message: string;
}

/**
 * The rules a tier list must meet before we store it. Tiers start at the first unit and
 * each one ends above the previous one, so none has zero width; only the last tier is
 * unbounded, and it must be. `model` adds the per-model field rules. Stored rows are never
 * re-checked, so a legacy list keeps rating as it did.
 */
export function tierListIssues(
  tiers: readonly PriceTier[] | null | undefined,
  model?: string,
): TierIssue[] {
  if (!tiers || tiers.length === 0) {
    return model && TIER_MODELS.has(model)
      ? [{ index: null, field: null, message: "Add at least one tier." }]
      : [];
  }
  const issues: TierIssue[] = [];
  let prev: number | null = 0;
  tiers.forEach((t, i) => {
    const last = i === tiers.length - 1;
    const upTo = t.upToMinor;
    if (upTo == null) {
      if (!last)
        issues.push({
          index: i,
          field: "upToMinor",
          message: "Only the last tier can have no upper limit.",
        });
    } else if (last) {
      issues.push({
        index: i,
        field: "upToMinor",
        message: "The last tier must have no upper limit. Leave its upper limit empty.",
      });
    } else if (!Number.isInteger(upTo) || upTo < 1) {
      issues.push({ index: i, field: "upToMinor", message: "Enter a whole number of 1 or more." });
    } else if (prev != null && upTo <= prev) {
      issues.push({
        index: i,
        field: "upToMinor",
        message: "Each tier must end above the tier before it.",
      });
    }
    prev = upTo;
    if (model === "graduated_percentage") {
      if (t.rateBps == null)
        issues.push({ index: i, field: "rateBps", message: "Enter a rate for each tier." });
      if (t.unitAmountMinor != null)
        issues.push({
          index: i,
          field: "unitAmountMinor",
          message: "A graduated percentage tier has a rate, not a price per unit.",
        });
    } else if (model && t.rateBps != null) {
      issues.push({
        index: i,
        field: "rateBps",
        message: "Only a graduated percentage tier has a rate.",
      });
    }
  });
  return issues;
}

/**
 * The subset of price fields the rating math reads. Both a full `prices` row and
 * a price reconstructed from a `subscription_items.price_snapshot` satisfy it.
 */
export interface RatablePrice {
  model: string;
  amountMinor: bigint | null;
  tiers: unknown;
  packageSize: number | null;
  freeUnits: number | null;
  percentageBps: number | null;
  /** Units billed at 0 each period before the model rates the rest — see `computeLineAmount`. */
  freeQuantity: number | null;
}

/**
 * JSON-safe snapshot of a price's rating + billing fields, frozen onto a
 * subscription item at create/change time (BLUEPRINT: prices immutable for live
 * subs). `amountMinor` is stored as a number (minor units fit in a JS integer)
 * because jsonb can't carry a bigint. `tiers` is already plain JSON.
 */
export interface PriceSnapshot {
  priceId: string;
  publicId: string;
  model: string;
  type: string;
  currency: string;
  amountMinor: number | null;
  interval: string | null;
  intervalCount: number;
  usageAggregation: string | null;
  /** The level carries into later periods (0378). Absent = false. */
  usageRecurring?: boolean;
  /** `weighted_sum` unit (0378). Absent = null. */
  usageTimeUnit?: UsageTimeUnit | null;
  tiers: unknown;
  packageSize: number | null;
  freeUnits: number | null;
  percentageBps: number | null;
  /** The price's `free_quantity` when the item was attached. Absent on older snapshots. */
  freeQuantity?: number | null;
  /** Minimum spend per period, on the subscription's cycle. Absent = no minimum. */
  minimumAmountMinor?: number | null;
  /** true when `amountMinor` was overridden at subscription level (custom price). */
  amountOverridden?: boolean;
  /** the catalog `amountMinor` before override — kept for transparency. */
  catalogAmountMinor?: number | null;
  /**
   * The divisor rule: the item's own cadence was SHORTER than the
   * subscription's, so its amount was scaled by this integer multiple and the
   * `interval`/`intervalCount` above re-expressed on the subscription's cycle
   * (a ₹475/month add-on on a yearly plan → multiple 12, amount 5700_00, interval
   * `year`). Absent or 1 = the item already billed on the subscription's cadence.
   */
  cadenceMultiple?: number;
  /** the item's own catalog cadence, before it was aligned to the subscription's. */
  catalogInterval?: string | null;
  catalogIntervalCount?: number;
  /** 0453: set = the price bills from this meter's events. Absent on every other price. */
  meter?: SnapshotMeter;
  /** The rate card at attach, oldest first. A later rate edit never reprices the item. */
  rates?: MeterRate[];
  /** Minor units per `quantityDivisor` units, ≤ 12 dp. */
  unitAmountDecimal?: string | null;
  /** bigint as a string (jsonb has no bigint). */
  quantityDivisor?: string;
  /** rate | event_amount | event_cost | model_price_list | event_cost_or_list; open set. */
  amountSource?: string;
  markupPercent?: string | null;
  /** model_price_list: what a markup applies to. Absent or null = list. */
  markupBase?: MarkupBase | null;
  /** model_price_list: this customer's selling price, set on the item. Wins over the price. */
  sellingOverride?: SellingOverride;
}

export type MarkupBase = "list" | "cost";

/** A per-customer selling price on a `model_price_list` item (in its snapshot). */
export interface SellingOverride {
  /** Percent over the markup base for every combination no rate matches. */
  markupPercent: string | null;
  /** Per-combination rows: a fixed rate or a markup, never both. */
  rates: SellingOverrideRate[];
}

export interface SellingOverrideRate {
  match: Record<string, string>;
  /** Minor units per the price's `quantity_divisor` units. */
  unitAmountDecimal: string | null;
  markupPercent: string | null;
}

/** The meter a price bills from, as frozen on the snapshot. */
export interface SnapshotMeter {
  id: string;
  key: string;
  eventName: string;
  /** Ordered: group values follow this order. */
  groupBy: string[];
}

/** One tier on a meter price or rate: decimal bounds, a rate per divisor, a flat fee. */
export interface MeterTier {
  /** Inclusive upper bound in units (decimal string); null = unbounded last tier. */
  up_to: string | null;
  /** Minor units per `quantity_divisor` units, ≤ 12 dp. */
  unit_amount_decimal: string;
  flat_amount_minor?: number;
}

/** One rate-card row: a match over a subset of the meter's group_by, and its own numbers. */
export interface MeterRate {
  id: string;
  match: Record<string, string>;
  unitAmountDecimal: string | null;
  tiers: MeterTier[] | null;
  /** model_price_list: percent over the markup base, in place of a fixed rate. */
  markupPercent?: string | null;
}

/** Cadence units that convert exactly among themselves. Day↔month has no exact
 *  conversion (a month is not 30 days), so the two families never mix. */
const MONTH_UNITS: Record<string, number> = { month: 1, year: 12 };
const DAY_UNITS: Record<string, number> = { day: 1, week: 7 };

/**
 * How many times an item's own billing period fits into the subscription's cycle
 * — the "billing cycle for addons" rule. Returns the integer multiple, or
 * `null` when the item's period does NOT divide the cycle exactly.
 *
 * A monthly add-on on a yearly plan → **12** (billed 12× its monthly rate, once a
 * year, on the plan's cycle: one unit at a unit price of 12 × the rate).
 * A yearly add-on on a monthly plan → **null**: the subscription's cycle would end
 * before the item's period does, so there is no amount to charge for one cycle.
 * The rule is deliberately one-directional — only items billing at least as often
 * as the subscription can be folded into its cycle.
 *
 * Cross-family (a 15-day add-on on a monthly plan) returns `null` rather than
 * guessing a 30-day month.
 */
export function cadenceMultiple(
  cycle: { interval: string; intervalCount: number },
  item: { interval: string | null; intervalCount: number | null },
): number | null {
  const itemInterval = item.interval ?? "month";
  const itemCount = item.intervalCount ?? 1;
  if (itemCount <= 0 || cycle.intervalCount <= 0) return null;
  for (const units of [MONTH_UNITS, DAY_UNITS]) {
    const cycleUnit = units[cycle.interval];
    const itemUnit = units[itemInterval];
    if (cycleUnit == null || itemUnit == null) continue; // not this family
    const cycleSpan = cycleUnit * cycle.intervalCount;
    const itemSpan = itemUnit * itemCount;
    if (itemSpan <= 0 || cycleSpan % itemSpan !== 0) return null;
    return cycleSpan / itemSpan;
  }
  return null;
}

/**
 * Re-express a recurring item's snapshot on the SUBSCRIPTION's cycle, per
 * `cadenceMultiple`. A monthly ₹475 add-on on a yearly plan becomes ₹5,700/year —
 * the invoice prints one unit at the scaled rate rather than 12 units at the
 * monthly rate.
 *
 * Doing this once, at snapshot time, is what keeps every downstream reader correct
 * without knowing the rule exists: invoicing, `recurringChargeMinor`, proration,
 * cycle caps and MRR all rate the snapshot, and MRR's normalization turns
 * ₹5,700/year back into ₹475/month on its own.
 *
 * Scaling is restricted to `OVERRIDABLE_MODELS` (flat/per-unit, the single-amount
 * models). Scaling a tier table, package size or percentage has no unambiguous
 * meaning, so those keep requiring an exact cadence match — see `cadenceMismatch`.
 */
export function alignSnapshotToCycle(
  snap: PriceSnapshot,
  cycle: { interval: string; intervalCount: number },
): PriceSnapshot {
  if (snap.type !== "recurring" || !isOverridable(snap.model)) return snap;
  const multiple = cadenceMultiple(cycle, snap);
  if (multiple == null || multiple === 1) return snap;
  return {
    ...snap,
    amountMinor: snap.amountMinor != null ? snap.amountMinor * multiple : null,
    ...(snap.minimumAmountMinor != null
      ? { minimumAmountMinor: snap.minimumAmountMinor * multiple }
      : {}),
    interval: cycle.interval,
    intervalCount: cycle.intervalCount,
    cadenceMultiple: multiple,
    catalogInterval: snap.interval,
    catalogIntervalCount: snap.intervalCount,
  };
}

/**
 * Undo `alignSnapshotToCycle`, recovering the item's own-cadence amount.
 *
 * `alignSnapshotToCycle` scales from `snap.interval`, so it is NOT idempotent across a
 * CHANGE of cycle: handed an already-×12 yearly snapshot and a monthly cycle,
 * `cadenceMultiple` returns null (1 month does not divide 12 months) and the snapshot
 * comes back untouched — leaving ₹9,024 **per month**. Re-aligning therefore has to rewind
 * first, which is what `cadenceMultiple` / `catalogInterval` / `catalogIntervalCount` were
 * recorded for.
 *
 * Division is exact: the forward step is a plain multiplication by the same integer.
 *
 * ⚠️ It rewinds the EFFECTIVE amount, not `catalogAmountMinor`. A differential add-on's
 * catalog list price is 0 and the real figure lives in the override (`amountOverridden`),
 * so reconstructing from the catalog would silently zero the item — measured on the real
 * catalog, where the connections add-on is ₹0 base with a ₹752 per-plan differential.
 */
export function deAlignSnapshotFromCycle(snap: PriceSnapshot): PriceSnapshot {
  const multiple = snap.cadenceMultiple;
  if (!multiple || multiple === 1) return snap;
  const { cadenceMultiple: _m, catalogInterval: _i, catalogIntervalCount: _c, ...rest } = snap;
  return {
    ...rest,
    amountMinor: snap.amountMinor != null ? snap.amountMinor / multiple : null,
    ...(snap.minimumAmountMinor != null
      ? { minimumAmountMinor: snap.minimumAmountMinor / multiple }
      : {}),
    interval: snap.catalogInterval ?? snap.interval,
    intervalCount: snap.catalogIntervalCount ?? snap.intervalCount,
  };
}

/**
 * Re-express an item's snapshot on a NEW subscription cycle — the term-reset counterpart
 * of `alignSnapshotToCycle`, which only ever runs against the cycle an item is joining.
 *
 * A frequency change (monthly → yearly) resets the term but leaves every other item where
 * it was, so a monthly add-on ends up on a yearly plan: it must bill 12× the monthly price
 * for the year, and we billed one month. Rewind then re-scale so a
 * monthly→yearly change multiplies and a yearly→monthly change divides back.
 */
export function realignSnapshotToCycle(
  snap: PriceSnapshot,
  cycle: { interval: string; intervalCount: number },
): PriceSnapshot {
  return alignSnapshotToCycle(deAlignSnapshotFromCycle(snap), cycle);
}

/**
 * Freeze a price row into a JSON-safe snapshot for a subscription item.
 *
 * `overrideAmountMinor` (optional) applies a **subscription-level custom price**:
 * the effective `amountMinor` becomes the override while every other rating field
 * (model, interval, tiers, …) is preserved from the catalog price. It replaces the
 * flat/per-unit amount — downstream billing reads `amountMinor` unchanged, so no
 * other code needs to know an override happened.
 */
export function snapshotPrice(
  price: typeof prices.$inferSelect,
  overrideAmountMinor?: number | null,
  overrideTiers?: unknown,
): PriceSnapshot {
  const catalogAmount = price.amountMinor != null ? Number(price.amountMinor) : null;
  const overridden = overrideAmountMinor != null;
  return {
    priceId: price.id,
    publicId: price.publicId,
    model: price.model,
    type: price.type,
    currency: price.currency,
    amountMinor: overridden ? overrideAmountMinor! : catalogAmount,
    interval: price.interval,
    intervalCount: price.intervalCount,
    usageAggregation: price.usageAggregation,
    ...(price.usageRecurring ? { usageRecurring: true } : {}),
    ...(price.usageTimeUnit ? { usageTimeUnit: price.usageTimeUnit as UsageTimeUnit } : {}),
    // CAT-7: a tiered differential overrides the tier table for this plan.
    tiers: overrideTiers != null ? overrideTiers : price.tiers,
    packageSize: price.packageSize,
    freeUnits: price.freeUnits,
    percentageBps: price.percentageBps,
    freeQuantity: price.freeQuantity,
    ...(price.minimumAmountMinor != null
      ? { minimumAmountMinor: Number(price.minimumAmountMinor) }
      : {}),
    ...(overridden ? { amountOverridden: true, catalogAmountMinor: catalogAmount } : {}),
  };
}

/** A meter price's meter and rate card, loaded once for `snapshotPrice`. */
export interface MeterPricing {
  meter: SnapshotMeter;
  rates: MeterRate[];
}

/**
 * Freeze a meter price's meter and rate card onto a snapshot. `syncMeterBilling` runs it on
 * every attach path, in the attach transaction, so a rate edit never reprices a live item.
 */
export function applyMeterPricing(
  snap: PriceSnapshot,
  price: Pick<
    typeof prices.$inferSelect,
    "unitAmountDecimal" | "quantityDivisor" | "amountSource" | "markupPercent" | "markupBase"
  >,
  mp: MeterPricing,
): PriceSnapshot {
  return {
    ...snap,
    meter: mp.meter,
    rates: mp.rates,
    unitAmountDecimal:
      price.unitAmountDecimal != null
        ? formatFixed12(fixed12FromNumeric(price.unitAmountDecimal))
        : null,
    quantityDivisor: String(price.quantityDivisor),
    amountSource: price.amountSource,
    markupPercent:
      price.markupPercent != null ? formatFixed12(fixed12FromNumeric(price.markupPercent)) : null,
    ...(billsFromList(price.amountSource)
      ? { markupBase: (price.markupBase as MarkupBase | null) ?? "list" }
      : {}),
  };
}

/**
 * The meter and rate card for every meter price in `priceRows`, keyed by price id. One query
 * each; non-meter prices are absent. Pass the entry to `snapshotPrice`.
 */
export async function loadMeterPricing(
  tx: Tx,
  priceRows: ReadonlyArray<Pick<typeof prices.$inferSelect, "id" | "meterId">>,
): Promise<Map<string, MeterPricing>> {
  const out = new Map<string, MeterPricing>();
  const metered = priceRows.filter((p) => p.meterId);
  if (metered.length === 0) return out;
  const meterIds = [...new Set(metered.map((p) => p.meterId!))];
  const meterRows = await tx
    .select({
      id: meters.id,
      key: meters.key,
      eventName: meters.eventName,
      groupBy: meters.groupBy,
    })
    .from(meters)
    .where(inArray(meters.id, meterIds));
  const meterById = new Map(meterRows.map((m) => [m.id, m]));
  const rateRows = await tx
    .select()
    .from(priceRates)
    .where(
      inArray(
        priceRates.priceId,
        metered.map((p) => p.id),
      ),
    )
    .orderBy(asc(priceRates.createdAt), asc(priceRates.id));
  for (const p of metered) {
    const m = meterById.get(p.meterId!);
    if (!m) continue;
    out.set(p.id, {
      meter: { id: m.id, key: m.key, eventName: m.eventName, groupBy: [...m.groupBy] },
      rates: rateRows
        .filter((r) => r.priceId === p.id)
        .map((r) => ({
          id: r.id,
          match: r.match,
          unitAmountDecimal:
            r.unitAmountDecimal != null
              ? formatFixed12(fixed12FromNumeric(r.unitAmountDecimal))
              : null,
          tiers: (r.tiers as MeterTier[] | null) ?? null,
          ...(r.markupPercent != null
            ? { markupPercent: formatFixed12(fixed12FromNumeric(r.markupPercent)) }
            : {}),
        })),
    });
  }
  return out;
}

/**
 * Models whose price is a single flat/per-unit amount that a subscription-level
 * custom price can override (tiered/volume/percentage/package are driven by
 * other fields).
 */
export const OVERRIDABLE_MODELS = new Set(["flat", "per_unit"]);
export const isOverridable = (model: string) => OVERRIDABLE_MODELS.has(model);

/**
 * Human-readable label for a price on an invoice line: prefer the
 * customer-facing `external_name`, then the internal `name`, then the PRODUCT's
 * name, then the slug id.
 *
 * The product step is not cosmetic. Our platform prices carry neither an
 * `external_name` nor a `name` — the name lives on the product — so the chain used to
 * reach the slug on every one of them, and a buyer's invoice PDF read
 * "platform-lite-v202607-INR-Monthly": an internal handle with a version stamp and a
 * currency in it, where the line should read "LITE plan". The slug remains the last resort,
 * because a line with no name at all is worse than an ugly one.
 *
 * `product` is optional so a caller that genuinely has only the price still compiles —
 * but every line-building path passes it, since a line without a product is a line
 * nobody can name.
 */
export function priceLabel(
  price: { externalName?: string | null; name?: string | null; publicId: string },
  product?: { name?: string | null } | null,
): string {
  return price.externalName ?? price.name ?? product?.name ?? price.publicId;
}

/**
 * A `priceLabel` bound to a transaction, resolving the PRODUCT name the fallback needs and
 * memoising it per product.
 *
 * Exists because `priceLabel` is pure and the product name is a row. `changeSubscription`
 * and `estimateChange` each grew their own identical copy of this closure when the product
 * fallback landed, which is two places for one naming rule — and those two must agree
 * exactly, since `verify:estimates` asserts the preview and the booking describe a line the
 * same way. One implementation makes that structural instead of a coincidence.
 *
 * One change touches a handful of products and this is called once per line built, so the
 * memo turns N line-lookups into one query per product.
 */
export function makePriceLabeller(
  tx: Tx,
): (price: {
  productId: string;
  externalName?: string | null;
  name?: string | null;
  publicId: string;
}) => Promise<string> {
  const nameByProductId = new Map<string, string | null>();
  return async (price) => {
    if (!nameByProductId.has(price.productId)) {
      const [row] = await tx
        .select({ name: products.name })
        .from(products)
        .where(eq(products.id, price.productId))
        .limit(1);
      nameByProductId.set(price.productId, row?.name ?? null);
    }
    return priceLabel(price, { name: nameByProductId.get(price.productId) ?? null });
  };
}

/**
 * The billing-cycle cap for a subscription item — how many cycles its price may
 * be rated before billing stops re-charging it. An EXPLICIT `billing_cycles`
 * always wins; absent one, a `one_time` price snapshot gets an IMPLICIT cap of 1
 * — it is billed once, by definition (see invoicing/README.md's 2026-08-03 entry:
 * a one-off fee attached as a subscription item was re-billed on every renewal
 * until this was derived from the price TYPE rather than left to a column
 * nobody sets).
 *
 * Single source of truth for the rule — shared by `planSubscriptionPeriodInvoice`
 * (the actual booking, `invoicing/service.ts`) and `estimateChange`'s in-trial
 * preview (`subscriptions/estimate.ts`), so a preview can never independently
 * drift from what renewal will actually charge.
 */
export function itemCycleCap(
  billingCycles: number | null | undefined,
  snapshotType: string,
): number | null {
  return billingCycles ?? (snapshotType === "one_time" ? 1 : null);
}

/** Whether an item has exhausted `itemCycleCap(...)` and should stop being rated. */
export function isCycleCapExhausted(
  billingCycles: number | null | undefined,
  snapshotType: string,
  cyclesBilled: number,
): boolean {
  const cap = itemCycleCap(billingCycles, snapshotType);
  return cap != null && cyclesBilled >= cap;
}

/**
 * The free units an item gets each period: the item's own `free_quantity` wins (0 included),
 * else the price's, frozen into the snapshot at attach. A later price edit never reaches a
 * live item.
 */
export function effectiveFreeQuantity(
  itemFreeQuantity: number | null | undefined,
  snap: Pick<PriceSnapshot, "freeQuantity"> | null | undefined,
): number {
  return Math.max(0, itemFreeQuantity ?? snap?.freeQuantity ?? 0);
}

/**
 * Reconstruct the rating fields (amountMinor back to bigint) from a snapshot.
 * `itemFreeQuantity` is the item's own `free_quantity` column — required so every caller
 * decides; pass `null` when the line has no item value (the price's then applies).
 */
export function ratableFromSnapshot(
  s: PriceSnapshot,
  itemFreeQuantity: number | null | undefined,
): RatablePrice {
  return {
    model: s.model,
    amountMinor: s.amountMinor != null ? BigInt(s.amountMinor) : null,
    tiers: s.tiers,
    packageSize: s.packageSize,
    freeUnits: s.freeUnits,
    percentageBps: s.percentageBps,
    freeQuantity: effectiveFreeQuantity(itemFreeQuantity, s),
  };
}

/**
 * A subscription item's ratable: its frozen snapshot plus its own `free_quantity`. A legacy
 * item without a snapshot rates the live price row.
 */
export function ratableForItem(
  item: { priceSnapshot: unknown; freeQuantity: number | null },
  price: typeof prices.$inferSelect,
): RatablePrice {
  const snap = (item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(price);
  return ratableFromSnapshot(snap, item.freeQuantity);
}

/** Models `free_quantity` does not apply to: flat ignores quantity; percentage models rate money. */
const NO_FREE_QUANTITY_MODELS = new Set(["flat", ...PERCENT_OF_BASE_MODELS]);

/** The quantity the model rates once `freeQuantity` is taken off. Never below 0. */
export function billableQuantity(price: RatablePrice, quantity: number): number {
  if (NO_FREE_QUANTITY_MODELS.has(price.model)) return quantity;
  const free = price.freeQuantity ?? 0;
  return free > 0 ? Math.max(0, quantity - free) : quantity;
}

/**
 * What an item bills for its `quantity` outside usage rating: proration, add/remove,
 * term reset, recurring totals. A metered price bills only measured usage, so 0.
 */
export function fixedChargeMinor(
  snap: { model: string; usageAggregation?: string | null },
  ratable: RatablePrice,
  quantity: number,
): bigint {
  return isMeteredPrice(snap) ? 0n : computeLineAmount(ratable, quantity);
}

/** The rate for one unit, free quantity ignored — the line's stated unit price. */
export function unitRate(price: RatablePrice): bigint {
  return computeLineAmount({ ...price, freeQuantity: null }, 1);
}

/**
 * Compute the charge for a price at a given quantity, in integer minor units.
 *  - flat:     fixed amount (quantity ignored)
 *  - per_unit: unit amount × quantity
 *  - volume:   all units at the rate of the tier the quantity lands in
 *  - tiered:   graduated — each tier's units billed at that tier's rate
 *  - stairstep: flat price of the tier the quantity lands in (one fixed fee per
 *              band; quantity within the band doesn't matter). Zero qty → 0.
 *  - usage:    rated like per_unit on the aggregated usage quantity (passed in)
 *  - package:  charge `amountMinor` per package of `packageSize` units, after
 *              `freeUnits`; partial packages round UP
 *  - percentage: charge `percentageBps` basis points of the base value
 *              (quantity = base in minor units), after `freeUnits` of free base.
 *              Rounded half-up. Base ≤ free → 0. (e.g. "2.5% of transaction volume")
 *  - graduated_percentage: graduated tiers over the base (minor units); each tier
 *              takes `rateBps` of the part of the base inside it, plus its flat fee
 *              once the base reaches it. Rounded half-up once, on the total.
 * Returns bigint minor units. Usage/package/percentage with no billable base → 0.
 *
 * `freeQuantity` comes off the quantity FIRST, every period, and the model rates what is left
 * (`billableQuantity`): 10 seats with 3 free at 100 → 700. On a tier table the billable units
 * fill from the first tier, and a volume/stairstep band is picked by the billable count. A
 * package price takes `freeQuantity` and then its own `freeUnits`.
 */
export function computeLineAmount(price: RatablePrice, rawQuantity: number): bigint {
  const quantity = billableQuantity(price, rawQuantity);
  switch (price.model) {
    case "flat":
      return BigInt(price.amountMinor ?? 0n);
    case "per_unit":
    case "usage":
      return BigInt(price.amountMinor ?? 0n) * BigInt(quantity);
    case "volume":
      return volumeAmount(asTiers(price.tiers), quantity);
    case "tiered":
      return tieredAmount(asTiers(price.tiers), quantity);
    case "stairstep":
      return stairstepAmount(asTiers(price.tiers), quantity);
    case "package":
      return packageAmount(price, quantity);
    case "percentage":
      return percentageAmount(price, quantity);
    case "graduated_percentage":
      return graduatedPercentageAmount(asTiers(price.tiers), quantity);
    default:
      return 0n;
  }
}

/** One tier's share of a rated quantity. `from`/`to` are unit bounds (inclusive). */
export interface RatedTier {
  from: bigint;
  to: bigint | null;
  units: bigint;
  unitAmountMinor: bigint;
  flatAmountMinor: bigint;
  amountMinor: bigint;
}

/**
 * Rate a measured quantity for a metered price: free quantity first, then the model.
 * `amountMinor` always equals `computeLineAmount`; `tiers` breaks it down for the unit tier
 * models (tiered, volume, stairstep). Zero usage rates 0 under every model.
 */
export function rateMeteredQuantity(input: {
  snapshot: PriceSnapshot;
  itemFreeQuantity: number | null;
  quantity: bigint;
}): {
  amountMinor: bigint;
  unitAmountMinor: bigint;
  billableQuantity: bigint;
  tiers?: RatedTier[];
} {
  const ratable = ratableFromSnapshot(input.snapshot, input.itemFreeQuantity);
  const qty = input.quantity > 0n ? input.quantity : 0n;
  if (qty > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError(`Usage quantity ${qty} is too large to rate.`);
  const n = Number(qty);
  const billable = billableQuantity(ratable, n);
  const amountMinor = n > 0 ? computeLineAmount(ratable, n) : 0n;
  // Usage states its rate: with free units, amount / qty would be an average.
  const unitAmountMinor =
    input.snapshot.model === "usage" ? unitRate(ratable) : qty > 0n ? amountMinor / qty : 0n;
  const tiers = TIER_MODELS.has(ratable.model)
    ? ratedTiers(ratable.model, asTiers(ratable.tiers), billable)
    : undefined;
  return { amountMinor, unitAmountMinor, billableQuantity: BigInt(billable), tiers };
}

/** The tier rows behind `computeLineAmount` for the unit tier models; none for the others. */
function ratedTiers(model: string, tiers: PriceTier[], quantity: number): RatedTier[] | undefined {
  if (model === "graduated_percentage") return undefined;
  if (quantity <= 0) return [];
  const rows: RatedTier[] = [];
  let lower = 0;
  for (const tier of tiers) {
    const cap = tier.upToMinor;
    const unit = BigInt(tier.unitAmountMinor ?? 0);
    const flat = BigInt(tier.flatAmountMinor ?? 0);
    const to = cap == null ? null : BigInt(cap);
    if (model === "tiered") {
      const units = Math.min(quantity, cap ?? Infinity) - lower;
      if (units > 0) {
        const u = BigInt(units);
        rows.push({
          from: BigInt(lower + 1),
          to,
          units: u,
          unitAmountMinor: unit,
          flatAmountMinor: flat,
          amountMinor: unit * u + flat,
        });
      }
      if (cap == null || quantity <= cap) break;
    } else if (cap == null || quantity <= cap) {
      // volume / stairstep: the band the whole quantity lands in.
      const u = BigInt(quantity);
      const amount = model === "volume" ? unit * u + flat : flat;
      rows.push({
        from: BigInt(lower + 1),
        to,
        units: u,
        unitAmountMinor: model === "volume" ? unit : 0n,
        flatAmountMinor: flat,
        amountMinor: amount,
      });
      break;
    }
    if (cap != null) lower = cap;
  }
  return rows;
}

/**
 * Percentage: round(percentageBps × (base − freeUnits) / 10000), half-up, ≥ 0.
 * `base` is the monetary value to take a cut of (passed as `quantity`, minor units).
 */
function percentageAmount(price: RatablePrice, base: number): bigint {
  const bps = price.percentageBps ?? 0;
  const free = price.freeUnits ?? 0;
  if (bps <= 0) return 0n;
  const billable = base - free;
  if (billable <= 0) return 0n;
  // Integer half-up: (billable·bps + 5000) / 10000.
  return (BigInt(billable) * BigInt(bps) + 5000n) / 10000n;
}

/**
 * Graduated percentage over a money base. Tier i holds the base in (previous bound, its
 * bound]: tiers 0–1000 and 1000–2000 at a base of 1500 rate 1000 and 500. A tier the base
 * reaches adds its flat fee once. Summed in 1/10000 minor units, rounded half-up once.
 */
function graduatedPercentageAmount(tiers: PriceTier[], base: number): bigint {
  if (base <= 0) return 0n;
  let lower = 0;
  let total = 0n;
  for (const tier of tiers) {
    if (base <= lower) break;
    const inTier = Math.min(base, tier.upToMinor ?? Infinity) - lower;
    total += BigInt(inTier) * BigInt(tier.rateBps ?? 0);
    total += BigInt(tier.flatAmountMinor ?? 0) * 10000n;
    if (tier.upToMinor == null) break;
    lower = tier.upToMinor;
  }
  return (total + 5000n) / 10000n;
}

/**
 * The minimum for a billed window, prorated when the window is shorter than a full period
 * (`fullPeriodMs`, measured from the window's start): minimum × window ÷ full, rounded
 * half-up, as `prorate` does for mid-term changes. A window as long as a full period or
 * longer takes the whole minimum.
 */
export function proratedMinimum(
  minimumMinor: bigint,
  windowMs: number,
  fullPeriodMs: number,
): bigint {
  if (minimumMinor <= 0n || windowMs <= 0) return 0n;
  if (fullPeriodMs <= 0 || windowMs >= fullPeriodMs) return minimumMinor;
  const w = BigInt(Math.floor(windowMs));
  const f = BigInt(Math.floor(fullPeriodMs));
  return (minimumMinor * w + f / 2n) / f;
}

/** The true-up that lifts a line to its (prorated) minimum; 0 when it is already there. */
export function minimumTrueUp(
  minimumMinor: bigint,
  lineAmountMinor: bigint,
  windowMs: number,
  fullPeriodMs: number,
): bigint {
  const floor = proratedMinimum(minimumMinor, windowMs, fullPeriodMs);
  return floor > lineAmountMinor ? floor - lineAmountMinor : 0n;
}

/** Package: ceil((qty − freeUnits) / packageSize) × amount. Free units billed at 0. */
function packageAmount(price: RatablePrice, quantity: number): bigint {
  const size = price.packageSize ?? 0;
  const free = price.freeUnits ?? 0;
  if (size <= 0) return 0n;
  const billable = quantity - free;
  if (billable <= 0) return 0n;
  const packages = Math.ceil(billable / size);
  return BigInt(price.amountMinor ?? 0n) * BigInt(packages);
}

function asTiers(raw: unknown): PriceTier[] {
  return Array.isArray(raw) ? (raw as PriceTier[]) : [];
}

/** Volume: find the tier the quantity falls in; charge all units at that rate. */
function volumeAmount(tiers: PriceTier[], quantity: number): bigint {
  // Zero usage → no charge (not even the tier flat fee).
  if (quantity <= 0) return 0n;
  for (const tier of tiers) {
    if (tier.upToMinor === null || quantity <= tier.upToMinor) {
      const unit = BigInt(tier.unitAmountMinor ?? 0) * BigInt(quantity);
      return unit + BigInt(tier.flatAmountMinor ?? 0);
    }
  }
  return 0n;
}

/**
 * Stairstep: charge the FLAT price of the tier the quantity lands in — one fixed
 * fee per band, independent of quantity within the band. (e.g. 1–10 users = $90,
 * 11–20 = $180.) The band's price is `flatAmountMinor`. Zero qty → no charge.
 */
function stairstepAmount(tiers: PriceTier[], quantity: number): bigint {
  if (quantity <= 0) return 0n;
  for (const tier of tiers) {
    if (tier.upToMinor === null || quantity <= tier.upToMinor) {
      return BigInt(tier.flatAmountMinor ?? 0);
    }
  }
  return 0n;
}

/** Graduated: fill each tier in order; bill the units within each at its rate. */
function tieredAmount(tiers: PriceTier[], quantity: number): bigint {
  let remaining = quantity;
  let prevCap = 0;
  let total = 0n;
  for (const tier of tiers) {
    if (remaining <= 0) break;
    const cap = tier.upToMinor === null ? Infinity : tier.upToMinor;
    const tierUnits = Math.min(remaining, cap - prevCap);
    if (tierUnits > 0) {
      total += BigInt(tier.unitAmountMinor ?? 0) * BigInt(tierUnits);
      total += BigInt(tier.flatAmountMinor ?? 0);
      remaining -= tierUnits;
    }
    prevCap = cap === Infinity ? prevCap : cap;
  }
  return total;
}

// ── Meter prices (Tier 3 G2) ─────────────────────────────────────────────────────────────

/** Models a meter price may use. */
export const METER_PRICE_MODELS = new Set(["usage", "tiered", "volume", "package"]);
/** `amount_source` values this build rates. Open set: stored as text, checked by the API. */
export const AMOUNT_SOURCES = [
  "rate",
  "event_amount",
  "event_cost",
  "model_price_list",
  "event_cost_or_list",
] as const;

/**
 * Prices that bill from the model price list. `event_cost_or_list` bills an event's own cost
 * first (+ markup) and the list only for events without one (design G1c).
 */
export function billsFromList(source: string | null | undefined): boolean {
  return source === "model_price_list" || source === "event_cost_or_list";
}
export const MAX_PRICE_RATES = 500;
const MARKUP_MAX_DECIMALS = 6;

/** One broken rule in a meter price, keyed by the API field. */
export interface MeterPriceIssue {
  field: string;
  message: string;
}

/** A meter price's numbers as the API sends them (snake case, decimal strings). */
export interface MeterPriceInput {
  model: string;
  type?: string;
  amountSource?: string;
  unitAmountDecimal?: string | null;
  quantityDivisor?: string | number | null;
  markupPercent?: string | null;
  markupBase?: string | null;
  tiers?: unknown;
  packageSize?: number | null;
  rates?: ReadonlyArray<{
    match: Record<string, unknown>;
    unitAmountDecimal?: string | null;
    tiers?: unknown;
    markupPercent?: string | null;
  }>;
  /** The meter's aggregation and recurrence: model_price_list sums a running total. */
  meterAggregation?: string;
  meterRecurring?: boolean;
}

const decimalIssue = (
  field: string,
  label: string,
  v: string,
  maxDp = 12,
): MeterPriceIssue | null => {
  const f = tryParseFixed12(v);
  if (f == null || f < 0n || (maxDp < 12 && (v.split(".")[1]?.length ?? 0) > maxDp))
    return {
      field,
      message: `${label} must be a number of 0 or more with at most ${maxDp} decimal places, with no exponent.`,
    };
  return null;
};

/** Rules for a meter tier list; `prefix` is the API path of the list. */
export function meterTierIssues(raw: unknown, prefix: string): MeterPriceIssue[] {
  if (!Array.isArray(raw) || raw.length === 0)
    return [{ field: prefix, message: "Add at least one tier." }];
  const issues: MeterPriceIssue[] = [];
  let prev: bigint = 0n;
  raw.forEach((t: unknown, i) => {
    const tier = (t ?? {}) as Partial<MeterTier>;
    const at = `${prefix}.${i}`;
    const last = i === raw.length - 1;
    if (typeof tier.unit_amount_decimal !== "string") {
      issues.push({ field: `${at}.unit_amount_decimal`, message: "Enter a rate for each tier." });
    } else {
      const d = decimalIssue(`${at}.unit_amount_decimal`, "The rate", tier.unit_amount_decimal);
      if (d) issues.push(d);
    }
    if (
      tier.flat_amount_minor != null &&
      (!Number.isInteger(tier.flat_amount_minor) || tier.flat_amount_minor < 0)
    )
      issues.push({
        field: `${at}.flat_amount_minor`,
        message: "Enter a whole number of 0 or more.",
      });
    if (tier.up_to == null) {
      if (!last)
        issues.push({
          field: `${at}.up_to`,
          message: "Only the last tier can have no upper limit.",
        });
      return;
    }
    if (last) {
      issues.push({
        field: `${at}.up_to`,
        message: "The last tier must have no upper limit. Leave its upper limit empty.",
      });
      return;
    }
    const up = typeof tier.up_to === "string" ? tryParseFixed12(tier.up_to) : null;
    if (up == null || up <= 0n) {
      issues.push({
        field: `${at}.up_to`,
        message: "Enter a number above 0 with at most 12 decimal places.",
      });
      return;
    }
    if (up <= prev)
      issues.push({
        field: `${at}.up_to`,
        message: "Each tier must end above the tier before it.",
      });
    prev = up;
  });
  return issues;
}

/**
 * The rules for a meter price: a meter model, a known amount source, the numbers that source
 * needs and nothing it does not. Rates match on group_by properties only, one row per match.
 */
export function meterPriceIssues(
  p: MeterPriceInput,
  groupBy: readonly string[],
): MeterPriceIssue[] {
  const issues: MeterPriceIssue[] = [];
  const source = p.amountSource ?? "rate";
  if (!METER_PRICE_MODELS.has(p.model))
    issues.push({
      field: "model",
      message: `A price on a meter cannot use the ${p.model} model. Use usage, tiered, volume or package.`,
    });
  if (p.type === "one_time")
    issues.push({ field: "type", message: "A price on a meter must be recurring." });
  if (!(AMOUNT_SOURCES as readonly string[]).includes(source))
    issues.push({
      field: "amount_source",
      message:
        "The amount source must be rate, event_amount, event_cost, model_price_list or event_cost_or_list.",
    });
  const divisor =
    p.quantityDivisor == null
      ? 1n
      : /^\d{1,18}$/.test(String(p.quantityDivisor))
        ? BigInt(p.quantityDivisor)
        : 0n;
  if (divisor < 1n)
    issues.push({
      field: "quantity_divisor",
      message: "The quantity divisor must be a whole number of 1 or more.",
    });
  if (p.markupPercent != null) {
    if (source !== "event_cost" && !billsFromList(source))
      issues.push({
        field: "markup_percent",
        message:
          "A markup applies only to the event_cost, model_price_list and event_cost_or_list amount sources.",
      });
    else {
      const d = decimalIssue("markup_percent", "The markup", p.markupPercent, MARKUP_MAX_DECIMALS);
      if (d) issues.push(d);
    }
  }
  if (p.markupBase != null) {
    if (!billsFromList(source))
      issues.push({
        field: "markup_base",
        message:
          "A markup base applies only to the model_price_list and event_cost_or_list amount sources.",
      });
    else if (p.markupBase !== "list" && p.markupBase !== "cost")
      issues.push({ field: "markup_base", message: "The markup base must be list or cost." });
  }
  if (!billsFromList(source))
    (p.rates ?? []).forEach((r, i) => {
      if (r.markupPercent != null)
        issues.push({
          field: `rates.${i}.markup_percent`,
          message:
            "A rate can have a markup only on a model_price_list or event_cost_or_list price.",
        });
    });
  if (billsFromList(source)) {
    issues.push(...modelPriceListIssues(p, groupBy));
    return issues;
  }
  if (source !== "rate") {
    if (p.model !== "usage")
      issues.push({
        field: "model",
        message: "A price that bills the event amount or cost must use the usage model.",
      });
    if (p.unitAmountDecimal != null || p.tiers != null || (p.rates?.length ?? 0) > 0)
      issues.push({
        field: "amount_source",
        message: "A price that bills the event amount or cost has no rate, tiers or rate card.",
      });
    return issues;
  }
  const tiered = p.model === "tiered" || p.model === "volume";
  const checkNumbers = (prefix: string, unit: string | null | undefined, tiers: unknown) => {
    const at = (f: string) => (prefix ? `${prefix}.${f}` : f);
    if (tiered) {
      if (unit != null)
        issues.push({
          field: at("unit_amount_decimal"),
          message: "A tiered price states its rates in its tiers.",
        });
      issues.push(...meterTierIssues(tiers, at("tiers")));
    } else {
      if (tiers != null)
        issues.push({ field: at("tiers"), message: `A ${p.model} price has no tiers.` });
      if (unit == null)
        issues.push({
          field: at("unit_amount_decimal"),
          message: "Enter a rate (unit_amount_decimal).",
        });
      else {
        const d = decimalIssue(at("unit_amount_decimal"), "The rate", unit);
        if (d) issues.push(d);
      }
    }
  };
  checkNumbers("", p.unitAmountDecimal, p.tiers);
  if (p.model === "package") {
    if (p.packageSize == null || p.packageSize < 1)
      issues.push({
        field: "package_size",
        message: "A package price needs a package_size of 1 or more.",
      });
    if (divisor !== 1n)
      issues.push({
        field: "quantity_divisor",
        message: "A package price states its size in package_size. Leave quantity_divisor at 1.",
      });
  }
  const rates = p.rates ?? [];
  if (rates.length > MAX_PRICE_RATES)
    issues.push({ field: "rates", message: `A price can have at most ${MAX_PRICE_RATES} rates.` });
  const seen = new Set<string>();
  rates.forEach((r, i) => {
    const keys = Object.keys(r.match ?? {});
    if (keys.length === 0)
      issues.push({
        field: `rates.${i}.match`,
        message: "A rate must match at least one property. The price's own rate is the default.",
      });
    for (const k of keys) {
      if (!groupBy.includes(k))
        issues.push({
          field: `rates.${i}.match.${k}`,
          message: `The meter does not group by ${k}. Match only on its group_by properties.`,
        });
      if (typeof r.match[k] !== "string")
        issues.push({ field: `rates.${i}.match.${k}`, message: "A match value must be a string." });
    }
    const canon = canonicalMatch(r.match as Record<string, string>);
    if (seen.has(canon))
      issues.push({
        field: `rates.${i}.match`,
        message: "Two rates have the same match. Keep one.",
      });
    seen.add(canon);
    checkNumbers(`rates.${i}`, r.unitAmountDecimal, r.tiers);
  });
  return issues;
}

/**
 * A `model_price_list` price: the usage model on a summed (or counted) meter; its own
 * `unit_amount_decimal` is the default rate for a combination with no price; each rate is a
 * fixed rate or a markup, never tiers.
 */
function modelPriceListIssues(p: MeterPriceInput, groupBy: readonly string[]): MeterPriceIssue[] {
  const issues: MeterPriceIssue[] = [];
  if (p.model !== "usage")
    issues.push({
      field: "model",
      message: "A price that bills from the model price list must use the usage model.",
    });
  if (
    (p.meterAggregation != null &&
      p.meterAggregation !== "sum" &&
      p.meterAggregation !== "count") ||
    p.meterRecurring
  )
    issues.push({
      field: "meter",
      message:
        "A price that bills from the model price list needs a meter that sums or counts usage and does not carry it into the next period.",
    });
  if (p.tiers != null)
    issues.push({
      field: "tiers",
      message: "A price that bills from the model price list has no tiers.",
    });
  if (p.unitAmountDecimal == null)
    issues.push({
      field: "unit_amount_decimal",
      message:
        "Enter a default rate (unit_amount_decimal). It bills a model that has no price in the list.",
    });
  else {
    const d = decimalIssue("unit_amount_decimal", "The rate", p.unitAmountDecimal);
    if (d) issues.push(d);
  }
  issues.push(...sellingRateIssues(p.rates ?? [], groupBy, "rates"));
  return issues;
}

/**
 * Rules for selling-price rows (a price's rate card or an item's override): a match on the
 * meter's group_by, one row per match, and a fixed rate or a markup, never both.
 */
export function sellingRateIssues(
  rates: ReadonlyArray<{
    match: Record<string, unknown>;
    unitAmountDecimal?: string | null;
    markupPercent?: string | null;
    tiers?: unknown;
  }>,
  groupBy: readonly string[],
  prefix: string,
): MeterPriceIssue[] {
  const issues: MeterPriceIssue[] = [];
  if (rates.length > MAX_PRICE_RATES)
    issues.push({ field: prefix, message: `A price can have at most ${MAX_PRICE_RATES} rates.` });
  const seen = new Set<string>();
  rates.forEach((r, i) => {
    const at = `${prefix}.${i}`;
    const keys = Object.keys(r.match ?? {});
    if (keys.length === 0)
      issues.push({ field: `${at}.match`, message: "A rate must match at least one property." });
    for (const k of keys) {
      if (!groupBy.includes(k))
        issues.push({
          field: `${at}.match.${k}`,
          message: `The meter does not group by ${k}. Match only on its group_by properties.`,
        });
      if (typeof r.match[k] !== "string")
        issues.push({ field: `${at}.match.${k}`, message: "A match value must be a string." });
    }
    const canon = canonicalMatch(r.match as Record<string, string>);
    if (seen.has(canon))
      issues.push({ field: `${at}.match`, message: "Two rates have the same match. Keep one." });
    seen.add(canon);
    if (r.tiers != null)
      issues.push({
        field: `${at}.tiers`,
        message: "A rate on the model price list has no tiers.",
      });
    if ((r.unitAmountDecimal == null) === (r.markupPercent == null))
      issues.push({
        field: `${at}.unit_amount_decimal`,
        message: "Enter a fixed rate (unit_amount_decimal) or a markup (markup_percent), not both.",
      });
    if (r.unitAmountDecimal != null) {
      const d = decimalIssue(`${at}.unit_amount_decimal`, "The rate", r.unitAmountDecimal);
      if (d) issues.push(d);
    }
    if (r.markupPercent != null) {
      const d = decimalIssue(
        `${at}.markup_percent`,
        "The markup",
        r.markupPercent,
        MARKUP_MAX_DECIMALS,
      );
      if (d) issues.push(d);
    }
  });
  return issues;
}

/** Key-sorted JSON of a match, so two spellings of one match compare equal. */
export function canonicalMatch(match: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(match)
      .sort()
      .map((k) => [k, match[k]]),
  );
}

/** The numbers one combination rates with, and which rate-card row they came from. */
export interface MeterRateSpec {
  unitAmountDecimal: string | null;
  tiers: MeterTier[] | null;
  /** The rate's match, or "default" for the price's own numbers. */
  match: Record<string, string> | "default";
}

/**
 * The rate for one combination of group values: the matching rate that names the most
 * properties, then the oldest (rates are stored oldest first); none → the price's own numbers.
 */
export function resolveMeterRate(
  snap: Pick<PriceSnapshot, "rates" | "unitAmountDecimal" | "tiers">,
  group: Readonly<Record<string, string>>,
): MeterRateSpec {
  let best: MeterRate | null = null;
  let bestSize = -1;
  for (const r of snap.rates ?? []) {
    const keys = Object.keys(r.match);
    if (keys.length <= bestSize) continue;
    if (keys.every((k) => group[k] === r.match[k])) {
      best = r;
      bestSize = keys.length;
    }
  }
  if (best)
    return { unitAmountDecimal: best.unitAmountDecimal, tiers: best.tiers, match: best.match };
  return {
    unitAmountDecimal: snap.unitAmountDecimal ?? null,
    tiers: Array.isArray(snap.tiers) ? (snap.tiers as MeterTier[]) : null,
    match: "default",
  };
}

/** One tier's share of a meter line. Amounts are unrounded (Fixed12 minor units). */
export interface MeterRatedTier {
  from: string;
  to: string | null;
  units: string;
  unitAmountDecimal: string;
  flatAmountMinor: number;
  amount: string;
}

export interface MeterCombinationRating {
  /** The line amount: rounded half-up once. */
  amountMinor: bigint;
  /** Fixed12 units, free quantity taken off. */
  billableQuantity: bigint;
  /** Fixed12 minor units per ONE unit: the rate ÷ divisor, or amount ÷ quantity for tiers. */
  unitAmount: bigint;
  tiers?: MeterRatedTier[];
}

/**
 * Rate one combination of a meter price. Pure; Fixed12 in, minor units out, rounded half-up
 * ONCE per line — tier rows keep unrounded amounts. With `rate`: quantity × rate ÷ divisor
 * through the model. With `event_amount` / `event_cost`: the summed major-unit amount or cost
 * (plus the markup) in minor units.
 */
export function rateMeterCombination(input: {
  model: string;
  amountSource: string;
  /** Fixed12 units. */
  quantity: bigint;
  /** Whole units billed at 0 per line. */
  freeQuantity: number;
  rate: Pick<MeterRateSpec, "unitAmountDecimal" | "tiers">;
  quantityDivisor: bigint;
  packageSize?: number | null;
  /** Fixed12 major units: Σ event amount / Σ event cost. */
  amountSum?: bigint;
  costSum?: bigint;
  /** Fixed12 percent. */
  markupPercent?: bigint | null;
  currencyExponent: number;
  /**
   * One segment of a period that splits: `quantity` is its billable share (free already
   * taken, `freeQuantity` 0), `before` the billable units of earlier segments and `total`
   * the period's. Tiers, volume and packages are decided on the period, not the segment.
   */
  position?: { before: bigint; total: bigint };
}): MeterCombinationRating {
  const S = FIXED12_SCALE;
  const scaleMinor = 10n ** BigInt(input.currencyExponent);
  if (input.amountSource === "event_amount" || input.amountSource === "event_cost") {
    const base =
      input.amountSource === "event_amount" ? (input.amountSum ?? 0n) : (input.costSum ?? 0n);
    const markup = input.amountSource === "event_cost" ? (input.markupPercent ?? 0n) : 0n;
    // base(major, ×S) × 10^exp × (100S + m) ÷ (100S × S)
    const amountMinor = mulDivHalfUp(base * scaleMinor, 100n * S + markup, 100n * S * S);
    const q = input.quantity > 0n ? input.quantity : 0n;
    return {
      amountMinor: amountMinor > 0n ? amountMinor : 0n,
      billableQuantity: q,
      unitAmount: q > 0n ? mulDivHalfUp(amountMinor, S * S, q) : 0n,
    };
  }
  if (input.amountSource !== "rate")
    throw new RangeError(`Unknown amount source ${input.amountSource}`);
  const free = fixed12FromInt(Math.max(0, input.freeQuantity));
  const q = input.quantity > 0n ? input.quantity : 0n;
  const billable = q > free ? q - free : 0n;
  const divisor = input.quantityDivisor > 0n ? input.quantityDivisor : 1n;
  // Every term below is over the common denominator D = divisor × S × S (units × rate).
  const D = divisor * S * S;
  if (billable === 0n)
    return {
      amountMinor: 0n,
      billableQuantity: 0n,
      unitAmount: 0n,
      ...(input.rate.tiers ? { tiers: [] } : {}),
    };

  if (input.model === "usage") {
    const rate = parseFixed12(input.rate.unitAmountDecimal ?? "0");
    if (input.markupPercent != null) {
      // A rate over a markup base: rate × (100 + m) ÷ 100, rounded once with the line.
      const m = 100n * S + input.markupPercent;
      return {
        amountMinor: divHalfUp(billable * rate * m, D * 100n * S),
        billableQuantity: billable,
        unitAmount: divHalfUp(rate * m, divisor * 100n * S),
      };
    }
    return {
      amountMinor: divHalfUp(billable * rate, D),
      billableQuantity: billable,
      unitAmount: divHalfUp(rate, divisor),
    };
  }
  const before = input.position?.before ?? 0n;
  const total = input.position?.total ?? billable;
  if (input.model === "package") {
    const size = fixed12FromInt(Math.max(1, input.packageSize ?? 1));
    // The packages the period's running total opens inside this segment.
    const packages = (before + billable + size - 1n) / size - (before + size - 1n) / size;
    const rate = parseFixed12(input.rate.unitAmountDecimal ?? "0");
    const amountMinor = divHalfUp(packages * rate, S);
    return {
      amountMinor,
      billableQuantity: billable,
      unitAmount: mulDivHalfUp(amountMinor, S * S, billable),
    };
  }
  if (input.model === "tiered" || input.model === "volume") {
    const tiers = input.rate.tiers ?? [];
    const rows: MeterRatedTier[] = [];
    let numerator = 0n;
    let lower = 0n;
    for (const t of tiers) {
      const cap = t.up_to == null ? null : parseFixed12(t.up_to);
      const rate = parseFixed12(t.unit_amount_decimal);
      const flat = BigInt(t.flat_amount_minor ?? 0);
      if (input.model === "tiered") {
        // This segment holds units [before, end) of the period; a tier's flat fee goes with
        // the segment that holds its first unit.
        const end = before + billable;
        const top = cap == null || end < cap ? end : cap;
        const units = top - (before > lower ? before : lower);
        if (units > 0n) {
          const f = lower >= before ? flat : 0n;
          const n = units * rate + f * D;
          numerator += n;
          rows.push(tierRow(lower, cap, units, rate, f, n, D));
        }
        if (cap == null || end <= cap) break;
      } else if (cap == null || total <= cap) {
        // Volume: the period total picks the tier; the flat fee bills once, on its first units.
        const f = before === 0n ? flat : 0n;
        const n = billable * rate + f * D;
        numerator += n;
        rows.push(tierRow(lower, cap, billable, rate, f, n, D));
        break;
      }
      if (cap != null) lower = cap;
    }
    const amountMinor = divHalfUp(numerator, D);
    return {
      amountMinor,
      billableQuantity: billable,
      unitAmount: divHalfUp(numerator, divisor * billable),
      tiers: rows,
    };
  }
  throw new RangeError(`A meter price cannot use the ${input.model} model.`);
}

function tierRow(
  lower: bigint,
  cap: bigint | null,
  units: bigint,
  rate: bigint,
  flat: bigint,
  numerator: bigint,
  D: bigint,
): MeterRatedTier {
  return {
    from: formatFixed12(lower),
    to: cap == null ? null : formatFixed12(cap),
    units: formatFixed12(units),
    unitAmountDecimal: formatFixed12(rate),
    flatAmountMinor: Number(flat),
    // Unrounded at 12 dp: numerator ÷ D in minor units, ×S for Fixed12.
    amount: formatFixed12(divHalfUp(numerator * FIXED12_SCALE, D)),
  };
}
