import { payerWordingTexts } from "@/providers/decline-codes";
import { CODE_MATCHED, PAYER_CLIENT_TEXTS } from "@/providers/payer-wording";

/**
 * Is an error text a buyer read made only of OUR payer wording? Pure.
 *
 * A text is checked sentence by sentence. A sentence is ours when it is one of the payer
 * sentences the engine and the storefront write (built from their constants, never a copy),
 * or has one of our fixed shapes: the "We could not …" lead, "Contact <business>.", "Select
 * <button> to try again.", or a refusal the storefront matches on text. Anything else is a
 * leak: a gateway's or a library's own words reached the screen.
 *
 * A field error is never a leak: the storefront keeps a gateway form's field instruction on
 * purpose ("Your card number is incomplete.").
 */

const OUR_SHAPES: readonly RegExp[] = [
  /^We could not \S.*[.!?]$/,
  /^(?:If the problem continues, c|C)ontact .{1,120}\.$/,
  /^Select .{1,80} to try again(?:, or use a different payment method)?\.$/,
  /^The payment setup of .{1,120} is not complete\.$/,
  ...CODE_MATCHED,
];

/** Split into sentences: a stop, then white space. */
export function sentencesOf(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

let ours: Set<string> | null = null;
function ourSentences(): Set<string> {
  ours ??= new Set([...payerWordingTexts(), ...PAYER_CLIENT_TEXTS].flatMap(sentencesOf));
  return ours;
}

/** The sentences of `text` that are not our wording, in order. */
export function foreignSentences(text: string): string[] {
  const known = ourSentences();
  return sentencesOf(text).filter((s) => !known.has(s) && !OUR_SHAPES.some((re) => re.test(s)));
}

export function buyerTextLeaks(text: string, opts: { fieldError?: boolean } = {}): boolean {
  if (opts.fieldError) return false;
  return foreignSentences(text).length > 0;
}
