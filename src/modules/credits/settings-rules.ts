/**
 * Pure rules of the credit settings (step 6) and reports (step 7), with no database and no
 * import of the credits service, so unit tests and any module can load them alone.
 */
import { faceMinorFor, isUnrated } from "./units";

export type OverdraftSource = "customer" | "plan" | "unit" | "default";

export interface OverdraftLayers {
  /** The unit's own limit; undefined = none. */
  unit?: bigint;
  /** Product id → limit. */
  byProduct: ReadonlyMap<string, bigint>;
  /** The customer's own limit; undefined = none. */
  customer?: bigint;
}

/**
 * Most specific wins: the customer's row, then the first plan with a row (live subscriptions
 * oldest first, as the credit cost resolves), then the unit's row, else 0.
 */
export function pickOverdraftLimit(
  layers: OverdraftLayers,
  subscriptions: ReadonlyArray<{ productIds: readonly string[] }>,
): { steps: bigint; source: OverdraftSource } {
  if (layers.customer !== undefined) return { steps: layers.customer, source: "customer" };
  for (const s of subscriptions)
    for (const p of s.productIds) {
      const v = layers.byProduct.get(p);
      if (v !== undefined) return { steps: v, source: "plan" };
    }
  if (layers.unit !== undefined) return { steps: layers.unit, source: "unit" };
  return { steps: 0n, source: "default" };
}

/**
 * The money price of usage past the credits. A meter's own usage price wins over the unit's
 * overage price; neither = no price, and the usage is refused.
 */
export function pickOveragePrice(input: {
  meterUsagePrice: boolean;
  unitOverageMinorPerUnitE12: bigint | null;
}): "meter_price" | "unit_overage" | "none" {
  if (input.meterUsagePrice) return "meter_price";
  return input.unitOverageMinorPerUnitE12 != null ? "unit_overage" : "none";
}

/** Money for `steps` of overage at the unit's overage price, rounded half up. */
export function overageMinorFor(steps: bigint, overageE12: bigint, decimals: number): bigint {
  return faceMinorFor(steps, { minorPerUnitE12: overageE12, decimals });
}

const REFUSED = "We could not save the credit unit.";

/** A refusal for a patch the unit cannot take, else null. */
export function policiesIssue(
  u: { minorPerUnitE12: bigint | null },
  p: {
    overageMinorPerUnitE12?: bigint | null;
    negativeAtReset?: "carry" | "forgive";
    overdraftSteps?: bigint;
  },
) {
  if (p.overageMinorPerUnitE12 != null && !isUnrated(u))
    return `${REFUSED} An overage price is for a unit with no money value. A unit with a money value bills usage through its prices.`;
  if (p.overageMinorPerUnitE12 != null && p.overageMinorPerUnitE12 <= 0n)
    return `${REFUSED} The overage price must be more than 0.`;
  if (p.overdraftSteps !== undefined && p.overdraftSteps < 0n)
    return `${REFUSED} The overdraft limit must be 0 or more.`;
  if (p.overdraftSteps && p.overdraftSteps > 0n && !isUnrated(u))
    return `${REFUSED} An overdraft limit in units is for a unit with no money value. For money, use the overdraft limit in the credit settings.`;
  if (p.negativeAtReset === "forgive" && !isUnrated(u))
    return `${REFUSED} Forgive at plan reset is for a unit with no money value.`;
  return null;
}

/** A refusal for a reason the void cannot take, else null. */
export function voidReasonIssue(input: { reason?: string; note?: string | null }): string | null {
  if (input.note && !input.reason)
    return "We could not void the credit grant. A note needs a reason. Send reason too.";
  if (input.reason === "other" && !input.note)
    return "We could not void the credit grant. The reason other needs a note. Send note.";
  return null;
}

export type RollBucket = "sold" | "recognised" | "breakage" | "refunds" | "other";

/**
 * Which line of the roll-forward a movement of a PAID grant lands on, signed as the
 * deferred balance moves (+ in, − out).
 * - grant / activate: sold (paid credit becomes spendable).
 * - draw / restore: recognised (a draw moves it to revenue; a restore gives a draw back).
 * - expire: breakage. void: refunds (a credit note). The reader passes a void with no invoice
 *   (paid credit voided without a refund, 0530) as expire.
 * - rollover_in / rollover_out: other (moves between grants; nets to 0 in one instant).
 */
export function rollBucketOf(kind: string): RollBucket {
  switch (kind) {
    case "grant":
    case "activate":
      return "sold";
    case "draw":
    case "restore":
      return "recognised";
    case "expire":
      return "breakage";
    case "void":
      return "refunds";
    default:
      return "other";
  }
}

export interface RollRow {
  month: string;
  currency: string;
  unit: string;
  opening: bigint;
  sold: bigint;
  recognised: bigint;
  breakage: bigint;
  refunds: bigint;
  other: bigint;
  closing: bigint;
  /** What credit notes gave back on the packs, used credits included. Not in the balance. */
  credited?: bigint;
}

/**
 * Fold signed movement sums into month rows. Each row satisfies
 * opening + sold − recognised − breakage − refunds + other = closing, and a month's closing is
 * the next month's opening. `flows` are (month, currency, unit, kind, cost) sums inside the
 * range; `openings` the balance before it.
 */
export function foldRollForward(input: {
  months: readonly string[];
  openings: ReadonlyArray<{ currency: string; unit: string; cost: bigint }>;
  flows: ReadonlyArray<{
    month: string;
    currency: string;
    unit: string;
    kind: string;
    cost: bigint;
  }>;
}): RollRow[] {
  const keys = new Set<string>();
  for (const o of input.openings) keys.add(`${o.currency}\u0000${o.unit}`);
  for (const f of input.flows) keys.add(`${f.currency}\u0000${f.unit}`);
  const out: RollRow[] = [];
  for (const key of [...keys].sort()) {
    const [currency, unit] = key.split("\u0000") as [string, string];
    let balance = input.openings
      .filter((o) => o.currency === currency && o.unit === unit)
      .reduce((s, o) => s + o.cost, 0n);
    for (const month of input.months) {
      const row: RollRow = {
        month,
        currency,
        unit,
        opening: balance,
        sold: 0n,
        recognised: 0n,
        breakage: 0n,
        refunds: 0n,
        other: 0n,
        closing: 0n,
      };
      for (const f of input.flows) {
        if (f.month !== month || f.currency !== currency || f.unit !== unit) continue;
        const b = rollBucketOf(f.kind);
        // Out-flows are reported as positive amounts.
        if (b === "sold" || b === "other") row[b] += f.cost;
        else row[b] -= f.cost;
      }
      row.closing =
        row.opening + row.sold - row.recognised - row.breakage - row.refunds + row.other;
      balance = row.closing;
      out.push(row);
    }
  }
  return out;
}

/** "2026-01" … "2026-03" inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  const out: string[] = [];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, (m = 1)) : m++)
    out.push(`${y}-${String(m).padStart(2, "0")}`);
  return out;
}
