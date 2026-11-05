import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * Payment instructions printed on invoices.
 *
 * How a customer paying OFFLINE is told where to send the money — a bank block, a PayPal
 * handle. The merchant maintains a list, orders it, retires entries, and can narrow each
 * one to an invoice currency or a billing country.
 *
 * A table rather than another key in `businesses.invoice_customization` because these are
 * addressable rows a merchant edits individually; the two GLOBAL switches (send all vs.
 * only the customer's preferred method, and whether to personalise at all) do live in
 * that settings object, since those are single preferences.
 *
 * Business-scoped, tenant-isolated by org RLS — the same shape as
 * `custom_field_definitions`.
 */
export const paymentInstructions = pgTable(
  "payment_instructions",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // pinst_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /**
     * 'bank_transfer' | 'paypal' — the two rails today. Text rather than a pg enum so
     * adding a rail is a row's worth of change instead of a migration.
     */
    kind: text("kind").notNull(),
    sectionTitle: text("section_title").notNull(),
    /** The merchant's own reference for this block; opaque to us. */
    sectionId: text("section_id"),
    /**
     * PLAIN TEXT, deliberately: this is printed into a customer-facing PDF and HTML
     * view, and merchant-editable markup on that path is an injection surface — the
     * same call as the invoice note and the signature caption.
     */
    description: text("description"),
    /** Ordered label/value pairs: [{ label: 'IFSC', value: 'HDFC0000001' }, …]. */
    fields: jsonb("fields").notNull().default([]),
    /**
     * PERSONALISATION. Empty = applies to every invoice; a non-empty array narrows to
     * those ISO currency codes. Empty rather than null so "all" has one representation.
     */
    currencies: text("currencies").array().notNull().default([]),
    /** Same rule, on the customer's billing country (alpha-2). */
    countries: text("countries").array().notNull().default([]),
    position: integer("position").notNull().default(0),
    /**
     * Soft-delete. An archived instruction stops printing but stays readable, so an
     * invoice issued while it was live can still be explained.
     */
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("payment_instructions_public_id_uq").on(t.publicId),
    index("payment_instructions_biz_idx").on(t.businessId, t.position),
  ],
);
