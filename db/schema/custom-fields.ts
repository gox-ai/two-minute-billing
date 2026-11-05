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
 * Custom fields (SET-4) — a DISTINCT subsystem from `metadata`.
 * `metadata` is a free-form JSONB escape hatch; custom fields are admin-DEFINED,
 * typed fields configured per business (in Settings) that then appear as
 * first-class `cf_<api_name>` values on records and in the API.
 *
 * This table holds the DEFINITIONS. Values live in a dedicated `custom_fields`
 * JSONB column on each supporting entity (customers, subscriptions — v1), keyed
 * by `api_name`, validated + coerced against these definitions on every write.
 *
 * Business-scoped (like the catalog): a definition belongs to exactly one
 * business + entity type. Tenant-isolated by org RLS.
 */
export const customFieldDefinitions = pgTable(
  "custom_field_definitions",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // cfd_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    // Which entity this field attaches to. v1: 'customer' | 'subscription'.
    entityType: text("entity_type").notNull(),
    // The base key; exposed to the API as `cf_<api_name>`. Unique per (business, entity).
    apiName: text("api_name").notNull(),
    label: text("label").notNull(),
    // 'string' | 'number' | 'boolean' | 'date' | 'enum'.
    dataType: text("data_type").notNull(),
    // Allowed values when dataType='enum' (array of strings); null otherwise.
    enumOptions: jsonb("enum_options"),
    required: boolean("required").notNull().default(false),
    isPii: boolean("is_pii").notNull().default(false),
    showInPortal: boolean("show_in_portal").notNull().default(false),
    // Print this field on the invoice/credit-note document (0240). Reuses the
    // show_in_portal pattern rather than a fixed set of slots; at most
    // MAX_INVOICE_CUSTOM_FIELDS are rendered, ordered by `position`.
    showOnInvoice: boolean("show_on_invoice").notNull().default(false),
    position: integer("position").notNull().default(0), // display/column order
    // Soft-disable: archived definitions reject NEW values but existing values still read.
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("custom_field_defs_public_id_uq").on(t.publicId),
    uniqueIndex("custom_field_defs_scope_uq").on(t.businessId, t.entityType, t.apiName),
    index("custom_field_defs_biz_entity_idx").on(t.businessId, t.entityType),
  ],
);
