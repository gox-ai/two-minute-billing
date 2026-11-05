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
 * A receipt (0387): a numbered, immutable record of money received. One per succeeded
 * payment, or one per payment-request settlement (`transaction_id`). `number` is null
 * until the batch numberer assigns it (one series per business). `snapshot` holds what
 * the PDF prints, frozen at creation.
 */
export const receipts = pgTable(
  "receipts",
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
    publicId: text("public_id").notNull(), // rcpt_…
    number: text("number"),
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "restrict" }),
    paymentRequestId: uuid("payment_request_id"),
    transactionId: uuid("transaction_id"),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    snapshot: jsonb("snapshot").notNull(),
    numberedAt: timestamp("numbered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("receipts_public_id_uq").on(t.publicId),
    uniqueIndex("receipts_payment_uq")
      .on(t.paymentId)
      .where(sql`payment_id IS NOT NULL`),
    uniqueIndex("receipts_transaction_uq")
      .on(t.transactionId)
      .where(sql`transaction_id IS NOT NULL`),
    uniqueIndex("receipts_business_number_uq")
      .on(t.businessId, t.number)
      .where(sql`number IS NOT NULL`),
    index("receipts_unnumbered_idx")
      .on(t.businessId, t.createdAt)
      .where(sql`number IS NULL`),
    index("receipts_business_created_idx").on(t.businessId, t.createdAt.desc(), t.publicId.desc()),
    index("receipts_customer_idx").on(t.customerId, t.createdAt.desc()),
    index("receipts_request_idx")
      .on(t.paymentRequestId)
      .where(sql`payment_request_id IS NOT NULL`),
  ],
);
