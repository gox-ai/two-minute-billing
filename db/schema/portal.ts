import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
  boolean,
  integer,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { customers } from "./customers";
import { subscriptions } from "./subscriptions";

/**
 * Customer-scoped portal sessions (P14 slice) — short-lived bearer tokens an
 * operator mints so a BUYER can manage their own payment methods at
 * /portal/<token>, without the org API key ever reaching the buyer's browser.
 * Mirrors the operator `sessions` model: only a SHA-256 hash of the token is
 * stored, never the token itself.
 */
export const portalSessions = pgTable(
  "portal_sessions",
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
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // psess_…
    /**
     * SHA-256 of the SESSION credential (`psst_…`), minted by the exchange and held only
     * in the buyer's HttpOnly cookie (0193). NULL before the exchange and again after
     * logout — a logged-out session must not be re-authenticated by a kept cookie.
     */
    tokenHash: text("token_hash"),
    /**
     * SHA-256 of the single-use ENTRY credential (`pstk_…`) — the one that appears in the
     * portal link. Consumed by the exchange; `/portal/v1/*` never accepts it.
     */
    accessTokenHash: text("access_token_hash"),
    /**
     * Where this link was destined, which is what picks the entry window (0195):
     * `api` keeps 0193's one hour, `email` gets five days.
     *
     * Billing mail is a different animal from an API-minted link: a link handed to an
     * integration is used at once, while one embedded in a notification has to survive
     * the inbox. A dunning notice read the next morning has to still work.
     */
    accessKind: text("access_kind").notNull().default("api"),
    /** Entry window. Set from `accessKind` at mint; see PORTAL_ACCESS_TTL_MS. */
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
    /** When the entry credential was spent. Non-null ⇒ the link is dead. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    /** created → logged_in → logged_out. */
    status: text("status").notNull().default("created"),
    /** API key public id that minted the link (audit trail). */
    createdBy: text("created_by"),
    /** Absolute ceiling on the SESSION, independent of the entry window above. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** First use — i.e. when the link was actually opened. */
    loginAt: timestamp("login_at", { withTimezone: true }),
    loginIp: text("login_ip"),
    logoutAt: timestamp("logout_at", { withTimezone: true }),
    logoutIp: text("logout_ip"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Where logout sends the buyer (0319). Null = the portal's signed-out card. */
    redirectUrl: text("redirect_url"),
    /** Portal path the entry link opens on (0319). Null = `/portal`. */
    forwardUrl: text("forward_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("portal_sessions_public_id_uq").on(t.publicId),
    uniqueIndex("portal_sessions_token_hash_uq").on(t.tokenHash),
    uniqueIndex("portal_sessions_access_token_hash_uq").on(t.accessTokenHash),
    index("portal_sessions_org_idx").on(t.organizationId),
    index("portal_sessions_customer_idx").on(t.customerId),
  ],
);

/**
 * The portal's cancel flow (0483): each offer a customer took and each cancellation with its
 * reason. "Show an offer once" reads `offer_accepted`; the saves report reads both kinds.
 */
export const retentionEvents = pgTable(
  "retention_events",
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
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    /** `offer_accepted` | `cancelled` */
    kind: text("kind").notNull(),
    /** `pause` | `downgrade` | `discount` | `contact`; null for a cancellation. */
    offer: text("offer"),
    reasonCode: text("reason_code"),
    /** A cancellation that came after the flow showed offers. */
    offersShown: boolean("offers_shown").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("retention_events_customer_idx").on(t.customerId, t.kind),
    index("retention_events_business_created_idx").on(t.businessId, t.createdAt),
  ],
);

/** Portal sign-in by email code (0485). Hashes only; single-use, short-lived. */
export const portalLoginCodes = pgTable(
  "portal_login_codes",
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
    /** sha256 of the lower-cased email. */
    emailHash: text("email_hash").notNull(),
    /** sha256 of the row id and the code. */
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("portal_login_codes_lookup_idx").on(t.businessId, t.emailHash, t.createdAt)],
);
