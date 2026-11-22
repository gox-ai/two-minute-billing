/**
 * Which layout a `DataTable` mounts. Pure, so it is unit-tested (test/unit/list-layout.test.ts);
 * `useListLayout` feeds it.
 */

export type ListLayout = "phone" | "table" | "both";

/**
 * `narrow` is the card's verdict from the `list-narrow` container query, or `null` until it
 * may be read (server render, hydration, the rest of the stream). Until then both layouts
 * stay mounted and CSS shows the right one. `overflows`: the table, laid out in a wide card,
 * was wider than the card, so its rows stack instead of scrolling sideways.
 */
export function chooseListLayout(narrow: boolean | null, overflows = false): ListLayout {
  if (narrow === null) return "both";
  return narrow || overflows ? "phone" : "table";
}
