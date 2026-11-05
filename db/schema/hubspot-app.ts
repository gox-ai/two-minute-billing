import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { hubspotConnections } from "./hubspot";

/** One HubSpot workflow-action run, keyed on its `callbackId` so a retry replays the first result. */
export const hubspotActionExecutions = pgTable(
  "hubspot_action_executions",
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
    callbackId: text("callback_id").notNull(),
    action: text("action").notNull(),
    /** running | succeeded | failed */
    status: text("status").notNull(),
    result: jsonb("result").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("hubspot_action_executions_callback_uq").on(t.connectionId, t.callbackId)],
);
