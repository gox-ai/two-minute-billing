import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  char,
  bigint,
  integer,
  timestamp,
  uniqueIndex,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { subscriptions } from "./subscriptions";
import { invoices } from "./invoices";
import { prices } from "./catalog";

/**
 * A one-time charge queued against a subscription to be folded into its NEXT
 * renewal invoice (vs. invoiced immediately) — a deferred ad-hoc charge (§4).
 * `billSubscriptionPeriod` pulls pending rows in, adds them as line items, and
 * marks them billed.
 *
 * Subscription-scoped by design (`subscriptionId` is NOT NULL): deferring needs a
 * future invoice to defer TO, and only a subscription has one. A customer-level
 * charge always invoices.
 */
export const unbilledCharges = pgTable(
  "unbilled_charges",
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
    publicId: text("public_id").notNull(), // uch_…
    description: text("description").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    status: text("status").notNull().default("pending"), // pending | billed | voided
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    /**
     * Service period — the span the charge covers, for revenue recognition.
     * Carried onto the invoice line when the charge is billed.
     */
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    /**
     * The catalog Charge price this came from, when it was picked rather than
     * typed. Previously absent, so a catalog-picked charge lost all trace of its
     * origin the moment it was created.
     */
    priceId: uuid("price_id").references(() => prices.id, { onDelete: "set null" }),
    quantity: integer("quantity").notNull().default(1),
    /** adhoc (typed) | charge_item_price (from the catalog) | usage_settlement | commitment. */
    entityType: text("entity_type").notNull().default("adhoc"),
    /** 0454: a meter settlement's line rating, copied onto the invoice line that bills it. */
    rating: jsonb("rating"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("unbilled_charges_public_id_uq").on(t.publicId),
    index("unbilled_charges_sub_idx").on(t.subscriptionId, t.status),
    // One early-end commitment true-up per term (0385).
    uniqueIndex("unbilled_charges_commitment_uq")
      .on(t.subscriptionId, t.periodStart)
      .where(sql`entity_type = 'commitment' AND status <> 'voided'`),
  ],
);
