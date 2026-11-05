import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * A saved report dashboard: a named, ordered set of REFERENCES into the report
 * catalogue. It stores keys, never definitions — so a report whose maths is corrected
 * is corrected on every dashboard that shows it, and a dashboard cannot drift into
 * being a second, stale catalogue.
 *
 * Deliberately field-for-field the same shape as `list_views` (see that file for the
 * full reasoning): ownership, visibility and defaults are the same problem, and a
 * second convention for one idea is how two features drift apart.
 *
 * `business_id` IS NULLABLE, with the same meaning it has there: NULL is an ORG-LEVEL
 * dashboard — a layout the operator can point at any business — not "unknown". The
 * uniqueness indexes coalesce it rather than relying on NULL-distinctness, so a
 * duplicate name on an org-level dashboard is still caught.
 *
 * `owner` is free text (a dashboard user's email, or an API key's public id), like
 * `list_views.owner` and `comments.author`: the writer is not always a `users` row, and
 * an FK would make an API-created dashboard unattributable. It is also the
 * private-visibility key, so it must be stable per person.
 */
export const reportDashboards = pgTable(
  "report_dashboards",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // NULL = an org-level dashboard; the business is then supplied when it is opened.
    businessId: uuid("business_id").references(() => businesses.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // dash_…
    name: text("name").notNull(),
    owner: text("owner").notNull(),
    /** `private` (only `owner` sees it) | `everyone` (the whole organization). */
    visibility: text("visibility").notNull().default("private"),
    /**
     * The dashboard this operator lands on. Per-OWNER, not per-organization, exactly as
     * `list_views.is_default` is: "my default" is a personal choice even for a shared
     * dashboard, so two colleagues must not fight over one flag.
     */
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("report_dashboards_public_id_uq").on(t.publicId),
    index("report_dashboards_scope_idx").on(t.organizationId, t.businessId),
    /**
     * No two of one operator's dashboards share a name. The `coalesce` is what makes it
     * hold for org-level dashboards too: a plain unique index over a NULL `business_id`
     * treats every such row as distinct and would let duplicates through on exactly the
     * dashboards where `business_id` is always NULL.
     */
    uniqueIndex("report_dashboards_name_uq").on(
      t.organizationId,
      sql`coalesce(${t.businessId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.owner,
      sql`lower(${t.name})`,
    ),
    /** At most one default per operator per scope. Partial, so non-defaults don't collide. */
    uniqueIndex("report_dashboards_default_uq")
      .on(
        t.organizationId,
        sql`coalesce(${t.businessId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        t.owner,
      )
      .where(sql`${t.isDefault}`),
  ],
);

/**
 * One tile: a report key plus the options that report already accepts, so a tile asks
 * the engine exactly what the report screen asks it.
 *
 * ⚠ `report_key` is NOT a foreign key and cannot be — the catalogue lives in code. A
 * key can therefore leave the registry under a dashboard that still names it. The
 * engine validates against `REPORT_BY_KEY` on write AND on read, and a tile whose
 * report is gone is reported as unavailable rather than blanked or dropped: silently
 * dropping it would change what a named dashboard means without telling anyone.
 *
 * `organization_id` is carried on the tile as well as on the dashboard so RLS can scope
 * it without a join — the same reason every other child table here repeats it.
 */
export const reportDashboardTiles = pgTable(
  "report_dashboard_tiles",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    dashboardId: uuid("dashboard_id")
      .notNull()
      .references(() => reportDashboards.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // dtile_…
    /** A `REPORTS` key. Validated in code, not by an enum — adding a report is not a migration. */
    reportKey: text("report_key").notNull(),
    /**
     * The report's own parameters. NULL means "whatever the report defaults to", which is
     * different from pinning today's default: a tile that pinned `12m` because that was
     * the default would stop following a later change of default.
     */
    range: text("range"),
    currency: text("currency"),
    groupBy: text("group_by"),
    granularity: text("granularity"),
    /** `series` | `totals` (0274) — a measure tile's answer shape; NULL = `series`. */
    shape: text("shape"),
    /** A segment's public id (0276) — answer this measure for that population; NULL = all. */
    segmentId: text("segment_id"),
    /**
     * DEPRECATED (0270). `sm` | `md` | `lg` | `full`, mirrored by
     * `report_dashboard_tiles_size_check`. Still written, derived from `widthUnits`, so a
     * caller that has not moved to the units keeps reading a truthful value. Nothing reads it.
     */
    size: text("size").notNull().default("md"),
    /**
     * The tile's size on the board, free rather than one of four presets (0270).
     * `widthUnits` is columns of twelve; `heightUnits` is rows of 80px. Both are checked
     * in the database as well as in `validateTile` — a tile dragged to nothing is a tile
     * nobody can read.
     */
    widthUnits: integer("width_units").notNull().default(6),
    heightUnits: integer("height_units").notNull().default(4),
    /**
     * Order within the dashboard, ascending. NOT unique: a reorder rewrites the whole
     * list in one transaction, and a unique index would force a two-pass shuffle through
     * throwaway positions to say nothing the rewrite does not already guarantee.
     */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("report_dashboard_tiles_public_id_uq").on(t.publicId),
    // The only read path: every tile of one dashboard, in order.
    index("report_dashboard_tiles_dashboard_idx").on(t.dashboardId, t.position),
  ],
);
