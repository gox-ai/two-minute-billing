// A meter's credit cost (0526) and what the credit gate recorded on an event: shapes, form
// conversion and labels. Pure, relative imports only, so the root unit tests load it.

/** `GET …/meters/{meter}/credit_cost` and `meter.credit_cost`. */
export interface MeterCreditCost {
  /** The credit unit key: a unit with no money value. */
  unit: string;
  /** Credits for one event of a count meter, or one unit of a sum meter's value. */
  credits_per_unit: string;
  overrides: Array<
    | { product: string; credits_per_unit: string }
    | { subscription: string; credits_per_unit: string }
  >;
}

/** One entry of `usage_event.credit[]`: what one meter with a credit cost took for the event. */
export interface EventCreditEntry {
  meter: string;
  unit: string;
  status: "taken" | "pending" | "settled" | "refused" | "skipped";
  reason: "insufficient_credit" | "backfill" | "unmatched_customer" | "voided" | null;
  quantity: string;
  credits_per_unit: string;
  cost_source: "meter" | "plan" | "subscription";
  credits_due: string;
  credits_taken: string;
  credits_from_closed_grant: string;
  /** The part that credits did not pay: billed in money when `overage_basis` is set. */
  credits_uncovered: string;
  /** What bills that part: the meter's usage price, or the unit's price per credit. */
  overage_basis?: "meter" | "unit" | null;
  /** The part of `credits_taken` that is below zero and not paid back or billed yet. */
  credits_overdrawn?: string;
  covered_by_hold: boolean;
}

/** The names of a unit, as a label needs them. */
export interface UnitNames {
  name: string;
  plural: string;
}

/** "12500.5" → "12,500.5". String math: a cost has up to 6 decimals and no float may round it. */
export function groupDecimal(text: string): string {
  const t = text.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) return t;
  const whole = m[2]!.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (m[3] ?? "").replace(/0+$/, "");
  return `${m[1]}${whole}${frac ? `.${frac}` : ""}`;
}

/** "1 credit", "12,500 credits", "0.5 credits". */
export function creditsLabel(text: string, unit: UnitNames): string {
  const g = groupDecimal(text);
  return `${g} ${g === "1" ? unit.name : unit.plural}`;
}

/**
 * Why a meter cannot have a credit cost, or null when it can. Same rule as the API: each
 * event must have its own quantity, so a count, or a sum that does not carry over.
 */
export function creditCostRefusal(m: {
  aggregation: string;
  recurring: boolean;
  status: string;
}): string | null {
  if (m.status !== "active") return "An archived meter cannot have a credit cost.";
  if (m.aggregation === "count" || (m.aggregation === "sum" && !m.recurring)) return null;
  return m.aggregation === "sum"
    ? "This meter carries its level to the next period, so its events have no quantity of their own. Only a meter that counts events, or adds a value that does not carry over, can have a credit cost."
    : "Only a meter that counts events, or adds a value that does not carry over, can have a credit cost.";
}

/**
 * What the cost is charged on: "each event", or "each unit of the value" for a meter that
 * adds a value. The property name is the meter's setup, so a sentence does not print it.
 */
export const costBasis = (aggregation: string, _valueProperty?: string | null) =>
  aggregation === "count" ? "each event" : "each unit of the value";

/** "Each event costs 1 credit." */
export function costSentence(
  cost: string,
  unit: UnitNames,
  aggregation: string,
  valueProperty: string | null,
): string {
  const basis = costBasis(aggregation, valueProperty);
  return `${basis.charAt(0).toUpperCase()}${basis.slice(1)} costs ${creditsLabel(cost, unit)}.`;
}

const COST_RE = /^\d+(?:\.\d{1,6})?$/;

/** A cost as typed: a number more than 0 with at most 6 decimals, like the API. */
export function costIssue(text: string): string | null {
  const t = text.trim();
  if (!COST_RE.test(t) || !/[1-9]/.test(t))
    return "Enter a number more than 0, with at most 6 decimal places.";
  return null;
}

export interface CreditCostDraft {
  unit: string;
  cost: string;
  plans: Array<{ product: string; cost: string }>;
}

/** The dialog's starting values: the stored cost, or the one unit there is. */
export function creditCostDraft(
  cost: MeterCreditCost | null | undefined,
  units: ReadonlyArray<{ id: string }>,
): CreditCostDraft {
  return {
    unit: cost?.unit ?? (units.length === 1 ? units[0]!.id : ""),
    cost: cost?.credits_per_unit ?? "",
    plans: (cost?.overrides ?? []).flatMap((o) =>
      "product" in o ? [{ product: o.product, cost: o.credits_per_unit }] : [],
    ),
  };
}

