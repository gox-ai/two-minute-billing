import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  uniqueIndex,
  index,
  boolean,
  bigint,
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
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
    /** The file import that created the target (0550). Undo deletes only these. */
    runId: uuid("run_id").references((): AnyPgColumn => importRuns.id, { onDelete: "set null" }),
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

/**
 * A bulk import from files (0550): uploaded → checking → checked → queued → running →
 * succeeded | partially_failed | failed, then undoing → undone. `files` holds each file's
 * entity, name, headers and column mapping; `summary` is the check's review; `result` the run's.
 */
export const importRuns = pgTable(
  "import_runs",
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
    status: text("status").notNull().default("uploaded"),
    /** The `import_records.source` this run writes under: one per business. */
    sourceName: text("source_name").notNull(),
    files: jsonb("files")
      .notNull()
      .default(sql`'[]'::jsonb`),
    options: jsonb("options")
      .notNull()
      .default(sql`'{}'::jsonb`),
    summary: jsonb("summary"),
    result: jsonb("result"),
    error: text("error"),
    createdBy: text("created_by"),
    createdByUserId: uuid("created_by_user_id"),
    startedBy: text("started_by"),
    startedByUserId: uuid("started_by_user_id"),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    undoneBy: text("undone_by"),
    undoneByUserId: uuid("undone_by_user_id"),
    undoNotifiedAt: timestamp("undo_notified_at", { withTimezone: true }),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseCount: integer("lease_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("import_runs_business_idx").on(t.businessId, t.createdAt)],
);

/** One row of an uploaded file: raw cells, parsed values, errors, and what the run did. */
export const importRows = pgTable(
  "import_rows",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => importRuns.id, { onDelete: "cascade" }),
    entity: text("entity").notNull(),
    /** 1-based data row in the file (the header is row 0). */
    rowNumber: integer("row_number").notNull(),
    sourceId: text("source_id"),
    raw: jsonb("raw").notNull(),
    parsed: jsonb("parsed"),
    errors: jsonb("errors")
      .notNull()
      .default(sql`'[]'::jsonb`),
    warnings: jsonb("warnings")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** At check: new | existing | invalid | excluded. */
    state: text("state"),
    /** After the run: created | unchanged | failed | excluded. */
    outcome: text("outcome"),
    outcomeMessage: text("outcome_message"),
    targetId: uuid("target_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("import_rows_run_row_uq").on(t.runId, t.entity, t.rowNumber),
    index("import_rows_run_source_idx").on(t.runId, t.entity, t.sourceId),
  ],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** A bulk export (0552): the record types and filters asked for, and the files it wrote. */
export const exportRuns = pgTable(
  "export_runs",
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
    /** queued → running → succeeded | failed; succeeded → expired | deleted. */
    status: text("status").notNull().default("queued"),
    entities: jsonb("entities")
      .notNull()
      .default(sql`'[]'::jsonb`),
    filters: jsonb("filters")
      .notNull()
      .default(sql`'{}'::jsonb`),
    includeRelated: boolean("include_related").notNull().default(true),
    files: jsonb("files")
      .notNull()
      .default(sql`'[]'::jsonb`),
    skipped: jsonb("skipped")
      .notNull()
      .default(sql`'[]'::jsonb`),
    progress: jsonb("progress"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    error: text("error"),
    createdBy: text("created_by"),
    createdByUserId: uuid("created_by_user_id"),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: text("deleted_by"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseCount: integer("lease_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("export_runs_business_idx").on(t.businessId, t.createdAt)],
);

/** One deflate-compressed part (up to 8 MB) of one file of an export, in order. */
export const exportParts = pgTable(
  "export_parts",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => exportRuns.id, { onDelete: "cascade" }),
    entity: text("entity").notNull(),
    seq: integer("seq").notNull(),
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("export_parts_run_seq_uq").on(t.runId, t.entity, t.seq)],
);
