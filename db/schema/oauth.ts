import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { apiKeys, businesses, organizations } from "./tenancy";

/**
 * OAuth 2.1 for the MCP server (0503).
 *
 * `oauth_clients` and `oauth_requests` are PLATFORM tables: a client registers, and a request
 * starts, before any organization is known. The app role has no privilege on them; only the
 * system connection reads them. `oauth_grants` and `oauth_tokens` are tenant rows behind RLS.
 *
 * A grant is backed by a read-only `api_keys` row, so rate limits, the request log and
 * revocation work exactly as for a key. Revoking that key ends the grant.
 */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    /** `tmc_…` for a registered (DCR) client; the metadata URL itself for a CIMD client. */
    clientId: text("client_id").notNull(),
    kind: text("kind").notNull(), // dcr | cimd
    clientName: text("client_name"),
    redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
    /** CIMD: when the metadata document was last fetched. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("oauth_clients_client_id_uq").on(t.clientId)],
);

/** An authorization request waiting for the member's decision on the consent page. */
export const oauthRequests = pgTable(
  "oauth_requests",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // oar_…
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    state: text("state"),
    codeChallenge: text("code_challenge").notNull(),
    scope: text("scope").notNull(),
    resource: text("resource"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("oauth_requests_public_id_uq").on(t.publicId)],
);

export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // ogr_…
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /** The member who approved it. */
    userId: uuid("user_id").notNull(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    clientName: text("client_name"),
    scope: text("scope").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("oauth_grants_org_idx").on(t.organizationId),
    uniqueIndex("oauth_grants_public_id_uq").on(t.publicId),
  ],
);

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // code | access | refresh
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    redirectUri: text("redirect_uri"),
    codeChallenge: text("code_challenge"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("oauth_tokens_hash_uq").on(t.tokenHash),
    index("oauth_tokens_grant_idx").on(t.grantId),
  ],
);
