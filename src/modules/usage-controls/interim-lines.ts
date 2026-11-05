/**
 * Threshold invoicing inside the period planner (design G5 §3.7, Decision 1): what interim
 * invoices already billed per item, the eligibility rule, and the coupon fold that puts the
 * whole period's discount on the final invoice. No import of `invoicing/service` (it imports
 * this file).
 */
import { sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { tryParseFixed12 } from "@/platform/fixed";
import type { DiscountShare, DiscountStack } from "@/modules/coupons/service";
import type { MeterItemRating, MeterLineRating } from "@/modules/metering/meter-rating";

/** What interim invoices billed for one item in a window (quantities Fixed12 for meters). */
export interface ItemBilled {
  amountMinor: bigint;
  /** Classic metered items: whole units. */
  quantity: bigint;
  /** Meter prices: per value combination, Fixed12 quantity. */
  groups: Map<string, { amountMinor: bigint; quantity: bigint }>;
}

export const groupKey = (g: readonly string[] | null | undefined) => JSON.stringify(g ?? []);

/**
 * Σ interim lines per item for a subscription whose line period lies in `[start, end]`, on
 * interim invoices not voided. Derived, never stored. A credit note does not reduce it.
 */
export async function billedOnInterims(
  tx: Tx,
  subscriptionId: string,
  window: { start: Date; end: Date },
): Promise<Map<string, ItemBilled>> {
  const rows = (await tx.execute(sql`
    select li.amount_minor::text amount, li.quantity, li.rating
    from invoice_line_items li join invoices i on i.id = li.invoice_id
    where i.subscription_id = ${subscriptionId} and i.purpose = 'usage_interim'
      and i.status not in ('voided', 'pending') and li.kind = 'usage'
      and li.rating ->> 'interim' = 'true'
      and li.period_start >= ${window.start.toISOString()}::timestamptz
      and li.period_end <= ${window.end.toISOString()}::timestamptz`)) as unknown as Array<{
    amount: string;
    quantity: number;
    rating: { item_id?: string; meter?: string; group?: string[]; quantity?: unknown } | null;
  }>;
  const out = new Map<string, ItemBilled>();
  for (const r of rows) {
    const id = r.rating?.item_id;
    if (!id) continue;
    const b = out.get(id) ?? { amountMinor: 0n, quantity: 0n, groups: new Map() };
    const amount = BigInt(r.amount);
    b.amountMinor += amount;
    if (r.rating?.meter) {
      const k = groupKey(r.rating.group);
      const g = b.groups.get(k) ?? { amountMinor: 0n, quantity: 0n };
      g.amountMinor += amount;
      g.quantity += tryParseFixed12(String(r.rating.quantity ?? "0")) ?? 0n;
      b.groups.set(k, g);
    } else b.quantity += BigInt(r.quantity ?? 0);
    out.set(id, b);
  }
  return out;
}

const ELIGIBLE_AGGREGATIONS = new Set(["sum", "count", "max", "unique", "weighted_sum"]);
const ELIGIBLE_MODELS = new Set([
  "usage",
  "tiered",
  "package",
  "percentage",
  "graduated_percentage",
  "stairstep",
]);

/**
 * Can this item bill early? Only when its rated amount can never fall as the window grows:
 * `volume`, `last`, `min`, `avg` and recurring levels bill at period end only.
 */
export function thresholdEligible(snap: {
  model: string;
  usageAggregation?: string | null;
  usageRecurring?: boolean | null;
  tiers?: unknown;
  meterAggregation?: string | null;
  meterRecurring?: boolean | null;
}): boolean {
  if (!ELIGIBLE_MODELS.has(snap.model)) return false;
  if (snap.usageRecurring || snap.meterRecurring) return false;
  const agg = snap.meterAggregation ?? snap.usageAggregation ?? "sum";
  if (!ELIGIBLE_AGGREGATIONS.has(agg)) return false;
  if (snap.model === "stairstep") {
    // A stairstep whose flat fee ever falls from one step to the next can bill less later.
    const tiers = Array.isArray(snap.tiers) ? (snap.tiers as Array<Record<string, unknown>>) : [];
    let prev = -Infinity;
    for (const t of tiers) {
      const f = Number(t.flatAmountMinor ?? t.flat_amount_minor ?? 0);
      if (f < prev) return false;
      prev = f;
    }
  }
  return true;
}

/** Spread `amount` over `caps` by weight (largest remainder), never above a cap. */
function spread(amount: bigint, caps: bigint[]): bigint[] {
  const out = caps.map(() => 0n);
  const total = caps.reduce((s, c) => s + (c > 0n ? c : 0n), 0n);
  if (amount <= 0n || total <= 0n) return out;
  const take = amount > total ? total : amount;
  const parts = caps.map((c, i) => {
    const w = c > 0n ? c : 0n;
    const exact = w * take;
    return { i, floor: exact / total, frac: exact % total, cap: w };
  });
  let left = take;
  for (const p of parts) {
    out[p.i] = p.floor;
    left -= p.floor;
  }
  for (const p of [...parts].sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : 0))) {
    if (left <= 0n) break;
    if (out[p.i]! < p.cap) {
      out[p.i]! += 1n;
      left -= 1n;
    }
  }
  return out;
}

