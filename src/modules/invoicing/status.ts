/**
 * Invoice status vocabulary (E1 / INV-2).
 *
 * State machine (architecture doc §5.1):
 *   pending → posted → paid
 *   posted → payment_due → paid | not_paid
 *   posted → not_paid (offline, due date passed)
 *   payment_due|not_paid → voided
 *
 * `posted` means finalized but NOT YET DUE, which in practice means Net-D: an
 * invoice is only born `posted` when it carries a future due date, and `due.ts`
 * moves it to `payment_due` when that date arrives. An invoice with NO due date is
 * due on issue and is born `payment_due` — it must never be `posted`, because
 * due.ts only ever scans invoices that HAVE a due date, so nothing would move it
 * and it would sit "not yet due" forever.
 */
export type InvoiceStatus = "pending" | "posted" | "payment_due" | "not_paid" | "paid" | "voided";

/**
 * `credited` was here too, and NOTHING EVER ASSIGNED IT — zero writers, eight readers
 * (removed 2026-08-28). It was the last trace of the abandoned design in which a downgrade
 * minted a negative "credited" invoice; `issueCurrentTermCredit` replaced that with real
 * credit notes. Nothing ever reported it either: both canonicalizers of the day mapped
 * it straight to `voided`.
 *
 * It was not merely unused, it was ACTIVELY MISLEADING: five filters excluded it
 * (`!['voided', 'credited', 'pending']`), one of which — `creditItemsForSubscription`'s
 * `live` filter — would have dropped the already-reversed invoice in PROGRESS :146 before
 * the capacity question was ever asked. Two independent guards against that bug, both
 * ineffective, both reading as protection. A status that can never hold is worse than no
 * status. The real guard is `creditableCapacityForInvoice`.
 */

// `parked` is written by `settlement.ts` and `dunning.ts` (retries exhausted, awaiting a
// final action) and was missing from this union — the column is free text, so nothing
// caught it.
export type DunningStatus = "in_progress" | "parked" | "succeeded" | "exhausted" | "stopped";

/** Deprecated input spellings (renamed in 0321), still accepted on filters. */
export const DUNNING_STATUS_ALIASES: Readonly<Record<string, DunningStatus>> = {
  success: "succeeded",
};

/** Map a caller-supplied dunning status to the stored spelling; unknown values pass through. */
export function normalizeDunningStatus(value: string): string {
  const key = value.toLowerCase();
  return Object.hasOwn(DUNNING_STATUS_ALIASES, key) ? DUNNING_STATUS_ALIASES[key]! : value;
}

/**
 * Finalized statuses where the invoice still owes money (collectible AR is
 * outstanding). Used to guard collect / void / write-off / record-payment ops,
 * to post opening AR for imported invoices, and to sum open AR in reconcile.
 * Excludes `pending` (not finalized), `paid`/`voided` (settled).
 */
export const OPEN_INVOICE_STATUSES = ["posted", "payment_due", "not_paid"] as const;

/** Dunning states that claim work is still running. Only a `payment_due` invoice can hold one. */
export function isLiveDunning(s: string | null | undefined): boolean {
  return s === "in_progress" || s === "parked";
}

export function isOpenInvoiceStatus(s: string): boolean {
  return (OPEN_INVOICE_STATUSES as readonly string[]).includes(s);
}

/**
 * What `dunning_status` should become when an invoice SETTLES — whatever settled it.
 *
 * A real subscriber's INV-3361 sat at `status: paid`, `amount_due: 0`, `attempt_count: 3`
 * and `dunning_status: parked`: three collection attempts had parked it, then credit notes
 * covered the balance and the invoice was marked paid by a path that never revisited
 * dunning. Nothing bad follows from it — `sweepExpiredParkedDunning` scans
 * `status = 'payment_due'`, so no final action can reach a paid invoice — but the invoice
 * reports itself as still in collections, on the /ops screens and in the API. A settled
 * document must not claim to be mid-chase.
 *
 * Only the payment-success path in `service.ts` got this right, and only for its own case.
 * Every settle site now shares this rule so a fourth one cannot drift:
 *
 *   was being chased  → `succeeded`  (the chase ended with the money in, however it arrived)
 *   never chased      → leave null (a first-try payment is not a recovered dunning case)
 *
 * `stopped` is deliberately NOT preserved: an operator who halted the chase and then saw
 * the invoice settle got the outcome, and reporting the settled invoice as `stopped` hides
 * that. Pass `attemptDelta` where the settle also counts as an attempt.
 */
export function dunningFieldsOnSettle(inv: {
  attemptCount: number;
  dunningStatus: string | null;
}): { dunningStatus?: "succeeded" } {
  const wasChased =
    inv.attemptCount > 0 || (inv.dunningStatus != null && inv.dunningStatus !== "succeeded");
  return wasChased ? { dunningStatus: "succeeded" as const } : {};
}

/**
 * The same question when the balance went away WITHOUT ANY CASH — an adjustment credit
 * note (a plan-change credit, a cancellation credit, a write-off) took the debt to zero.
 *
 * `succeeded` would be a lie here, and it was one: sub_XXXXXXXXXXXXXXXXXXXXXX01 has ten
 * invoices reading `status: paid, dunning_status: succeeded` whose only payment attempt
 * FAILED — every one of them was zeroed by an adjustment note, and the invoice then
 * reported a recovered collection that never happened. `dunningFieldsOnSettle` cannot
 * tell the two apart because it only sees the invoice, not what settled it.
 *
 * The rule: `status` becomes `paid` and `paid_at` is stamped with the ADJUSTMENT's
 * timestamp, but `amount_paid` stays 0, `next_retry_at`
 * is dropped, and `dunning_status` becomes **`stopped`** — not `succeeded`. The chase ended;
 * it did not succeed.
 *
 * Deliberately NOT folded into `dunningFieldsOnSettle` as a flag: the cash paths and the
 * credit paths give different answers to the same question, and a boolean parameter is how
 * a caller silently picks the wrong one. Two names, one call site each way.
 *
 * `never chased → leave null` matches the cash rule for the same reason: an invoice
 * credited away before anyone chased it was never in collections.
 */
export function dunningFieldsOnCreditSettle(inv: {
  attemptCount: number;
  dunningStatus: string | null;
}): { dunningStatus?: "stopped" } {
  const wasChased = inv.attemptCount > 0 || inv.dunningStatus != null;
  return wasChased ? { dunningStatus: "stopped" as const } : {};
}
