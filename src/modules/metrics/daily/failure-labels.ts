import { resolveStoredErrorId } from "@/providers/decline-codes";

/**
 * A stored failure code as a sentence: raw provider spellings resolve to our canonical code
 * first, so `INSTRUMENT_DECLINED` and `card_declined` read the same. A code nothing names
 * still shows, humanised — a blank would be a silent hole.
 */
export function failureReasonLabel(key: string): string {
  // Razorpay writes `NA` ("not available") where it has no reason: a missing code, not a word.
  if (key === "unspecified" || key.toLowerCase() === "na") return "No reason given";
  const resolved = resolveStoredErrorId(key);
  const code = resolved.known ? resolved.id.slice(resolved.id.lastIndexOf(".") + 1) : key;
  const words = code.toLowerCase().replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
