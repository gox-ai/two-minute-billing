import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, bigint, char, numeric, index } from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { subscriptions } from "./subscriptions";
import { customers } from "./customers";
import { products } from "./catalog";

/**
 * Every change to a subscription's MRR, as it happens — append-only.
 *
 * `subscriptions.mrr` says what a subscription earns NOW. It cannot say how it got there,
 * and that is the question every recurring-revenue report asks: an upgrade and a
 * reactivation both raise MRR, and a business that cannot tell them apart cannot compute
 * expansion, retention, or a quick ratio. The analytics module used to reconstruct stocks
 * from lifecycle timestamps and could only ever see two events per subscription — its
 * start and its cancellation — so an upgrade, a downgrade, a pause and a 100%-off coupon
 * were all invisible.
 *
 * **Written from exactly one place**: `recomputeSubscriptionMrr`, which is what every
 * mutation path already calls after changing items, coupons, quantity or status. A row is
 * appended only when the value actually moves, so the sum of `delta_minor` over any window
 * equals the change in MRR across it — that identity is what makes the ledger checkable,
 * and it is why PAUSE and RESUME get their own reasons instead of being dropped.
 *
 * Append-only like the money ledger: never UPDATE, never DELETE. A correction is a new row
 * under the ORIGINAL reason at the same instant, opposite-signed (a reversed trial is `new` −N
 * and `churn` +N), so a single row may contradict its reason. Read movements NETTED per
 * (subscription, occurred_at, reason); ops invariant `mrr_movements_net_to_their_reason`
 * guards that the netted sign always matches.
 */
export const mrrMovements = pgTable(
  "mrr_movements",
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
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    // Denormalized so a report can group by customer without joining the subscription —
    // and so the row survives a subscription that is later soft-deleted.
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /**
     * new | expansion | contraction | churn | reactivation | pause | resume
     *
     * Text, not an enum: the taxonomy will grow (free-to-paid and scheduled changes are
     * already named on the roadmap) and a Postgres enum makes each addition a migration
     * with a lock. The writer is one function, so the values cannot drift.
     */
    reason: text("reason").notNull(),
    /**
     * The plan this subscription was on WHEN the money moved — resolved by the writer and
     * stored, because a later join cannot reproduce it after a plan change, which is
     * exactly the movement it would be explaining. Null for a subscription with no
     * plan-kind item (charges only).
     */
    planProductId: uuid("plan_product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    /**
     * The plan the subscription was on BEFORE this movement — taken from its previous
     * movement row, because the live items no longer say. Without it "3 seats instead of
     * 1" and "moved to a pricier plan" are the same row, so upgrade and downgrade collapse
     * into expansion and contraction and no plan-to-plan matrix can be built.
     *
     * Null on the first movement, and also null when the previous movement had no plan —
     * the column cannot tell those apart, and both mean "no from-plan to report".
     */
    previousPlanProductId: uuid("previous_plan_product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    /** The subscription's own currency — never summed across currencies without FX. */
    currency: char("currency", { length: 3 }).notNull(),
    previousMrrMinor: bigint("previous_mrr_minor", { mode: "bigint" }).notNull(),
    newMrrMinor: bigint("new_mrr_minor", { mode: "bigint" }).notNull(),
    /** `new − previous`. Stored rather than derived so a report can SUM it in SQL. */
    deltaMinor: bigint("delta_minor", { mode: "bigint" }).notNull(),
    /**
     * The FX rate in force WHEN this movement happened: `exchange_rate` units of THIS
     * row's `currency` per 1 unit of `exchangeRateBase`. Base USD and `1 USD = 94.953741
     * INR` stores "94.953741" on an INR movement — the same convention as
     * `invoices.exchangeRate` and the direction `analytics.ts` divides by (`minor / rate`).
     *
     * WHY. `businesses.exchange_rates` is the rate NOW and is overwritten in place, so a
     * converted roll-up reprices its own history the day an operator edits a rate: last
     * March's expansion becomes a different number and nothing says so. Stamping the rate
     * on the row makes the figure sourceable.
     *
     * WHAT IT DOES NOT DO YET, stated plainly because the column looks like more than it
     * is: it RECORDS the rate and nothing else. FX is not a movement reason of its own —
     * a rate change still appends no row, because no subscription's rate moved — and the
     * reports still convert at read time off `businesses.exchange_rates`, unchanged.
     * Switching them onto these stamps would restate every converted figure on every
     * screen, which is the failure this exists to make visible rather than to repeat.
     *
     * Null, never 1, when no rate is available — pre-0260 rows, and any movement recorded
     * while the business had no usable rate for that currency. A missing rate and parity
     * are different facts. A movement already in the base currency DOES store 1: there
     * the parity is a fact. A STRING to the column: `Number("94.953741")` is where an
     * exact rate becomes 94.95374099999999.
     */
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 }),
    /**
     * The currency the rate is measured against — the business's default (reporting)
     * currency as it stood when the movement happened. Stored per row rather than read
     * off the business at report time: a business may change its default, and history
     * must not silently re-base.
     */
    exchangeRateBase: char("exchange_rate_base", { length: 3 }),
    /** When the money changed, which is the business's clock, not the row's write time. */
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .default(sql`app_now()`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`app_now()`),
  },
  (t) => [
    // The reporting access path: one business, one window, grouped by reason.
    index("mrr_movements_business_occurred_idx").on(t.businessId, t.occurredAt),
    // "How did THIS subscription get here" — also what the writer reads to tell a first
    // sale from a reactivation.
    index("mrr_movements_subscription_idx").on(t.subscriptionId, t.occurredAt),
    // The breakdown path: one business, one window, grouped by plan.
    index("mrr_movements_business_plan_idx").on(t.businessId, t.planProductId, t.occurredAt),
    // The matrix path: one business, one window, grouped by from-plan → to-plan.
    index("mrr_movements_business_plan_pair_idx").on(
      t.businessId,
      t.previousPlanProductId,
      t.planProductId,
      t.occurredAt,
    ),
  ],
);
