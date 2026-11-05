/**
 * The cuts this screen offers, as plain data.
 *
 * Not in the `"use client"` picker beside it: in RSC every export of a client module is a
 * client REFERENCE rather than the value, so the page could not read the list to validate
 * what arrived in the URL.
 */

/**
 * Billing intervals, the closed set `subscriptions.billing_period_unit` stores. Drives
 * `billing_period_unit[is]` on the subscriptions list — the same filter the list offers.
 */
export const CANCELLATION_INTERVALS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "year", label: "Yearly" },
];

/** The row a cancellation without a stored reason code falls into. */
export const NO_REASON_LABEL = "No reason recorded";
