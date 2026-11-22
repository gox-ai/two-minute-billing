/**
 * Split an engine tax figure into the tax added on top and the tax already inside
 * tax-inclusive prices.
 *
 * The engine's `tax_minor` counts both, but its tax rows (`tax_lines`) list only added
 * tax: inside tax never becomes a row, because it is not added to the total. So with the
 * rows present, inside tax = `tax_minor − Σ rows`. With no rows at all (a payload without
 * the breakdown) the figure is treated as added tax, as screens always showed it.
 */
export const INCLUDED_TAX_LABEL = "Tax (included)";

type TaxRow = { amountMinor: number } | { amount_minor: number };

const rowMinor = (r: TaxRow) => ("amountMinor" in r ? r.amountMinor : r.amount_minor);

export function splitTax(
  taxMinor: number | null | undefined,
  rows: ReadonlyArray<TaxRow> | null | undefined,
): { addedMinor: number; includedMinor: number } {
  const tax = taxMinor ?? 0;
  if (!rows) return { addedMinor: tax, includedMinor: 0 };
  const added = rows.reduce((s, r) => s + rowMinor(r), 0);
  return { addedMinor: added, includedMinor: Math.max(0, tax - added) };
}
