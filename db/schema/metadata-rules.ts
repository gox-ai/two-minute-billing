import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  doublePrecision,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * Metadata key rules (0332): rules for dot paths in the free-form `metadata` of a customer or
 * subscription, each with a type and optional limits. Every path is optional: a rule checks a
 * value only when it is present.
 *
 * Not to be confused with custom fields (`custom-fields.ts`): those are typed values in their
 * own `custom_fields` column. These rules only CHECK the caller's raw `metadata` JSON on write;
 * nothing is coerced or rewritten. Business-scoped, tenant-isolated by org RLS.
 */
export const metadataKeyRules = pgTable(
  "metadata_key_rules",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // mkr_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    // 'customer' | 'subscription'.
    entityType: text("entity_type").notNull(),
    // A dot path into metadata, e.g. `billing.po`. Immutable after create.
    key: text("key").notNull(),
    // 'string' | 'number' | 'boolean' | 'date' | 'email' | 'enum' | 'object' | 'array'. Immutable.
    dataType: text("data_type").notNull(),
    enumOptions: jsonb("enum_options"), // string[] when dataType = 'enum'
    pattern: text("pattern"), // regex for string-like values
    maxLength: integer("max_length"),
    // number rules (0333): whole numbers only, and inclusive bounds.
    integerOnly: boolean("integer_only").notNull().default(false),
    minValue: doublePrecision("min_value"),
    maxValue: doublePrecision("max_value"),
    // array rules (0333): each item's type and allowed values, and the item count.
    itemType: text("item_type"), // 'string' | 'number' | 'boolean'
    itemEnumOptions: jsonb("item_enum_options"), // string[]
    minItems: integer("min_items"),
    maxItems: integer("max_items"),
    description: text("description"),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("metadata_key_rules_public_id_uq").on(t.publicId),
    uniqueIndex("metadata_key_rules_scope_uq").on(t.businessId, t.entityType, t.key),
  ],
);
