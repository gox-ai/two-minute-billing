/**
 * The query: Explore's unit of work.
 *
 * Explore is a query builder — measures pick the COLUMNS, one dimension picks the ROWS, and
 * a period governs both. Change anything and the result re-renders; there are no steps and
 * nothing to navigate between. The whole query lives in the URL:
 *
 *   ?m=mrr&m=mrr_churn&dim=plan&range=12m&grain=month&currency=INR
 *
 * `m` repeats, once per column, in reading order. `dim` names the dimension the rows are cut
 * by; without it the rows are the periods themselves. So a view is a shareable link and Back
 * undoes exactly one change.
 *
 * Plain data and pure functions ONLY, and deliberately NOT a `"use client"` module: a server
 * component importing an array or a function from one receives a client reference rather than
 * the value, which typechecks and then throws at request time.
 */

import type { AnalyticsMeasure, AnalyticsQuery, Grain } from "@/lib/analytics-api";
import { EXPLORE_RANGES } from "@/components/analytics/cut-options";

/**
 * `/v1/analytics/measures` publishes `value_as_of` — `computed_at` means the figure is the
 * live book at the instant it was written and has NO history, so it is a reading and never a
 * series. `AnalyticsMeasure` in `lib/analytics-api.ts` does not declare it yet (that file is
 * owned elsewhere); read it through this widening until it does.
 */
export type MeasureMeta = AnalyticsMeasure & { value_as_of?: "period_end" | "computed_at" };

/** A measure whose figure is a reading at one instant — no series, nothing to sum. */
export function isReading(m: MeasureMeta): boolean {
  return m.value_as_of === "computed_at";
}

/** A rate. Never charted beside an amount, never added to anything. */
export function isRate(m: MeasureMeta): boolean {
  return m.unit === "ratio" || m.unit === "bps";
}

/** The engine answers at most this many questions per batch (`src/api/analytics-routes.ts`). */
export const MAX_COLUMNS = 24;

/** The rows the table is cut by, when no dimension is chosen. */
export const PERIOD_ROWS = "period";

export interface ExploreQuery {
  /** The columns, in reading order. Never empty — a default is resolved if the URL names none. */
  measures: MeasureMeta[];
  /** The rows. `null` means the periods themselves. */
  dimension: string | null;
  range: string;
  grain: Grain;
  compare?: "previous";
  currency?: string;
  /** Measures the URL named that this registry does not carry, or that overflow one batch. */
  dropped: string[];
  /** A dimension the URL named that not every chosen measure carries, and the one that lacks it. */
  droppedDimension?: { dimension: string; because: string };
}

/* ------------------------------------------------------------------ offering */

/**
 * What a control may offer, and why it may not.
 *
 * A disabled option keeps its place and states its reason: a builder that silently drops a
 * dimension when you tick a second measure teaches nothing about its own limits.
 */
export interface Offer {
  id: string;
  label: string;
  disabled?: boolean;
  reason?: string;
}

/**
 * Dimensions, offered only where EVERY chosen measure declares them. A measure that does not
 * carry one would be refused by the engine, so the dimension is disabled and names the
 * measure standing in its way.
 */
export function offerDimensions(selected: MeasureMeta[], label: (d: string) => string): Offer[] {
  const union = [...new Set(selected.flatMap((m) => m.dimensions))].sort();
  return union.map((d) => {
    const missing = selected.filter((m) => !m.dimensions.includes(d));
    return {
      id: d,
      label: label(d),
      disabled: missing.length > 0,
      reason:
        missing.length > 0
          ? `${missing.map((m) => m.name).join(", ")} ${missing.length === 1 ? "carries" : "carry"} no ${label(d).toLowerCase()} breakdown`
          : undefined,
    };
  });
}

/** Grains every chosen measure declares. One that any measure lacks is disabled, with the why. */
export function offerGrains(selected: MeasureMeta[], phrase: Record<string, string>): Offer[] {
  const union = [...new Set(selected.flatMap((m) => m.grains))];
  const order: Grain[] = ["day", "week", "month", "quarter", "year"];
  return order
    .filter((g) => union.includes(g))
    .map((g) => {
      const missing = selected.filter((m) => !m.grains.includes(g));
      return {
        id: g,
        label: phrase[g] ?? g,
        disabled: missing.length > 0,
        reason:
          missing.length > 0
            ? `${missing.map((m) => m.name).join(", ")} is not stored by ${phrase[g] ?? g}`
            : undefined,
      };
    });
}

