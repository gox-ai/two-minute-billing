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
import { sql } from "drizzle-orm";
import { organizations, businesses } from "./tenancy";
import { events } from "./platform";

/**
 * One business's connection to a PUSH integration (`modules/integrations`). At most one row per
 * business and provider; a disconnect keeps the row (credentials cleared) so its delivery
 * history survives a reconnect. Sync integrations (HubSpot) keep their own tables.
 */
export const integrationConnections = pgTable(
  "integration_connections",
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
    publicId: text("public_id").notNull(), // icn_…
    /** The integration key, e.g. `firstpromoter`. */
    provider: text("provider").notNull(),
    /** Copied from the business at connect; partitions delivery like an endpoint's livemode. */
    livemode: text("livemode").notNull(),
    /** active | disconnected */
    status: text("status").notNull().default("active"),
    /** Paused by the operator. Events are not queued while false. */
    enabled: boolean("enabled").notNull().default(true),
    /** Encrypted credential envelope (platform/secrets). Write-only. Null once disconnected. */
    credentialsEnc: text("credentials_enc"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** The partner base URL this connection calls; seeded from the integration's default. */
    apiBase: text("api_base").notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow().notNull(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("integration_connections_public_id_uq").on(t.publicId),
    uniqueIndex("integration_connections_business_provider_uq").on(t.businessId, t.provider),
  ],
);

/** One event owed to one push connection. Same lifecycle as `webhook_deliveries`. */
export const integrationDeliveries = pgTable(
  "integration_deliveries",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    /** pending | delivered | failed | skipped | superseded */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastResponseStatus: integer("last_response_status"),
    durationMs: integer("duration_ms"),
    /** The partner's reply on the last failed attempt, clipped, or the transport error. */
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("integration_deliveries_status_idx").on(t.status, t.nextAttemptAt),
    index("integration_deliveries_connection_idx").on(t.connectionId, t.createdAt),
    index("integration_deliveries_event_idx").on(t.eventId),
  ],
);
