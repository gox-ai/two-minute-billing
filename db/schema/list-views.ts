import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  bigint,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * One member of a saved view's filter set, in the same `field / op / value` grammar
 * the list API takes (`?<field>[<op>]=<value>`) and the dashboard URL uses.
 *
 * ONE grammar for all three — stored view, URL and API call — is the point. A view
 * that had to be translated into query params would drift from what the endpoint
 * accepts, and the first symptom of that drift is a view that shows the wrong rows
 * under a name the operator trusts.
 */
export interface ListViewFilter {
  field: string;
  op: string;
  value: string;
}

/**
 * A saved list view, or **segment**: the `All Subscriptions ▾` dropdown on every
 * list screen, holding the operator's own named filter sets alongside the
 * built-in ones.
 *
 * SERVER-SIDE, not localStorage, because a segment is a work artefact rather than a
 * browser preference: "Overdue INR invoices > ₹50k" is something a finance team agrees
 * on once and then everyone opens, and one that lived in a browser profile would be
 * lost on a new laptop and impossible to share. `visibility` is what makes both cases
 * work off one table.
 *
 * `business_id` IS NULLABLE, unlike most tenant-scoped tables: two lists in the product
 * are org-wide rather than per-business (the `/audit` activity log, and the billing
 * clock, which crosses tenants entirely), and their views have no business to hang off.
 * A NULL therefore means "an org-level list", not "unknown" — the uniqueness indexes
 * coalesce it rather than relying on NULL-distinctness, so a duplicate name on an
 * org-level list is still caught.
 *
 * `owner` is free text — a dashboard user's email, or an API key's public id — for the
 * same reason `comments.author` and `audit_logs.actor` are: the writer is not always a
 * `users` row, and an FK here would make an API-created view impossible to attribute.
 * It is also the private-visibility key, so it must be stable per person.
 */
export const listViews = pgTable(
  "list_views",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // NULL = an org-level list (see the note above). No default: "which business" is
    // never something this table should guess.
    businessId: uuid("business_id").references(() => businesses.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // view_…
    /**
     * Which list this view belongs to — the same entity key the dashboard's
     * `/api/lists/<entity>` proxy uses (`subscriptions`, `invoices`, `org_audit_logs`).
     * Validated at the route against `LIST_VIEW_ENTITIES` rather than by a DB enum, so
     * adding a list is one line instead of a migration.
     */
    entity: text("entity").notNull(),
    name: text("name").notNull(),
    owner: text("owner").notNull(),
    /** `private` (only `owner` sees it) | `everyone` (the whole organization). */
    visibility: text("visibility").notNull().default("private"),
    /** `ListViewFilter[]` — the `field/op/value` triples this view applies. */
    filters: jsonb("filters").$type<ListViewFilter[]>().notNull().default([]),
    /** Free-text search the view carries, if any. */
    search: text("search"),
    sortField: text("sort_field"),
    sortDesc: boolean("sort_desc"),
    /**
     * Column ids this view hides. NULL means "whatever the list hides by default".
     *
     * Stored as the HIDDEN set rather than the full id → visible map that
     * `DataTable` keeps in localStorage: a map records a verdict for every column that
     * existed when the view was saved, so a column added later would come back
     * `undefined` and its default would silently depend on how tanstack reads a missing
     * key. A hidden-list degrades the right way — a new column is visible until someone
     * hides it.
     */
    hiddenColumns: jsonb("hidden_columns").$type<string[]>(),
    /**
     * The view this operator lands on when they open the list. Per-OWNER, not
     * per-organization: "my default" is a personal choice even for a shared view, so a
     * colleague defaulting to the same segment must not fight over one flag.
     */
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("list_views_public_id_uq").on(t.publicId),
    // The only read path: every view visible on one list, for one operator.
    index("list_views_scope_idx").on(t.organizationId, t.businessId, t.entity),
    /**
     * No two of one operator's views on one list share a name. The `coalesce` is what
     * makes it hold for org-level lists too: a plain unique index over a NULL
     * `business_id` would treat every such row as distinct and let duplicates through
     * on exactly the lists where `business_id` is always NULL.
     */
    uniqueIndex("list_views_name_uq").on(
      t.organizationId,
      sql`coalesce(${t.businessId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.entity,
      t.owner,
      sql`lower(${t.name})`,
    ),
    /** At most one default per operator per list. Partial, so non-defaults don't collide. */
    uniqueIndex("list_views_default_uq")
      .on(
        t.organizationId,
        sql`coalesce(${t.businessId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        t.entity,
        t.owner,
      )
      .where(sql`${t.isDefault}`),
  ],
);
