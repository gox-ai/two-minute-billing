import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
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
    // sync: running | succeeded | failed. async (0517): planned → queued → running →
    // succeeded | partially_failed | failed | cancelled; a replaced plan is superseded.
    status: text("status").notNull().default("running"),
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
    // 0517: 'async' = a persisted plan applied by the `transfer_run` job, item by item.
    runKind: text("run_kind").notNull().default("sync"),
    conflictPolicy: jsonb("conflict_policy"), // { <section>: "skip" | "update" }
    validation: jsonb("validation"), // { errors: [...], warnings: [...] } at the last check
    counts: jsonb("counts"), // item counts by status
    plannedBy: text("planned_by"),
    startedBy: text("started_by"),
    startedByUserId: uuid("started_by_user_id"),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // The runner's lease: a second runner waits until the heartbeat is stale.
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseCount: integer("lease_count").notNull().default(0),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("transfer_configurations_org_idx").on(t.organizationId, t.createdAt),
    index("transfer_configurations_source_status_idx").on(
      t.sourceBusinessId,
      t.status,
      t.createdAt,
    ),
  ],
);

/** One object or setting of an async transfer plan, with its own apply status (0517). */
export const transferItems = pgTable(
  "transfer_items",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    transferId: uuid("transfer_id")
      .notNull()
      .references(() => transferConfigurations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    pair: text("pair").notNull().default("main"), // main | twin
    section: text("section").notNull(),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    action: text("action").notNull(), // create | update | unchanged | skip | blocked | delete
    excluded: boolean("excluded").notNull().default(false),
    dependsOn: jsonb("depends_on").$type<string[]>().notNull().default([]),
    diff: jsonb("diff"),
    messages: jsonb("messages").notNull().default([]),
    sourceRef: text("source_ref"),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").notNull().default("pending"), // pending | running | done | failed | skipped
    error: text("error"),
    skipReason: text("skip_reason"), // unchanged | excluded | dependency | cancelled | drift
    resultRef: text("result_ref"),
    replaced: jsonb("replaced"), // the destination values an update replaced (undo record)
    attempts: integer("attempts").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("transfer_items_key_uq").on(t.transferId, t.pair, t.key),
    index("transfer_items_run_seq_idx").on(t.transferId, t.seq),
  ],
);
