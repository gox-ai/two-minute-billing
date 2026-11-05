import {
  pgTable,
  uuid,
  text,
  char,
  bigint,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, businesses } from "./tenancy";
import { invoices, invoiceLineItems } from "./invoices";

/**
 * A tax profile groups the rates that apply to one CLASS of product. A business
 * selling goods at 18% GST and books at 5% configures two profiles and assigns each
 * to the relevant products (`products.tax_profile_id`).
 * Exactly one profile per business carries `isDefault` — products with no explicit
 * profile resolve to it, so a single-rate business never has to think about profiles.
 * The "exactly one" is a partial unique index, hand-written in the RLS migration.
 */
export const taxProfiles = pgTable(
  "tax_profiles",
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
    publicId: text("public_id").notNull(), // txp_…
    name: text("name").notNull(), // e.g. 'Primary', 'Reduced rate'
    isDefault: boolean("is_default").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("tax_profiles_public_id_uq").on(t.publicId),
    uniqueIndex("tax_profiles_name_uq").on(t.businessId, t.name),
    index("tax_profiles_business_idx").on(t.businessId),
  ],
);

/**
 * A taxable region: one country, under one tax profile. Holds everything decided per
 * country rather than per rate — the regime (which decides whether place-of-supply
 * splitting applies at all), whether catalog prices in this country are tax-inclusive,
 * the seller's own registration, and the country-specific treatments a customer in
 * this region may be assigned.
 *
 * `homeStateCode` is the SELLER's place of supply and is what makes India's
 * intra-state (CGST+SGST) vs inter-state (IGST) decision possible. It is snapshotted
 * onto every invoice (`invoices.seller_state_code`) so the decision stays reproducible
 * after the seller's own registration moves.
 */
export const taxRegions = pgTable(
  "tax_regions",
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
    taxProfileId: uuid("tax_profile_id")
      .notNull()
      .references(() => taxProfiles.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // txg_…
    country: char("country", { length: 2 }).notNull(), // ISO 3166-1 alpha-2
    /**
     * Tax regime. `gst` is the only one that splits by place of supply (intra vs
     * inter state); `vat` / `sales_tax` / `flat` resolve their components
     * unconditionally. Enum-as-text, validated in Zod.
     */
    regime: text("regime").notNull().default("flat"), // gst | vat | sales_tax | flat
    /** Are catalog prices in this country tax-inclusive? Overrides the price's own default. */
    priceType: text("price_type").notNull().default("exclusive"), // exclusive | inclusive
    /** The seller's own state — the origin of supply. ISO-3166-2 subdivision code. */
    homeStateCode: text("home_state_code"),
    /** How the seller's registration is LABELLED on invoices, e.g. 'GSTIN', 'VAT #'. */
    registrationLabel: text("registration_label"), // gstin | vat | gst | tax_reg | abn
    registrationNumber: text("registration_number"),
    /** Ask customers in this region for their own registration number. */
    collectRegistrationNumber: boolean("collect_registration_number").notNull().default(false),
    /**
     * Reverse charge: liability moves to the buyer, so we zero-rate the line and
     * print `reverseChargeNote` on the invoice. The note is only rendered when
     * `showReverseChargeNote` is on — enabling the treatment and printing the note are
     * two separate switches.
     */
    reverseChargeEnabled: boolean("reverse_charge_enabled").notNull().default(false),
    showReverseChargeNote: boolean("show_reverse_charge_note").notNull().default(false),
    reverseChargeNote: text("reverse_charge_note"),
    /**
     * Which special treatments a customer in this region may be given, and the
     * invoice note each one prints. These GATE the choice — they compute nothing on
     * their own; `customers.tax_treatment` is what actually selects one.
     */
    sezIgstEnabled: boolean("sez_igst_enabled").notNull().default(false),
    sezIgstNote: text("sez_igst_note"),
    sezZeroRatedEnabled: boolean("sez_zero_rated_enabled").notNull().default(false),
    sezZeroRatedNote: text("sez_zero_rated_note"),
    exportIgstEnabled: boolean("export_igst_enabled").notNull().default(false),
    exportIgstNote: text("export_igst_note"),
    exportZeroRatedEnabled: boolean("export_zero_rated_enabled").notNull().default(false),
    exportZeroRatedNote: text("export_zero_rated_note"),
    enabled: boolean("enabled").notNull().default(true),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("tax_regions_public_id_uq").on(t.publicId),
    // One region per country per profile — two would make resolution ambiguous.
    uniqueIndex("tax_regions_profile_country_uq").on(t.taxProfileId, t.country),
    index("tax_regions_lookup_idx").on(t.businessId, t.country),
  ],
);

