import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { subscriptions } from "./subscriptions";
import { invoices } from "./invoices";

/**
 * One skipped renewal: at `renewal_at` the billing clock advances the period without
 * charging its recurring items, and the fixed term (`remaining_billing_cycles`) does not
 * count it. Metered usage from the period just ended is still invoiced.
 */
export const renewalSkips = pgTable(
  "renewal_skips",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // skip_…
    /** The renewal boundary skipped: the `current_period_end` the clock renews from. */
    renewalAt: timestamp("renewal_at", { withTimezone: true }).notNull(),
    // scheduled | applied | cancelled | void. `void` = the renewal never came at that
    // instant (the subscription was paused, cancelled or re-anchored first).
    status: text("status").notNull().default("scheduled"),
    source: text("source").notNull(), // api | dashboard | portal
    /** The usage-only invoice raised at the skipped renewal, if there was usage to bill. */
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("renewal_skips_public_id_uq").on(t.publicId),
    // One live skip per renewal; a cancelled or void one may be scheduled again.
    uniqueIndex("renewal_skips_live_uq")
      .on(t.subscriptionId, t.renewalAt)
      .where(sql`status in ('scheduled', 'applied')`),
    index("renewal_skips_sub_idx").on(t.subscriptionId, t.renewalAt),
  ],
);
