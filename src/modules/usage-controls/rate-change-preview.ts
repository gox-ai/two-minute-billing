/**
 * Price-change preview (design G5 § 3.8): re-rate each customer's last closed period of usage
 * under a draft rate card. Reads only, in a READ ONLY transaction, so it can never write.
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { currencyExponent } from "@/platform/currency";
import { parseFixed12 } from "@/platform/fixed";
import { customers, meters, prices, subscriptionItems, subscriptions } from "@db/schema";
import {
  applyMeterPricing,
  isMeteredPrice,
  loadMeterPricing,
  meterPriceIssues,
  rateMeterCombination,
  rateMeteredQuantity,
  resolveMeterRate,
  snapshotPrice,
  tierListIssues,
  type MeterRate,
  type MeterTier,
  type PriceSnapshot,
  type PriceTier,
} from "@/modules/catalog/pricing";
import { groupRecord } from "@/modules/metering/meter-rating";
import { accountHolderName } from "@/modules/customers/names";
import { rowsOf } from "@/modules/metering/usage-sql";

/** Customers rated per request; more are reported as `truncated`. */
export const PREVIEW_MAX_CUSTOMERS = 5000;
export const PREVIEW_PAGE_SIZE = 200;

/** The rate fields a draft may change. Absent = the price's current value. */
export interface RateDraft {
  /** Meter prices: minor units per `quantityDivisor` units. */
  unitAmountDecimal?: string | null;
  quantityDivisor?: string;
  /** Meter prices: `MeterTier[]`; other metered prices: `PriceTier[]`. */
  tiers?: unknown;
  /** Meter prices: the whole rate card. */
  rates?: Array<{
    match: Record<string, string>;
    unitAmountDecimal?: string | null;
    tiers?: unknown;
  }>;
  /** Other metered prices: the unit amount in minor units. */
  amountMinor?: number;
}

