/**
 * Reading one batch reply. Pure, server-safe — the batch is fetched once by the page and
 * every column reads its own slot out of it.
 *
 * A refused question comes back in its own slot with the engine's 422 sentence, so one
 * measure refusing never blanks the table: the other columns still answer and the refusal is
 * shown where it happened, in the engine's own words.
 */

import type { AnalyticsResult, BatchEntry } from "@/lib/analytics-api";
import { answerKey } from "./query";

export type Answers = Map<string, BatchEntry>;

export function indexAnswers(entries: BatchEntry[]): Answers {
  return new Map(entries.map((e) => [e.key, e]));
}

function isError(e: BatchEntry): boolean {
  return "object" in e && e.object === "analytics_error";
}

export function resultFor(answers: Answers, measureId: string): AnalyticsResult | null {
  const e = answers.get(answerKey(measureId));
  return e && !isError(e) ? (e as AnalyticsResult) : null;
}

export interface AnswerRefusal {
  /** The measure that was refused, so a reader knows which column is missing. */
  measure: string;
  message: string;
  param?: string;
  options?: string[];
}

export function refusalFor(answers: Answers, measureId: string): AnswerRefusal | null {
  const e = answers.get(answerKey(measureId));
  if (e && "object" in e && e.object === "analytics_error") {
    return {
      measure: measureId,
      message: e.error.message,
      param: e.error.param,
      options: e.error.options,
    };
  }
  return null;
}

/** The reporting currency the answers actually came back in, if any of them is money. */
export function currencyOf(answers: Answers): string | null {
  for (const e of answers.values()) {
    if (isError(e)) continue;
    const r = e as AnalyticsResult;
    if (r.currency) return r.currency;
  }
  return null;
}

/**
 * The instants the answers were computed at. ONE distinct `as_of` is what proves the whole
 * table was answered in a single batch — the screen states it, and a second value here would
 * mean two columns could disagree about when they were true.
 */
export function instantsOf(answers: Answers): string[] {
  const seen = new Set<string>();
  for (const e of answers.values()) {
    if (!isError(e)) seen.add((e as AnalyticsResult).as_of);
  }
  return [...seen];
}
