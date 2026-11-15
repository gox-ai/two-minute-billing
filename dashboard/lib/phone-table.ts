/**
 * The phone layout of a hand-rolled `ui/table` (`<Table phone="stack">`) below 640px: each row
 * becomes a block — the title cell full width, an `aside` cell (an amount) opposite it, then
 * every other cell as a 12px label (its column head) and its value. Pure, so it is
 * unit-tested (test/unit/phone-table.test.ts); `components/ui/table.tsx` applies it.
 */

import type { PhonePlace } from "./phone-row";

export type { PhonePlace };

/** What a head row tells the body about one column. */
export interface PhoneHead {
  label: string;
  place?: PhonePlace;
}

/** The plain text of a React node: strings and numbers, through elements' children. */
export function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) {
    return textOf((node as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

/** The column each cell starts in, given each cell's `colSpan`. */
export function columnStarts(spans: Array<number | undefined>): number[] {
  let col = 0;
  return spans.map((s) => {
    const at = col;
    col += s && s > 0 ? Math.floor(s) : 1;
    return at;
  });
}

/**
 * Where a cell goes: its own `phone`, else its column head's, else the first column is the
 * title (unless a head names another one) and the rest are label/value rows.
 */
export function cellPlace(col: number, heads: PhoneHead[], own?: PhonePlace): PhonePlace {
  const first = col === 0 && !heads.some((h) => h?.place === "title");
  return own ?? heads[col]?.place ?? (first ? "title" : "detail");
}
