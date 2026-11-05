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
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * Non-additive measures over rolling windows (0292) — the distinct counts and cohort rates a
 * "last 30 days" asks for, which no calendar period in `metric_daily` holds. Keyed by the
 * window's exact local dates. Derived and restated hourly (`daily/windows.ts`).
 */
export const metricWindows = pgTable(
  "metric_windows",
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
    windowName: text("window_name").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    measure: text("measure").notNull(),
    dim: text("dim").notNull().default(""),
    dimValue: text("dim_value").notNull().default(""),
    currency: char("currency", { length: 3 }).notNull(),
    value: bigint("value", { mode: "bigint" }),
    denominator: bigint("denominator", { mode: "bigint" }),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("metric_windows_key").on(
      t.businessId,
      t.periodStart,
      t.periodEnd,
      t.measure,
      t.dim,
      t.dimValue,
      t.currency,
    ),
  ],
);
