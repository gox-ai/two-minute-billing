import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * Reason codes (Settings → Reason Codes) — a merchant-managed
 * list of the reasons an operator can pick from when performing an action, so
 * churn/refund reporting groups on a stable code instead of free prose.
 *
 * This is the DEFINITIONS table only. The chosen value keeps living on the entity
 * it describes as plain text (`subscriptions.cancel_reason_code`,
 * `refunds.reason`) — deliberately NOT a foreign key:
 *   - the API has always accepted an arbitrary string there, and importers carry
 *     codes from other systems that were never defined here;
 *   - a historical record must not change meaning (or break) because someone
 *     later renamed or deleted a reason code.
 * So this table drives what the UI OFFERS; it does not constrain what is stored.
 *
 * Distinct from `credit_notes.reason_code`, which is a FIXED protocol enum
 * (write_off | subscription_change | …) the engine itself branches on — that one
 * is not merchant-editable and is not represented here.
 *
 * Business-scoped like the catalog; tenant-isolated by org RLS.
 */
export const reasonCodes = pgTable(
  "reason_codes",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // rsn_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    // Which action this reason is offered for. v1: 'subscription_cancellation' | 'refund'.
    // Extending this is additive — add the value plus a UI that reads it.
    appliesTo: text("applies_to").notNull(),
    // Stable machine value persisted on the entity. Unique per (business, applies_to).
    code: text("code").notNull(),
    label: text("label").notNull(),
    position: integer("position").notNull().default(0), // display order in the picker
    // Soft-disable: a disabled code stops being OFFERED but existing records that
    // already carry it still render its label.
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("reason_codes_public_id_uq").on(t.publicId),
    uniqueIndex("reason_codes_scope_uq").on(t.businessId, t.appliesTo, t.code),
    index("reason_codes_biz_applies_idx").on(t.businessId, t.appliesTo),
  ],
);
