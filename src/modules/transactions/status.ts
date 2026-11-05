/**
 * The gateway-log outcome vocabulary — the same `succeeded` / `failed` words payments,
 * refunds and events use. The old spellings were renamed in 0321 and are accepted on
 * input only (filters, reconcile), never written or returned.
 */
export const TRANSACTION_STATUSES = [
  "in_progress",
  "succeeded",
  "failed",
  "voided",
  "timeout",
  "needs_attention",
  "late_failed",
] as const;

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/** Deprecated input spelling → current value. */
export const TRANSACTION_STATUS_ALIASES: Readonly<Record<string, TransactionStatus>> = {
  success: "succeeded",
  failure: "failed",
  late_failure: "late_failed",
};

/** Map a caller-supplied status to the stored spelling; unknown values pass through. */
export function normalizeTransactionStatus(value: string): string {
  const key = value.toLowerCase();
  return Object.hasOwn(TRANSACTION_STATUS_ALIASES, key) ? TRANSACTION_STATUS_ALIASES[key]! : value;
}
