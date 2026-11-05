/**
 * The engine's one CSV writer. Every field is quoted (RFC 4180).
 *
 * Text that starts with `= + - @`, a tab or a carriage return gets a leading `'`, so a
 * spreadsheet shows it instead of evaluating it: customer names reach exports from the
 * public checkout and the portal. Numbers are never prefixed — a number value, or a string
 * that is a plain decimal (`-12.50`, `-3`, `-1e-7`), stays a number in the sheet.
 * `dashboard/lib/csv.ts` is the same rule for the dashboard runtime.
 */
export type CsvValue = string | number | bigint | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function csvField(v: CsvValue): string {
  let s = v == null ? "" : String(v);
  if (typeof v === "string" && FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}

export const csvRow = (cells: readonly CsvValue[]) => cells.map(csvField).join(",");
