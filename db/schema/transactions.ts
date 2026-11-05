import { sql } from "drizzle-orm";
import {
  pgTable,
  boolean,
  uuid,
  text,
  char,
  bigint,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { customers } from "./customers";

/**
 * The gateway-facing transaction log (C5 / GW-4). Distinct from `payments`
 * (which is the engine's ledger truth): a transaction records one attempt against
 * a gateway with its gateway-side identifiers and outcome, including states the
 * payments table has no vocabulary for (timeout, needs_attention, late_failure).
 * One payment attempt → one transaction.
 */
export const transactions = pgTable(
  "transactions",
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
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    publicId: text("public_id").notNull(), // txn_…
    type: text("type").notNull(), // authorization | payment | refund | payment_reversal
    // in_progress | succeeded | failed | voided | timeout | needs_attention | late_failed
    status: text("status").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    gatewayAccountId: uuid("gateway_account_id"),
    gatewayKey: text("gateway_key"),
    idAtGateway: text("id_at_gateway"),
    /**
     * A lost-answer charge (`timeout`, no gateway id) only: the ownership ref stamped on the
     * gateway object and the idempotency key sent (0396). What the sweep and the webhook
     * find the charge by. Null on every other row.
     */
    ownershipRef: text("ownership_ref"),
    idempotencyKey: text("idempotency_key"),
    paymentMethodId: uuid("payment_method_id"),
    /**
     * The ambient trace this transaction was written under — the ONLY key that correlates it
     * with `gateway_request_logs`, which is platform-global (no RLS) and therefore has no FK
     * to anything. Without it the money log and the gateway request/response log could not be
     * joined, so "show me what we actually sent the gateway" had no answer from a transaction.
     *
     * Null on historic rows and on anything written outside a trace context: a trace id cannot
     * be reconstructed later, and inventing one would link to the wrong requests.
     */
    traceId: text("trace_id"),
    /** The span inside `traceId` that wrote this row; matches `gateway_request_logs.span_id`. */
    spanId: text("span_id"),
    errorCode: text("error_code"),
    errorText: text("error_text"),
    // Whether the gateway said this failure was worth retrying. Set from the
    // provider's `FailureResult.retriable`, which `collectInvoice` already acts
    // on (retriable → schedule dunning; hard → settle to not_paid). Nullable:
    // null = not a failure / predates the column, so a historical success is
    // never mistaken for a hard decline.
    retriable: boolean("retriable"),
    // The intent/attempt that produced this transaction (0172). Nullable — most
    // transactions have no intent (an off-session renewal against a vaulted card never
    // creates one), and no FK, matching the other links on this row: `transactions` is
    // the gateway-side audit log and must survive the deletion of what it references.
    // `payment_intent_id` is redundant through the attempt and kept anyway: the
    // intent-level failure metrics group by intent over a large table and must not join
    // through a child to do it. This is the schema hole the Payment Intents dashboard
    // documents — its failure tiles counted TRANSACTIONS for want of these columns.
    paymentIntentId: uuid("payment_intent_id"),
    paymentAttemptId: uuid("payment_attempt_id"),
    invoiceId: uuid("invoice_id"),
    /**
     * Set only where no invoice exists to reach it through: a charge refused before a
     * reactivation or signup commits its invoice (0402). Read as
     * `coalesce(subscription_id, invoices.subscription_id)`.
     */
    subscriptionId: uuid("subscription_id"),
    paymentId: uuid("payment_id"),
    /** The payment request whose one charge this is (0388); `payment_id` is null then. */
    paymentRequestId: uuid("payment_request_id"),
    refundId: uuid("refund_id"),
    creditNoteId: uuid("credit_note_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    /**
     * When the row reached a TERMINAL status, whatever that status was. Distinct from
     * `settledAt`, which means cash moved and is therefore null on every failure — see
     * migration 0230 for the 6,659 rows whose timeline had no terminal entry because of
     * it. Null while `in_progress`, and also while `timeout`/`needs_attention`: those two
     * are reconcilable, so they are not finished.
     */
    finalisedAt: timestamp("finalised_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("transactions_public_id_uq").on(t.publicId),
    index("transactions_business_idx").on(t.businessId),
    // Keyset pagination for the transactions (money log) list.
    index("transactions_business_created_idx").on(
      t.businessId,
      t.createdAt.desc(),
      t.publicId.desc(),
    ),
    // Report windows (metrics/reports), which bound by occurred_at (0281).
    index("transactions_business_occurred_idx").on(t.businessId, t.occurredAt),
    index("transactions_customer_idx").on(t.customerId),
    index("transactions_invoice_idx").on(t.invoiceId),
    index("transactions_gateway_charge_idx").on(t.idAtGateway),
    index("transactions_lost_answer_ref_idx")
      .on(t.gatewayKey, t.ownershipRef)
      .where(sql`ownership_ref IS NOT NULL`),
    // Intent-level metrics (group by intent), and the money row inside an "Attempt N" card.
    index("transactions_payment_intent_idx").on(t.paymentIntentId),
    index("transactions_payment_attempt_idx").on(t.paymentAttemptId),
    index("transactions_payment_request_idx")
      .on(t.paymentRequestId)
      .where(sql`payment_request_id IS NOT NULL`),
  ],
);
