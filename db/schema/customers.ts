import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  char,
  integer,
  bigint,
  jsonb,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { dunningPolicies } from "./dunning-policies";
import type { CustomerCreditSettings } from "./credits";

/**
 * A customer is the PAYER — belongs to exactly one business (businesses are
 * independent and don't share customers). Subscriptions, payment methods, and
 * invoices hang off a customer (Phase 1/2).
 */
export const customers = pgTable(
  "customers",
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
    publicId: text("public_id").notNull(), // cus_…
    email: text("email"),
    /**
     * ⚠️ DEPRECATED 2026-08-23 — NOT READ AND NOT WRITTEN by anything.
     *
     * Our own invention, and a mistake: a customer is named by
     * `first_name`/`last_name`/`company`.
     * Removed from every precedence chain (`modules/customers/names.ts`), from the SQL
     * mirror (`name-sql.ts`), from the create/update API (a request carrying `name`
     * now 400s) and from the importers. `GET /v1/customers` still emits a `name` key,
     * but it is DERIVED — `holderName()` — not this column.
     *
     * Kept rather than dropped so the rows that only ever had this value are not
     * destroyed; nothing depends on it, so dropping it later is a one-line migration.
     * Do not reintroduce a read: it is the column that let a customer print one name
     * on an invoice and show another in a list.
     */
    name: text("name"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    company: text("company"),
    phone: text("phone"),
    currency: char("currency", { length: 3 }), // preferred billing currency
    locale: text("locale"), // BCP-47-ish; drives portal/invoice/email language (CP-2)
    // Auto-collection (CP-1): 'on' = charge the vaulted PM when an invoice is created
    // (default, today's behavior); 'off' = leave the invoice open (send-invoice).
    autoCollection: text("auto_collection").notNull().default("on"), // on | off
    netTermDays: integer("net_term_days").notNull().default(0), // Net-D for send-invoice
    invoiceNotes: text("invoice_notes"), // default note stamped on this customer's invoices
    // Billing address — needed for tax, invoicing, and some providers' compliance
    // (e.g. India export regulations require name + address on cross-border charges).
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    addressLine3: text("address_line3"),
    city: text("city"),
    state: text("state"),
    stateCode: text("state_code"), // ISO-3166-2 subdivision code (tax resolution)
    postalCode: text("postal_code"),
    country: char("country", { length: 2 }), // ISO 3166-1 alpha-2
    // Structured billing-address contact sub-fields (CP-2).
    billingFirstName: text("billing_first_name"),
    billingLastName: text("billing_last_name"),
    billingCompany: text("billing_company"),
    billingPhone: text("billing_phone"),
    // Shipping address (CP-2) — same shape as billing, kept as one object.
    shippingAddress: jsonb("shipping_address"),
    // Tax status (Phase 10). tax_exempt short-circuits tax to 0 with reason
    // 'customer_exempt'; vat_number is the B2B/reverse-charge registration number.
    taxExempt: boolean("tax_exempt").notNull().default(false),
    // false = no automatic billing emails to this customer, whatever the business's
    // switches say. An operator's explicit "Email" action still sends.
    emailNotifications: boolean("email_notifications").notNull().default(true),
    // true = dunning never starts for this customer's invoices and running dunning makes no
    // attempt or reminder (0373). Time is frozen meanwhile: turning it off pushes every
    // remaining step of the invoices in dunning later by the exclusion's length.
    dunningExcluded: boolean("dunning_excluded").notNull().default(false),
    // When the current exclusion started (business clock); null while not excluded.
    dunningExcludedAt: timestamp("dunning_excluded_at", { withTimezone: true }),
    // Internal or test account (0482): metrics leave it out of every figure.
    excludeFromReporting: boolean("exclude_from_reporting").notNull().default(false),
    // Copies of this customer's document emails (0486).
    billingCcEmails: text("billing_cc_emails")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    billingBccEmails: text("billing_bcc_emails")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Named dunning policy (0386); null = the business dunning config.
    dunningPolicyId: uuid("dunning_policy_id").references(() => dunningPolicies.id, {
      onDelete: "restrict",
    }),
    vatNumber: text("vat_number"),
    // VAT/tax-id validation status (CUST-4). A TaxIdValidator (noop today, VIES
    // later) sets this; editing vat_number resets it to 'not_validated'.
    vatNumberStatus: text("vat_number_status").notNull().default("not_validated"), // not_validated | valid | invalid | undetermined
    vatValidatedAt: timestamp("vat_validated_at", { withTimezone: true }),
    // Per-customer calendar billing anchor (CUST-5): day-of-month a subscription's
    // billing aligns to when no sub-level anchor is given. mode 'using_defaults'
    // (anchor = subscription start) or 'manually_set' (use billing_date).
    billingDate: integer("billing_date"), // 1–31
    billingDateMode: text("billing_date_mode").notNull().default("using_defaults"), // using_defaults | manually_set
    // GDPR clear_personal_data (CUST-7): 'cleared' once PII has been scrubbed.
    piiCleared: text("pii_cleared"), // null (active) | 'cleared'
    // Withholding tax / TDS (Phase 10): the payer withholds this % of the net base
    // and remits it to the tax authority. Reduces what's collected; booked to a
    // withholding_receivable asset. 0 = none. Basis points (1000 = 10%).
    withholdingRateBps: integer("withholding_rate_bps").notNull().default(0),
    // How this customer is treated for tax within their region's regime. `default`
    // resolves normally from place of supply (India: CGST+SGST intra-state, IGST
    // inter-state). The others are the region-gated special treatments — a customer
    // may only be given one its `tax_regions.*_enabled` flag allows:
    //   sez_igst · sez_zero_rated · export_igst · export_zero_rated · reverse_charge
    // Zero-rated treatments tax at 0 with reason 'zero_rated'; reverse_charge with
    // reason 'reverse_charge'. Distinct from `tax_exempt`, which zero-rates
    // unconditionally regardless of region or regime.
    taxTreatment: text("tax_treatment").notNull().default("default"),
    // 0489: NULL = each price decides; set = every taxed line is inclusive or exclusive.
    taxBehavior: text("tax_behavior"), // inclusive | exclusive | null
    // The customer's OWN registration number (GSTIN for India), collected when the
    // region sets `collect_registration_number`. Distinct from `vat_number`, which is
    // the EU B2B/VIES-validated id with its own validation lifecycle.
    taxRegistrationNumber: text("tax_registration_number"),
    /** Marketing opt-in from checkout (0479). Null = never asked. */
    marketingOptIn: boolean("marketing_opt_in"),
    marketingOptInAt: timestamp("marketing_opt_in_at", { withTimezone: true }),
    metadata: jsonb("metadata"),
    // Custom-field values (SET-4) — DISTINCT from `metadata`: keyed by definition
    // `api_name`, typed + validated against custom_field_definitions on write.
    customFields: jsonb("custom_fields"),
    /** Credit policy override and overdraft limit (0464). NULL = the business's settings. */
    creditSettings: jsonb("credit_settings").$type<CustomerCreditSettings>(),
    active: boolean("active").notNull().default(true), // soft-archive flag
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    // Cross-cutting (CP-0): bumped by the shared bump_row_version() trigger on every UPDATE.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    // Bugs #11: public-id uniqueness is PER BUSINESS (matching the catalog tables;
    // an imported customer id is unique per source account, and the id-stable
    // importer maps one source account onto one business). Every lookup by
    // public_id must therefore also carry business_id: RLS scopes to the
    // ORGANIZATION, which may own several businesses.
    uniqueIndex("customers_biz_public_id_uq").on(t.businessId, t.publicId),
    index("customers_business_idx").on(t.businessId),
    index("customers_dunning_policy_idx")
      .on(t.dunningPolicyId)
      .where(sql`dunning_policy_id IS NOT NULL`),
    index("customers_email_idx").on(t.businessId, t.email),
    // Keyset pagination for the customers list: newest-first within a business,
    // with public_id as the tiebreak so the cursor is total-ordered. Matches the
    // ORDER BY in listCustomersPage() exactly — without this a 50k-customer
    // business sorts the whole partition on every page.
    index("customers_business_created_idx").on(t.businessId, t.createdAt.desc(), t.publicId.desc()),
    // Substring search (`ILIKE '%q%'`) on the six searched columns; needs pg_trgm (0348).
    index("customers_search_trgm_idx").using(
      "gin",
      sql`public_id gin_trgm_ops`,
      sql`email gin_trgm_ops`,
      sql`first_name gin_trgm_ops`,
      sql`last_name gin_trgm_ops`,
      sql`company gin_trgm_ops`,
      sql`phone gin_trgm_ops`,
    ),
  ],
);