export class RatePreviewError extends Error {
  constructor(
    message: string,
    readonly param?: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

export interface PreviewRow {
  customer: string;
  customerName: string | null;
  subscriptions: string[];
  period: { start: Date | null; end: Date | null };
  oldMinor: bigint;
  newMinor: bigint;
}

export interface RateChangePreview {
  price: string;
  currency: string;
  rows: PreviewRow[];
  /** Customers whose live items have no finalized period invoice yet: nothing to re-rate. */
  withoutUsage: number;
  truncated: boolean;
}

type ItemRow = {
  itemId: string;
  subscriptionPublicId: string;
  customerId: string;
  customerPublicId: string;
  customerName: string | null;
  freeQuantity: number | null;
  snapshot: PriceSnapshot | null;
};

type LineRow = {
  item_id: string;
  quantity: number;
  rating: Record<string, unknown> | null;
  period_start: string | null;
  period_end: string | null;
  /** An interim invoice's line inside the period (meter quantities add up). */
  interim: boolean;
};

export async function previewRateChange(input: {
  organizationId: string;
  businessId: string;
  pricePublicId: string;
  draft: RateDraft;
}): Promise<RateChangePreview> {
  return withTenant(input.organizationId, async (tx) => {
    await tx.execute(sql`set transaction read only`);
    const [price] = await tx
      .select()
      .from(prices)
      .where(and(eq(prices.businessId, input.businessId), eq(prices.publicId, input.pricePublicId)))
      .limit(1);
    if (!price) throw new RatePreviewError(`No such price: ${input.pricePublicId}`, "price", 404);
    if (!isMeteredPrice(price))
      throw new RatePreviewError("This price does not bill usage. Only a usage price has a rate.");
    const meterPrice = price.meterId != null;
    if (meterPrice && price.amountSource !== "rate")
      throw new RatePreviewError(
        "This price bills from the event amount, the event cost or the model price list, not from a rate.",
        "price",
      );
    await checkDraft(tx, price, input.draft);

    const items = await liveItems(tx, price.id);
    const meterPricing = meterPrice ? await loadMeterPricing(tx, [price]) : null;
    const baseSnapshot = (s: PriceSnapshot | null): PriceSnapshot => {
      if (s) return s;
      const snap = snapshotPrice(price);
      const mp = meterPricing?.get(price.id);
      return mp ? applyMeterPricing(snap, price, mp) : snap;
    };

    const customerIds = [...new Set(items.map((i) => i.customerId))];
    const kept = new Set(customerIds.slice(0, PREVIEW_MAX_CUSTOMERS));
    const rated = items.filter((i) => kept.has(i.customerId));
    const lines = await lastClosedLines(
      tx,
      rated.map((i) => i.itemId),
    );
    const linesByItem = new Map<string, LineRow[]>();
    for (const l of lines) linesByItem.set(l.item_id, [...(linesByItem.get(l.item_id) ?? []), l]);

    const byCustomer = new Map<string, PreviewRow>();
    for (const item of rated) {
      const itemLines = linesByItem.get(item.itemId);
      if (!itemLines?.length) continue;
      const snap = baseSnapshot(item.snapshot);
      const draftSnap = applyDraft(snap, input.draft);
      const amounts = meterPrice
        ? rateMeterLines(snap, draftSnap, item.freeQuantity, itemLines)
        : rateClassicLines(snap, draftSnap, item.freeQuantity, itemLines);
      const row = byCustomer.get(item.customerId) ?? {
        customer: item.customerPublicId,
        customerName: item.customerName,
        subscriptions: [],
        period: { start: null, end: null },
        oldMinor: 0n,
        newMinor: 0n,
      };
      row.oldMinor += amounts.oldMinor;
      row.newMinor += amounts.newMinor;
      if (!row.subscriptions.includes(item.subscriptionPublicId))
        row.subscriptions.push(item.subscriptionPublicId);
      const own = itemLines.filter((l) => !l.interim);
      const start = earliest(own.map((l) => periodOf(l).start));
      const end = latest(own.map((l) => periodOf(l).end));
      row.period = {
        start: earliest([row.period.start, start]),
        end: latest([row.period.end, end]),
      };
      byCustomer.set(item.customerId, row);
    }
    return {
      price: price.publicId,
      currency: price.currency,
      rows: [...byCustomer.values()],
      withoutUsage: kept.size - byCustomer.size,
      truncated: customerIds.length > PREVIEW_MAX_CUSTOMERS,
    };
  });
}

/** Refuse a draft that could not be saved on the price, naming the field. */
async function checkDraft(tx: Tx, price: typeof prices.$inferSelect, d: RateDraft): Promise<void> {
  const keys = Object.entries(d).filter(([, v]) => v !== undefined);
  if (keys.length === 0)
    throw new RatePreviewError("Send at least one rate field to preview a change.");
  if (price.meterId == null) {
    if (d.unitAmountDecimal !== undefined || d.quantityDivisor !== undefined || d.rates)
      throw new RatePreviewError(
        "This price does not bill from a meter. Send amount_minor or tiers.",
        "unit_amount_decimal",
      );
    if (d.tiers !== undefined) {
      const issue = tierListIssues(d.tiers as PriceTier[], price.model)[0];
      if (issue)
        throw new RatePreviewError(
          issue.message,
          issue.index == null ? "tiers" : `tiers.${issue.index}`,
        );
    }
    return;
  }
  if (d.amountMinor !== undefined)
    throw new RatePreviewError(
      "This price bills from a meter. Send unit_amount_decimal, tiers or rates.",
      "amount_minor",
    );
  const [m] = await tx
    .select({ groupBy: meters.groupBy })
    .from(meters)
    .where(eq(meters.id, price.meterId))
    .limit(1);
  const current = (await loadMeterPricing(tx, [price])).get(price.id);
  const issues = meterPriceIssues(
    {
      model: price.model,
      type: price.type,
      amountSource: "rate",
      unitAmountDecimal:
        d.unitAmountDecimal !== undefined
          ? d.unitAmountDecimal
          : price.unitAmountDecimal != null
            ? String(price.unitAmountDecimal)
            : null,
      quantityDivisor: d.quantityDivisor ?? String(price.quantityDivisor),
      tiers: d.tiers !== undefined ? d.tiers : (price.tiers ?? undefined),
      packageSize: price.packageSize,
      rates: d.rates ?? current?.rates ?? [],
    },
    m?.groupBy ?? [],
  );
  if (issues[0]) throw new RatePreviewError(issues[0].message, issues[0].field);
}

function applyDraft(snap: PriceSnapshot, d: RateDraft): PriceSnapshot {
  if (snap.meter)
    return {
      ...snap,
      ...(d.unitAmountDecimal !== undefined ? { unitAmountDecimal: d.unitAmountDecimal } : {}),
      ...(d.quantityDivisor !== undefined ? { quantityDivisor: d.quantityDivisor } : {}),
      ...(d.tiers !== undefined ? { tiers: d.tiers as MeterTier[] } : {}),
      ...(d.rates
        ? {
            rates: d.rates.map((r, i): MeterRate => ({
              id: `draft_${i}`,
              match: r.match,
              unitAmountDecimal: r.unitAmountDecimal ?? null,
              tiers: (r.tiers as MeterTier[] | undefined) ?? null,
            })),
          }
        : {}),
    };
  return {
    ...snap,
    // A subscription's own custom amount is not the catalog rate: a rate change leaves it.
    ...(d.amountMinor !== undefined && !snap.amountOverridden
      ? { amountMinor: d.amountMinor }
      : {}),
    ...(d.tiers !== undefined ? { tiers: d.tiers } : {}),
  };
}

/** One combination per line group, summed over its rate segments; free units per combination. */
function rateMeterLines(
  snap: PriceSnapshot,
  draft: PriceSnapshot,
  itemFree: number | null,
  lines: LineRow[],
): { oldMinor: bigint; newMinor: bigint } {
  const free = Math.max(0, itemFree ?? snap.freeQuantity ?? 0);
  const groupBy = snap.meter?.groupBy ?? [];
  const combos = new Map<string, { group: string[]; quantity: bigint }>();
  for (const l of lines) {
    const group = Array.isArray(l.rating?.group) ? (l.rating!.group as string[]) : [];
    const q = typeof l.rating?.quantity === "string" ? parseFixed12(l.rating.quantity) : 0n;
    const key = JSON.stringify(group);
    const c = combos.get(key) ?? { group, quantity: 0n };
    c.quantity += q;
    combos.set(key, c);
  }
  const exp = currencyExponent(snap.currency);
  const rate = (s: PriceSnapshot, c: { group: string[]; quantity: bigint }) =>
    rateMeterCombination({
      model: s.model,
      amountSource: "rate",
      quantity: c.quantity,
      freeQuantity: free,
      rate: resolveMeterRate(s, groupRecord(groupBy, c.group)),
      quantityDivisor: BigInt(s.quantityDivisor ?? "1"),
      packageSize: s.packageSize,
      currencyExponent: exp,
    }).amountMinor;
  let oldMinor = 0n;
  let newMinor = 0n;
  for (const c of combos.values()) {
    oldMinor += rate(snap, c);
    newMinor += rate(draft, c);
  }
  return { oldMinor, newMinor };
}

/** The window's measured quantity (`rating.quantity`: cumulative, before free units). */
function rateClassicLines(
  snap: PriceSnapshot,
  draft: PriceSnapshot,
  itemFree: number | null,
  lines: LineRow[],
): { oldMinor: bigint; newMinor: bigint } {
  let oldMinor = 0n;
  let newMinor = 0n;
  // The final line's rating already covers the whole window.
  for (const l of lines.filter((x) => !x.interim)) {
    const q = typeof l.rating?.quantity === "number" ? l.rating.quantity : l.quantity;
    const quantity = BigInt(Math.max(0, Math.trunc(q)));
    oldMinor += rateMeteredQuantity({
      snapshot: snap,
      itemFreeQuantity: itemFree,
      quantity,
    }).amountMinor;
    newMinor += rateMeteredQuantity({
      snapshot: draft,
      itemFreeQuantity: itemFree,
      quantity,
    }).amountMinor;
  }
  return { oldMinor, newMinor };
}

async function liveItems(tx: Tx, priceId: string): Promise<ItemRow[]> {
  const rows = await tx
    .select({
      itemId: subscriptionItems.id,
      subscriptionPublicId: subscriptions.publicId,
      customerId: customers.id,
      customerPublicId: customers.publicId,
      firstName: customers.firstName,
      lastName: customers.lastName,
      company: customers.company,
      email: customers.email,
      freeQuantity: subscriptionItems.freeQuantity,
      snapshot: subscriptionItems.priceSnapshot,
    })
    .from(subscriptionItems)
    .innerJoin(subscriptions, eq(subscriptions.id, subscriptionItems.subscriptionId))
    .innerJoin(customers, eq(customers.id, subscriptions.customerId))
    .where(
      and(
        eq(subscriptionItems.priceId, priceId),
        ne(subscriptions.status, "cancelled"),
        isNull(subscriptions.deletedAt),
      ),
    )
    .orderBy(customers.id, subscriptionItems.id);
  return rows.map(({ firstName, lastName, company, email, ...r }) => ({
    ...r,
    customerName: accountHolderName({ firstName, lastName, company, email }),
    snapshot: (r.snapshot as PriceSnapshot | null) ?? null,
  }));
}

/**
 * The usage lines of each item's last finalized period invoice, plus the lines of the interim
 * invoices inside that period: a final meter line bills only what they did not, so the whole
 * period is the sum. Late lines for older windows are left out.
 */
async function lastClosedLines(tx: Tx, itemIds: string[]): Promise<LineRow[]> {
  if (itemIds.length === 0) return [];
  return rowsOf<LineRow>(
    await tx.execute(sql`
      with last as (
        select distinct on (si.id) si.id as item_id, si.price_id, si.subscription_id, l.invoice_id
        from subscription_items si
        join invoices i on i.subscription_id = si.subscription_id
          and i.status not in ('pending', 'voided')
          and i.purpose is distinct from 'usage_interim'
        join invoice_line_items l on l.invoice_id = i.id
          and l.price_id = si.price_id
          and l.kind = 'usage'
          and (l.rating ->> 'late_for') is null
        where si.id = any(${sql`array[${sql.join(
          itemIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[]`})
        order by si.id, l.period_end desc nulls last, i.created_at desc
      ),
      fin as (
        select last.item_id, last.subscription_id, l.quantity, l.rating, l.period_start,
          l.period_end, false as interim
        from last
        join invoice_line_items l on l.invoice_id = last.invoice_id
          and l.price_id = last.price_id
          and l.kind = 'usage'
          and (l.rating ->> 'late_for') is null
      ),
      win as (
        select item_id, subscription_id, min(period_start) as s, max(period_end) as e
        from fin group by item_id, subscription_id
      )
      select item_id, quantity, rating, period_start, period_end, interim from fin
      union all
      select win.item_id, l.quantity, l.rating, l.period_start, l.period_end, true
      from win
      join invoices i on i.subscription_id = win.subscription_id
        and i.purpose = 'usage_interim'
        and i.status not in ('pending', 'voided')
      join invoice_line_items l on l.invoice_id = i.id
        and l.kind = 'usage'
        and l.rating ->> 'interim' = 'true'
        and l.rating ->> 'item_id' = win.item_id::text
        and l.period_start >= win.s
        and l.period_end <= win.e
    `),
  );
}

function periodOf(l: LineRow): { start: Date | null; end: Date | null } {
  const p = l.rating?.period as { start?: string; end?: string } | undefined;
  const start = p?.start ?? l.period_start;
  const end = p?.end ?? l.period_end;
  return { start: start ? new Date(start) : null, end: end ? new Date(end) : null };
}

const earliest = (ds: Array<Date | null>) =>
  ds.reduce<Date | null>((a, d) => (d && (!a || d < a) ? d : a), null);
const latest = (ds: Array<Date | null>) =>
  ds.reduce<Date | null>((a, d) => (d && (!a || d > a) ? d : a), null);

/** Signed basis points of `old`; null when nothing was billed before. */
export function diffBps(oldMinor: bigint, newMinor: bigint): number | null {
  if (oldMinor === 0n) return null;
  const diff = (newMinor - oldMinor) * 10_000n;
  // Round half away from zero.
  const q = diff / oldMinor;
  const r = diff % oldMinor;
  const half = (r < 0n ? -r : r) * 2n >= (oldMinor < 0n ? -oldMinor : oldMinor);
  return Number(half ? q + (diff < 0n ? -1n : 1n) : q);
}
