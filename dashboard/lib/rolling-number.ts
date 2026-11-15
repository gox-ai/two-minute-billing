/**
 * A formatted figure split for the rolling number (components/ui/rolling-number.tsx).
 * Pure, so the split is unit-tested apart from the DOM.
 */

/** One run of a figure: an ASCII digit that rolls, text that stays still, or a break point. */
export type RollPart =
  | { kind: "digit"; to: number; from: number; delayMs: number }
  | { kind: "text"; text: string }
  | { kind: "space"; text: string };

/** Right finishes last: the rightmost digit starts this much after the leftmost. */
export const ROLL_SPREAD_MS = 60;

function digitsOf(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) if (ch >= "0" && ch <= "9") out.push(ch.charCodeAt(0) - 48);
  return out;
}

/**
 * Split `value` into digit, text and space runs. Each digit starts from the digit in the
 * same place in `previous`, counted from the right so units meet units; with no previous
 * value, or no digit there, it starts from 0.
 */
export function rollParts(
  value: string,
  previous: string | null = null,
  spreadMs = ROLL_SPREAD_MS,
): RollPart[] {
  const n = digitsOf(value).length;
  const prev = previous == null ? [] : digitsOf(previous);
  const parts: RollPart[] = [];
  let k = 0;
  for (const ch of value) {
    if (ch >= "0" && ch <= "9") {
      const fromRight = n - 1 - k;
      const from = prev[prev.length - 1 - fromRight] ?? 0;
      const delayMs = n > 1 ? Math.round((k / (n - 1)) * spreadMs) : 0;
      parts.push({ kind: "digit", to: ch.charCodeAt(0) - 48, from, delayMs });
      k++;
      continue;
    }
    const kind = /\s/.test(ch) ? "space" : "text";
    const last = parts.at(-1);
    if (last && last.kind === kind) last.text += ch;
    else parts.push({ kind, text: ch });
  }
  return parts;
}

/**
 * The parts grouped into words: a figure breaks only where its string has whitespace, as the
 * plain text did. Spaces come back as their own one-part groups.
 */
export function rollWords(parts: RollPart[]): RollPart[][] {
  const words: RollPart[][] = [];
  for (const p of parts) {
    if (p.kind === "space") {
      words.push([p]);
      continue;
    }
    const last = words.at(-1);
    if (last && last[0]!.kind !== "space") last.push(p);
    else words.push([p]);
  }
  return words;
}
