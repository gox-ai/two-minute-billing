/**
 * Shared plumbing for **paginated list endpoints**.
 *
 * Every list read that can grow with customer volume must be cursor-paginated —
 * an unbounded `SELECT` is a latent outage, and a silently capped one hides rows
 * from the operator (worse: the count says 50 when there are 40,000). The
 * contract, first implemented on `GET /v1/businesses/:biz/customers` and
 * documented in `docs/GUIDE.md` §3.4:
 *
 *   ?limit=50&starting_after=<opaque>&q=<text>&sort_by[desc]=created_at&<field>[<op>]=<value>
 *   → { object: 'list', data, has_more, next_cursor, total, next_offset? }
 *
 * `offset` / `next_offset` are the same opaque token as `starting_after` / `next_cursor`
 * under a second name; `next_offset` is present only while `has_more`.
 *
 * This module owns the parts that are identical everywhere: query parsing +
 * validation, the keyset/offset cursor, and the SQL for one filter operator.
 * Each module keeps its own column maps (they're table-specific).
 */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  lt,
  or,
  sql,
  type Column,
  type SQL,
  type Subquery,
} from "drizzle-orm";
import type { Tx } from "./db";
import { AsyncLocalStorage } from "node:async_hooks";

export const DEFAULT_LIST_LIMIT = 50;
/** Deliberately high because our own pickers still bulk-read. */
export const MAX_LIST_LIMIT = 1000;

// ── Operators ─────────────────────────────────────────────────────────────────

/**
 * Operators by column kind. Routes validate the request against these.
 *
 * List filters offer set membership (`is one of`), closed ranges
 * (`between`) and relative windows (`in the last N days`) on every applicable
 * column, and an operator we don't implement is a question the operator has to
 * answer by exporting to a spreadsheet. Widening the tables here widens EVERY
 * list at once: each module's `*_FILTER_OPS` is derived from its column map via
 * `opsFromSpecs`, and `parseListQuery` validates against that.
 *
 * Ordered coarse → fine, because the UI renders them in this order.
 */
export const TEXT_OPS = [
  "is",
  "is_not",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "in",
  "not_in",
  "is_present",
] as const;
export const ENUM_OPS = ["is", "is_not", "in", "not_in", "is_present"] as const;
export const BOOL_OPS = ["is"] as const;
export const NUMBER_OPS = [
  "is",
  "is_not",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "is_present",
] as const;
export const DATE_OPS = [
  "on",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "between",
  "in_last",
  "in_next",
  "is_present",
] as const;
/** For a virtual EXISTS-backed field (e.g. a customer's subscription status). */
export const SET_OPS = ["is", "is_not", "in", "not_in", "is_present"] as const;

export type FilterKind = "text" | "enum" | "bool" | "number" | "date";

export const OPS_BY_KIND: Record<FilterKind, readonly string[]> = {
  text: TEXT_OPS,
  enum: ENUM_OPS,
  bool: BOOL_OPS,
  number: NUMBER_OPS,
  date: DATE_OPS,
};

/**
 * Operators whose VALUE is not a single scalar. The UI renders a different control
 * for each, and `filterValueError` validates the shape before it reaches SQL.
 *
 *   `in` / `not_in`  → a set                      `status[in]=active,in_trial`
 *   `between`        → exactly two bounds, inclusive of both ends
 *   `in_last`/`in_next` → a positive integer count of DAYS
 *
 * A set or range is comma-separated OR a JSON array (`status[in]=["active","in_trial"]`,
 * `created_at[between]=[1767225600,1769904000]`); see `splitMulti`.
 */
export const SET_VALUE_OPS = ["in", "not_in"] as const;
export const RANGE_VALUE_OPS = ["between"] as const;
export const RELATIVE_DAY_OPS = ["in_last", "in_next"] as const;

/**
 * The members of a JSON-array value, or null when the value is not one.
 *
 * Only a flat array of strings/finite numbers counts; anything else (`[foo]`, a nested
 * array, an object) falls back to the comma form, so it parses exactly as it always did.
 */
