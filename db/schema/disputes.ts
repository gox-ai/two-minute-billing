import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  bigint,
  char,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./tenancy";

/**
 * Disputes / chargebacks. One row per gateway dispute, driven by
 * normalized provider webhooks (dispute.created/funds_withdrawn/funds_reinstated/
 * won/lost/closed). The disputes SERVICE owns the money side: funds_withdrawn posts
 * dr disputed_funds / cr cash (the network clawed the cash back), reversed on
 * won/funds_reinstated, or realized to dispute_losses on lost.
 *
 * `provider_dispute_id` is the idempotency anchor (webhook replays upsert the same
 * row). Correlated to a payment/invoice/customer via the disputed charge when known.
 */
export const disputes = pgTable(
  "disputes",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // dsp_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id"),
    customerId: uuid("customer_id"),
    paymentId: uuid("payment_id"),
    invoiceId: uuid("invoice_id"),
    providerKey: text("provider_key").notNull(), // stripe | razorpay | paypal | tmtest
    providerDisputeId: text("provider_dispute_id").notNull(),
    providerChargeId: text("provider_charge_id"),
    // Lifecycle: needs_response | under_review | won | lost | closed.
    status: text("status").notNull().default("needs_response"),
    reason: text("reason"),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    // Whether the funds_withdrawn ledger clawback has been posted (idempotency for
    // the money side, independent of status transitions).
    fundsWithdrawn: text("funds_withdrawn").notNull().default("false"), // 'true' | 'false'
    evidenceDueBy: timestamp("evidence_due_by", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // `gateway` (a dispute webhook) | `operator` (recorded by hand, 0394). An operator row's
    // `provider_dispute_id` is its own public id: the gateway never named the case.
    source: text("source").notNull().default("gateway"),
    // The processor's case number, as the operator entered it. Null on gateway rows.
    processorReference: text("processor_reference"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("disputes_public_id_uq").on(t.publicId),
    uniqueIndex("disputes_provider_dispute_uq").on(t.organizationId, t.providerDisputeId),
    index("disputes_org_idx").on(t.organizationId),
    index("disputes_biz_created_idx").on(t.businessId, t.createdAt),
    index("disputes_status_idx").on(t.status),
    index("disputes_payment_idx")
      .on(t.paymentId)
      .where(sql`payment_id IS NOT NULL`),
  ],
);