/**
 * The period's discount, computed once over the real lines plus one virtual line per item
 * for what interim invoices billed, folded onto the real lines (Decision 1). The virtual
 * lines' shares move onto the real lines as document-level shares, up to what each real
 * line has left; what does not fit is the excess the caller credits on the interim invoices.
 */
export function foldBilledDiscount<S extends DiscountStack>(
  stack: S,
  lineAmounts: readonly bigint[],
): { stack: S; excessMinor: bigint } {
  const real = lineAmounts.length;
  const virtual = stack.shares.filter((s) => s.lineIndex >= real);
  const lineDisc = stack.lineDiscountByIndex.slice(0, real);
  const invLevel = stack.invoiceLevelByIndex.slice(0, real);
  const shares: DiscountShare[] = stack.shares.filter((s) => s.lineIndex < real);
  const byCoupon = new Map<string, { label: string; amount: bigint }>();
  for (const s of virtual) {
    const c = byCoupon.get(s.appliedCouponId) ?? { label: s.label, amount: 0n };
    c.amount += s.amountMinor;
    byCoupon.set(s.appliedCouponId, c);
  }
  let excess = 0n;
  for (const [couponId, v] of byCoupon) {
    const caps = lineAmounts.map((a, i) => a - lineDisc[i]! - invLevel[i]!);
    const parts = spread(v.amount, caps);
    let placed = 0n;
    parts.forEach((p, i) => {
      if (p <= 0n) return;
      invLevel[i] = invLevel[i]! + p;
      placed += p;
      shares.push({
        lineIndex: i,
        appliedCouponId: couponId,
        label: v.label,
        scope: "document_level",
        amountMinor: p,
      });
    });
    excess += v.amount - placed;
  }
  const rows = stack.rows.map((r) => {
    const mine = shares.filter((s) => s.appliedCouponId === r.appliedCouponId);
    const doc = mine
      .filter((s) => s.scope === "document_level")
      .reduce((a, s) => a + s.amountMinor, 0n);
    return {
      ...r,
      discountMinor: mine.reduce((a, s) => a + s.amountMinor, 0n),
      documentLevelMinor: doc,
    };
  });
  const itemLevelMinor = lineDisc.reduce((a, d) => a + d, 0n);
  const invoiceLevelMinor = invLevel.reduce((a, d) => a + d, 0n);
  return {
    stack: {
      ...stack,
      rows,
      shares,
      lineDiscountByIndex: lineDisc,
      invoiceLevelByIndex: invLevel,
      itemLevelMinor,
      invoiceLevelMinor,
      totalMinor: itemLevelMinor + invoiceLevelMinor,
    },
    excessMinor: excess,
  };
}

/**
 * A final invoice's meter lines less what interim invoices billed, per value combination: each
 * combination's window lines give up the billed amount and quantity in order, never below 0.
 * What is left over (late voids, a cheaper re-rate) is the excess credited on the interims.
 */
export function netMeterLines(rated: MeterItemRating, prior: ItemBilled) {
  const lines = new Map<MeterLineRating, { cumulative: bigint; billedBefore: bigint }>();
  const taken = new Map<MeterLineRating, bigint>();
  const takenQty = new Map<MeterLineRating, bigint>();
  let excessMinor = 0n;
  const groups = new Map<string, MeterLineRating[]>();
  for (const l of rated.lines)
    if (!l.late) groups.set(groupKey(l.group), [...(groups.get(groupKey(l.group)) ?? []), l]);
  for (const [k, b] of prior.groups) {
    const ls = groups.get(k) ?? [];
    const cumulative = ls.reduce((a, l) => a + l.amountMinor, 0n);
    let amt = b.amountMinor;
    let qty = b.quantity;
    for (const l of ls) {
      const a = amt < l.amountMinor ? amt : l.amountMinor;
      const q = qty < l.quantity ? qty : l.quantity;
      l.amountMinor -= a > 0n ? a : 0n;
      l.quantity -= q > 0n ? q : 0n;
      taken.set(l, a > 0n ? a : 0n);
      takenQty.set(l, q > 0n ? q : 0n);
      amt -= a > 0n ? a : 0n;
      qty -= q > 0n ? q : 0n;
    }
    if (ls[0]) lines.set(ls[0], { cumulative, billedBefore: b.amountMinor });
    if (amt > 0n) excessMinor += amt;
  }
  return { lines, taken, takenQty, excessMinor };
}
