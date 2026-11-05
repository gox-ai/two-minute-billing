/**
 * `customers.billing_date_mode` (CUST-5) as human copy.
 *
 * The vocabulary was written out three times — a filter's options, an edit dialog's
 * options, and the customer detail page, which printed the RAW enum (`using_defaults`
 * on screen). Three copies also meant three wordings for two values: the dialog said
 * "Use business defaults" where the filter said "Using defaults". One map, so a value
 * reads the same everywhere it appears.
 */
export type BillingDateMode = "using_defaults" | "manually_set";

export const BILLING_DATE_MODE_LABELS: Record<BillingDateMode, string> = {
  using_defaults: "Using defaults",
  manually_set: "Manually set",
};

export const BILLING_DATE_MODE_OPTIONS = (
  Object.keys(BILLING_DATE_MODE_LABELS) as BillingDateMode[]
).map((value) => ({ value, label: BILLING_DATE_MODE_LABELS[value] }));

/** Unknown values pass through rather than vanish — a new enum member should be visible. */
export function billingDateModeLabel(mode: string | null | undefined): string {
  if (!mode) return "—";
  return BILLING_DATE_MODE_LABELS[mode as BillingDateMode] ?? mode;
}
