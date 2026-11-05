import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { paymentMethods } from "./payment-methods";
import { gatewayAccounts } from "./gateway";
import { subscriptions } from "./subscriptions";
import { invoices } from "./invoices";

/**
 * A pre-debit notice sent THROUGH a gateway (0360): on these rails the bank notifies the
 * payer after our API call, and a debit is legal only inside the notice's window
 * (`executable_after` … `expires_at`) and, where the gateway says so, only for
 * `amount_minor`. Our own notice email is a different thing (`subscriptions/reminders.ts`).
 */
export const preDebitNotices = pgTable(
  "pre_debit_notices",
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
    publicId: text("public_id").notNull(), // pdn_…
    paymentMethodId: uuid("payment_method_id")
      .notNull()
      .references(() => paymentMethods.id, { onDelete: "cascade" }),
    gatewayAccountId: uuid("gateway_account_id").references(() => gatewayAccounts.id, {
      onDelete: "set null",
    }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    /** The debit date the notice announced. */
    debitAt: timestamp("debit_at", { withTimezone: true }).notNull(),
    /**
     * invoice | wallet_topup (0362) | credit_topup (0473). A notice covers debits of its own
     * purpose only.
     */
    purpose: text("purpose").notNull().default("invoice"),
    // pending | sent | failed | superseded | exhausted
    status: text("status").notNull().default("pending"),
    notificationRef: text("notification_ref"),
    executableAfter: timestamp("executable_after", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Debits made under this notice; the gateway caps it (`maxDebitsPerNotice`). */
    debitsUsed: integer("debits_used").notNull().default(0),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("pre_debit_notices_public_id_uq").on(t.publicId),
    uniqueIndex("pre_debit_notices_idem_uq").on(t.businessId, t.idempotencyKey),
    index("pre_debit_notices_pm_idx").on(t.paymentMethodId, t.purpose, t.createdAt),
    index("pre_debit_notices_ref_idx").on(t.gatewayAccountId, t.notificationRef),
  ],
);
