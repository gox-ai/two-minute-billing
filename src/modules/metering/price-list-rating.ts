import type { Tx } from "@/platform/db";
import { billsFromList, type PriceSnapshot } from "@/modules/catalog/pricing";
import { currencyExponent } from "@/platform/currency";
import { FIXED12_SCALE, divHalfUp, fixed12FromNumeric, formatFixed12 } from "@/platform/fixed";
import { loadRateTimeline, type RateTimeline } from "@/platform/fx/history";
import {
  loadModelPriceBook,
  type CostHit,
  type ListPriceHit,
  type ModelKey,
  type ModelPriceBook,
} from "@/modules/model-prices/resolve";
import type {
  LineCost,
  MeterCutoff,
  MeterLineRating,
  MeterRow,
  RateSegment,
  ResolveRate,
  SegmentCite,
} from "./meter-rating";
import { readMeterUsage } from "./read";

/**
 * Billing from the model price list (design G1b § 3.4) and the cost of a usage line (§ 3.7).
 * Selling rate per combination: the item's override, then the price's rate, then the price's
 * markup. A markup applies to the price's markup base (list, else your cost; or your cost,
 * else list). Each change of a base row inside the window starts a new segment, billed on
 * its own line at its own rate.
 */

const S = FIXED12_SCALE;

/** The list key one combination maps to through the meter's `price_list`. Null = unmapped. */
export function listKeyOf(
  meter: Pick<MeterRow, "priceList">,
  group: Readonly<Record<string, string>>,
  currency: string,
): ModelKey | null {
  const m = meter.priceList;
  if (!m) return null;
  const model = group[m.model_key ?? "model"];
  const tokenType = m.token_type ?? (m.token_type_key ? group[m.token_type_key] : undefined);
  if (!model || !tokenType) return null;
  const provider = m.provider ?? (m.provider_key ? group[m.provider_key] || null : null);
  return { provider, model, tokenType, currency };
}

/** Where a combination's selling rate comes from. */
export interface SellingRule {
  from: SegmentCite["rate_from"];
  /** A fixed rate, minor units per the price's divisor. */
  fixed: string | null;
  /** Percent over the markup base, when not fixed. */
  markup: string | null;
  match: Record<string, string> | "default";
}

type MatchRow = {
  match: Record<string, string>;
  unitAmountDecimal: string | null;
  markupPercent?: string | null;
};

/** The matching row that names the most properties, then the first. */
function bestMatch<R extends MatchRow>(
  rows: readonly R[],
  group: Readonly<Record<string, string>>,
): R | null {
  let best: R | null = null;
  let size = -1;
  for (const r of rows) {
    const keys = Object.keys(r.match);
    if (keys.length <= size) continue;
    if (keys.every((k) => group[k] === r.match[k])) {
      best = r;
      size = keys.length;
    }
  }
  return best;
}

/** Item override → price rate → price markup (default 0). */
export function sellingRule(
  snap: Pick<PriceSnapshot, "sellingOverride" | "rates" | "markupPercent">,
  group: Readonly<Record<string, string>>,
): SellingRule {
  const ov = snap.sellingOverride;
  if (ov) {
    const r = bestMatch(ov.rates, group);
    if (r)
      return {
        from: "subscription_override",
        fixed: r.unitAmountDecimal,
        markup: r.markupPercent,
        match: r.match,
      };
    if (ov.markupPercent != null)
      return {
        from: "subscription_override",
        fixed: null,
        markup: ov.markupPercent,
        match: "default",
      };
  }
  const r = bestMatch(snap.rates ?? [], group);
  if (r)
    return {
      from: "price_rate",
      fixed: r.unitAmountDecimal,
      markup: r.markupPercent ?? null,
      match: r.match,
    };
  return { from: "price", fixed: null, markup: snap.markupPercent ?? null, match: "default" };
}

type BaseHit = ListPriceHit | CostHit;

/** The markup base at `at`: list (else your cost), or your cost (else list). */
export function markupBaseAt(
  book: ModelPriceBook,
  key: ModelKey,
  base: "list" | "cost",
  at: Date,
): BaseHit | null {
  if (base === "cost") {
    const c = book.modelCost(key, at);
    return c.kind ? c : null;
  }
  const l = book.listPrice(key, at);
  if (l.kind) return l;
  const c = book.ownCost(key, at);
  return c.kind ? c : null;
}

