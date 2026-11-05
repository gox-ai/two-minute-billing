import { sql } from "drizzle-orm";
import { pgTable, uuid, char, numeric, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * Every rate this business has held, in the order it held them — append-only.
 *
 * `businesses.exchange_rates` is the rate NOW: one value per currency, overwritten in
 * place. It cannot answer "what was the rate in March", so a converted figure that moved
 * between two readings gives no way to tell a book that grew from a currency that did.
 * On the measured book 42% of subscriptions are in a currency other than the default, so
 * that ambiguity is most of the movement, not a rounding detail.
 *
 * One row per OBSERVED CHANGE, written wherever `businesses.exchange_rates` is written.
 * A write that leaves a rate where it was appends nothing, so the timeline holds distinct
 * values and a reader walks a handful of rows, not one per settings save.
 *
 * Append-only like the movement ledger: SELECT and INSERT are granted, UPDATE and DELETE
 * are not. A rate that turns out to have been wrong is corrected by observing the right
 * one, not by editing the past.
 */
export const exchangeRateHistory = pgTable(
  "exchange_rate_history",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    /** The quoted currency. */
    currency: char("currency", { length: 3 }).notNull(),
    /**
     * What it is quoted AGAINST — the business's default currency as it stood at the
     * observation. Stored per row because a business may change its default, and a
     * timeline that silently re-based would be worse than none.
     */
    baseCurrency: char("base_currency", { length: 3 }).notNull(),
    /**
     * `rate` units of `currency` per 1 unit of `baseCurrency` — base USD and
     * `1 USD = 94.953741 INR` stores "94.953741" on the INR row. The same direction
     * `invoices.exchange_rate` and `mrr_movements.exchange_rate` use, and the one the
     * readers divide by (`minor / rate`).
     *
     * NULL means the business held NO USABLE RATE for this currency from here on — the
     * currency was removed, or its stored value was zero/negative/non-numeric. Never 1:
     * a missing rate and parity are different facts, and a reader must exclude the
     * currency rather than count it at par.
     *
     * Unconstrained `numeric`, not `numeric(p,s)`: a scale would round an operator's rate
     * on the way in, and a rounded seed would restate the very figures this table exists
     * to leave alone. A STRING all the way to the column — `Number("94.953741")` is where
     * an exact rate becomes 94.95374099999999.
     */
    rate: numeric("rate"),
    /** When this rate came into force — the observation's clock. */
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The reader's access path: one business, one currency, walked in time order.
    index("exchange_rate_history_business_currency_idx").on(
      t.businessId,
      t.currency,
      t.effectiveFrom,
    ),
    // Makes the recorder idempotent under a retry: the same observation at the same
    // instant is one row, not two.
    uniqueIndex("exchange_rate_history_observation_key").on(
      t.businessId,
      t.currency,
      t.effectiveFrom,
    ),
  ],
);
