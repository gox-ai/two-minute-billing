/**
 * Billing mode as ONE choice for the UI, over the two axes the API stores.
 *
 * One "billing mode" setting, but the day-based option would cover two genuinely
 * different billing behaviors. Rather than render one control that silently means two
 * things, we offer the three real modes by name. The fourth combination (day-anchored
 * + exact proration) is rejected by the API, so it is not offered here either.
 */
export type BillingModeId = "millisecond" | "day_based" | "day_based_legacy";

export interface BillingModeAxes {
  anchor_granularity: "instant" | "day";
  proration_granularity: "exact" | "whole_day";
}

export const BILLING_MODES: Record<
  BillingModeId,
  BillingModeAxes & { label: string; help: string }
> = {
  millisecond: {
    anchor_granularity: "instant",
    proration_granularity: "exact",
    label: "Milliseconds (exact instant)",
    help: "Terms start at the exact instant of signup and renew at that same timestamp. Prorated credits and charges are measured to the millisecond. This is the default.",
  },
  day_based: {
    anchor_granularity: "instant",
    proration_granularity: "whole_day",
    label: "Calendar days",
    help: "Terms still start at the exact instant of signup. Prorated credits and charges use whole days. A billing day starts at the term’s start time, not at midnight.",
  },
  day_based_legacy: {
    anchor_granularity: "day",
    proration_granularity: "whole_day",
    label: "Calendar days, midnight-aligned terms",
    help: "Terms start at the beginning of the signup day in this business’s time zone. They end at the last moment of the final day (23:59:59). Proration uses whole days.",
  },
};

/** Which mode a business's stored axes represent. Unknown pairs fall back to the default. */
export function billingModeIdOf(axes: Partial<BillingModeAxes> | null | undefined): BillingModeId {
  if (axes?.anchor_granularity === "day") return "day_based_legacy";
  if (axes?.proration_granularity === "whole_day") return "day_based";
  return "millisecond";
}

/** Short label for the settings-hub row. */
export function billingModeLabel(axes: Partial<BillingModeAxes> | null | undefined): string {
  return BILLING_MODES[billingModeIdOf(axes)].label;
}

export function isBillingModeId(v: string): v is BillingModeId {
  return v === "millisecond" || v === "day_based" || v === "day_based_legacy";
}
