import { sql, type SQL } from "drizzle-orm";
import { invoices } from "@db/schema";
import { splitMulti } from "@/platform/list-query";

/**
 * The AR ageing ladder — ONE definition, so the ageing report and the list filter that
 * drills into it cannot disagree.
 *
 * Upper edges in whole days overdue, measured from the DUE date. An invoice with 30-day
 * terms is not overdue on the day it is raised, so ageing from the issue date would report
 * a collections problem that does not exist.
 *
 * This is the STANDARD ladder — monthly rungs out to six months, then a single rung to a
 * year. It is deliberately not uniform, and it is what a reader gets when they ask for no
 * interval, so an ageing link saved a year ago still names a rung that exists.
 */
export const AR_AGING_EDGES = [30, 60, 90, 120, 150, 180, 365] as const;

/** Nothing overdue yet — including an invoice with no due date, which is due on issue. */
export const AR_AGING_CURRENT = "Current";

/** How far the closed rungs reach before the open-ended tail, at every interval. */
export const AR_AGING_HORIZON_DAYS = 365;

/**
 * The rung widths a reader may ask the ladder to be rebuilt at.
 *
 * A closed set, because a rung width is a question about how collections are chased, not a
 * free number: a weekly collector reads the first month in weeks, an annual-terms book
 * reads the year in two-month steps. `standard` is the ladder above, named so a URL can
 * pin it; the rest are uniform rungs of that many days out to the horizon, with the last
 * rung absorbing the remainder rather than leaving a one-day stub.
 */
export const AR_AGING_INTERVALS = ["standard", "7", "15", "30", "60"] as const;
export type ArAgingInterval = (typeof AR_AGING_INTERVALS)[number];

const isInterval = (v: string): v is ArAgingInterval =>
  (AR_AGING_INTERVALS as readonly string[]).includes(v);

/**
 * Refused by name, never clamped: a reader who asks for 45-day rungs and is silently given
 * 30-day ones reads a ladder that answers a question they did not ask.
 */
export function arAgingIntervalError(value: string): string | null {
  return isInterval(value)
    ? null
    : `'${value}' is not an aging interval — use one of: ${AR_AGING_INTERVALS.join(", ")}.`;
}

/** Labels from edges: `Current`, each closed rung, then the open-ended tail. */
function labelsFor(edges: readonly number[]): string[] {
  return [
    AR_AGING_CURRENT,
    ...edges.map((edge, i) => `${(edges[i - 1] ?? 0) + 1}–${edge} days`),
    `${edges[edges.length - 1]}+ days`,
  ];
}

/**
 * The rung labels, derived from the edges rather than written out beside them: a ladder
 * whose labels are a second list is a ladder that eventually says "31–60" over a 90-day
 * rung.
 *
 * These strings are also the filter's VOCABULARY — `ar_bucket[is]=61–90 days` — which is
 * what lets a report row drill through with no translation step. The en dash is
 * deliberate and load-bearing: it is the character the report prints.
 */
export const AR_AGING_BUCKETS: readonly string[] = labelsFor(AR_AGING_EDGES);

/**
 * The ladder for one interval.
 *
 * `standard` returns the list above verbatim — a uniform generator must not quietly
 * replace it, because the saved views and bookmarks in the field name its rungs. A uniform
 * interval steps out to the horizon and then folds the remainder into the last rung: at
 * 15-day rungs the 24th multiple is 360, and a 361–365 stub would be a rung nobody asked
 * for, so the last rung is 346–365 instead.
 */
export function arAgingLadder(interval?: string | null): {
  interval: ArAgingInterval;
  edges: readonly number[];
  labels: readonly string[];
} {
  if (interval == null || interval === "" || interval === "standard") {
    return { interval: "standard", edges: AR_AGING_EDGES, labels: AR_AGING_BUCKETS };
  }
  const problem = arAgingIntervalError(interval);
  if (problem) throw new Error(problem);
  const width = Number(interval);
  const edges: number[] = [];
  for (let edge = width; edge <= AR_AGING_HORIZON_DAYS; edge += width) edges.push(edge);
  if (edges[edges.length - 1] !== AR_AGING_HORIZON_DAYS) {
    if (AR_AGING_HORIZON_DAYS - (edges[edges.length - 1] ?? 0) < width) edges.pop();
    edges.push(AR_AGING_HORIZON_DAYS);
  }
  return { interval: interval as ArAgingInterval, edges, labels: labelsFor(edges) };
}

/** Whole days overdue — the same arithmetic the report does in JS. */
const daysOverdue = sql`floor(extract(epoch from (now() - ${invoices.dueDate})) / 86400)`;
/** Past its due date at all. `Current` is everything else, missing due date included. */
const overdue = sql`(${invoices.dueDate} IS NOT NULL AND ${invoices.dueDate} < now())`;