function jsonArrayMembers(value: string): string[] | null {
  const t = value.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const scalar = (m: unknown) =>
    typeof m === "string" || (typeof m === "number" && Number.isFinite(m));
  return parsed.every(scalar) ? parsed.map(String) : null;
}

/** Is this set/range value spelled as a JSON array (rather than comma-separated)? */
export function isJsonArrayValue(value: string): boolean {
  return jsonArrayMembers(value) != null;
}

/**
 * Split a set/range value, dropping blanks (`a,,b` is a typo, not an empty member).
 * A JSON array is the way to pass a member that itself contains a comma.
 */
export function splitMulti(value: string): string[] {
  return (jsonArrayMembers(value) ?? value.split(",")).map((v) => v.trim()).filter((v) => v !== "");
}

/**
 * A date value given as unix SECONDS is an exact INSTANT for `before` / `after` /
 * `on_or_*` and each `between` bound — "after my last sync" must not round to a day.
 * `on=<unix>` alone means the business-zone day holding the instant. Eleven digits caps
 * it at year 5138 and refuses milliseconds.
 */
const UNIX_SECONDS_RE = /^\d{1,11}$/;

/** One validated `field[op]=value` triple from the query string. */
export interface ListFilter {
  field: string;
  op: string;
  value: string;
}

/**
 * The `field → operators` allow-list a route validates against, from a column map.
 *
 * Derived purely from the KIND, which means `is_present` is offered on `NOT NULL`
 * columns too — where "is empty" can only ever match nothing. That is a real wart:
 * the dashboard mirrors this allow-list into a live "is empty" row in its filter
 * builder, so a handful of fields per list carry a question with a foregone answer.
 *
 * It was fixed here once, by reading `column.notNull` and trimming the operator, and
 * then REVERTED — because the dashboard does not read this map, it re-declares it by
 * hand as `serverOps` on each `ListFilterField`. Trimming the engine while ~250
 * hand-written mirrors kept offering the operator turned a harmless dead row into a
 * **400 on the whole list request**. Desynchronising the two is worse than the wart.
 *
 * The actual defect is the duplication, and the fix is to SERVE this map (per entity,
 * alongside the sortable fields) so the builder is built from it instead of mirroring
 * it. Filed in `docs/PROGRESS.md`. Until then, keep the two in step by hand.
 */
export function opsFromSpecs(
  specs: Record<string, { kind: FilterKind }>,
): Record<string, readonly string[]> {
  return Object.fromEntries(
    Object.entries(specs).map(([field, s]) => [field, OPS_BY_KIND[s.kind]]),
  );
}

/**
 * The `field → kind` map a route hands `parseListQuery` so it can validate the VALUE,
 * not just the field and operator. Same column map as `opsFromSpecs` — passing both is
 * what turns a malformed `amount[between]=10` or `created_at[on]=31/08/2026` into a 400
 * that names the shape, rather than a 500 from the Postgres cast.
 */
export function kindsFromSpecs(
  specs: Record<string, { kind: FilterKind }>,
): Record<string, FilterKind> {
  return Object.fromEntries(Object.entries(specs).map(([field, s]) => [field, s.kind]));
}

/**
 * A filterable column: the comparable expression plus how to compare it.
 *
 * Usually a Drizzle column. A **virtual** field — a computed sum, a CASE, a
 * scalar subquery — is a plain `SQL` fragment instead, and every operator below
 * interpolates it identically. Widening this (rather than each module writing
 * its own `is`/`gt`/`contains` for derived fields) is what keeps a virtual
 * field's semantics the same as a real column's: `/ops` needs to filter on the
 * SUM of a tick's seven counters, and a second copy of the operator table is
 * how two filters that read alike start behaving differently.
 */
export interface FilterSpec {
  column: Column | SQL;
  kind: FilterKind;
  /**
   * Deprecated value spellings → the stored one (lowercase keys), for an `enum` whose
   * vocabulary was renamed: old saved views and integrations keep matching the same rows.
   */
  aliases?: Readonly<Record<string, string>>;
}