/* ----------------------------------------------------------------- the URL */

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const many = (v: string | string[] | undefined) => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function exploreHref(
  basePath: string,
  q: {
    measures: string[];
    dimension: string | null;
    range: string;
    grain: Grain;
    compare?: "previous";
    currency?: string;
  },
): string {
  const p = new URLSearchParams();
  for (const id of q.measures) p.append("m", id);
  if (q.dimension) p.set("dim", q.dimension);
  p.set("range", q.range);
  p.set("grain", q.grain);
  if (q.compare) p.set("compare", q.compare);
  if (q.currency) p.set("currency", q.currency);
  return `${basePath}?${p.toString()}`;
}

/**
 * The URL, resolved against what the registry actually declares.
 *
 * Everything unanswerable is dropped and NAMED rather than silently corrected: a measure this
 * organization does not carry, a dimension one of the chosen measures lacks, a grain none of
 * them is stored by. The screen then renders the query that was really run.
 */
export function parseQuery(input: {
  searchParams: Record<string, string | string[] | undefined>;
  all: MeasureMeta[];
  byId: Map<string, MeasureMeta>;
  knownCurrencies: string[];
}): ExploreQuery {
  const { searchParams: sp, all, byId, knownCurrencies } = input;

  // `measure=` is the board tile's older spelling of one column. Kept so a tile's "Explore"
  // link lands on the measure it names rather than on a default.
  const named = [...many(sp.m), ...many(sp.measure)];
  const dropped: string[] = [];
  const picked: MeasureMeta[] = [];
  for (const id of named) {
    const m = byId.get(id);
    if (!m) {
      dropped.push(id);
      continue;
    }
    if (picked.some((p) => p.id === m.id)) continue;
    if (picked.length >= MAX_COLUMNS) {
      dropped.push(id);
      continue;
    }
    picked.push(m);
  }
  // An empty selection still has to show something, so the default is resolved here and
  // written into every link on the page — it is a resolved default, not hidden state.
  const measures =
    picked.length > 0 ? picked : [byId.get("mrr") ?? all[0]].filter((m) => m != null);

  const grainUnion = measures.filter((m) => m.grains.length > 0);
  const grainOk = (g: string): g is Grain => grainUnion.every((m) => m.grains.includes(g as Grain));
  const grainParam = one(sp.grain);
  const grain: Grain =
    grainParam && grainOk(grainParam)
      ? grainParam
      : grainOk("month")
        ? "month"
        : ((measures[0]?.grains.find((g) => grainOk(g)) ?? "month") as Grain);

  let dimension = one(sp.dim) ?? null;
  let droppedDimension: ExploreQuery["droppedDimension"];
  if (dimension) {
    const missing = measures.find((m) => !m.dimensions.includes(dimension!));
    if (missing) {
      droppedDimension = { dimension, because: missing.name };
      dimension = null;
    }
  }

  // A reading has no history: only the period in progress carries a figure, so a view made
  // only of readings opens on the period in progress rather than on an empty last month.
  const defaultRange = measures.every(isReading) ? "this_month" : "12m";
  const rangeParam = one(sp.range);
  const range = EXPLORE_RANGES.some((r) => r.id === rangeParam) ? rangeParam! : defaultRange;

  const comparable = measures.some((m) => m.supports_compare);
  const compare = comparable && one(sp.compare) === "previous" ? ("previous" as const) : undefined;

  const currencyParam = one(sp.currency);
  const currency =
    currencyParam && knownCurrencies.includes(currencyParam) ? currencyParam : undefined;

  return { measures, dimension, range, grain, compare, currency, dropped, droppedDimension };
}

/* ------------------------------------------------------------------- the ask */

/** The key a column's answer comes back under. One query per measure, one measure per column. */
export function answerKey(measureId: string): string {
  return `m_${measureId}`;
}

/**
 * ONE batched question per column, sent as a single `POST /v1/analytics/query`.
 *
 * Every column therefore shares one `as_of`: a request per measure would let two columns of
 * the same table disagree about when they were true.
 */
export function planQueries(q: ExploreQuery, business: string): AnalyticsQuery[] {
  return q.measures.map((m) => ({
    key: answerKey(m.id),
    measure: m.id,
    business,
    grain: q.grain,
    range: q.range,
    ...(q.dimension ? { split: q.dimension } : {}),
    ...(q.currency && m.currency === "per_currency" ? { currency: q.currency } : {}),
    ...(q.compare && m.supports_compare ? { compare: q.compare } : {}),
  }));
}
