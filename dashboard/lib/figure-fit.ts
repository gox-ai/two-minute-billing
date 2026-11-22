/**
 * How wide a figure tile must be to show its figure on one line, so `FigureTiles` puts tiles
 * side by side only where every figure fits, at any width. Pure, so it is unit-tested
 * (test/unit/figure-fit.test.ts).
 */

/** Advance of each glyph at 1em, Inter 600 with the figure's -0.02em tracking (measured). */
const EM: Record<string, number> = {
  ",": 0.249,
  ".": 0.249,
  " ": 0.26,
  "₹": 0.542,
  $: 0.63,
  "€": 0.659,
  "£": 0.61,
  "¥": 0.544,
  "—": 0.98,
  "%": 0.985,
};
const DIGIT = 0.627;
const UPPER = 0.75;
const LOWER = 0.6;
const WIDE = 0.9;

/** The width of a figure string in em, rounded up to a hundredth. */
export function figureEm(value: string): number {
  let em = 0;
  for (const ch of value) {
    const known = EM[ch];
    if (known !== undefined) em += known;
    else if (ch >= "0" && ch <= "9") em += DIGIT;
    else if (ch === "m" || ch === "w" || ch === "M" || ch === "W") em += WIDE;
    else if (ch >= "A" && ch <= "Z") em += UPPER;
    else em += LOWER;
  }
  return Math.ceil(em * 100) / 100;
}

/** The figure's size (text-2xl) and the tile's padding plus border, in rem. */
const FIGURE_REM = 1.625;
const CHROME_REM = 2.25;

/**
 * The narrowest tile that shows every figure whole, as a CSS length — or `undefined` when a
 * value is not a plain string, so the caller keeps one tile per row.
 */
export function figureTileMin(values: unknown[]): string | undefined {
  if (values.length === 0 || values.some((v) => typeof v !== "string")) return undefined;
  const em = Math.max(...(values as string[]).map(figureEm));
  return `${Math.ceil((em * FIGURE_REM + CHROME_REM) * 100) / 100}rem`;
}
