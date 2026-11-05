import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  jsonb,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, businesses } from "./tenancy";

/**
 * One business's HubSpot portal. At most one row per business; a disconnect keeps the row
 * (status `disconnected`, tokens cleared) so links and history survive a reconnect.
 */
export const hubspotConnections = pgTable(
  "hubspot_connections",
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
    publicId: text("public_id").notNull(), // hsc_…
    portalId: text("portal_id").notNull(),
    hubDomain: text("hub_domain"),
    /** The HubSpot user who approved the install. */
    installedBy: text("installed_by"),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** `v1:` envelopes from `platform/secrets`. Null once disconnected. */
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    /** active | reauth_required | disconnected */
    status: text("status").notNull().default("active"),
    autosync: boolean("autosync").notNull().default(true),
    /** Sync preferences; shape owned by `modules/hubspot/settings.ts`. */
    settings: jsonb("settings").notNull().default({}),
    /** Overridable per row so a sandbox or a verify suite can stand in for HubSpot. */
    apiBase: text("api_base").notNull(),
    /** pending | running | done — the full sweep that follows a connect. */
    initialSync: text("initial_sync").notNull().default("pending"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    /** Pull watermarks: the next search reads records modified after these. Null → `connected_at`. */
    contactsWatermark: timestamp("contacts_watermark", { withTimezone: true }),
    companiesWatermark: timestamp("companies_watermark", { withTimezone: true }),
    dealsWatermark: timestamp("deals_watermark", { withTimezone: true }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow().notNull(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("hubspot_connections_public_id_uq").on(t.publicId),
    uniqueIndex("hubspot_connections_business_uq").on(t.businessId),
    index("hubspot_connections_status_idx").on(t.status),
  ],
);

/**
 * Which of our records is which HubSpot record. Many customers may share one company, so
 * the remote side is indexed, not unique.
 */
export const hubspotLinks = pgTable(
  "hubspot_links",
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
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => hubspotConnections.id, { onDelete: "cascade" }),
    /** customer | subscription | product */
    localType: text("local_type").notNull(),
    localId: uuid("local_id").notNull(),
    /** contact | company | deal | product */
    remoteType: text("remote_type").notNull(),
    remoteId: text("remote_id").notNull(),
    /** Hash of the properties last written, so an unchanged record costs no API call. */
    lastPushedHash: text("last_pushed_hash"),
    lastPushedAt: timestamp("last_pushed_at", { withTimezone: true }),
    lastPulledAt: timestamp("last_pulled_at", { withTimezone: true }),
    remoteUpdatedAt: timestamp("remote_updated_at", { withTimezone: true }),
    /** HubSpot's values for the pulled properties as last seen, so a pull knows which ones moved. */
    remoteValues: jsonb("remote_values").$type<Record<string, string | null>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("hubspot_links_local_uq").on(t.connectionId, t.localType, t.localId, t.remoteType),
    index("hubspot_links_remote_idx").on(t.connectionId, t.remoteType, t.remoteId),
  ],
);

/**
 * Records waiting to be pushed, written in the emitting transaction by the event sink
 * (outbox). A record appears at most once while unclaimed, so a burst of events on one
 * customer is one push.
 */
export const hubspotSyncQueue = pgTable(
  "hubspot_sync_queue",
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
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => hubspotConnections.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    /** The event type that queued it; the latest one wins on coalesce. */
    reason: text("reason"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("hubspot_sync_queue_pending_uq")
      .on(t.connectionId, t.resourceType, t.resourceId)
      .where(sql`locked_at IS NULL`),
    index("hubspot_sync_queue_due_idx").on(t.connectionId, t.nextAttemptAt),
  ],
);

/** One pass of the sync engine: what triggered it and what it did. */
export const hubspotSyncRuns = pgTable(
  "hubspot_sync_runs",
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
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => hubspotConnections.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // hsr_…
    /** event | autosync | manual | initial */
    trigger: text("trigger").notNull(),
    /** running | succeeded | partial | failed | interrupted (worker stopped mid-run) */
    status: text("status").notNull().default("running"),
    created: integer("created").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("hubspot_sync_runs_public_id_uq").on(t.publicId),
    index("hubspot_sync_runs_connection_started_idx").on(t.connectionId, t.startedAt, t.publicId),
  ],
);

/** The sync log: one line per record a run touched. Append-only. */
export const hubspotSyncItems = pgTable(
  "hubspot_sync_items",
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
    runId: uuid("run_id")
      .notNull()
      .references(() => hubspotSyncRuns.id, { onDelete: "cascade" }),
    localType: text("local_type").notNull(),
    /** The public id (cus_…), so the log reads without a join. */
    localRef: text("local_ref"),
    remoteType: text("remote_type"),
    remoteId: text("remote_id"),
    /** created | updated | skipped | failed */
    action: text("action").notNull(),
    message: text("message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("hubspot_sync_items_run_idx").on(t.runId, t.createdAt)],
);

/** One field that differs in a conflict: our value and HubSpot's, both as HubSpot strings. */
export interface HubSpotConflictField {
  local: string;
  remote: string;
  label: string;
  ours: string | null;
  theirs: string | null;
}

/**
 * A linked record changed on both sides since the last sync, under the `flag` rule. While open,
 * neither direction syncs that record.
 */
export const hubspotConflicts = pgTable(
  "hubspot_conflicts",
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
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => hubspotConnections.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // hscf_…
    /** customer | subscription */
    localType: text("local_type").notNull(),
    localId: uuid("local_id").notNull(),
    localRef: text("local_ref"),
    /** contact | company | deal */
    remoteType: text("remote_type").notNull(),
    remoteId: text("remote_id").notNull(),
    fields: jsonb("fields").$type<HubSpotConflictField[]>().notNull().default([]),
    remoteUpdatedAt: timestamp("remote_updated_at", { withTimezone: true }),
    /** open | resolved */
    status: text("status").notNull().default("open"),
    /** ours | theirs */
    resolution: text("resolution"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("hubspot_conflicts_public_id_uq").on(t.publicId),
    uniqueIndex("hubspot_conflicts_open_uq")
      .on(t.connectionId, t.localType, t.localId, t.remoteType)
      .where(sql`status = 'open'`),
    index("hubspot_conflicts_list_idx").on(t.connectionId, t.status, t.createdAt, t.publicId),
  ],
);
