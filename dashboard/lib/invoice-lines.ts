// Pure helpers for invoice lines. Relative imports only: a unit test reads this file.

/**
 * An information line states a fact and charges nothing: usage that credits paid
 * (kind `credit_usage`, amount 0). It has no price, quantity or amount to show, it is
 * not a row of the line table and a credit note cannot credit it.
 */
export const isInformationLine = (line: { kind?: string | null }): boolean =>
  line.kind === "credit_usage";

/** The lines that are charges or adjustments: every line but the information lines. */
export const withoutInformationLines = <T extends { kind?: string | null }>(
  lines: readonly T[] | null | undefined,
): T[] => (lines ?? []).filter((l) => !isInformationLine(l));
