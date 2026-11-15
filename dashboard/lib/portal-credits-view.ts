// The portal's credit card and history: which rows, in which order (pure; unit-tested).

import { fmtUnits } from "./credits";
import { money } from "./format";

interface UnitBalance {
  unit: string | null;
  /** False = the unit has no money value. Absent = it has one. */
  rated?: boolean;
}
interface Balance {
  currency: string;
  available_minor: number;
  units: UnitBalance[];
}
interface Grant {
  currency: string;
  unit: string | null;
  unit_rated?: boolean;
}

export type CreditRow<B extends Balance, G extends Grant> =
  | { kind: "money"; balance: B }
  | { kind: "unit"; balance: B; unit: B["units"][number] }
  | { kind: "grant"; grant: G };

const noRate = (u: UnitBalance) => u.unit != null && u.rated === false;

/**
 * Each figure followed by its own grants: the money row with the grants that have a money
 * value, then each unit with no rate with its grants. A money row of 0 is left out when the
 * buyer holds only credit with no money value. With no such unit, the order is the old one:
 * every money row, then every grant.
 */
export function creditRows<B extends Balance, G extends Grant>(credits: {
  balances: B[];
  grants: G[];
}): CreditRow<B, G>[] {
  const { balances, grants } = credits;
  const grantRow = (grant: G): CreditRow<B, G> => ({ kind: "grant", grant });
  if (!balances.some((b) => b.units.some(noRate)))
    return [
      ...balances.map((balance): CreditRow<B, G> => ({ kind: "money", balance })),
      ...grants.map(grantRow),
    ];

  const rows: CreditRow<B, G>[] = [];
  const placed = new Set<G>();
  const take = (list: G[]) => {
    for (const g of list) placed.add(g);
    return list.map(grantRow);
  };
  for (const balance of balances) {
    const mine = grants.filter((g) => g.currency === balance.currency);
    const withValue = mine.filter((g) => g.unit_rated !== false);
    const units = balance.units.filter(noRate);
    const onlyNoValue = balance.available_minor === 0 && withValue.length === 0 && units.length > 0;
    if (!onlyNoValue) rows.push({ kind: "money", balance }, ...take(withValue));
    for (const unit of units)
      rows.push(
        { kind: "unit", balance, unit },
        ...take(mine.filter((g) => g.unit_rated === false && g.unit === unit.unit)),
      );
  }
  // A grant with no figure row of its own is still listed.
  return [...rows, ...grants.filter((g) => !placed.has(g)).map(grantRow)];
}

const HISTORY_KIND: Record<string, string> = {
  grant: "Credit added",
  activate: "Credit added",
  draw: "Used on an invoice",
  expire: "Expired",
  void: "Removed",
  restore: "Returned",
  rollover_in: "Carried to this period",
  rollover_out: "Carried to the next period",
};

/** A history line's name. A draw made by a usage settlement has no invoice. */
export const historyLabel = (t: { kind: string; for_usage?: boolean }) =>
  t.kind === "draw" && t.for_usage ? "Paid for usage" : (HISTORY_KIND[t.kind] ?? "Credit changed");

/** A history line's amount: units for a unit with no money value, else money as before. */
export function historyAmount(t: {
  currency: string;
  face_minor: number;
  units?: number;
  unit?: string | null;
  unit_name?: string;
  unit_plural_name?: string;
  decimals?: number;
  unit_rated?: boolean;
}): string {
  if (t.unit == null || t.unit_rated !== false || t.units == null)
    return money(t.face_minor, t.currency);
  return fmtUnits(t.units, {
    key: t.unit,
    name: t.unit_name ?? t.unit,
    plural: t.unit_plural_name ?? t.unit,
    decimals: t.decimals ?? 0,
    currency: t.currency,
  });
}

/**
 * A unit with no money value, under its available figure: what open holds reserve and what
 * is used but not settled yet, in the buyer's words (not the operator's "hold" and
 * "settled"). Absent or zero: no line.
 */