/** Selling rate per divisor for display: base × (100 + m) ÷ 100 at 12 dp. */
const sellingDecimal = (base: bigint, markup: bigint) =>
  formatFixed12(divHalfUp(base * (100n * S + markup), 100n * S));

/**
 * The rate resolver of a snapshot that bills from the list (`model_price_list`,
 * `event_cost_or_list`); null for any other amount source.
 * Async: it loads the window's list and cost rows once per combination.
 */
export function priceListResolver(ctx: {
  tx: Tx;
  meter: MeterRow;
  snap: PriceSnapshot;
  currency: string;
}): ResolveRate | null {
  const { tx, meter, snap, currency } = ctx;
  if (!billsFromList(snap.amountSource)) return null;
  const priceDivisor = BigInt(snap.quantityDivisor ?? "1");
  const markupBase = snap.markupBase ?? "list";
  return async (combo, w) => {
    const rule = sellingRule(snap, combo.group);
    const cite = (
      from: Date,
      to: Date,
      c: Omit<SegmentCite, "from" | "to" | "rate_from">,
    ): SegmentCite => ({
      from: from.toISOString(),
      to: to.toISOString(),
      rate_from: rule.from,
      ...c,
    });
    const fixedSeg = (
      from: Date,
      to: Date,
      amount: string,
      source: "fixed_rate" | "default_rate",
    ): RateSegment => ({
      start: from,
      end: to,
      rate: {
        unitAmountDecimal: amount,
        tiers: null,
        match: source === "fixed_rate" ? rule.match : "default",
      },
      quantityDivisor: priceDivisor,
      markupPercent: null,
      cite: cite(from, to, {
        unit_amount_decimal: formatFixed12(fixed12FromNumeric(amount)),
        quantity_divisor: String(priceDivisor),
        markup_percent: null,
        markup_base: null,
        base_unit_amount_decimal: null,
        price_source: source,
        model_price_id: null,
        model_cost_override_id: null,
        source: null,
        source_version: null,
        source_effective_from: null,
      }),
    });
    if (rule.fixed != null) return [fixedSeg(w.start, w.end, rule.fixed, "fixed_rate")];
    const defaultRate = snap.unitAmountDecimal ?? "0";
    const key = listKeyOf(meter, combo.group, currency);
    if (!key) return [fixedSeg(w.start, w.end, defaultRate, "default_rate")];
    const markup = fixed12FromNumeric(rule.markup ?? "0");
    const book = await loadModelPriceBook(tx, meter.organizationId, [key.model], w);
    const points = [w.start, ...book.changeInstants(key, w.start, w.end), w.end];
    const out: Array<{ seg: RateSegment; id: string | null }> = [];
    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i]!;
      const to = points[i + 1]!;
      const hit = markupBaseAt(book, key, markupBase, from);
      const prev = out.at(-1);
      // Same row as the piece before: one segment.
      if (prev && prev.id === (hit?.id ?? null)) {
        prev.seg.end = to;
        prev.seg.cite!.to = to.toISOString();
        continue;
      }
      const seg: RateSegment = hit
        ? {
            start: from,
            end: to,
            rate: {
              unitAmountDecimal: formatFixed12(hit.unitAmount),
              tiers: null,
              match: rule.match,
            },
            quantityDivisor: hit.quantityDivisor,
            markupPercent: markup,
            cite: cite(from, to, {
              unit_amount_decimal: sellingDecimal(hit.unitAmount, markup),
              quantity_divisor: String(hit.quantityDivisor),
              markup_percent: formatFixed12(markup),
              markup_base: markupBase,
              base_unit_amount_decimal: formatFixed12(hit.unitAmount),
              price_source: hit.kind === "list" ? "model_price_list" : "your_cost",
              model_price_id: hit.kind === "list" ? hit.publicId : null,
              model_cost_override_id: hit.kind === "cost" ? hit.publicId : null,
              source: hit.kind === "list" ? hit.source : null,
              source_version: hit.kind === "list" ? hit.sourceVersion : null,
              source_effective_from: hit.kind === "list" ? hit.sourceEffectiveFrom : null,
            }),
          }
        : fixedSeg(from, to, defaultRate, "default_rate");
      out.push({ seg, id: hit?.id ?? null });
    }
    return out.map((o) => o.seg);
  };
}

