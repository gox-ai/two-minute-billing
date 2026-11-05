/**
 * The dashboard's one CSV writer: quote a field only when it needs it (RFC 4180).
 *
 * Text that starts with `= + - @`, a tab or a carriage return gets a leading `'`, so a
 * spreadsheet shows it instead of evaluating it: customer names reach exports from the
 * public checkout and the portal. Numbers are never prefixed — a number value, or a string
 * that is a plain decimal (`-12.50`, `-3`, `-1e-7`), stays a number in the sheet.
 * `src/platform/csv.ts` is the same rule for the engine.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (typeof v === "string" && FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: readonly unknown[]) => cells.map(csvCell).join(",");
