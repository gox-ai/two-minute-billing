import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { checkoutSessions } from "./checkout";
import { portalSessions } from "./portal";

/**
 * One row per buyer session on a hosted page (0547): a checkout session (`cosess_…`) or a
 * portal session (`psess_…`). No cookie, no stored id of our own: the session the buyer
 * already has is the key. Never holds an IP address or a full user agent; see
 * `src/modules/storefront-analytics/README.md`.
 */
export const storefrontVisits = pgTable(
  "storefront_visits",
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
    /** `checkout` | `portal`. */
    surface: text("surface").notNull(),
    sessionPublicId: text("session_public_id").notNull(),
    checkoutSessionId: uuid("checkout_session_id").references(() => checkoutSessions.id, {
      onDelete: "cascade",
    }),
    portalSessionId: uuid("portal_session_id").references(() => portalSessions.id, {
      onDelete: "cascade",
    }),
    /** The entry link was opened (server side). Attribution is first touch. */
    enteredAt: timestamp("entered_at", { withTimezone: true }),
    /** The page ran in a browser (its beacon arrived). Only these rows count as views. */
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    /** Host of the Referer only, never its path or query. */
    referrerHost: text("referrer_host"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    /** `desktop` | `mobile` | `tablet`. */
    deviceCategory: text("device_category"),
    browser: text("browser"),
    os: text("os"),
    /** ISO 3166-1 alpha-2 from the edge's country header; null when there is none. */
    country: char("country", { length: 2 }),
    engagedMs: bigint("engaged_ms", { mode: "number" }).notNull().default(0),
    /** Visible time per checkout step or portal section: `{ "details": 41200, … }`. */
    stepMs: jsonb("step_ms").$type<Record<string, number>>().notNull().default({}),
    pdfDownloads: integer("pdf_downloads").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("storefront_visits_session_uq").on(t.surface, t.sessionPublicId),
    index("storefront_visits_business_idx").on(t.businessId, t.surface, t.viewedAt),
    index("storefront_visits_created_idx").on(t.createdAt),
  ],
);