export function unitPartLines(u: {
  name: string;
  plural_name: string;
  decimals: number;
  held_amount?: number;
  unsettled_amount?: number;
}): string[] {
  const info = {
    key: "unit",
    name: u.name,
    plural: u.plural_name,
    decimals: u.decimals,
    currency: "",
    rated: false,
  };
  const lines: string[] = [];
  if (u.held_amount) lines.push(`Reserved for usage in progress: ${fmtUnits(u.held_amount, info)}`);
  if (u.unsettled_amount)
    lines.push(`Used recently, not in the history yet: ${fmtUnits(u.unsettled_amount, info)}`);
  return lines;
}

interface AutoTopup {
  unit_name: string;
  unit_plural_name: string;
  decimals: number;
  currency: string;
  trigger: "threshold" | "schedule";
  threshold_amount: number | null;
  target_amount: number | null;
  /** One purchase: all its packs, and their price before tax. */
  pack_credits_amount: number;
  pack_amount_minor: number;
  /** Packs one purchase buys. Absent on an older API. */
  pack_quantity?: number;
  /** False: a run has no payment method that we can charge. Absent on an older API. */
  has_payment_method?: boolean;
  status: "active" | "disabled";
  disabled_reason: string | null;
}

/**
 * What the buyer reads for one automatic top-up: what it buys and when, and what to correct.
 * A fixed top-up states one purchase: its packs, their credits and their price before tax.
 * A target top-up buys single packs, so the price of one pack is true for every run.
 */
export function autoTopupLines(t: AutoTopup): {
  title: string;
  detail: string;
  problem: string | null;
} {
  const info = {
    key: "unit",
    name: t.unit_name,
    plural: t.unit_plural_name,
    decimals: t.decimals,
    currency: t.currency,
    rated: false,
  };
  const count = (steps: number) => fmtUnits(steps, info);
  const price = money(t.pack_amount_minor, t.currency);
  const byThreshold = t.trigger === "threshold" && t.threshold_amount != null;
  const packs = t.pack_quantity;
  // What one run buys, what stops it, and a closing sentence.
  let what: string;
  let until = "";
  let after = "";
  if (t.target_amount != null) {
    what = `packs of ${count(t.pack_credits_amount)}`;
    until = `until you have ${count(t.target_amount)} or more`;
    after = ` Each pack is ${price} before tax.`;
  } else if (packs == null) what = `${count(t.pack_credits_amount)} for ${price} before tax`;
  else if (packs === 1) what = `a pack of ${count(t.pack_credits_amount)} for ${price} before tax`;
  else {
    what = `${packs} packs of ${count(t.pack_credits_amount / packs)}`;
    after = ` That is ${count(t.pack_credits_amount)} for ${price} before tax.`;
  }
  const lead = byThreshold
    ? `When you have ${count(t.threshold_amount!)} or less, we`
    : "On a schedule, we";
  const cond = byThreshold
    ? `when you have ${count(t.threshold_amount!)} or less`
    : "on a schedule";
  const on = t.status === "active";
  return {
    title: on
      ? `Automatic top-up of ${t.unit_plural_name} is on`
      : `Automatic top-up of ${t.unit_plural_name} is off`,
    // Off, the sentence says what it does once enabled, not what it does now.
    detail: on
      ? `${lead} buy ${what}${until ? ` ${until}` : ""}.${after}`
      : `If you enable it, we buy ${what} ${cond}${until ? `, ${until}` : ""}.${after}`,
    problem: autoTopupProblem(t),
  };
}

/** What the buyer must correct before a top-up can buy: a failed payment, or no payment method. */
export function autoTopupProblem(
  t: Pick<AutoTopup, "status" | "disabled_reason" | "has_payment_method">,
): string | null {
  if (
    t.status === "disabled" &&
    (t.disabled_reason === "payment_declined" || t.disabled_reason === "retries_exhausted")
  )
    return "The last automatic top-up payment failed. Check your payment method. Then enable automatic top-up.";
  if (t.has_payment_method === false)
    return t.status === "active"
      ? "You have no payment method that we can charge. Add a payment method so that we can buy credit for you."
      : "You have no payment method that we can charge. Add a payment method before you enable automatic top-up.";
  return null;
}
