/**
 * Reason codes for a credit note — the one list every credit/refund control uses.
 *
 * Extracted from `components/credit-notes/create-form.tsx`, where it was a local
 * const, when the invoice page grew its own credit and refund dialogs. Two copies of
 * an enum that the route validates with `z.enum(REASON_CODES)` is how a dialog starts
 * offering a value the API 400s on — the same reasoning as `lib/offline-methods.ts`.
 *
 * The values mirror `REASON_CODES` in `src/api/credit-note-routes.ts` exactly. They
 * describe what the books did, not what the customer experienced — widening the list
 * means widening the engine's enum and deciding how each value maps onto the ledger,
 * which is an API change, not a form fix.
 */
export const CREDIT_REASON_CODES = [
  { value: "", label: "None" },
  { value: "write_off", label: "Write-off" },
  { value: "subscription_change", label: "Subscription change" },
  { value: "subscription_cancellation", label: "Subscription cancellation" },
  { value: "chargeback", label: "Chargeback" },
  { value: "other", label: "Other" },
] as const satisfies ReadonlyArray<{ value: string; label: string }>;

/** Mutable copy for `SelectField`, whose `options` prop is not readonly. */
export const creditReasonOptions = () => CREDIT_REASON_CODES.map((r) => ({ ...r }));