/** Resolve a deprecated value to its current spelling; anything else is returned as-is. */
export function resolveAlias(aliases: Readonly<Record<string, string>> | undefined, v: string) {
  if (!aliases) return v;
  const key = v.toLowerCase();
  return Object.hasOwn(aliases, key) ? aliases[key]! : v;
}

/**
 * A filter field resolved with an EXISTS sub-query instead of a column, so it cannot
 * live in a `FilterSpec` map (which `filterConditions` drives off a real column).
 *
 * `kind` is what `parseListQuery` validates the VALUE against, and it also selects the
 * operator table: `enum` is exactly the set an EXISTS can answer (equality, set
 * membership, presence), `bool` for the ones that are only ever a yes/no, `date` for
 * one resolved through `existsDateCondition`.
 *
 * `tz` is the BUSINESS zone, passed so a `date` virtual field buckets by the same day
 * boundary a real date column does. It is optional for the caller's sake — an
 * enum/bool condition has no use for it and every existing one ignores it — but a
 * `date` field that drops it silently answers in UTC, which is off by the business's
 * offset at both ends of every window.
 */
export interface VirtualFilter {
  kind: FilterKind;
  condition: (op: string, value: string, tz?: string) => SQL | undefined;
}

/**
 * The is/is_not/in/not_in/is_present family over an EXISTS sub-query — ONE
 * implementation for every virtual field, parameterized by the sub-query and the
 * column compared inside it.
 *
 * A second copy of this switch is how `subscription_status[not_in]` and
 * `payment_method_type[not_in]` would start disagreeing about the customer who has no
 * related row at all. The answer here is that such a customer MATCHES both negations
 * — "not paying by card" plainly includes "has no payment method" — and that is only
 * true because the negation wraps the whole EXISTS rather than the comparison inside.
 *
 * Comparisons lowercase both sides, matching `filterSql`, which does that for every
 * non-numeric column. An EXISTS-backed field that alone stayed case-sensitive would
 * answer `subscription_status[is]=Active` with an empty page while the real-column
 * filter beside it answered correctly.
 */
export function existsFieldCondition(
  exists: (inner: SQL) => SQL,
  col: Column,
  op: string,
  value: string,
): SQL | undefined {
  const eqTo = (v: string) => sql`lower(${col}::text) = lower(${v})`;
  const members = splitMulti(value);
  const oneOf = () =>
    sql`lower(${col}::text) IN (${sql.join(
      members.map((m) => sql`lower(${m})`),
      sql`, `,
    )})`;
  switch (op) {
    case "is":
      return exists(eqTo(value));
    case "is_not":
      return sql`NOT ${exists(eqTo(value))}`;
    case "in":
      return members.length ? exists(oneOf()) : undefined;
    case "not_in":
      return members.length ? sql`NOT ${exists(oneOf())}` : undefined;
    case "is_present":
      return value === "false" ? sql`NOT ${exists(sql`TRUE`)}` : exists(sql`TRUE`);
    default:
      return undefined;
  }
}

/**
 * The DATE family over an EXISTS sub-query — "has a related row whose `col` falls in
 * this window".
 *
 * Deliberately not a second operator switch. `existsFieldCondition` above had to write
 * one because it compares `lower(col::text)`, which cannot order dates; this one builds
 * the inner predicate with `filterSql` itself, so `on` / `before` / `between` /
 * `in_last` mean exactly what they mean on a real date column, business zone included.
 * A hand-written copy is how "cancelled in the last 30 days" would start disagreeing
 * with "created in the last 30 days" at the day boundary.
 *
 * `is_present` is handled here rather than delegated, because the negation has to wrap
 * the whole EXISTS: "has no cancellation date" must include the customer with no
 * subscription at all, the same rule `existsFieldCondition` settles for its family.
 */
export function existsDateCondition(
  exists: (inner: SQL) => SQL,
  col: Column,
  op: string,
  value: string,
  tz = "UTC",
): SQL | undefined {
  if (op === "is_present") {
    const any = exists(sql`${col} IS NOT NULL`);
    return value === "false" ? sql`NOT ${any}` : any;
  }
  const inner = filterSql({ column: col, kind: "date" }, op, value, tz);
  return inner ? exists(inner) : undefined;
}

