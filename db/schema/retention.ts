import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./tenancy";

/**
 * Retention defaults (D17), one row: the mode and periods every organization without its own
 * setting follows, and the periods of platform data. A period of 0 keeps that data forever.
 * Read by the nightly sweep (`modules/ops/retention.ts`), set by staff in the back-office.
 */
export const retentionDefaults = pgTable("retention_defaults", {
  id: boolean("id").primaryKey().default(true),
  mode: text("mode").notNull().default("dry_run"), // off | dry_run | on
  eventsDays: integer("events_days").notNull().default(90),
  webhookDeliveriesDays: integer("webhook_deliveries_days").notNull().default(30),
  gatewayLogsDays: integer("gateway_logs_days").notNull().default(90),
  emailBodyDays: integer("email_body_days").notNull().default(90),
  idempotencyHours: integer("idempotency_hours").notNull().default(24),
  clockTicksDays: integer("clock_ticks_days").notNull().default(30),
  invariantResultsDays: integer("invariant_results_days").notNull().default(30),
  /** API request log (0393): write requests and read requests have separate periods. */
  apiLogWritesDays: integer("api_log_writes_days").notNull().default(90),
  apiLogReadsDays: integer("api_log_reads_days").notNull().default(30),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text("updated_by"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastRunMode: text("last_run_mode"),
  lastRun: jsonb("last_run").$type<Record<string, number>>(),
});

/** One organization's own retention setting; a NULL column follows `retention_defaults`. */
export const organizationRetention = pgTable("organization_retention", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  mode: text("mode"),
  eventsDays: integer("events_days"),
  webhookDeliveriesDays: integer("webhook_deliveries_days"),
  gatewayLogsDays: integer("gateway_logs_days"),
  emailBodyDays: integer("email_body_days"),
  idempotencyHours: integer("idempotency_hours"),
  apiLogWritesDays: integer("api_log_writes_days"),
  apiLogReadsDays: integer("api_log_reads_days"),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  updatedBy: text("updated_by"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastRunMode: text("last_run_mode"),
  lastRun: jsonb("last_run").$type<Record<string, number>>(),
});