/**
 * A customer's shipping address book (0360). At most one live row is the default;
 * `customers.shipping_address` mirrors it so older readers keep working. A
 * subscription may point at a row (`subscriptions.shipping_address_id`); otherwise it
 * ships to the default. Archived rows stay so old references still resolve.
 */
export const customerAddresses = pgTable(
  "customer_addresses",
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
    publicId: text("public_id").notNull(), // addr_…
    label: text("label"), // "Home", "Office"
    firstName: text("first_name"),
    lastName: text("last_name"),
    company: text("company"),
    phone: text("phone"),
    line1: text("line1"),
    line2: text("line2"),
    line3: text("line3"),
    city: text("city"),
    state: text("state"),
    stateCode: text("state_code"),
    postalCode: text("postal_code"),
    country: char("country", { length: 2 }),
    isDefault: boolean("is_default").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("customer_addresses_biz_public_id_uq").on(t.businessId, t.publicId),
    index("customer_addresses_customer_idx").on(t.customerId, t.createdAt),
    uniqueIndex("customer_addresses_one_default_uq")
      .on(t.customerId)
      .where(sql`is_default AND archived_at IS NULL`),
  ],
);

/**
 * Additional Contacts (CP-3) — team members on a customer who receive
 * invoice/payment/subscription emails.
 */
export const contacts = pgTable(
  "contacts",
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
    publicId: text("public_id").notNull(), // con_…
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email").notNull(),
    phone: text("phone"),
    label: text("label"),
    enabled: boolean("enabled").notNull().default(true),
    sendAccountEmail: boolean("send_account_email").notNull().default(false),
    sendBillingEmail: boolean("send_billing_email").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("contacts_public_id_uq").on(t.publicId),
    index("contacts_customer_idx").on(t.customerId),
  ],
);

export const PROMOTIONAL_CREDIT_TYPES = ["general", "referral_rewards", "loyalty_credits"] as const;
export type PromotionalCreditType = (typeof PROMOTIONAL_CREDIT_TYPES)[number];

/**
 * Caller annotations on a manual promotional-credit movement (0312). The money is the
 * ledger transaction this row points at; the row carries only `credit_type` + `reference`.
 */
export const promotionalCreditMovements = pgTable(
  "promotional_credit_movements",
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
    ledgerTransactionId: uuid("ledger_transaction_id").notNull(),
    creditType: text("credit_type").$type<PromotionalCreditType>().notNull().default("general"),
    reference: text("reference"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("promotional_credit_movements_txn_uq").on(t.ledgerTransactionId),
    index("promotional_credit_movements_customer_idx").on(t.customerId),
  ],
);
