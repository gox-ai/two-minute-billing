import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  bigint,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { subscriptions } from "./subscriptions";
import { invoices } from "./invoices";

/**
 * A change held until its invoice is paid (`failed_change_charge: apply_when_paid`, 0531).
 * The invoice is raised and collected at the request; the change applies only when it is paid,
 * priced as of `requested_at`. One `pending` row per subscription.
 */
export const subscriptionPendingChanges = pgTable(
  "subscription_pending_changes",
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
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // spc_…
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    kind: text("kind").$type<"change" | "item_add">().notNull(),
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    requestHash: text("request_hash").notNull(),
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
    fingerprint: text("fingerprint").notNull(),
    /** Public ids of the credit notes the change raised at the request. */
    creditNoteIds: jsonb("credit_note_ids").$type<string[]>().notNull().default([]),
    restore: jsonb("restore").$type<Record<string, unknown> | null>(),
    source: text("source")
      .$type<"api" | "dashboard" | "checkout" | "portal">()
      .notNull()
      .default("api"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status")
      .$type<"pending" | "applied" | "expired" | "cancelled">()
      .notNull()
      .default("pending"),
    endReason: text("end_reason").$type<
      "expired" | "replaced" | "cancelled" | "voided" | "moved" | null
    >(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Paid, but the change could not apply: the credit note that gave the money back. */
    keptCreditNote: text("kept_credit_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("subscription_pending_changes_public_id_uq").on(t.publicId),
    uniqueIndex("subscription_pending_changes_live_uq")
      .on(t.subscriptionId)
      .where(sql`status = 'pending'`),
    uniqueIndex("subscription_pending_changes_invoice_uq").on(t.invoiceId),
    index("subscription_pending_changes_due_idx")
      .on(t.expiresAt)
      .where(sql`status = 'pending'`),
  ],
);