/**
 * Is a **date-kind** value a day (`YYYY-MM-DD`) or a full ISO instant starting with one?
 *
 * `filterSql` casts the value with `::date` inside SQL, so a value Postgres cannot cast
 * reached the database as a `22007 invalid input syntax for type date` — a **500** on a
 * caller typo. `filterValueError` rejects it as a 400 instead, naming the shape.
 */
const DAY_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

/** A positive integer, for the relative-window day counts. */
function positiveInt(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Why the value shape is validated at the ROUTE and not left to SQL: every operator
 * below interpolates `value` into a cast or a bound parameter, so a malformed one has
 * only two possible endings — a Postgres cast error surfacing as a 500, or (worse) a
 * condition that quietly matches everything. `?tax_exempt[is]=yes` used to mean
 * `= false`, because `value === 'true'` is the whole of the old bool parse: the list came
 * back narrowed to the opposite of what was asked, with a 200.
 *
 * Returns a caller-facing message, or null when the value is usable.
 */
export function filterValueError(kind: FilterKind, op: string, value: string): string | null {
  if (op === "is_present") {
    return value === "true" || value === "false"
      ? null
      : `Operator 'is_present' takes 'true' or 'false', not '${value}'.`;
  }

  if ((RELATIVE_DAY_OPS as readonly string[]).includes(op)) {
    return positiveInt(value) == null
      ? `Operator '${op}' takes a positive number of days, not '${value}'.`
      : null;
  }

  const multi = (SET_VALUE_OPS as readonly string[]).includes(op) || op === "between";
  const members = multi ? splitMulti(value) : [value];

  if ((SET_VALUE_OPS as readonly string[]).includes(op) && members.length === 0) {
    return `Operator '${op}' takes a comma-separated list or a JSON array of values.`;
  }
  if (op === "between" && members.length !== 2) {
    return `Operator 'between' takes exactly two bounds, e.g. '10,20' or '[10,20]'.`;
  }

  for (const m of members) {
    if (kind === "bool") {
      if (m !== "true" && m !== "false") return `'${m}' is not a boolean. Use 'true' or 'false'.`;
    } else if (kind === "number") {
      if (m.trim() === "" || !Number.isFinite(Number(m))) return `'${m}' is not a number.`;
    } else if (kind === "date") {
      if (!DAY_PREFIX_RE.test(m) && !UNIX_SECONDS_RE.test(m))
        return `'${m}' is not a date. Use YYYY-MM-DD or unix seconds.`;
    }
  }
  return null;
}

/**
 * SQL for one filter. Returns undefined when the operator doesn't apply, so an
 * unusable filter narrows nothing instead of erroring mid-query.
 *
 * ⚠ That fallback is a last resort, not the validation layer: a filter the caller
 * ASKED for and that silently narrows nothing is the "list lies about being filtered"
 * bug class this module keeps running into. Routes call `filterValueError` first and
 * answer 400, so reaching `undefined` here means the operator genuinely does not apply
 * to the column kind rather than that the value was junk.
 */
export function filterSql(
  spec: FilterSpec,
  op: string,
  value: string,
  tz = "UTC",
): SQL | undefined {
  const col = spec.column;
  const numeric = spec.kind === "number";
  if (spec.aliases && op !== "is_present") {
    value = splitMulti(value)
      .map((v) => resolveAlias(spec.aliases, v))
      .join(",");
  }

  // ── Day boundaries, all in the BUSINESS zone ──
  //
  // `AT TIME ZONE tz` reads the naive `value::date` midnight AS a wall clock in `tz`
  // and yields the timestamptz instant it names — Postgres handles DST. Comparing
  // against a bare `::date` instead resolved midnight in the session zone (UTC), which
  // put every boundary off by the business's offset: a row created 21-Aug 00:30 IST is
  // stored 20-Aug 19:00Z, so `on 21-Aug` excluded a row the list itself dates 21-Aug.
  // `on=<unix>` reduces the instant to its business-zone day (`UNIX_SECONDS_RE`).
  const asDay = (v: string) =>
    UNIX_SECONDS_RE.test(v)
      ? sql`((to_timestamp(${v}::double precision) AT TIME ZONE ${tz})::date)`
      : sql`${v}::date`;
  const dayStart = (v: string) => sql`(${asDay(v)}::timestamp AT TIME ZONE ${tz})`;
  const dayAfter = (v: string) =>
    sql`((${asDay(v)} + interval '1 day')::timestamp AT TIME ZONE ${tz})`;
  const isUnix = (v: string) => UNIX_SECONDS_RE.test(v);
  const instant = (v: string) => sql`to_timestamp(${v}::double precision)`;
  /**
   * Midnight of "today + n" as the business reckons today — `now() AT TIME ZONE tz`
   * is the local wall clock, so `::date` is the local calendar day. Anchoring the
   * relative windows to the same day boundary as `on` is what makes "created in the
   * last 7 days" and "created on <day>" agree at the edges.
   *
   * ⚠ `${n}::int` is load-bearing. A bare placeholder reaches Postgres with an unknown
   * type, and `date + unknown` resolves to no operator — every `in_last`/`in_next` was
   * a `42883 operator is not unique` error rather than a filter. Caught by
   * `scripts/probe-list-views.ts`, which is why that probe executes each operator
   * instead of only rendering it.
   */
  const todayPlus = (n: number) =>
    sql`(((now() AT TIME ZONE ${tz})::date + ${n}::int)::timestamp AT TIME ZONE ${tz})`;

  /** One member of a set filter, comparable the way `is` compares. */
  const member = (v: string) => (numeric ? sql`${Number(v)}` : sql`lower(${v})`);
  const comparable = numeric ? sql`${col}` : sql`lower(${col}::text)`;

  switch (op) {
    case "is":
      // A template rather than `eq()`: `col` may be a virtual SQL expression, which
      // `eq`'s overloads reject. `${col} = $1` is what `eq` would have emitted anyway.
      if (spec.kind === "bool") return sql`${col} = ${value === "true"}`;
      if (numeric) return sql`${col} = ${Number(value)}`;
      return sql`lower(${col}::text) = lower(${value})`;
    case "is_not":
      if (spec.kind === "bool") return sql`${col} <> ${value === "true"}`;
      if (numeric) return sql`(${col} IS NULL OR ${col} <> ${Number(value)})`;
      return sql`(${col} IS NULL OR lower(${col}::text) <> lower(${value}))`;

    // ── Set membership. `is one of` is what the status filters use, and without it
    // "active or in trial" needed two passes or a hand-written segment.
    // NULL counts as "not one of", so the negation has to admit it explicitly — else a
    // row with no value falls out of BOTH `in` and `not_in`.
    case "in": {
      const members = splitMulti(value);
      if (members.length === 0) return undefined;
      return sql`${comparable} IN (${sql.join(members.map(member), sql`, `)})`;
    }
    case "not_in": {
      const members = splitMulti(value);
      if (members.length === 0) return undefined;
      return sql`(${col} IS NULL OR ${comparable} NOT IN (${sql.join(members.map(member), sql`, `)}))`;
    }

    case "contains":
      return sql`${col}::text ILIKE ${"%" + value + "%"}`;
    case "not_contains":
      return sql`(${col} IS NULL OR ${col}::text NOT ILIKE ${"%" + value + "%"})`;
    case "starts_with":
      return sql`${col}::text ILIKE ${value + "%"}`;
    case "ends_with":
      return sql`${col}::text ILIKE ${"%" + value}`;

    case "is_present":
      return value === "false"
        ? sql`(${col} IS NULL OR ${col}::text = '')`
        : sql`(${col} IS NOT NULL AND ${col}::text <> '')`;

    case "gt":
      return sql`${col} > ${Number(value)}`;
    case "gte":
      return sql`${col} >= ${Number(value)}`;
    case "lt":
      return sql`${col} < ${Number(value)}`;
    case "lte":
      return sql`${col} <= ${Number(value)}`;

    // Inclusive of BOTH bounds, in both kinds. An exclusive upper bound is the classic
    // way an amount range drops the round number the operator typed, and for dates it
    // would drop the whole final day. Numeric bounds are also sorted, so a range typed
    // high-then-low narrows to the same set instead of to nothing.
    case "between": {
      const [a, b] = splitMulti(value);
      if (a == null || b == null) return undefined;
      if (spec.kind === "date") {
        // Each bound on its own: a unix bound is an inclusive instant, a day bound a whole day.
        const lower = isUnix(a) ? sql`${col} >= ${instant(a)}` : sql`${col} >= ${dayStart(a)}`;
        const upper = isUnix(b) ? sql`${col} <= ${instant(b)}` : sql`${col} < ${dayAfter(b)}`;
        return sql`${lower} AND ${upper}`;
      }
      const [lo, hi] = Number(a) <= Number(b) ? [a, b] : [b, a];
      return sql`${col} >= ${Number(lo)} AND ${col} <= ${Number(hi)}`;
    }

    // A day value compares on the BUSINESS day, so `on` means that whole local day, `after`
    // strictly later days, and the `on_or_*` pair includes the named day. A unix value is
    // an instant: `after` is strictly later, `on_or_after` includes it (and mirror-wise).
    case "on":
      return sql`${col} >= ${dayStart(value)} AND ${col} < ${dayAfter(value)}`;
    case "after":
      return isUnix(value) ? sql`${col} > ${instant(value)}` : sql`${col} >= ${dayAfter(value)}`;
    case "on_or_after":
      return isUnix(value) ? sql`${col} >= ${instant(value)}` : sql`${col} >= ${dayStart(value)}`;
    case "before":
      return isUnix(value) ? sql`${col} < ${instant(value)}` : sql`${col} < ${dayStart(value)}`;
    case "on_or_before":
      return isUnix(value) ? sql`${col} <= ${instant(value)}` : sql`${col} < ${dayAfter(value)}`;

    // Relative windows, both INCLUSIVE OF TODAY and both N whole business days wide:
    // `in_last=7` is the seven days ending tonight, `in_next=7` the seven starting this
    // morning. "Renewing in the next 7 days" must include a renewal left today, and
    // "created in the last 7 days" one from an hour ago — an exclusive today would
    // silently drop exactly the rows the operator is looking at.
    case "in_last": {
      const n = positiveInt(value);
      if (n == null) return undefined;
      return sql`${col} >= ${todayPlus(-(n - 1))} AND ${col} < ${todayPlus(1)}`;
    }
    case "in_next": {
      const n = positiveInt(value);
      if (n == null) return undefined;
      return sql`${col} >= ${todayPlus(0)} AND ${col} < ${todayPlus(n)}`;
    }

    default:
      return undefined;
  }
}

/** Build the conditions for a validated filter list against a column map. */
export function filterConditions(
  specs: Record<string, FilterSpec>,
  filters: ListFilter[] = [],
  /**
   * The business's IANA zone, for `date`-kind day bucketing (`businessTimezone`,
   * `src/platform/business-tz.ts`). Defaults to UTC for org-level lists that span
   * businesses and therefore have no single zone.
   */
  tz = "UTC",
): SQL[] {
  const out: SQL[] = [];
  for (const f of filters) {
    const spec = Object.hasOwn(specs, f.field) ? specs[f.field] : undefined;
    if (!spec) continue;
    const c = filterSql(spec, f.op, f.value, tz);
    if (c) out.push(c);
  }
  return out;
}

/** Free-text search across several columns (unindexed ILIKE — fine to ~50k rows). */
export function searchCondition(columns: Column[], search?: string): SQL | undefined {
  if (!search) return undefined;
  const like = `%${search}%`;
  const parts = columns.map((c) => sql`${c}::text ILIKE ${like}`);
  return sql`(${sql.join(parts, sql` OR `)})`;
}

// ── Cursors ───────────────────────────────────────────────────────────────────

/**
 * Cursors are **opaque** to callers: `k:<publicId>` for the indexed keyset path,
 * `o:<n>` when a non-default sort forces offset paging. Keeping them opaque is
 * what lets a list switch strategies without breaking a client mid-scroll.
 */
export function parseCursor(cursor?: string | null): { keysetId?: string; offset: number } {
  if (!cursor) return { offset: 0 };
  if (cursor.startsWith("o:")) return { offset: Math.max(Number(cursor.slice(2)) || 0, 0) };
  if (cursor.startsWith("k:")) return { keysetId: cursor.slice(2), offset: 0 };
  return { offset: 0 };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this keyset id shaped like a uuid?
 *
 * Tables with a public id tiebreak (`cus_…`, `inv_…`) can look a stale cursor up
 * against a text column safely — the row simply isn't found. Tables whose only
 * tiebreak is the raw `uuid` PK (audit logs, gateway webhooks, gateway request
 * logs) cannot: Postgres rejects a non-uuid literal with `22P02 invalid input
 * syntax for type uuid`, which surfaced as a **500 on every one of those
 * endpoints** for any malformed `starting_after` — instead of the documented
 * "degrade to the first page". Cursors are opaque and clients persist them, so
 * a garbled or truncated one is a routine event, not an attack.
 *
 * Guard the lookup with this and the seek degrades correctly.
 */
export function isUuidCursor(keysetId: string): boolean {
  return isUuid(keysetId);
}

/**
 * The same guard, for a caller-supplied OBJECT id rather than a cursor.
 *
 * The note above describes this bug being found and fixed for `starting_after`. It survived on
 * the single-object GET routes: `/gateway_webhooks/:id`, `/gateway_requests/:id` and
 * `/transfer_configurations/:job` all compare a caller-supplied string against a raw `uuid` PK,
 * so any non-uuid id — `notreal_abc123`, a truncated paste, a customer id used by mistake —
 * reached Postgres and came back as `22P02`, surfacing as a **500 where every sibling route
 * answers 404**. Found 2026-08-28 by the all-resources sweep in `verify:bola`.
 *
 * The right answer is "not found", not "bad request": these ids are opaque to clients, and a
 * malformed one is indistinguishable from one that has been deleted.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Seek past the cursor row on `(sortCol, tiebreakCol)`. Needs the cursor row's
 * values — a stale cursor (row deleted) yields undefined, which degrades to the
 * first page rather than to "no filter at all".
 */
export function keysetCondition(
  sortCol: Column,
  tiebreakCol: Column,
  cursorRow: { sortValue: unknown; tiebreak: string } | undefined,
  descending: boolean,
): SQL | undefined {
  if (!cursorRow) return undefined;
  const { sortValue, tiebreak } = cursorRow;

  // ⚠ PRECISION: Postgres stores timestamptz to MICROseconds; a JS `Date` only
  // holds MILLIseconds. Drizzle maps a timestamptz column to `Date`, so reading
  // the cursor row through a typed select silently truncated `…12.452583` to
  // `…12.452`. Both seek branches then failed for every row sharing that
  // millisecond — `lt` because they are greater than the truncated value, and
  // `eq` because they no longer equal it — so those rows VANISHED between pages.
  // Bulk writes (an import, or one transaction emitting several events) routinely
  // share a millisecond, so this dropped real rows.
  //
  // Callers therefore pass the sort value as a full-precision STRING (select it
  // as `::text`), and it is cast back inside SQL so no JS type is in the path.
  // A non-string value keeps the old behaviour, for sorts that are not timestamps.
  const sv = typeof sortValue === "string" ? sql`${sortValue}::timestamptz` : sortValue;
  return descending
    ? or(lt(sortCol, sv), and(eq(sortCol, sv), lt(tiebreakCol, tiebreak)))
    : or(gt(sortCol, sv), and(eq(sortCol, sv), gt(tiebreakCol, tiebreak)));
}

/**
 * Sort key for a document number that orders its trailing digits by value:
 * `INV-9 < INV-10 < INV-100`, where a text sort gives `INV-10 < INV-100 < INV-9`.
 * The prefix still sorts as text, so numbering series stay grouped. NULL stays NULL.
 */
export function documentNumberSortKey(col: Column): SQL {
  return sql`(regexp_replace(${col}, '[0-9]+$', '') || lpad(coalesce(substring(${col} from '[0-9]+$'), ''), 20, '0'))`;
}

/**
 * ORDER BY for a page: the sort column then the tiebreak, NULLs last.
 *
 * `sortCol` may be a virtual `SQL` expression (see `FilterSpec`) — a list can
 * offer "sort by duration" on a table that stores only start and finish.
 */
export function pageOrder(
  sortCol: Column | SQL,
  tiebreakCol: Column,
  descending: boolean,
  indexed: boolean,
): SQL[] {
  if (indexed) {
    return descending
      ? [desc(sortCol) as SQL, desc(tiebreakCol) as SQL]
      : [asc(sortCol) as SQL, asc(tiebreakCol) as SQL];
  }
  return descending
    ? [sql`${sortCol} DESC NULLS LAST`, desc(tiebreakCol) as SQL]
    : [sql`${sortCol} ASC NULLS LAST`, asc(tiebreakCol) as SQL];
}

// ── Page shape ────────────────────────────────────────────────────────────────

export interface ListPage<T> {
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
  /** Filtered-set count — first page only (null afterwards), at most `TOTAL_CAP`. */
  total: number | null;
  /** More rows match than `total` says: the count stopped at `TOTAL_CAP`. */
  totalCapped?: boolean;
}

/** Clamp a requested limit into [1, MAX_LIST_LIMIT]. */
export function clampLimit(limit?: number): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
}

/**
 * Turn `limit + 1` rows into a page: trim the probe row, and mint the next
 * cursor from the last kept row (`keyOf`) or the offset.
 */
export function toPage<T>(
  rows: T[],
  limit: number,
  opts: { keyset: boolean; offset: number; keyOf: (row: T) => string; total: number | null },
): ListPage<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = !hasMore
    ? null
    : opts.keyset
      ? `k:${opts.keyOf(data[data.length - 1]!)}`
      : `o:${opts.offset + data.length}`;
  return {
    data,
    hasMore,
    nextCursor,
    ...cappedPageTotal(opts.total),
  };
}

