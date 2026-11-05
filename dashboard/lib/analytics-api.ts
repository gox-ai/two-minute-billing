// Server-only client for the analytics API (`/v1/analytics`). Same contract as `lib/api.ts`:
// authenticates as the SIGNED-IN OPERATOR by forwarding their session cookie, never imported
// into a client component.
//
// The types below deliberately carry `coverage`, `computed_at`, `kind`, `unit`,
// `currency_basis` and `total_basis`. The API publishes them so a screen can be honest about
// what it is showing; a client that drops them makes that honesty unreachable, which is the
// same as not having it.

import { cookies } from "next/headers";
import { forwardedFor } from "./forwarded-for";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

/** A value AT an instant, or a sum OVER a window. Never guess which from the name. */
export type MeasureKind = "stock" | "flow";
/** `money` is integer MINOR UNITS plus a currency code. Never a float, never pre-divided. */
export type MeasureUnit = "money" | "count" | "ratio" | "bps";
export type Grain = "day" | "week" | "month" | "quarter" | "year";

export interface AnalyticsMeasure {
  id: string;
  name: string;
  description: string;
  kind: MeasureKind;
  unit: MeasureUnit;
  aggregate: "sum" | "last" | "ratio" | "none";
  dimensions: string[];
  grains: Grain[];
  currency: "per_currency" | "none";
  supports_compare: boolean;
  /**
   * Whether this measure can be answered for a customer segment. Absent on an engine that
   * predates it, which reads as "no" — the builder then offers no segment rather than one the
   * engine would refuse.
   */
  segmentable?: boolean;
}

export interface SeriesPoint {
  t: string;
  label: string;
  /** Null is "computed, and the answer is nothing" — never render it as zero. */
  value: number | null;
  /** A ratio bucket's halves, as the engine divided them. */
  numerator?: number | null;
  denominator?: number | null;
}

export interface AnalyticsResult {
  object: "analytics_result";
  measure: string;
  name: string;
  description: string;
  kind: MeasureKind;
  unit: MeasureUnit;
  currency: string | null;
  /** Whether money was held per currency or counts were combined across them. */
  currency_basis: "per_currency" | "across_currencies";
  scope: "business" | "organization";
  grain: Grain;
  range: {
    name: string | null;
    start: string;
    end: string;
    timezone: string;
    timezone_source: string;
  };
  as_of: string;
  /** When the underlying rows were computed. Drives the freshness line. */
  computed_at: string | null;
  series: SeriesPoint[];
  total: number | null;
  /** `value_at_end` for a stock, `sum_over_window` for a flow. Say which, never imply it. */
  total_basis: "sum_over_window" | "value_at_end" | "window";
  /** Present with `total_basis: "window"`: the halves the window's rate was divided from. */
  total_numerator?: number | null;
  total_denominator?: number | null;
  /** Echoed by the engine; absent on an engine that predates the parameter. */
  shape?: AnswerShape;
  /** Present when the answer was scoped to a segment. `note` is meant to be shown. */
  segment?: { id: string; name: string; membership: "current"; note: string };
  split?: {
    dimension: string;
    limit: number;
    returned: number;
    truncated: boolean;
    /**
     * Whether the rows actually add up to `total`, and why not when they do not. A screen
     * that draws shares must say so rather than let them silently miss 100%.
     */
    exhaustive?: boolean;
    exhaustive_basis?:
      | "rows_add_to_total"
      | "row_totals_not_coincident"
      | "rate_not_decomposable"
      | "distinct_count_not_additive";
    note?: string;
    series: Array<{
      key: string;
      label: string;
      /**
       * `dimension` is a real value; `truncated` is the rows beyond `split_limit` added
       * together; `unattributed` is population the dimension does not attribute at all.
       * Filter on THIS, never on `key` — `split=cash_bucket` has a legitimate value called
       * "other", so the key alone cannot tell a residual from a real row.
       */
      kind?: "dimension" | "truncated" | "unattributed";
      total: number | null;
      points: SeriesPoint[];
    }>;
  };
  compare?: {
    basis: "previous_window";
    start: string;
    end: string;
    previous_total: number | null;
    change_minor: number | null;
    change_bps: number | null;
  };
  /**
   * Present ONLY where the history is genuinely partial. `note` is written to be shown to a
   * human verbatim — it is what stops a reader trusting a flattering pre-cutover figure.
   */
  coverage?: {
    complete_from: string | null;
    missing_periods?: string[];
    note: string;
  };
}

