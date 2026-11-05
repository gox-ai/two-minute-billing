// Pure display logic for the invoice fields that move on their own, shared
// between the initial server render (page.tsx) and the client refresh panel
// (invoice-refresh-panel.tsx) so the two never drift. No server-only imports —
// this file is bundled into the client.

export interface AmountsInput {
  amount_due_minor?: number | null;
  amount_paid_minor?: number | null;
  total_minor: number;
  status: string;
}

/**
 * `open` (whether the invoice can still collect) is taken from the page's
 * initial `invoiceCapabilities(inv)` and NOT recomputed on refresh — the action
 * rail's buttons are keyed off that same initial value and refreshing the
 * amounts must not make the numbers disagree with which controls are showing.
 */
export function computeAmounts(
  inv: AmountsInput,
  open: boolean,
): { amountDue: number; amountPaid: number } {
  const amountDue = open ? (inv.amount_due_minor ?? inv.total_minor) : 0;
  const amountPaid =
    inv.amount_paid_minor ??
    (inv.status === "paid" ? (inv.amount_due_minor ?? inv.total_minor) : 0);
  return { amountDue, amountPaid };
}
