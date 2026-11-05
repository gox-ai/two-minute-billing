/**
 * Replaces Docus's `formatOgDescription` (same name, so the docs page uses this one).
 *
 * Docus strips commas and cuts to a 150-character URL budget, which left cards ending mid-phrase
 * ("…from the dashboard build it in"). A card longer than the budget gets a hashed URL anyway,
 * so the budget does not apply: keep the first sentence, and clip only a very long one at a word.
 */
export function formatOgDescription(
  _title: string | undefined,
  description: string | undefined,
): string | undefined {
  if (!description) return undefined;
  const flat = description.replace(/\s+/g, " ").trim();
  const stop = /[.!?](\s|$)/.exec(flat);
  const sentence = stop ? flat.slice(0, stop.index + 1) : flat;
  if (sentence.length <= 120) return sentence;
  const cut = sentence.slice(0, 119);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[\s,;:]+$/, "")}…`;
}
