import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  bigint,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * One member of a segment's filter set — the same `field / op / value` grammar the
 * customer list API takes (`?<field>[<op>]=<value>`).
 *
 * Structurally identical to `ListViewFilter`, and deliberately a SEPARATE type rather
 * than a re-export: the two are validated against different things and will diverge.
 * A stored view's filters are checked for shape only (it may name a list whose fields
 * the engine does not own); a segment's are checked against
 * `CUSTOMER_FILTER_OPS`/`CUSTOMER_FILTER_KINDS`, field by field and value by value,
 * because a segment that cannot be resolved is a number nobody can trust.
 */
export interface CustomerSegmentFilter {
  field: string;
  op: string;
  value: string;
}

/**
 * A **customer segment**: a saved, named population, defined as a filter set over
 * customer attributes.
 *
 * ── THE VOCABULARY, WHICH IS LOAD-BEARING ────────────────────────────────────
 * Three words, three things, and they may not be swapped:
 *
 *   **view**      — a saved filter over a LIST of rows on a screen (`list_views`).
 *                   It is about how one operator looks at a table.
 *   **attribute** — a stored dimension a report is computed by or filtered on
 *                   (`FILTERABLE_DIMENSIONS` in `metrics/reports/resolve.ts`). The
 *                   metrics module never calls one of these a segment.
 *   **segment**   — THIS: a named population, saved once and then compared against
 *                   itself over time, or against another segment, on a metric.
 *
 * A view and a segment are both "a saved filter", which is exactly why they need
 * different words: the first narrows a screen, the second defines who a figure is
 * about. `docs/PROGRESS.md` § 4c settled it; the word "view" appears nowhere in this
 * module and the word "segment" appears nowhere in the metrics dimension vocabulary.
 *
 * ── WHY THE FILTERS ARE STORED IN THE LIST GRAMMAR ───────────────────────────
 * Because that is the only filtering path over customers we have, and a second one
 * would answer the same question two ways. The stored triples are handed to
 * `listCustomersPage` unchanged, so a segment can never hold a predicate the list
 * would refuse — the validation on write is the list's own allow-list.
 *
 * The STARTER LIBRARY is not in this table. Those are defined in code
 * (`modules/segments/starters.ts`) and merged in on read, so every business has them
 * on day one, they cannot be half-deleted, and improving one does not need a data
 * migration. This table holds what an operator saved.
 */
export const customerSegments = pgTable(
  "customer_segments",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * NOT NULL, unlike `list_views.business_id`. A segment is a population of
     * CUSTOMERS, and a customer belongs to exactly one business — there is no
     * org-level customer list for one to hang off, so a NULL here could only ever be
     * a bug wearing the shape of a feature.
     */
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // seg_…
    name: text("name").notNull(),
    /** What this population is for, in the operator's own words. */
    description: text("description"),
    /** `CustomerSegmentFilter[]` — the predicate, in the customer list grammar. */
    filters: jsonb("filters").$type<CustomerSegmentFilter[]>().notNull().default([]),
    /**
     * The starter this segment was copied from, or NULL for one built from scratch.
     *
     * Kept so "Recently cancelled, but only on annual plans" can be traced back to the
     * definition it started as — and so a starter whose definition we later improve
     * does NOT silently rewrite the copy somebody has been reporting against.
     */
    starterKey: text("starter_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("customer_segments_public_id_uq").on(t.publicId),
    /** The only read path: every segment on one business. */
    index("customer_segments_scope_idx").on(t.organizationId, t.businessId),
    /**
     * No two segments on one business share a name, case-insensitively. Shared across
     * the organization rather than per-owner (the `list_views` rule): a segment is
     * what a figure is ABOUT, so two people reporting "High MRR" at different
     * definitions is the failure this table exists to prevent.
     */
    uniqueIndex("customer_segments_name_uq").on(
      t.organizationId,
      t.businessId,
      sql`lower(${t.name})`,
    ),
  ],
);
