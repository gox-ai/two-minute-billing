import { sql } from "drizzle-orm";
import { pgTable, uuid, text, bigint, timestamp, index } from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * Operator notes pinned to a billing record. The same box appears on invoices,
 * credit notes, customers and subscriptions alike.
 *
 * POLYMORPHIC ON PURPOSE. The same widget belongs on at least four record
 * types; a `comments` column (or a table per type) would mean four
 * near-identical implementations and four migrations the next time a screen
 * wants one. `resource_type` + `resource_id` hold the PUBLIC id (`inv_…`,
 * `cn_…`, `cus_…`), matching how `audit_logs` and `events` already point at
 * resources — so the same `?resource_id=` read pattern works across all three.
 *
 * There is deliberately no FK: public ids are stable and the resource tables
 * differ per type. Deleting a business cascades; individual records do not
 * hard-delete anywhere in this system, so orphans are not a real case.
 *
 * MUTABLE, unlike `audit_logs` — an operator can edit or remove their own note.
 * That is why it carries the `bump_row_version` trigger.
 */
export const comments = pgTable(
  "comments",
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
    publicId: text("public_id").notNull(), // cmt_…
    // Public id of the annotated record + its type: invoice | credit_note |
    // customer | subscription. Same vocabulary as audit_logs.resource_type.
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    // Who wrote it — dashboard user email, or an api key public id. Free text for
    // the same reason audit_logs.actor is: the writer is not always a `users` row.
    author: text("author").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    index("comments_public_id_idx").on(t.publicId),
    // The only read path: every comment on one record, newest last.
    index("comments_resource_idx").on(t.businessId, t.resourceType, t.resourceId, t.createdAt),
  ],
);