/**
 * Cost of one usage line in its currency (§ 3.7): Σ event cost + Σ quantity of events with
 * no cost × your cost (else the list) where that quantity fell. Rounded half-up once. Event
 * cost in another currency converts at the business's rate on the line's end; no rate →
 * `no_rate`. Summed and counted meters only; null for any other. `part` (an
 * `event_cost_or_list` line) counts only the events' own cost, or only the events without one.
 */
export async function lineCost(ctx: {
  tx: Tx;
  meter: MeterRow;
  customerId: string;
  currency: string;
  cutoff: MeterCutoff;
  line: MeterLineRating;
  part?: "reported_cost" | "list";
}): Promise<LineCost | null> {
  const { tx, meter, line, currency, part } = ctx;
  if (meter.recurring || (meter.aggregation !== "sum" && meter.aggregation !== "count"))
    return null;
  const group: Record<string, string> = {};
  meter.groupBy.forEach((k, i) => (group[k] = line.group[i] ?? ""));
  const key = listKeyOf(meter, group, currency);
  const book = key
    ? await loadModelPriceBook(tx, meter.organizationId, [key.model], line.window)
    : null;
  const usage = await readMeterUsage(tx, {
    customerId: ctx.customerId,
    meterId: meter.id,
    window: line.window,
    splitAt: key && book ? book.changeInstants(key, line.window.start, line.window.end) : [],
    cutoff: {
      generation: ctx.cutoff.generation,
      at: ctx.cutoff.at,
      watermark: ctx.cutoff.watermark,
    },
  });
  const sameGroup = (g: readonly string[]) => JSON.stringify(g) === JSON.stringify(line.group);
  const minorScale = 10n ** BigInt(currencyExponent(currency));
  let total = 0n; // Fixed12 minor units of the line's currency
  let fromList = false;
  let fromEvents = false;
  let unpriced = 0n;
  let fx: RateTimeline | null = null;
  for (const seg of usage.segments) {
    let uncosted = 0n;
    for (const r of seg.rows) {
      if (!sameGroup(r.groupValues)) continue;
      // A split line: an event cost in another currency bills from the list (`mergeCurrencies`).
      if (part && r.currency != null && r.currency !== currency) {
        if (part === "list") uncosted += r.quantity;
        continue;
      }
      uncosted += r.uncostedQuantity;
      if (part === "list") continue;
      if (r.quantity > r.uncostedQuantity || r.costSum !== 0n) fromEvents = true;
      if (r.costSum === 0n) continue;
      const cur = r.currency ?? meter.costCurrency ?? currency;
      if (cur === currency) {
        total += r.costSum * minorScale;
        continue;
      }
      fx ??= await loadRateTimeline(tx, meter.businessId);
      const to = fx.rateAt(currency, line.window.end);
      const from = fx.rateAt(cur, line.window.end);
      if (!to || !from) return { minor: null, basis: "no_rate" };
      // cost(cur) × rate(line) ÷ rate(cur), both per one unit of the business's base.
      total += divHalfUp(r.costSum * minorScale * fixed12FromNumeric(to), fixed12FromNumeric(from));
    }
    if (uncosted <= 0n || part === "reported_cost") continue;
    const hit = key && book ? book.modelCost(key, seg.start) : null;
    if (hit?.kind) {
      total += divHalfUp(uncosted * hit.unitAmount, hit.quantityDivisor * S);
      fromList = true;
    } else unpriced += uncosted;
  }
  const minor = divHalfUp(total, S);
  if (unpriced > 0n)
    return fromList || fromEvents ? { minor, basis: "partial" } : { minor: null, basis: "none" };
  return { minor, basis: fromList && fromEvents ? "mixed" : fromList ? "price_list" : "event" };
}
