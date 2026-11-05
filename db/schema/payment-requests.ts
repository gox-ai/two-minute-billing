import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  char,
  bigint,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { customers } from "./customers";
import { invoices } from "./invoices";
import { paymentMethods } from "./payment-methods";

/**
 * A payment request (0388): several open invoices of one customer, paid by ONE gateway
 * charge (`mode = charge`) or one link the customer opens (`mode = link`). The request
 * holds the charge id; each invoice gets an ordinary child payment with none.
 */
export const paymentRequests = pgTable(
  "payment_requests",
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
    publicId: text("public_id").notNull(), // preq_…
    // open | processing | paid | canceled | expired
    status: text("status").notNull().default("open"),
    mode: text("mode").notNull(), // charge | link
    /** manual (operator/API) | dunning (clock combined retries) | portal (customer) — 0488 */
    origin: text("origin").notNull().default("manual"),
    currency: char("currency", { length: 3 }).notNull(),
    /** What the invoices owed at creation. History only: the live amount is recomputed. */
    createdAmountMinor: bigint("created_amount_minor", { mode: "bigint" }).notNull(),
    paymentMethodId: uuid("payment_method_id").references(() => paymentMethods.id, {
      onDelete: "set null",
    }),
    email: text("email"),
    providerKey: text("provider_key"),
    providerChargeId: text("provider_charge_id"),
    gatewayAccountId: uuid("gateway_account_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastPaymentError: jsonb("last_payment_error"),
    cancelReason: text("cancel_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("payment_requests_public_id_uq").on(t.publicId),
    uniqueIndex("payment_requests_charge_uq")
      .on(t.businessId, t.providerChargeId)
      .where(sql`provider_charge_id IS NOT NULL AND provider_charge_id <> ''`),
    index("payment_requests_business_created_idx").on(
      t.businessId,
      t.createdAt.desc(),
      t.publicId.desc(),
    ),
    index("payment_requests_customer_idx").on(t.customerId, t.createdAt.desc()),
    index("payment_requests_expiry_idx")
      .on(t.expiresAt)
      .where(sql`status = 'open'`),
  ],
);

/** The invoices of a request, in application order. `state = open` is unique per invoice. */
export const paymentRequestInvoices = pgTable(
  "payment_request_invoices",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => paymentRequests.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    createdOutstandingMinor: bigint("created_outstanding_minor", { mode: "bigint" }).notNull(),
    // open | paid | settled_elsewhere | removed
    state: text("state").notNull().default("open"),
  },
  (t) => [
    primaryKey({ columns: [t.requestId, t.invoiceId] }),
    uniqueIndex("payment_request_invoices_open_uq")
      .on(t.invoiceId)
      .where(sql`state = 'open'`),
  ],
);