/**
 * One tax COMPONENT of a region's rate — the row that generalizes a single scalar
 * rate into India's CGST + SGST/UTGST + Cess vector. An invoice line's tax is the sum
 * of the components that apply to it, and each component becomes its own
 * `applied_taxes` row so the invoice can print the breakdown a GST invoice requires.
 *
 * `appliesTo` is the place-of-supply predicate:
 *   - `intra` — seller state === customer state (CGST, SGST/UTGST)
 *   - `inter` — different states, or an IGST-treated SEZ/export customer (IGST)
 *   - `both`  — unconditional (Cess; every VAT/sales-tax component)
 *
 * `stateCode` null = the region's default vector. A non-null `stateCode` OVERRIDES the
 * default vector for customers whose place of supply is that state.
 */
export const taxRateComponents = pgTable(
  "tax_rate_components",
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
    taxRegionId: uuid("tax_region_id")
      .notNull()
      .references(() => taxRegions.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // txc_…
    /** null = region default vector; set = per-state override vector. */
    stateCode: text("state_code"),
    name: text("name").notNull(), // 'CGST' | 'SGST/UTGST' | 'IGST' | 'Cess' | 'VAT'
    rateBps: integer("rate_bps").notNull(), // basis points — 900 = 9%
    appliesTo: text("applies_to").notNull().default("both"), // intra | inter | both
    /** Print order on the invoice; ties break by name for determinism. */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("tax_rate_components_public_id_uq").on(t.publicId),
    index("tax_rate_components_region_idx").on(t.taxRegionId, t.stateCode),
    // One component per name per state scope. A region's vector is CGST + SGST/UTGST
    // + Cess — each named once. Declared as an expression index in migration 0147
    // (NULLs are distinct in a plain unique index, which would let country-wide
    // duplicates back in); repeated here so the constraint is visible in the schema.
    uniqueIndex("tax_rate_components_region_state_name_uq").on(
      t.taxRegionId,
      sql`coalesce(state_code, '')`,
      t.name,
    ),
  ],
);

/**
 * The seller's registration in ONE state of a region — India requires a separate GSTIN
 * per state you have a place of business in, and the GSTIN of the supplying state is
 * what must appear on the invoice. Distinct from `tax_rate_components.stateCode`,
 * which overrides RATES: a state can have a registration without overriding any rate.
 */
export const taxStateRegistrations = pgTable(
  "tax_state_registrations",
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
    taxRegionId: uuid("tax_region_id")
      .notNull()
      .references(() => taxRegions.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // txs_…
    stateCode: text("state_code").notNull(), // ISO-3166-2 subdivision code, e.g. 'TN'
    stateName: text("state_name"), // display label, e.g. 'Tamil Nadu'
    registrationNumber: text("registration_number"), // the state's GSTIN
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("tax_state_registrations_public_id_uq").on(t.publicId),
    uniqueIndex("tax_state_registrations_state_uq").on(t.taxRegionId, t.stateCode),
    index("tax_state_registrations_region_idx").on(t.taxRegionId),
  ],
);

/**
 * Per-line tax breakdown (Phase 10). One row per tax
 * COMPONENT per invoice line: the invoice's tax is the SUM of these rows, and an India
 * GST line yields two rows (CGST + SGST) or one (IGST). `name`/`rateBps` are
 * SNAPSHOTTED at compute time (immutable to later rate edits); `taxComponentId` is
 * nullable (`SET NULL` on delete) so historical invoices survive rate archival.
 * `taxabilityReason` explains a zero-rate line — `customer_exempt` · `product_exempt` ·
 * `zero_rated` (SEZ/export) · `reverse_charge` · `standard_rated`.
 * Withholding is just another row.
 */
export const appliedTaxes = pgTable(
  "applied_taxes",
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
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    invoiceLineItemId: uuid("invoice_line_item_id")
      .notNull()
      .references(() => invoiceLineItems.id, { onDelete: "cascade" }),
    taxComponentId: uuid("tax_component_id").references(() => taxRateComponents.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(), // snapshot, e.g. 'CGST'
    rateBps: integer("rate_bps").notNull(), // snapshot
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    taxabilityReason: text("taxability_reason").notNull().default("standard_rated"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    index("applied_taxes_invoice_idx").on(t.invoiceId),
    index("applied_taxes_line_idx").on(t.invoiceLineItemId),
  ],
);
