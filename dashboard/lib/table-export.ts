/**
 * List exports: the CSV a list's Export button writes.
 *
 * Relative imports only: the root unit tests load this file, and `@/` resolves to the engine there.
 */
import { csvCell } from "./csv";
import { toMajorInput } from "./money";

/** One CSV column: its header and how to read it off a row. */
export interface ExportCell<T> {
  header: string;
  value: (row: T) => unknown;
}

/** Most rows one export writes. Past it the file says so and the operator narrows the view. */
export const EXPORT_ROW_CAP = 10_000;
/**
 * Rows per request while an export pages through a server list. The engine allows 1,000, but
 * the customers list sends each page's ids in one URL to fetch their subscriptions: 200 ids
 * keep it near 5 KB, well under Node's 16 KB header limit.
 */
export const EXPORT_PAGE_SIZE = 200;

/** A header line, then one line per row. */
export function buildCsv<T>(cells: readonly ExportCell<T>[], rows: readonly T[]): string {
  return [
    cells.map((c) => csvCell(c.header)).join(","),
    ...rows.map((r) => cells.map((c) => csvCell(c.value(r))).join(",")),
  ].join("\n");
}

/**
 * A money column in major units, fixed to the currency's decimals (`8083` USD → `80.83`,
 * `1642` JPY → `1642`), so a spreadsheet can sum it. Pair it with a Currency cell.
 */
export function moneyCell<T>(
  header: string,
  minor: (row: T) => number | null | undefined,
  currency: (row: T) => string | null | undefined,
): ExportCell<T> {
  return {
    header,
    value: (r) => {
      const m = minor(r);
      return m == null ? "" : toMajorInput(m, currency(r));
    },
  };
}

/** Page through a list from the start until it ends or reaches `cap` rows. */
export async function fetchAllPages<T>(
  fetchPage: (
    cursor: string | null,
  ) => Promise<{ rows: T[]; hasMore: boolean; nextCursor: string | null }>,
  cap: number,
  onProgress?: (loaded: number) => void,
): Promise<{ rows: T[]; capped: boolean }> {
  const rows: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await fetchPage(cursor);
    rows.push(...page.rows);
    onProgress?.(Math.min(rows.length, cap));
    if (rows.length >= cap) {
      return { rows: rows.slice(0, cap), capped: rows.length > cap || page.hasMore };
    }
    if (!page.hasMore || !page.nextCursor) return { rows, capped: false };
    cursor = page.nextCursor;
  }
}
