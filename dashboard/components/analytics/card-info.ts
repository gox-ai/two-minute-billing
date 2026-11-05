/* Plain module, not "use client": server components build these and call `explain`. */

/** One figure: what it means in plain words and, where there is arithmetic, how it is worked out. */
export interface Term {
  label: string;
  text: string;
  /** One formula per line, e.g. "(New + Expansion) ÷ (Churn + Contraction)". */
  formula?: string | string[];
}

/** A card's explanation: its lead figure, then each secondary figure the card shows. */
export interface CardInfo {
  text: string;
  formula?: string | string[];
  terms?: Term[];
}

/** The lead term explains the card; the rest are listed under it by their own labels. */
export function explain(lead: Term, ...rest: Array<Term | null | false | undefined>): CardInfo {
  return { text: lead.text, formula: lead.formula, terms: rest.filter((t): t is Term => !!t) };
}
