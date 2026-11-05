// Plain-language consequences for the Dunning screen. Each mirrors
// `planFailureRearm` (src/modules/subscriptions/dunning-schedule.ts) and
// `sweepExpiredParkedDunning` (dunning.ts); change them together.

/** `resolveDunningConfig`'s fallback schedule. */
export const DEFAULT_RETRY_DAYS = [1, 3, 5, 7];
/** `PARKED_GRACE_DAYS`: a held invoice's window when no period is set. */
export const HELD_GRACE_DAYS = 30;
/** `RETRY_THEN_PARK_ATTEMPTS`: a generic refusal is held after this many failed attempts. */
export const GENERIC_HOLD_AFTER = 4;

export type FinalInvoice = "not_paid" | "void" | "write_off" | "reverse";
export type FinalSubscription =
  | "cancel"
  | "cancel_at_term_end"
  | "pause"
  | "stop_charging"
  | "retain";

/** `DEFAULT_ADAPTIVE_CADENCE` (src/modules/subscriptions/adaptive-schedule.ts). */
export const DEFAULT_CADENCE = {
  transientHours: [4, 24, 72],
  genericDays: [2, 3, 4],
  fundsGapDays: null as number | null,
  fundsMaxRetries: 4,
};

/** `BANK_DEBIT_MAX_RETRIES`: a bank-debit schedule stays within every debit scheme. */
export const BANK_DEBIT_MAX_RETRIES = 5;

export function listDays(days: number[]): string {
  if (days.length <= 1) return days.join("");
  return `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}`;
}

/** The days that actually run: an offset past the period's end is replaced by the last try. */
export function retryLine(days: number[], deadline: number | null): string {
  const inside = deadline == null ? days : days.filter((d) => d <= deadline);
  const head = inside.length ? `Days ${listDays(inside)} after the due date` : "No retries";
  if (deadline == null) return `${head}.`;
  if (inside[inside.length - 1] === deadline) return `${head}.`;
  return `${head}, then one last try on day ${deadline}.`;
}

/**
 * A decline that WOULD be held, with holding off: it retries, and with no period it
 * keeps the 30-day window a hold would have had — except on a mandate debit.
 */
export function unheldLine(days: number[], period: number | null): string {
  if (period != null) return `${retryLine(days, period)} Still unpaid: final actions.`;
  const base = retryLine(days, HELD_GRACE_DAYS).replace(/\.$/, "");
  return `${base} (not on mandate debits). Still unpaid: final actions.`;
}

export function plainLine(days: number[], period: number | null): string {
  return `${retryLine(days, period)} Still unpaid${period == null ? " after the last retry" : ""}: final actions.`;
}

const INVOICE_DONE: Record<FinalInvoice, string> = {
  not_paid: "marked not paid",
  void: "voided",
  write_off: "written off",
  reverse: "reversed",
};

const SUBSCRIPTION_DONE: Record<FinalSubscription, string> = {
  cancel: "cancelled",
  cancel_at_term_end: "cancelled at the end of its term",
  pause: "paused",
  stop_charging: "kept with automatic charges off",
  retain: "kept active",
};

export function finalActionsLine(inv: FinalInvoice, sub: FinalSubscription): string {
  return `the invoice is ${INVOICE_DONE[inv]} and the subscription is ${SUBSCRIPTION_DONE[sub]}`;
}

export const INVOICE_OPTIONS: Array<{ value: FinalInvoice; label: string }> = [
  { value: "not_paid", label: "Mark not paid (debt stands)" },
  { value: "void", label: "Void the invoice" },
  { value: "write_off", label: "Write off (bad debt, credit note)" },
  { value: "reverse", label: "Reverse (paid, order-cancellation credit note)" },
];

export const SUBSCRIPTION_OPTIONS: Array<{ value: FinalSubscription; label: string }> = [
  { value: "cancel", label: "Cancel now" },
  { value: "cancel_at_term_end", label: "Cancel at the end of the term" },
  { value: "pause", label: "Pause" },
  { value: "stop_charging", label: "Keep, and stop automatic charges" },
  { value: "retain", label: "Keep active, and continue to bill" },
];

/** What the end action does, for the consequence line under the selects. */
export const SUBSCRIPTION_HELP: Record<FinalSubscription, string> = {
  cancel: "We cancel the subscription at once.",
  cancel_at_term_end:
    "The subscription stays active until the end of its term. Then it is cancelled. If the end of its term is already past, it is cancelled at once. If it is not active (for example, in trial), we cancel it at once.",
  pause:
    "We pause the subscription at once, and it stays paused until you resume it. If it is set to cancel on a date that is in the future, we do not pause it, and the cancellation stays. If that date is already past, we cancel it at once. If it is not active (for example, in trial), we cancel it at once.",
  stop_charging:
    "The subscription stays active, and we set its automatic collection to off. We continue to send invoices, but we do not charge them.",
  retain: "The subscription stays active. We continue to bill and charge it.",
};