/** The error key of plan override row `i`. */
export const planCostKey = (i: number) => `plan_cost_${i}`;

/**
 * The PUT body. It replaces every override, so the subscription overrides (set through the
 * API, not on this screen) go back as they are, after the plans. Errors are keyed by field.
 */
export function creditCostBody(
  draft: CreditCostDraft,
  subscriptions: ReadonlyArray<{ subscription: string; credits_per_unit: string }>,
):
  | {
      ok: true;
      body: {
        unit: string;
        credits_per_unit: string;
        overrides: MeterCreditCost["overrides"];
      };
    }
  | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!draft.unit) errors.unit = "Select a credit unit.";
  const base = costIssue(draft.cost);
  if (base) errors.credits_per_unit = base;
  const seen = new Set<string>();
  draft.plans.forEach((p, i) => {
    if (!p.product) errors[planCostKey(i)] = "Select a plan.";
    else if (seen.has(p.product)) errors[planCostKey(i)] = "This plan is in the list two times.";
    else {
      const issue = costIssue(p.cost);
      if (issue) errors[planCostKey(i)] = issue;
    }
    seen.add(p.product);
  });
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      unit: draft.unit,
      credits_per_unit: draft.cost.trim(),
      overrides: [
        ...draft.plans.map((p) => ({ product: p.product, credits_per_unit: p.cost.trim() })),
        ...subscriptions.map((s) => ({
          subscription: s.subscription,
          credits_per_unit: s.credits_per_unit,
        })),
      ],
    },
  };
}

/**
 * The field an API refusal is about. The API names `credits_per_unit` and `overrides[i]`
 * in its message; the plans come first in the list, so index i < plans is plan row i.
 */
export function creditCostErrorField(message: string, plans: number): string | null {
  const o = /overrides\[(\d+)\]/.exec(message);
  if (o) {
    const i = Number(o[1]);
    return i < plans ? planCostKey(i) : null;
  }
  if (/credits_per_unit/.test(message)) return "credits_per_unit";
  if (/credit unit|different credit unit|keeps its unit/i.test(message)) return "unit";
  return null;
}

/** Where a cost came from, for the event line. */
const SOURCE_TEXT: Record<EventCreditEntry["cost_source"], string> = {
  meter: "",
  plan: " at the plan's cost",
  subscription: " at the subscription's cost",
};

/**
 * What an event of a meter with a credit cost did with credits, in one or two lines:
 * "Took 3 credits." / "Refused: not enough credit. It needed 3 credits." Never a currency.
 */
export function eventCreditLines(e: EventCreditEntry, unit: UnitNames): string[] {
  const n = (t: string) => creditsLabel(t, unit);
  const zero = (t: string) => /^0*(?:\.0*)?$/.test(t);
  switch (e.status) {
    case "refused":
      return [
        e.reason === "insufficient_credit"
          ? `Not enough credit. It needed ${n(e.credits_due)}.`
          : `Refused. It needed ${n(e.credits_due)}.`,
      ];
    case "skipped":
      return [
        e.reason === "backfill"
          ? "Sent as a backfill. It took no credits."
          : e.reason === "voided"
            ? "Voided. It took no credits."
            : "It took no credits.",
      ];
    default: {
      const lines = [`Took ${n(e.credits_taken)}${SOURCE_TEXT[e.cost_source]}.`];
      if (!zero(e.credits_uncovered))
        lines.push(
          e.overage_basis === "meter"
            ? `Credit did not pay ${n(e.credits_uncovered)}. We bill that part at the price of the meter.`
            : e.overage_basis === "unit"
              ? `Credit did not pay ${n(e.credits_uncovered)}. We bill that part at the price for each ${unit.name}.`
              : `Credit did not pay ${n(e.credits_uncovered)}.`,
        );
      if (e.credits_overdrawn && !zero(e.credits_overdrawn))
        lines.push(
          `${n(e.credits_overdrawn)} of that went below zero. The next credit pays this debt first.`,
        );
      if (!zero(e.credits_from_closed_grant))
        lines.push(`${n(e.credits_from_closed_grant)} from credit that ended after the event.`);
      if (e.covered_by_hold) lines.push("A hold paid for it.");
      if (e.status === "pending") lines.push("Waits for the late-event window to end.");
      return lines;
    }
  }
}

/** The event was refused for lack of credit: no usage counts it. */
export const refusedForCredit = (ev: { refused_at?: string | null; credit?: EventCreditEntry[] }) =>
  !!ev.refused_at || (ev.credit ?? []).some((c) => c.status === "refused");
