import type { TransactionStatus } from "./api/payments";

/**
 * Transaction status facts both halves need.
 *
 * Separate from `lib/api/payments.ts` because that module imports `next/headers`: a client
 * component importing this constant from there dragged the server chain into the browser
 * bundle and the transaction page 500'd. Type-only imports are erased, so naming
 * `TransactionStatus` here is safe — a value import is not.
 */

/** Only `needs_attention` / `timeout` transactions accept an operator verdict. */
export const RECONCILABLE_STATUSES: readonly TransactionStatus[] = ["needs_attention", "timeout"];
