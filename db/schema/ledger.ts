import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, bigint, char, index } from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * The money source of truth: an append-only, double-entry ledger.
 *
 * INVARIANTS (enforced in app code via postEntries(), see BLUEPRINT §4):
 *  - Rows are NEVER updated or deleted. Corrections are new, compensating rows.
 *  - Every `transactionId` group must net to zero (Σ debits = Σ credits per currency).
 *  - Amounts are integer MINOR units (cents/paise). Never floats.
 *
 * Money always belongs to a specific business (which bills its own customers),
 * within an organization (the isolation boundary). Balances are DERIVED by
 * summing entries, never stored as a mutable column.
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
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
    // Optional customer dimension — set for customer-attributable money (e.g.
    // customer_balance credits) so a customer's credit balance can be derived.
    customerId: uuid("customer_id"),
    // Groups the balanced set of entries for one economic event.
    transactionId: uuid("transaction_id").notNull(),
    // e.g. accounts_receivable | cash | revenue | customer_balance | tax_payable
    account: text("account").notNull(),
    direction: text("direction").notNull(), // 'debit' | 'credit'
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(), // ISO 4217
    // What this entry is about, for audit trails (e.g. invoice / payment / refund).
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    memo: text("memo"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    index("ledger_org_idx").on(t.organizationId),
    index("ledger_business_idx").on(t.businessId),
    index("ledger_txn_idx").on(t.transactionId),
    index("ledger_source_idx").on(t.sourceType, t.sourceId),
    // A customer's balance (0348).
    index("ledger_customer_balance_idx")
      .on(t.customerId, t.account, t.currency)
      .where(sql`customer_id IS NOT NULL`),
  ],
);
