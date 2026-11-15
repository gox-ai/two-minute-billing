/**
 * Which credit-note items are TAX the ladder already states, so a renderer leaves them
 * out of the line table and the tax prints once. Pure, no imports: `proration.ts` (the
 * writer), `document.ts` (PDF/email) and the REST detail read (the dashboard page) all
 * use this one rule.
 */

/**
 * The tax a credit note carries, DERIVED — a credit note stores no tax column, so
 * rearranging the totals identity is the only source of truth available:
 *
 *     total = sub_total − Σ discounts + tax
 *
 * Exact by construction: the writers size `subtotal_minor` net of the tax the note
 * carries (`creditOneInvoice`: `Σ cashable + bucketReturned − taxOnNote`). A note that
 * records no gross of its own comes out 0.
 *
 * A NULL `subtotal_minor` means "gross not recorded; it equals total_minor" — the
 * pre-0186 convention and the state of all 918 backfilled historical rows. There is no
 * ladder to rearrange on those, so the answer is 0 and no tax row prints.
 *
 * Exported so the REST read derives the number with the SAME code the PDF does, rather
 * than a second copy of the identity that can drift from it.
 */
export function creditNoteTaxTotal(
  note: { subtotalMinor: bigint | null; totalMinor: bigint },
  discounts: Array<{ amountMinor: bigint }>,
): bigint {
  if (note.subtotalMinor === null) return 0n;
  return note.totalMinor - note.subtotalMinor + discounts.reduce((s, d) => s + d.amountMinor, 0n);
}

/** The item the change path writes for the tax a note reverses (`proration.ts`). */
export const TAX_REVERSAL_DESCRIPTION = "Tax reversal on credited time";

export interface NoteItemForTax {
  kind: string | null;
  description: string;
  amountMinor: bigint;
  invoiceLineItemId: string | null;
}

/**
 * The items stated in the tax rows instead of as lines.
 *
 * A candidate is an item with `kind = 'tax'`, or an unmarked item (written before the
 * kind was recorded) that carries the engine's tax-reversal wording and credits no
 * invoice line. Candidates move to the tax rows only when they sum EXACTLY to the
 * ladder's tax (`creditNoteTaxTotal`): then the line table plus the ladder still add up
 * to the total. Any other shape keeps every item as a line, as before — a note whose
 * gross was not recorded has no tax rows, so its tax item is the one place that tax
 * prints.
 */
export function itemsStatedAsTax<T extends NoteItemForTax>(
  items: readonly T[],
  ladderTaxMinor: bigint,
): Set<T> {
  if (ladderTaxMinor <= 0n) return new Set();
  const candidates = items.filter(
    (it) =>
      it.kind === "tax" ||
      (it.kind === null &&
        it.invoiceLineItemId === null &&
        it.description === TAX_REVERSAL_DESCRIPTION),
  );
  const sum = candidates.reduce((s, it) => s + it.amountMinor, 0n);
  return sum === ladderTaxMinor ? new Set(candidates) : new Set();
}
