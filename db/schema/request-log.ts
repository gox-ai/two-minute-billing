import {
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./tenancy";

/**
 * API request log (0392): one row per `/v1/*` request an organization's credential made —
 * API-key reads and writes, dashboard writes. Written in batches off the request path by
 * `modules/request-log/flush.ts`; bodies are redacted before insert. Rows are facts: no
 * UPDATE grant. Retention: writes 90 days, reads 30 (`modules/ops/retention.ts`).
 *
 * `business_id` has no FK on purpose: inserts stay cheap, and a deleted business's rows age out.
 */
export const apiRequestLogs = pgTable(
  "api_request_logs",
  {
    id: uuid("id").primaryKey(), // app-side uuidv7, minted at onRequest; public form req_<hex>
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id"),
    livemode: text("livemode"), // test | live | null
    source: text("source").notNull(), // api | dashboard
    apiKeyId: uuid("api_key_id"),
    memberUserId: uuid("member_user_id"),
    method: text("method").notNull(),
    path: text("path").notNull(),
    route: text("route"),
    query: text("query"),
    kind: text("kind").notNull(), // read | write
    status: smallint("status"), // null = client closed the connection
    durationMs: integer("duration_ms"),
    idempotencyKey: text("idempotency_key"),
    idempotencyOutcome: text("idempotency_outcome"), // new | replayed | mismatch | in_progress | missing
    errorType: text("error_type"),
    traceId: text("trace_id"),
    customerId: text("customer_id"), // cus_… public id
    ip: inet("ip"),
    userAgent: text("user_agent"),
    requestBody: jsonb("request_body"),
    responseBody: jsonb("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("api_request_logs_org_created_idx").on(t.organizationId, t.createdAt.desc(), t.id.desc()),
    index("api_request_logs_idem_idx")
      .on(t.organizationId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    index("api_request_logs_trace_idx")
      .on(t.organizationId, t.traceId)
      .where(sql`trace_id IS NOT NULL`),
    index("api_request_logs_customer_idx")
      .on(t.organizationId, t.customerId, t.createdAt.desc())
      .where(sql`customer_id IS NOT NULL`),
  ],
);
