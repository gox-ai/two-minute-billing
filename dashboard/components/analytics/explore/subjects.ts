/**
 * The five subjects Explore is organised by — plain data, deliberately NOT in a
 * `"use client"` module (a server component importing an array from one receives a
 * client reference, not the value).
 *
 * These are PRESENTATION labels. The stored report keys and the engine's category ids
 * are untouched; this file is the only place the two vocabularies meet.
 */

export type SubjectId = "recurring_revenue" | "movement" | "lifecycle" | "billing" | "receivables";

export interface Subject {
  id: SubjectId;
  label: string;
  blurb: string;
  /** Engine report categories that belong to this subject. */
  categories: readonly string[];
}

export const SUBJECTS: readonly Subject[] = [
  {
    id: "recurring_revenue",
    label: "Recurring revenue",
    blurb: "What the live book bills, and how many subscriptions carry it. Measured at an instant.",
    categories: ["recurring_revenue", "subscriptions"],
  },
  {
    id: "movement",
    label: "Movement",
    blurb: "Every change to recurring revenue, and the retention rates those changes divide into.",
    categories: ["churn", "retention"],
  },
  {
    id: "lifecycle",
    label: "Lifecycle",
    blurb: "Trials, activations, cancellations and new customers, counted as they happen.",
    categories: ["acquisitions"],
  },
  {
    id: "billing",
    label: "Billing",
    blurb: "Billing, payments, refunds, credit notes and tax. What was charged and what settled.",
    categories: ["transactions"],
  },
  {
    id: "receivables",
    label: "Receivables",
    blurb: "Open invoices, how old they are, and the payments that did not go through.",
    categories: ["receivables"],
  },
];

export const SUBJECT_LABEL: Record<string, string> = Object.fromEntries(
  SUBJECTS.map((s) => [s.id, s.label]),
);

const SUBJECT_OF_CATEGORY: Record<string, SubjectId> = Object.fromEntries(
  SUBJECTS.flatMap((s) => s.categories.map((c) => [c, s.id])),
);

/** A saved question's subject. Unknown categories fall to "the book" rather than vanishing. */
export function subjectOfCategory(category: string): SubjectId {
  return SUBJECT_OF_CATEGORY[category] ?? "recurring_revenue";
}

/** Range and grain, worded to read inside the cut sentence rather than as menu labels. */
export const RANGE_PHRASE: Record<string, string> = {
  "7d": "the last 7 days",
  "30d": "the last 30 days",
  "90d": "the last 90 days",
  "6m": "the last 6 months",
  "12m": "the last 12 months",
  this_month: "this month",
  last_month: "last month",
  this_quarter: "this quarter",
  this_year: "this year",
};

export const GRAIN_PHRASE: Record<string, string> = {
  day: "day",
  week: "week",
  month: "month",
  quarter: "quarter",
  year: "year",
};