/** The `count(*)` expression for a first-page total (services run it inline). */
export const countExpr = sql<number>`count(*)::int`;

/** A list total stops here: past it the page says "10,000+" (`totalCapped`). */
export const TOTAL_CAP = 10_000;

/**
 * A list's first-page total, counting at most `TOTAL_CAP + 1` matches. An exact count reads
 * every matching row on every first page — seconds at a million rows, with nothing on screen
 * that needs more than "10,000+". Pass the list's own select (`{ one: sql`1` }`) with its
 * joins and filters, unlimited.
 */
export async function cappedTotal(
  tx: Pick<Tx, "select">,
  rows: { limit(n: number): { as(alias: string): Subquery } },
): Promise<number> {
  const limit = exactTotals.getStore() ? Number.MAX_SAFE_INTEGER : TOTAL_CAP + 1;
  const [r] = await tx.select({ n: countExpr }).from(rows.limit(limit).as("capped_total"));
  return r?.n ?? 0;
}

const exactTotals = new AsyncLocalStorage<true>();

/**
 * `?total=exact`: the rest of this request counts list totals in full. For a caller that shows
 * a total as a figure (a badge, a KPI tile) rather than as "N rows"; it pays the full scan.
 */
/** `total` / `totalCapped` for a page a service builds itself rather than through `toPage`. */
export function cappedPageTotal(total: number | null): {
  total: number | null;
  totalCapped: boolean;
} {
  if (total == null || exactTotals.getStore()) return { total, totalCapped: false };
  return { total: Math.min(total, TOTAL_CAP), totalCapped: total > TOTAL_CAP };
}

export function requestExactTotals(): void {
  exactTotals.enterWith(true);
}