/**
 * The rung an invoice sits on, as SQL, for a given interval.
 *
 * `floor(epoch/86400)` is the same whole-day arithmetic the report does in JS — not
 * `due_date + interval 'n days'`, which adds CALENDAR days on a timestamptz and would
 * disagree with the report by an hour across a DST change.
 *
 * The filter does NOT compare against this expression — it derives its boundaries from the
 * rung name, so it answers at every interval. This stays the ladder's labelling expression,
 * and `verify:bucket-drilldowns` runs it against the name-derived predicate to prove the
 * two select the same rows.
 */
export function arAgingBucketSql(interval?: string | null): SQL {
  const { edges, labels } = arAgingLadder(interval);
  const rungs = edges.map(
    (edge, i) => sql`WHEN ${daysOverdue} <= ${edge} THEN ${labels[i + 1]}::text`,
  );
  return sql`(CASE WHEN NOT ${overdue} THEN ${AR_AGING_CURRENT}::text
    ${sql.join(rungs, sql` `)}
    ELSE ${labels[labels.length - 1]}::text END)`;
}

/** What a rung name says: not yet due, a closed span of overdue days, or an open tail. */
type Rung = { current: true } | { current: false; from: number; to: number | null };

const CLOSED_RE = /^(\d+)–(\d+) days$/;
const TAIL_RE = /^(\d+)\+ days$/;

/**
 * Parse a rung NAME into its boundaries.
 *
 * The names are self-describing, so this is what lets one filter serve every interval the
 * report can offer — present or future — instead of a second parameter that could disagree
 * with the ladder the figure was printed from.
 */
export function parseArAgingRung(name: string): Rung | null {
  const v = name.trim();
  if (v.toLowerCase() === AR_AGING_CURRENT.toLowerCase()) return { current: true };
  const closed = CLOSED_RE.exec(v);
  if (closed) {
    const from = Number(closed[1]);
    const to = Number(closed[2]);
    return from >= 1 && to >= from ? { current: false, from, to } : null;
  }
  const tail = TAIL_RE.exec(v);
  if (tail) {
    const from = Number(tail[1]);
    return from >= 1 ? { current: false, from, to: null } : null;
  }
  return null;
}

/** One rung as a predicate over `due_date`, mirroring `arAgingBucketSql`'s CASE arms. */
function rungCondition(rung: Rung): SQL {
  if (rung.current) return sql`NOT ${overdue}`;
  const parts: SQL[] = [overdue];
  // The first rung has no lower bound beyond "overdue at all": an invoice due four hours
  // ago is 0 whole days overdue and the ladder files it on the first rung, not Current.
  if (rung.from > 1) parts.push(sql`${daysOverdue} > ${rung.from - 1}`);
  if (rung.to != null) parts.push(sql`${daysOverdue} <= ${rung.to}`);
  else parts.push(sql`${daysOverdue} > ${rung.from}`);
  return sql`(${sql.join(parts, sql` AND `)})`;
}

/**
 * `ar_bucket` as SQL, derived from the rung NAME rather than compared against a fixed
 * ladder — so a figure printed at 15-day rungs drills into the invoices behind it exactly
 * as the standard ladder's rungs do.
 *
 * Says nothing about status or write-off: the ageing ladder counts unpaid, un-written-off
 * invoices, and that population belongs in the drill-down's own `status` / `written_off`
 * filters. Folding it in here would make one filter silently narrow on three things.
 */
export function arAgingBucketCondition(op: string, value: string): SQL | undefined {
  const members = splitMulti(value);
  const anyOf = () => {
    const rungs = members.map((m) => parseArAgingRung(m)).filter((r): r is Rung => r != null);
    if (rungs.length === 0) return undefined;
    return sql`(${sql.join(rungs.map(rungCondition), sql` OR `)})`;
  };
  switch (op) {
    case "is":
    case "in":
      return anyOf();
    case "is_not":
    case "not_in": {
      const c = anyOf();
      return c && sql`NOT ${c}`;
    }
    // The rung is derived, never null, so presence is a foregone answer either way.
    case "is_present":
      return value === "false" ? sql`FALSE` : sql`TRUE`;
    default:
      return undefined;
  }
}

/**
 * Why `ar_bucket` needs a value check the shared kind validation cannot do: it names a rung,
 * and a name that is not a rung matches nothing at all. The route answers 400 — a stale
 * ageing label must say it is stale, not answer "nothing is 61-90 days overdue".
 *
 * A NAME is checked, not membership of one ladder: the report can print `1–15 days` when a
 * reader asks for 15-day rungs, and a check against the standard ladder would refuse the
 * very rung the figure was printed from.
 *
 * `is_present` is exempt: the expression is never NULL, so the operator is the documented
 * foregone-answer wart rather than a bad value.
 */
export function arBucketValueError(op: string, value: string): string | null {
  if (op === "is_present") return null;
  const bad = splitMulti(value).find((v) => parseArAgingRung(v) == null);
  return bad == null
    ? null
    : `'${bad}' is not an aging rung — a rung is '${AR_AGING_CURRENT}', ` +
        `'<from>–<to> days' or '<from>+ days', spelled with an en dash exactly as the ` +
        `receivables report prints it: ${AR_AGING_BUCKETS.join(", ")}.`;
}
