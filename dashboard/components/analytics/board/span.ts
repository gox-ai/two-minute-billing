import type { MeasureTileRole } from "@/components/analytics/role";

/**
 * A board is twelve columns wide and its rows are 80px tall. A tile's size is a whole
 * number of each — free, not one of four presets, and the same units the engine stores
 * (`report_dashboard_tiles.width_units` / `height_units`, migration 0270).
 */
export const BOARD_COLUMNS = 12;
export const ROW_UNIT_PX = 80;
export const MAX_ROWS = 12;

export interface TileUnits {
  width: number;
  height: number;
}

/**
 * The floor, by what shape of answer came back. A matrix is wide by construction; a table
 * needs half the board to stay readable; a figure or a trend reads at a quarter. Height has
 * a floor for the same reason width does — a chart squeezed below it is not a chart.
 */
export function minWidth(role: MeasureTileRole): number {
  if (role === "hero") return BOARD_COLUMNS;
  if (role === "rows") return 6;
  return 3;
}

export function minHeight(role: MeasureTileRole): number {
  if (role === "hero") return 5;
  if (role === "rows") return 4;
  if (role === "trend") return 4;
  return 2;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

export function clampUnits(units: TileUnits, role: MeasureTileRole): TileUnits {
  return {
    width: clamp(units.width, minWidth(role), BOARD_COLUMNS),
    height: clamp(units.height, minHeight(role), MAX_ROWS),
  };
}

export const sameUnits = (a: TileUnits, b: TileUnits) =>
  a.width === b.width && a.height === b.height;

/**
 * Static classes — Tailwind has to see each span literally. Below `xl` the grid really is
 * six columns, so a tile wider than six fills the row there rather than overflowing it.
 */
export const SPAN_CLASS: Record<number, string> = {
  1: "md:col-span-1 xl:col-span-1",
  2: "md:col-span-2 xl:col-span-2",
  3: "md:col-span-3 xl:col-span-3",
  4: "md:col-span-4 xl:col-span-4",
  5: "md:col-span-5 xl:col-span-5",
  6: "md:col-span-6 xl:col-span-6",
  7: "md:col-span-6 xl:col-span-7",
  8: "md:col-span-6 xl:col-span-8",
  9: "md:col-span-6 xl:col-span-9",
  10: "md:col-span-6 xl:col-span-10",
  11: "md:col-span-6 xl:col-span-11",
  12: "md:col-span-6 xl:col-span-12",
};

export const spanClass = (width: number) => SPAN_CLASS[clamp(width, 1, BOARD_COLUMNS)]!;

/** The constraint this tile really has, not the general rule. */
export function constraintLine(role: MeasureTileRole): string {
  const w = minWidth(role);
  const h = minHeight(role);
  const width =
    role === "hero"
      ? "This answer is a dimension-by-period matrix, so it stays at 12 columns and cannot go"
      : `This tile cannot go below ${w} columns or`;
  return `The tile snaps to whole columns and ${ROW_UNIT_PX}px rows. ${width} below ${h} rows.`;
}

/** Where each tile lands in the twelve-column flow, for the drop slot's label. */
export function placements(widths: number[]): Array<{ row: number; start: number }> {
  const out: Array<{ row: number; start: number }> = [];
  let row = 1;
  let used = 0;
  for (const c of widths) {
    if (used + c > BOARD_COLUMNS) {
      row += 1;
      used = 0;
    }
    out.push({ row, start: used + 1 });
    used += c;
    if (used >= BOARD_COLUMNS) {
      row += 1;
      used = 0;
    }
  }
  return out;
}
