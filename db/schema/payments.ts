import {
  pgTable,
  uuid,
  text,
  char,
  bigint,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, businesses } from "./tenancy";
import { customers } from "./customers";
import { invoices } from "./invoices";
import { paymentMethods } from "./payment-methods";

/**
 * A payment is one charge ATTEMPT against an invoice via a provider. Dunning
 * produces multiple payment rows per invoice (one per retry). The provider only
 * executes the charge; status + bookkeeping live here and in the ledger.
 */
export const payments = pgTable(
  "payments",
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
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    paymentMethodId: uuid("payment_method_id").references(() => paymentMethods.id, {
      onDelete: "set null",
    }),
    publicId: text("public_id").notNull(), // pay_…
    status: text("status").notNull(), // succeeded | failed | pending | requires_action
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    providerKey: text("provider_key").notNull(),
    providerChargeId: text("provider_charge_id"),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    /** The normalised decline of a late-failure reversal (0481); `failureCode` stays `late_failure`. */
    reversalCode: text("reversal_code"),
    // Archival rows imported from an external system (no cash/AR ledger postings).
    imported: boolean("imported").notNull().default(false),
    metadata: jsonb("metadata"),
    /**
     * The payment request this is a child of (0388). A child has NO charge id: the request
     * holds it, so `payments_provider_charge_uq` and the one-charge-one-payment resolvers
     * stay true. Typed loosely to avoid an import cycle with `payment-requests.ts`.
     */
    paymentRequestId: uuid("payment_request_id"),
    /** Which method type paid, in `METHOD_TYPES` vocabulary (0397). Null = not known. */
    methodType: text("method_type"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("payments_public_id_uq").on(t.publicId),
    index("payments_payment_request_idx")
      .on(t.paymentRequestId)
      .where(sql`payment_request_id IS NOT NULL`),
    index("payments_invoice_idx").on(t.invoiceId),
    index("payments_customer_idx").on(t.customerId),
    index("payments_payment_method_idx")
      .on(t.paymentMethodId)
      .where(sql`payment_method_id IS NOT NULL`),
    // One gateway charge books at most one payment (0162). Concurrent collectors
    // derived the SAME idempotency key from the same stale attempt count, so the
    // gateway deduplicated to one charge — and we booked it twice, with a second
    // cash/AR posting behind it. Scoped per business: the id belongs to the gateway,
    // and two businesses on different accounts have independent id spaces.
    //
    // Every exclusion in the predicate is load-bearing — an attempt that never reached
    // a gateway has no id; RazorPay/PayPal return '' on some failures; and `offline`
    // payments store the METHOD NAME here ('cash', 'cheque') rather than a charge id,
    // so they repeat by design. See the migration for the full reasoning.
    uniqueIndex("payments_provider_charge_uq")
      .on(t.businessId, t.providerChargeId)
      .where(
        sql`provider_charge_id IS NOT NULL AND provider_charge_id <> '' AND provider_key <> 'offline'`,
      ),
  ],
);

/**
 * A refund of (part of) a succeeded payment. Multiple partial refunds may exist
 * per payment; their sum can never exceed the payment amount (enforced in the
 * refund service). Each posts a contra-revenue/cash ledger transaction.
 */
export const refunds = pgTable(
  "refunds",
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
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    publicId: text("public_id").notNull(), // re_…
    status: text("status").notNull(), // succeeded | pending | failed
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    reason: text("reason"),
    providerKey: text("provider_key").notNull(),
    providerRefundId: text("provider_refund_id"),
    // Archival rows imported from an external system (no ledger postings).
    imported: boolean("imported").notNull().default(false),
    metadata: jsonb("metadata"),
    // 0491: a credit-note payout refund the gateway could not find. null = normal;
    // open → paid | credited (a person) | gateway_failed (the gateway); *_then_paid = paid
    // out after that credit (credited: twice; gateway_failed: out-of-order answers).
    notFoundState: text("not_found_state"),
    // 0501: what a gateway decline does (block | issue_credit), chosen on this refund.
    // null = the business rule `billing_rules_config.declined_refund`.
    onDecline: text("on_decline"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("refunds_public_id_uq").on(t.publicId),
    index("refunds_payment_idx").on(t.paymentId),
  ],
);
