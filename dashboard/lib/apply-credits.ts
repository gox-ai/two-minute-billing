/**
 * "Apply credits" on an invoice: what the engine draws and how a refusal reads.
 * Pure (unit-tested); imported by the dialog and the server action.
 */

export interface ApplyCreditsPlan {
  refundableMinor: number;
  excessMinor: number;
  totalMinor: number;
  dueAfterMinor: number;
}

/**
 * Refundable credit first, then excess payments, each up to what is still due: the order
 * `applyCreditsToInvoice` uses when it picks the amounts itself. The dialog posts these exact
 * amounts, so the engine refuses rather than applies a figure the operator did not see.
 */
export function applyCreditsPlan(
  dueMinor: number,
  refundableAvailable: number,
  excessAvailable: number,
): ApplyCreditsPlan {
  const due = Math.max(0, dueMinor);
  const refundableMinor = Math.min(Math.max(0, refundableAvailable), due);
  const excessMinor = Math.min(Math.max(0, excessAvailable), due - refundableMinor);
  const totalMinor = refundableMinor + excessMinor;
  return { refundableMinor, excessMinor, totalMinor, dueAfterMinor: due - totalMinor };
}

/**
 * The engine's refusal in our words. A 409 is a payment in progress: the engine's text already
 * says what to do. A 400 means the page is older than the invoice or the credit (both are read
 * again under the lock), so the next step is to reload.
 */
export function applyCreditsRefusal(status: number, engineMessage: string | undefined): string {
  if (status === 409 && engineMessage) return engineMessage;
  if (status === 400)
    return "We could not apply credits. The invoice or the customer's credit changed after you opened this page. Reload the page and try again.";
  if (status === 403) return "We could not apply credits. Your role does not include this action.";
  return "We could not apply credits. Try again.";
}
