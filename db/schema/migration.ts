import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * Maps an external object to the tmbilling object it was imported as.
 * The unique (organization, source, source_type, source_id) makes
 * re-running an import idempotent — already-imported objects are skipped, never
 * duplicated (and never re-charged).
 */
export const importRecords = pgTable(
  "import_records",
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
    source: text("source").notNull(), // the source system's id, e.g. "stripe"
    sourceType: text("source_type").notNull(), // plan | customer | subscription
    sourceId: text("source_id").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("import_records_uq").on(t.organizationId, t.source, t.sourceType, t.sourceId),
    index("import_records_business_idx").on(t.businessId),
  ],
);

/**
 * Raw events imported from an external billing system, archived read-only.
 * The source's event history can't be regenerated once that account is retired, so
 * we keep the payload verbatim. Our own event log starts fresh at import time.
 */
export const importedEvents = pgTable(
  "imported_events",
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
    publicId: text("public_id").notNull(), // ievt_…
    source: text("source").notNull(), // the source system's id, e.g. "stripe"
    sourceId: text("source_id").notNull(), // the source's event id
    eventType: text("event_type").notNull(), // source's own taxonomy, verbatim
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").notNull(), // raw source event JSON
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("imported_events_public_id_uq").on(t.publicId),
    uniqueIndex("imported_events_uq").on(t.organizationId, t.source, t.sourceId),
    index("imported_events_business_time_idx").on(t.businessId, t.occurredAt),
  ],
);
