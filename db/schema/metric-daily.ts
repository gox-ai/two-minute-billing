import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  date,
  char,
  text,
  bigint,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * One fact table for every ADDITIVE measure, replacing a table per dimension (0267).
 *
 * `mrr_snapshots` (0255), `mrr_snapshot_plans` (0261) and `mrr_snapshot_countries` (0263),
 * dropped in 0300, were the same idea three times: a day, a currency, a slice, a value. Each new dimension
 * cost a migration, a writer, a reader and a verify suite — so dimensions were added only
 * when someone would pay for all four, which is why plan and country exist and nothing
 * else does. Here a dimension is ROWS, and adding one is data.
 *
 * The read shape this exists for: `WHERE business_id AND measure AND period_end BETWEEN`,
 * bounded by PERIODS x the cardinality of one dimension — never by how many subscriptions a
 * business has. The reconstruction it caches costs the whole book per chart bucket,
 * measured at 3.5s of JavaScript on a 74,534-subscription book.
 *
 * Reproducible rather than authoritative: every value is
 * `stocks.ts` or the movement ledger evaluated for the day, so any row can be recomputed
 * from the facts — and the verify suites do precisely that. A materialised number that
 * cannot be re-derived is a number nobody can defend.
 *
 * ⚠️ NOT everything lives here. An audit of all 97 report keys (2026-09-20) found eight this
 * shape cannot hold: retention cohorts and the movement/account waterfalls carry TWO
 * dimensions at once, and customer concentration / top customers / MRR bands need a ranking
 * or band edges chosen at read time. Those keep their reconstruction. A table that pretended
 * to hold them would hold them wrongly.
 */
export const metricDaily = pgTable(
  "metric_daily",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /**
     * The period's grain, and its END.
     *
     * Daily rows alone are not enough: a DISTINCT COUNT is not additive, so a month's
     * distinct customers is not the sum of its days'. Those measures are computed at each
     * grain they are served at. Additive measures need only `day` and are summed on read;
     * a stock takes the LAST day in the period. The registry says which rule applies.
     */
    grain: text("grain").notNull().default("day"),
    periodEnd: date("period_end").notNull(),
    /**
     * What is being measured: `mrr`, `active_subscriptions`, `mrr_new`, `mrr_churn`, …
     * Text, not an enum: a new measure must not need a migration, and the registry is what
     * decides which names are real.
     */
    measure: text("measure").notNull(),
    /**
     * The slice. `''` (not NULL) means "no slice" — the total.
     *
     * NULL is the natural spelling and the wrong one: in Postgres NULL is not equal to
     * NULL, so the unique index below treats every unsliced row as distinct and the upsert
     * silently inserts a duplicate total each time a day is recomputed. The empty string
     * compares equal to itself, so the totals row has exactly one home.
     */
    dim: text("dim").notNull().default(""),
    dimValue: text("dim_value").notNull().default(""),
    /**
     * Per currency, never converted — FX is a read-time choice. `XXX` (ISO 4217's "no
     * currency") for a measure that is not currency-scoped, such as a customer count.
     */
    currency: char("currency", { length: 3 }).notNull(),
    /**
     * Money in MINOR UNITS, counts as counts. Never a float.
     *
     * NULLABLE, and null means "not applicable", never zero. Several resolvers return null
     * deliberately — a cohort cell with no base, LTV with no churn yet — and collapsing that
     * to 0 makes the UI report that everything churned. A missing row means "not computed";
     * a null value means "computed, and the answer is nothing".
     */
    value: bigint("value", { mode: "bigint" }),
    /**
     * The other half of a ratio or an average, so neither is stored pre-divided. A quotient
     * cannot be re-aggregated: a quarter's retention rate is not the mean of its months'.
     * Null for a plain scalar.
     */
    denominator: bigint("denominator", { mode: "bigint" }),
    /**
     * When this row was computed, so a reader can STATE its staleness rather than imply
     * freshness it does not have. The intraday refresh of "today" is what makes that
     * visible: a figure recomputed four minutes ago and one closed last night are both
     * legitimate, and only this column tells them apart.
     */
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The upsert target. A day recomputed after a late backdated change must restate, not
    // duplicate — the same contract `mrr_snapshots_day_currency_key` carries.
    uniqueIndex("metric_daily_key").on(
      t.businessId,
      t.grain,
      t.periodEnd,
      t.measure,
      t.dim,
      t.dimValue,
      t.currency,
    ),
    // The read path: one measure over a date range for one business. Column order matches
    // the predicate, so a range scan lands on the leading edge of the index.
    index("metric_daily_read_idx").on(t.businessId, t.measure, t.grain, t.periodEnd),
  ],
);
