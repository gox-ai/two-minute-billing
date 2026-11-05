/**
 * How money moved when it moved OUTSIDE a gateway — the option set for every
 * "record an offline payment / refund" control.
 *
 * ── WHY ONE LIST ────────────────────────────────────────────────────────────────
 * There were three of these controls and only the credit-note one was a select. The
 * two payment-side ones were free-text boxes (`placeholder="cash / cheque / wire"` on
 * the invoice, `placeholder="bank_transfer"` on the customer), so an operator could
 * type anything — and the value is not decorative: `recordOfflinePayment` builds the
 * transaction's `gateway_key` as `offline_${method}` (invoicing/ops.ts). Free text
 * therefore minted a new gateway_key per spelling — `offline_cheque`, `offline_check`,
 * `offline_Cheque`, `offline_wire` — and `transactions` is the money log the UI and
 * reconciliation group by.
 *
 * The values mirror the engine's own `OFFLINE_REFUND_METHODS`
 * (`src/modules/credit-notes/service.ts`), which the refund route already enforces as
 * a zod enum. Using the same four in both directions is the point: a cheque refund and
 * a cheque payment should not land under two different keys.
 *
 * ⚠️ KNOWN INCONSISTENCY, deliberately not papered over here. The PAYMENT route
 * (`payBody.method`, invoice-routes.ts) is still `z.string().max(50)` — free text — and
 * its doc comment names a THIRD vocabulary, `cash | cheque | wire | other`, which
 * `scripts/verify-audit.ts` also uses (`method: 'wire'`). Constraining the UI is safe
 * and is what stops new drift; narrowing the route to the enum is an API change with a
 * test to update, so it is filed rather than smuggled in with a form fix.
 */
export const OFFLINE_METHOD_OPTIONS = [
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'other', label: 'Other' },
] as const satisfies ReadonlyArray<{ value: string; label: string }>

/**
 * Mutable copy for `SelectField`, whose `options` prop is not readonly.
 * Spread at the call site rather than widening the const above, so the source list
 * stays literal-typed.
 */
export const offlineMethodOptions = () => OFFLINE_METHOD_OPTIONS.map((o) => ({ ...o }))
