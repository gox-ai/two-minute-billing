import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  char,
  bigint,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { customers } from "./customers";
import { payments } from "./payments";

/**
 * A wallet top-up adds prepaid credit to a customer. PAID top-ups charge the
 * card (cash in); GRANTED top-ups are promotional (no money in). Both credit the
 * customer_balance ledger account — the single spendable balance that invoice
 * billing already draws down — so a top-up reduces the next invoice automatically.
 *
 * This table is the paid-vs-granted audit view; the spendable balance itself is
 * derived from customer_balance (see ledger.customerCreditBalance).
 */
export const walletTopups = pgTable(
  "wallet_topups",
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
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // wt_…
    creditType: text("credit_type").notNull(), // paid | granted
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),
    // Free-form annotations; imported promo-credit balances carry { source, source_id }.
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("wallet_topups_public_id_uq").on(t.publicId),
    index("wallet_topups_customer_idx").on(t.customerId, t.currency),
  ],
);
