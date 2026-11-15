/**
 * The phone layout of a list row (`DataTable` below 640px): which visible column is the
 * row's title, which sit on the first line at the right, and which go in the row's
 * label/value list. Pure, so it is unit-tested (test/unit/phone-row.test.ts).
 */

/** `ColumnMeta.phone`. Unset: `detail`, except a column with the id `status` (`aside`). */
export type PhonePlace = "title" | "aside" | "detail" | "hide";

export interface PhoneColumn {
  id: string;
  grow?: boolean;
  phone?: PhonePlace;
}

export interface PhoneRowPlan {
  title: string | undefined;
  /** First line, right side: the money column, then the status chip. */
  aside: string[];
  detail: string[];
}

/** The columns `DataTable` adds for selection and the row menu. */
const CHROME = new Set(["__select", "__menu"]);

const isStatus = (c: PhoneColumn) => c.id === "status";

/**
 * Columns arrive in display order, visible ones only. The title is an explicit `title`,
 * else the `grow` column, else the first column — the same column that takes a desktop
 * row's spare width.
 */
export function planPhoneRow(columns: PhoneColumn[]): PhoneRowPlan {
  const shown = columns.filter((c) => !CHROME.has(c.id) && c.phone !== "hide");
  const title = (
    shown.find((c) => c.phone === "title") ??
    shown.find((c) => c.grow && !c.phone) ??
    shown.find((c) => !c.phone) ??
    shown[0]
  )?.id;
  const rest = shown.filter((c) => c.id !== title);
  const asAside = (c: PhoneColumn) => c.phone === "aside" || (isStatus(c) && !c.phone);
  const aside = rest.filter(asAside);
  return {
    title,
    // A status chip reads under the figure, the way the title's second line does.
    aside: [...aside.filter((c) => !isStatus(c)), ...aside.filter(isStatus)].map((c) => c.id),
    detail: rest.filter((c) => !asAside(c)).map((c) => c.id),
  };
}
