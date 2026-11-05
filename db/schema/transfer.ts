import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * H3 (TL-1) — Transfer Configuration job: copy catalog + coupons + tax rates +
 * settings from a source business to a destination (both directions). Records the
 * per-object report so `GET …/transfer_configurations/:job` can return it.
 * Wipe-first is honored only when the destination is a TEST business (live = merge
 * only, deliberately). Never copies customers/subs/invoices/creds/keys/webhooks.
 */
export const transferConfigurations = pgTable(
  "transfer_configurations",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceBusinessId: uuid("source_business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    destinationBusinessId: uuid("destination_business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    sections: jsonb("sections").notNull(), // string[]
    wipeDestination: boolean("wipe_destination").notNull().default(false),
    status: text("status").notNull().default("running"), // running | succeeded | failed
    report: jsonb("report"), // { <section>: { created, updated, skipped } }
    error: text("error"),
    // Set when the run wrote settings/company/email/tax into a LIVE destination (0358).
    liveOverride: boolean("live_override").notNull().default(false),
    planDigest: text("plan_digest"), // the preview the live override was bound to
    options: jsonb("options"), // { numbering?, include_test_twins? }
    // A test-twin job points at the live job it ran with.
    twinOf: uuid("twin_of").references((): AnyPgColumn => transferConfigurations.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("transfer_configurations_org_idx").on(t.organizationId, t.createdAt)],
);
