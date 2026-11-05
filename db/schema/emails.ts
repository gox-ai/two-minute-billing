import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./tenancy";
import { events } from "./platform";
import { invoices } from "./invoices";
import { creditNotes } from "./credit-notes";

/**
 * Customer-facing billing emails, as an outbox (mirrors `webhookDeliveries`):
 * one row per (billing event → recipient) message. `enqueueEmails` (an event
 * sink) renders + inserts a `pending` row in the same tx as the source event;
 * `deliverPendingEmails` sends it via the configured mailer adapter on the
 * billing-clock tick, with retry/backoff. The row is the record of truth — the
 * `console` dev sink only logs, so the table is what the dashboard/tests read.
 *
 * `businessId` / `customerId` are plain uuids (not FKs), mirroring `events`, so
 * message history survives object hard-deletes and avoids FK ordering coupling.
 */
export const emailMessages = pgTable(
  "email_messages",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // em_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id"),
    customerId: uuid("customer_id"),
    // The billing event that triggered this email (nullable: resends / ad-hoc).
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    // The invoice this message is ABOUT, when it is about one — set at enqueue so delivery
    // can render and attach its PDF. NULL for every email with no document behind it:
    // trials, lifecycle, card expiry. The invoice number reaches the template as a
    // rendered string; that is not a link back to the document, which is why this
    // column exists (0211).
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    /**
     * What the provider told us about this message AFTER accepting it —
     * `permanent | transient | undetermined | complaint` (0212). Distinct from `last_error`,
     * which records why an ATTEMPT failed: this is feedback about a send that succeeded.
     * NULL is the normal state for almost every row.
     */
    bounceType: text("bounce_type"),
    /**
     * The credit note this message is about, when it is about one (0213). Mutually exclusive
     * with `invoiceId` — `email_messages_one_document_ck` enforces it, because a message
     * about two documents makes "which PDF do we attach?" ambiguous.
     */
    creditNoteId: uuid("credit_note_id").references(() => creditNotes.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(), // invoice_issued | payment_receipt | payment_failed | dunning_retry | subscription_canceled_nonpayment
    toAddress: text("to_address").notNull(),
    // Additional contacts copied (0301), captured at enqueue like to_address.
    ccAddresses: text("cc_addresses")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // The customer's BCC list (0486), captured at enqueue. Never shown to the recipient.
    bccAddresses: text("bcc_addresses")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html").notNull(),
    bodyText: text("body_text").notNull(),
    status: text("status").notNull().default("pending"),
    // pending | sent | failed | bounced | skipped. Plain text, no CHECK — `bounced` was
    // added without a migration. `failed` = retries exhausted on an inconclusive error;
    // `bounced` = the relay permanently refused (5xx), terminal on the first attempt.
    // WHICH transport carried this message — console | smtp | esp. `status: 'sent'` alone
    // is not a delivery claim: the console dev sink logs the mail and then marks the row
    // sent, so a deployment left on the default reports 100% delivery while nothing
    // leaves the building. Recording the transport is what lets the log say "written to
    // the dev sink" instead of "sent". NULL on rows written before this column existed —
    // their transport is genuinely unknown, and defaulting them to 'console' would be a
    // guess that reads as a fact.
    transport: text("transport"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    providerMessageId: text("provider_message_id"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /**
     * Wall-clock ms of the LAST send attempt (0249), attachment build INCLUDED — a PDF
     * render is our own work, but the pass waits on it just the same, so excluding it would
     * understate exactly the number egress concurrency is sized from.
     *
     * Distinct from `sent_at - created_at`, which measures how long the message WAITED and is
     * a property of the queue: that read is p50 29s / p95 10.3h today, and neither figure
     * says anything about how long a send takes. NULL on rows predating the column.
     */
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** When the retention sweep removed the body (D17); the email cannot be resent after. */
    bodyRemovedAt: timestamp("body_removed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("email_messages_public_id_uq").on(t.publicId),
    index("email_messages_org_idx").on(t.organizationId),
    index("email_messages_biz_created_idx").on(t.businessId, t.createdAt),
    index("email_messages_customer_idx").on(t.customerId),
    index("email_messages_status_idx").on(t.status, t.nextAttemptAt),
  ],
);

/**
 * Per-business overrides of the built-in billing-email templates.
 *
 * SPARSE ON PURPOSE: a row exists only for a type a merchant has actually edited.
 * Everything else renders from DEFAULT_TEMPLATES in src/modules/emails/templates.ts, so
 * an empty table behaves exactly as the code did before this table existed, and improving
 * a built-in still reaches every business that never customised it. Seeding all five rows
 * per business on creation would have frozen each one at its creation-day wording.
 *
 * "Reset to default" is therefore a DELETE, not a rewrite — which is also why there is no
 * is_customised flag: the row's existence is the flag.
 *
 * Only subject / heading / body are stored. The HTML shell is not overridable (see
 * renderEmail): free-form markup with no sanitiser is an injection surface pointed at the
 * merchant's own customers.
 */
export const emailTemplates = pgTable(
  "email_templates",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // et_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id").notNull(),
    type: text("type").notNull(), // one of EMAIL_TYPES
    subject: text("subject").notNull(),
    heading: text("heading").notNull(),
    body: text("body").notNull(),
    // Layout (0301). Null / default = the built-in shape; a null footer uses the business's.
    footer: text("footer"),
    ctaLabel: text("cta_label"),
    showFacts: boolean("show_facts").notNull().default(true),
    blockOrder: text("block_order").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("email_templates_public_id_uq").on(t.publicId),
    // One override per (business, type) — the lookup key on every render.
    uniqueIndex("email_templates_biz_type_uq").on(t.businessId, t.type),
    index("email_templates_org_idx").on(t.organizationId),
  ],
);

/**
 * Addresses this business must not write to again — the asynchronous half of delivery
 * feedback (0212).
 *
 * A hard bounce or a spam complaint arrives over SNS minutes to hours AFTER the send
 * returned a message id, so nothing in the send path can see it. Continuing to mail a dead
 * address is what destroys a sending reputation: SES publishes a bounce rate and pauses
 * accounts that exceed it, so one stale customer list can suspend the whole account.
 *
 * Scoped per BUSINESS: two businesses in one org have separate customer relationships and
 * separate sending identities, and a bounce from one says nothing about the other.
 * `lower(address)` is unique per business — see the migration for why case-insensitivity is
 * a correctness property here rather than a convenience.
 */
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id").notNull(),
    address: text("address").notNull(),
    /** bounce | complaint | manual. */
    reason: text("reason").notNull(),
    /** The provider's own words (bounceSubType, complaintFeedbackType), kept verbatim. */
    detail: text("detail"),
    /** The message that triggered it, when one could be correlated. */
    sourceEmailId: uuid("source_email_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("email_suppressions_org_idx").on(t.organizationId)],
);