/**
 * A refusal. The API answers 422 with a sentence naming the fix; show the sentence.
 *
 * Where the refusal has a finite set of valid answers (e.g. asking for money summed across
 * currencies), they ride along as DATA — `param` (the query param to set) and `options` (its
 * valid values) — so a screen can offer them as one-click links instead of parsing the
 * sentence.
 */
export class AnalyticsRefused extends Error {
  readonly param?: string;
  readonly options?: string[];
  constructor(message: string, detail?: { param?: string; options?: string[] }) {
    super(message);
    this.param = detail?.param;
    this.options = detail?.options;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const jar = await cookies();
  const cookie = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  return { cookie, ...(await forwardedFor()) };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: await authHeaders(), cache: "no-store" });
  if (res.status === 422) {
    // The engine's own sentence, forwarded intact. A code here would make the screen invent
    // its own wording for a refusal the engine already explained precisely.
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string; param?: string; options?: string[] };
    } | null;
    throw new AnalyticsRefused(body?.error?.message ?? "That combination is not available.", {
      param: body?.error?.param,
      options: body?.error?.options,
    });
  }
  if (!res.ok) throw new Error(`tmbilling API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function listMeasures(): Promise<AnalyticsMeasure[]> {
  const r = await get<{ object: "list"; data: AnalyticsMeasure[] }>("/v1/analytics/measures");
  return r.data;
}

/** Whether an answer carries its series (`series`) or only its totals (`totals`). */
export type AnswerShape = "series" | "totals";

export interface AnalyticsQuery {
  /** Labels this question's slot in a batch reply — otherwise it's positional (`q0`, `q1`, …). */
  key?: string;
  measure: string;
  business?: string;
  /** Set for us by the callers below; a caller never passes it. */
  livemode?: "live" | "test";
  grain?: Grain;
  range?: string;
  start?: string;
  end?: string;
  split?: string;
  split_limit?: number;
  currency?: string;
  compare?: "previous";
  /** `totals` drops every series: one figure, or one total per split key. Default `series`. */
  shape?: AnswerShape;
  /** A customer segment's public id. Business-scoped, and never together with `split`. */
  segment?: string;
}

export function analyticsPath(q: AnalyticsQuery): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v != null && v !== "") p.set(k, String(v));
  }
  return `/v1/analytics?${p.toString()}`;
}

/**
 * The org-wide partition, and ONLY for an org-wide question: org totals are LIVE.
 *
 * The dashboard authenticates as an operator, whose key is minted `livemode: "all"`, so
 * without this an organization total would count every business's test mode too.
 *
 * A business-scoped question needs nothing: that business's own `livemode` already decides,
 * and the engine refuses a mismatch.
 */
async function orgLivemode(business?: string): Promise<{ livemode?: "live" | "test" }> {
  return business ? {} : { livemode: "live" };
}

export const getAnalytics = async (q: AnalyticsQuery) =>
  get<AnalyticsResult>(analyticsPath({ ...(await orgLivemode(q.business)), ...q }));

/**
 * When the 5-minute cron last refreshed these figures. Null on any failure: a missing
 * "synced" pill is fine, a page that fails because of one is not.
 */
export async function getSyncedAt(business?: string): Promise<string | null> {
  try {
    const q = new URLSearchParams({
      ...(business ? { business } : {}),
      ...(await orgLivemode(business)),
    });
    const r = await get<{ synced_at: string | null }>(`/v1/analytics/sync?${q.toString()}`);
    return r.synced_at;
  } catch {
    return null;
  }
}

/**
 * Several measures in ONE round trip — what makes a twelve-widget board one request rather
 * than twelve. A refused measure lands in its own slot; the others still answer.
 *
 * Every entry carries the `key` its query was labelled with (or `q<i>` by position), so a
 * caller can match answers back up without relying on array order.
 */
export type BatchEntry =
  | (AnalyticsResult & { key: string })
  | {
      key: string;
      object: "analytics_error";
      measure: string;
      status: number;
      error: { type: string; message: string; param?: string; options?: string[] };
    };

export async function queryAnalytics(input: {
  queries: AnalyticsQuery[];
  business?: string;
  grain?: Grain;
  range?: string;
  currency?: string;
}): Promise<BatchEntry[]> {
  const res = await fetch(`${BASE}/v1/analytics/query`, {
    method: "POST",
    headers: { ...(await authHeaders()), "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ ...(await orgLivemode(input.business)), ...input }),
  });
  if (!res.ok) throw new Error(`tmbilling API /v1/analytics/query → ${res.status}`);
  const body = (await res.json()) as { data: BatchEntry[] };
  return body.data;
}
