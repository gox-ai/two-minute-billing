/**
 * How much of a credit note's total is tax — the `tax_payable` leg of its ledger entry.
 * Pure: the writers in `./service.ts` read the inputs and post the result.
 *
 * A note's total is the gross it takes off the invoice. Two rules split it:
 *
 *  - LINE RULE — every item names a line of the credited invoice. Each line's items
 *    reverse that line's own tax: the amount is tax-inclusive, so the tax inside it is
 *    backed out of the line's combined rate, `amount × R / (10000 + R)`, half up, once
 *    per line, capped at what the line booked. A `kind = 'tax'` line is all tax.
 *  - INVOICE RULE — any amount-only item. Such an item names no supply, so the note
 *    takes the invoice's average share, `total × bookedTax / taxedGross`, half up.
 *
 * Either way the result is capped at the tax still standing, and the note that brings
 * the credited amount up to the invoice's taxed gross reverses ALL of what is left, so
 * a fully credited invoice ends with nothing on `tax_payable`.
 */

/** One credited line, with this note's items against it summed. */
export interface CreditedLineTax {
  /** Σ this note's item amounts against the line (tax-inclusive). */
  amountMinor: bigint;
  /** Σ `rate_bps` of the line's applied tax components that charged anything. */
  rateBps: bigint;
  /** What the line booked: its applied tax, or its own amount for a tax line. */
  bookedTaxMinor: bigint;
  /** A `kind = 'tax'` invoice line: every unit credited against it is tax. */
  isTaxLine: boolean;
}

export interface CreditNoteTaxInput {
  totalMinor: bigint;
  /** Tax the invoice booked to `tax_payable`. */
  bookedTaxMinor: bigint;
  /** Booked tax less what earlier notes on the invoice reversed (net of voids). */
  remainingTaxMinor: bigint;
  /** The part of the invoice that bore tax: total less pre-tax promotional credit. */
  taxedGrossMinor: bigint;
  /** Σ totals of the invoice's non-voided notes, this one included. */
  creditedAfterMinor: bigint;
  /** Null selects the invoice rule. */
  lines: CreditedLineTax[] | null;
}

const halfUpDiv = (n: bigint, d: bigint): bigint => (n + d / 2n) / d;
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** The tax a line's credited amount carries under the line rule. */
export function lineTaxShare(line: CreditedLineTax): bigint {
  if (line.amountMinor <= 0n || line.bookedTaxMinor <= 0n) return 0n;
  const raw = line.isTaxLine
    ? line.amountMinor
    : line.rateBps > 0n
      ? halfUpDiv(line.amountMinor * line.rateBps, 10000n + line.rateBps)
      : 0n;
  return min(raw, line.bookedTaxMinor);
}

export function creditNoteTaxShare(input: CreditNoteTaxInput): bigint {
  const { totalMinor, bookedTaxMinor, remainingTaxMinor, taxedGrossMinor } = input;
  if (totalMinor <= 0n || bookedTaxMinor <= 0n || remainingTaxMinor <= 0n) return 0n;
  // The last note settles the remainder, so per-note rounding cannot leave tax behind.
  if (taxedGrossMinor > 0n && input.creditedAfterMinor >= taxedGrossMinor)
    return min(remainingTaxMinor, totalMinor);
  const raw = input.lines
    ? input.lines.reduce((s, l) => s + lineTaxShare(l), 0n)
    : taxedGrossMinor > 0n
      ? halfUpDiv(totalMinor * bookedTaxMinor, taxedGrossMinor)
      : 0n;
  return min(min(raw, remainingTaxMinor), totalMinor);
}
