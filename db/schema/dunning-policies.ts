import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * A named dunning configuration (0386). `config` holds the FULL set of per-invoice dunning
 * keys (snake_case, as `businesses.dunning_config`), so what a customer runs is readable
 * from one row. Business-wide keys stay on the business.
 */
export const dunningPolicies = pgTable(
  "dunning_policies",
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
    publicId: text("public_id").notNull(), // dpol_…
    name: text("name").notNull(),
    code: text("code").notNull(),
    description: text("description"),
    config: jsonb("config").notNull(),
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
    uniqueIndex("dunning_policies_public_id_uq").on(t.publicId),
    uniqueIndex("dunning_policies_code_uq")
      .on(t.businessId, t.code)
      .where(sql`archived_at IS NULL`),
    index("dunning_policies_business_created_idx").on(
      t.businessId,
      t.createdAt.desc(),
      t.publicId.desc(),
    ),
  ],
);
