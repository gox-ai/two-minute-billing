import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, inet, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * The payer's authorization to debit a bank account, as shown and accepted (0400). Written
 * in the transaction that records the payment method, for a gateway that leaves this to the
 * merchant (`achAuthorization: "ours"` in the gateway catalogue).
 *
 * Evidence, so APPEND-ONLY: the app role has SELECT and INSERT only. The payment method and
 * customer ids carry no foreign key: deleting either must not delete the proof.
 */
export const paymentMethodAuthorizations = pgTable(
  "payment_method_authorizations",
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
    publicId: text("public_id").notNull(), // pma_…
    paymentMethodId: uuid("payment_method_id").notNull(),
    /** `pm_…` at the time, readable after the row is gone. */
    paymentMethodPublicId: text("payment_method_public_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    gatewayKey: text("gateway_key").notNull(),
    methodType: text("method_type").notNull(),
    textVersion: text("text_version").notNull(),
    /** The full text the payer saw, with the business and payer filled in. */
    text: text("text").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    payerName: text("payer_name"),
    payerEmail: text("payer_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payment_method_authorizations_public_id_uq").on(t.publicId),
    index("payment_method_authorizations_pm_idx").on(t.paymentMethodId, t.acceptedAt),
  ],
);
