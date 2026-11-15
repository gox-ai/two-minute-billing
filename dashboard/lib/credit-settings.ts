// Pure helpers and shared types for the credit unit policies (overage price, overdraft limit,
// negative balance at a plan reset) and the credit reports. Unit tests import this file.

export type NegativeAtReset = "carry" | "forgive";
export type OverdraftSource = "customer" | "plan" | "unit" | "default";

/** The policy fields of the credit unit object. */
export interface CreditUnitPolicies {
  overage_minor_per_unit: string | null;
  overdraft_limit: number;
  overdraft_limit_decimal: string;
  negative_balance_at_reset: NegativeAtReset;
}

/** "2.5" whole units → 25 steps at 1 decimal. Null when it is not a number ≥ 0 at that precision. */
export function stepsFromUnits(text: string, decimals: number): number | null {
  const t = text.trim();
  if (t === "") return null;
  const re = decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`);
  if (!re.test(t)) return null;
  const [whole = "0", frac = ""] = t.split(".");
  const v = Number(whole) * 10 ** decimals + Number(frac.padEnd(decimals, "0") || "0");
  return Number.isSafeInteger(v) ? v : null;
}

/** 25 steps at 1 decimal → "2.5". */
export function unitsFromSteps(steps: number, decimals: number): string {
  if (decimals === 0) return String(steps);
  const neg = steps < 0;
  const s = String(Math.abs(steps)).padStart(decimals + 1, "0");
  const out = `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "");
  return neg ? `-${out}` : out;
}

/** "Enter 0 or more" for an amount in a unit, with real words for 0 and 1 decimal places. */
export function zeroOrMoreMessage(decimals: number, thing = ""): string {
  const what = thing ? `${thing} ` : "";
  if (decimals === 0)
    return thing
      ? `Enter ${what}that is a whole number, 0 or more.`
      : "Enter a whole number, 0 or more.";
  return `Enter ${what}${thing ? "of " : ""}0 or more, with up to ${decimals} decimal ${decimals === 1 ? "place" : "places"}.`;
}

export const SOURCE_LABELS: Record<OverdraftSource, string> = {
  customer: "This customer",
  plan: "Plan",
  unit: "Credit unit",
  default: "Default",
};

export const VOID_REASON_OPTIONS = [
  { value: "customer_request", label: "Customer request" },
  { value: "goodwill_reversal", label: "Goodwill credit taken back" },
  { value: "billing_error", label: "Billing error" },
  { value: "fraud", label: "Fraud" },
  { value: "migration", label: "Migration" },
  { value: "other", label: "Other" },
] as const;
export type VoidReason = (typeof VOID_REASON_OPTIONS)[number]["value"];

/** One plan override row of the unit form. */
export interface PlanOverdraftRow {
  product: string;
  limit: string;
}

/**
 * What the form's plan rows change against what is stored: PUT these, DELETE those. Only a
 * plan the form loaded can be removed, so a limit added elsewhere since, or a post with no
 * list, never deletes a stored row.
 */
export function planOverdraftChanges(
  stored: ReadonlyArray<{ product: string; overdraft_limit: number }>,
  rows: ReadonlyArray<{ product: string; steps: number }>,
  loaded: ReadonlySet<string>,
): { put: Array<{ product: string; steps: number }>; remove: string[] } {
  const want = new Map(rows.map((r) => [r.product, r.steps]));
  const have = new Map(stored.map((s) => [s.product, s.overdraft_limit]));
  return {
    put: [...want]
      .filter(([p, v]) => have.get(p) !== v)
      .map(([product, steps]) => ({ product, steps })),
    remove: [...have.keys()].filter((p) => loaded.has(p) && !want.has(p)),
  };
}

/** A roll-forward row as the report API returns it. */
export interface RollForwardRow {
  month: string;
  currency: string;
  unit: string;
  opening_minor: number;
  sold_minor: number;
  recognised_minor: number;
  breakage_minor: number;
  refunds_minor: number;
  other_minor: number;
  closing_minor: number;
  /** Credit notes on the packs, used credits included. Outside the balance. */
  credited_minor: number;
}

/** Σ of each flow over the rows, with the first opening and the last closing. */
export function rollTotals(rows: readonly RollForwardRow[]) {
  const sum = (k: keyof RollForwardRow) => rows.reduce((s, r) => s + Number(r[k]), 0);
  return {
    opening_minor: rows[0]?.opening_minor ?? 0,
    sold_minor: sum("sold_minor"),
    recognised_minor: sum("recognised_minor"),
    breakage_minor: sum("breakage_minor"),
    refunds_minor: sum("refunds_minor"),
    other_minor: sum("other_minor"),
    closing_minor: rows.at(-1)?.closing_minor ?? 0,
    credited_minor: sum("credited_minor"),
  };
}
