import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  char,
  text,
  timestamp,
  uniqueIndex,
  index,
  integer,
  bigint,
  inet,
  jsonb,
  primaryKey,
  boolean,
  customType,
} from "drizzle-orm/pg-core";
import { organizations } from "./tenancy";

/**
 * A portal user. Belongs to an organization via memberships (a user could later
 * span orgs; today one membership each). Password is stored as a salted hash.
 * This is SEPARATE from API keys: users log into the portal; API keys are for
 * programmatic API access.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // usr_…
    email: text("email").notNull(),
    name: text("name"),
    /**
     * scrypt `salt:hash`. NULL means the account was INVITED and the invite has not been
     * accepted — it cannot be signed into (0197). Never seed a random hash here: that
     * would be indistinguishable from a real account nobody knows the password to, and
     * `login` could no longer tell the two apart.
     */
    passwordHash: text("password_hash"),
    /**
     * Google OIDC `sub` — the stable, opaque per-account id (0194). Email is used only
     * to find an invited user on FIRST Google sign-in; after that this is the link, so
     * a person changing their Google address stays the same person and a recycled
     * address never inherits an account.
     */
    googleSub: text("google_sub"),
    /** When the address was confirmed (Google asserts it). NULL = unconfirmed. */
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    /** Standard §3.3: "Update user: lastLoginAt, lastLoginIP" — written on every success. */
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    lastLoginIp: inet("last_login_ip"),
    /**
     * Which org to open on next sign-in. A PREFERENCE, never an authorization — every
     * reader re-checks the membership still exists, or a user removed from an org would
     * be walked back into it by their own stale pointer (SR-2026-008 Issue #4).
     */
    lastOrganizationId: uuid("last_organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    /**
     * How many release notes existed when this person last acknowledged them — the highwater
     * for the dashboard's What's-new badge and dialog. A COUNT, not a timestamp: notes carry a
     * calendar date only, so two notes published on the same day are indistinguishable by date
     * and the second would never be announced. Notes are append-only, so `total - seen` is the
     * unread count; a note deleted from the repo makes it negative, and the reader clamps.
     *
     * NULL = never initialised, which the dashboard reads as CAUGHT UP (and writes through on
     * first sight). That is what makes a brand-new operator start clean while the migration's
     * explicit backfill to 0 gives everyone who predates the feature one launch announcement.
     */
    releaseNotesSeenCount: integer("release_notes_seen_count"),
    /** When this person finished or dismissed the product tour (0500). NULL = offer it. */
    productTourSeenAt: timestamp("product_tour_seen_at", { withTimezone: true }),
    /** Consecutive failed logins; reset to 0 on any success. Drives `lockedUntil`. */
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    /**
     * Login refused until this instant (0191). Self-expiring on purpose — a lock only
     * an operator can clear would let anyone who knows an address deny that user
     * access at will, which is the second failure mode SR-2026-009 Finding 3 names.
     */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    /** Profile photo on the object store (0327). NULL = initials. */
    avatarUrl: text("avatar_url"),
    /** The Google account's photo (0331), refreshed on each Google sign-in. Used when `avatarUrl` is NULL. */
    googlePictureUrl: text("google_picture_url"),
    /** light | dark | system (0327). NULL = never chosen, so the browser's own choice stands. */
    theme: text("theme"),
    /** WebAuthn user handle (0330): random, stable, never the email. Minted on first passkey. */
    webauthnUserId: text("webauthn_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("users_public_id_uq").on(t.publicId),
    uniqueIndex("users_webauthn_user_id_uq").on(t.webauthnUserId),
    uniqueIndex("users_email_uq").on(t.email),
    uniqueIndex("users_google_sub_uq").on(t.googleSub),
  ],
);

/**
 * A user's role within an organization. Roles map to portal personas:
 *  - owner/admin: full access (manager + ops + developer + write),
 *  - manager:     manager + ops views,
 *  - ops:         ops view,
 *  - developer:   developer view.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // owner | admin | manager | ops | developer | custom
    /** 0390: set exactly when `role = 'custom'`. Composite FK keeps it in this organization. */
    customRoleId: uuid("custom_role_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    /**
     * 0498: NULL = pending. An invite to an address that already has an account waits for that
     * person to accept; a pending row grants nothing. Every other insert is accepted on creation.
     */
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).defaultNow(),
    /** 0498: the `usr_…` id the inviting org sees while pending, never the account's own. */
    inviteId: text("invite_id"),
    /** 0498: the name the inviter typed, shown while pending instead of the account's. */
    inviteName: text("invite_name"),
  },
  (t) => [
    uniqueIndex("memberships_org_user_uq").on(t.organizationId, t.userId),
    uniqueIndex("memberships_invite_id_uq")
      .on(t.inviteId)
      .where(sql`invite_id IS NOT NULL`),
  ],
);

/**
 * A custom role (0389): a named set of catalogue permission keys (`src/modules/auth/permissions.ts`).
 * Soft-deleted; `version` bumps on every edit, so the in-process permission memo never goes stale.
 */
export const roles = pgTable(
  "roles",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // role_…
    name: text("name").notNull(),
    /** Normalised name: uniqueness and the reserved-name check use it. */
    nameKey: text("name_key").notNull(),
    description: text("description"),
    permissions: text("permissions").array().notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("roles_public_id_uq").on(t.publicId),
    uniqueIndex("roles_org_name_key_uq")
      .on(t.organizationId, t.nameKey)
      .where(sql`deleted_at IS NULL`),
  ],
);

/** A portal login session (opaque token hash → user+org). */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * Last use, written with every idle refresh (0482). An org can shorten the idle window
     * after `expiresAt` was stamped, so idleness is measured from this. NULL = older row:
     * `expiresAt` minus the deployment window.
     */
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    /**
     * Where the session STARTED (audit M5, the residue of M7; standard §4.3). A session
     * whose requests later move continents is the hijack signal, and it cannot be seen
     * without this — the session's two deadlines bound how long a stolen token lives, not
     * whether it was stolen.
     */
    createdIp: inet("created_ip"),
    userAgent: text("user_agent"),
    /**
     * When this session last RE-authenticated (audit M3.3). Null = never.
     *
     * On the session, not the user: it is this session's freshness being questioned, so a
     * stolen one cannot inherit the legitimate session's.
     */
    stepUpAt: timestamp("step_up_at", { withTimezone: true }),
    /** How this session was established: `password` | `google` (0326). Null on older rows. */
    authMethod: text("auth_method"),
    /** When this session passed a second factor (0326). Null = it never did. */
    mfaAt: timestamp("mfa_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_uq").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
  ],
);

/**
 * TOTP enrolment, one row per person (audit M3).
 *
 * The secret is ENCRYPTED (recoverable — every verification recomputes the code from it) while
 * the recovery codes are HASHED (only ever compared). Storing both the same way would mean one
 * key compromise hands over both factors, which defeats having two. See
 * `db/migrations/0203_user_mfa.sql`.
 */
export const userMfa = pgTable("user_mfa", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /**
   * The authenticator app's secret, `v1:<base64url(iv ‖ tag ‖ ciphertext)>` (`platform/secrets.ts`).
   * Null when 2FA is on through passkeys alone (0330): this row is the 2FA STATE, the app is optional.
   */
  secretEnc: text("secret_enc"),
  /** When the authenticator app was set up (0330); null while there is none. */
  totpAddedAt: timestamp("totp_added_at", { withTimezone: true }),
  /** Null until the person proves their authenticator works. Only a confirmed row gates login. */
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  /** SHA-256 of each UNUSED code. Consumed by removal, so single-use is a property of the array. */
  recoveryCodesHashed: text("recovery_codes_hashed").array().notNull().default([]),
  /** The last 30-second step a code was accepted for (0326). Only a LATER step is accepted. */
  lastUsedStep: bigint("last_used_step", { mode: "number" }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  /** Null = the person has not said they saved the current recovery codes. */
  recoveryCodesConfirmedAt: timestamp("recovery_codes_confirmed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Every credential attempt, successful or not (audit M5, standard §3.3 step 10 / §9.1).
 *
 * Append-only in practice: rows are written and swept, never updated. Not tenant-scoped and
 * deliberately without RLS — an attempt precedes knowing the organization, and for an unknown
 * address there never is one. See `db/migrations/0201_login_attempts.sql` for the reasoning
 * behind the hashed address and the missing foreign key.
 */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    /** success | bad_password | unknown_user | locked | unverified | mfa_failed */
    outcome: text("outcome").notNull(),
    /** Null when the address matched nothing. NOT a foreign key — see the migration. */
    userId: uuid("user_id"),
    /** sha256(lower(trim(email))), hex. Equality is all a query needs. */
    emailHash: text("email_hash").notNull(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [
    index("login_attempts_at_idx").on(t.at),
    index("login_attempts_email_at_idx").on(t.emailHash, t.at),
    index("login_attempts_ip_at_idx").on(t.ip, t.at),
  ],
);

/**
 * Single-use, short-lived OPERATOR credentials — password resets and invites (0194, 0197).
 *
 * Same two-credential shape as `portal_sessions`: the value that travels in a link is
 * short-lived and buys ONE action, rather than being the thing it protects. Only the
 * SHA-256 is stored — a reset table holding plaintext tokens grants access to every
 * account in it.
 *
 * A table rather than columns on `users` because a reset is an EVENT with its own
 * lifetime, and more than one can legitimately be outstanding (a user who clicks
 * "forgot password" twice). Columns would silently make the second request invalidate
 * the first, which is defensible but should be a decision, not a storage side effect.
 *
 * No RLS: this is OPERATOR identity, read before any organization is known, and a user
 * spans organizations by design.
 */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    /** Null only for `signup` (0354) and `signup_invite` (0405): no user exists yet. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * What spending this token means (0197). CHECKED when consuming, so the two kinds are
     * not interchangeable — otherwise an invite link, which any admin can have sent to any
     * address, would double as a password reset for an account that already exists.
     */
    purpose: text("purpose").notNull().default("password_reset"),
    /** Non-null ⇒ spent. Single-use is enforced against this in the consuming UPDATE. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    /** Who asked — the first signal when a user reports a reset they never requested. */
    requestedIp: text("requested_ip"),
    /** Opaque per-purpose data (0326): `mfa_setup` = encrypted pending secret; `mfa_challenge` = first-factor method; `signup` = the pending sign-up as JSON (0354). */
    payload: text("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("auth_tokens_token_hash_uq").on(t.tokenHash),
    index("auth_tokens_expires_idx").on(t.expiresAt),
  ],
);

/**
 * Access requests made while self-serve sign-up is locked (0405). Platform-global: only system
 * paths use it. Staff answer one from the back-office with a `signup_invite` link or dismiss it.
 */
export const signupRequests = pgTable(
  "signup_requests",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    publicId: text("public_id").notNull(), // sreq_…
    email: text("email").notNull(),
    name: text("name").notNull(),
    company: text("company").notNull(),
    country: char("country", { length: 2 }),
    billingVolume: text("billing_volume"),
    gateway: text("gateway"),
    message: text("message"),
    status: text("status").notNull().default("pending"), // pending | invited | dismissed
    requestedIp: text("requested_ip"),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    invitedBy: text("invited_by"),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissedBy: text("dismissed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("signup_requests_public_id_uq").on(t.publicId),
    uniqueIndex("signup_requests_open_email_uq")
      .on(t.email)
      .where(sql`status = 'pending'`),
    index("signup_requests_created_idx").on(t.createdAt.desc()),
  ],
);

/**
 * Account security trail (0328): 2FA changes, recovery codes, passwords, signed-out sessions,
 * failed second-step codes and support resets. Append-only, no RLS, `userId` not a foreign key —
 * the same reasoning as `login_attempts`. Written only through `modules/auth/security-events.ts`,
 * which refuses metadata keys that could carry a code, secret or token.
 */
export const securityEvents = pgTable(
  "security_events",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    userId: uuid("user_id").notNull(),
    kind: text("kind").notNull(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
  },
  (t) => [
    index("security_events_user_at_idx").on(t.userId, t.at),
    index("security_events_at_idx").on(t.at),
  ],
);

/**
 * Support-assisted 2FA reset (0328): effective 3 days after filing unless the owner cancels from
 * the emailed link. Only sha256 of the cancel token is stored. One open request per person.
 */
export const mfaResetRequests = pgTable(
  "mfa_reset_requests",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Which second proof support checked, in words. Never a credential. */
    proof: text("proof").notNull(),
    requestedBy: text("requested_by").notNull(),
    cancelTokenHash: text("cancel_token_hash").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("mfa_reset_requests_token_uq").on(t.cancelTokenHash),
    index("mfa_reset_requests_due_idx").on(t.effectiveAt),
  ],
);

/**
 * One deadline reminder per member, organization and deadline (0329). The primary key is the
 * "at most once": the sweep inserts first and mails only when the insert landed.
 */
export const orgMfaReminders = pgTable(
  "org_mfa_reminders",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deadline: timestamp("deadline", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.userId, t.deadline] })],
);

/**
 * Browsers allowed to skip the sign-in second step for 30 days (0329). Only sha256 of the cookie
 * value is stored. Skipping the step is not a second factor: such a session has no `mfa_at`.
 */
export const trustedBrowsers = pgTable(
  "trusted_browsers",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ip: inet("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("trusted_browsers_token_uq").on(t.tokenHash),
    index("trusted_browsers_user_idx").on(t.userId),
  ],
);

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

/** A passkey registered as a second factor (0330). The public key only — the private key never leaves the authenticator. */
export const userPasskeys = pgTable(
  "user_passkeys",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** base64url, as the browser reports it. */
    credentialId: text("credential_id").notNull(),
    /** COSE-encoded public key. */
    publicKey: bytea("public_key").notNull(),
    /** Signature counter. Synced passkeys always report 0. */
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    transports: text("transports").array().notNull().default([]),
    aaguid: text("aaguid"),
    name: text("name").notNull(),
    /** Synced to a cloud keychain, so it survives losing the device. */
    backedUp: boolean("backed_up").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("user_passkeys_credential_uq").on(t.credentialId),
    index("user_passkeys_user_idx").on(t.userId),
  ],
);

/** One WebAuthn ceremony in flight (0330). `user_id` is null only for a discoverable sign-in. */
export const webauthnChallenges = pgTable(
  "webauthn_challenges",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    /** sha256 of the handle the browser carries back. */
    handleHash: text("handle_hash").notNull(),
    /** register | sign_in | second_step */
    purpose: text("purpose").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    challenge: text("challenge").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("webauthn_challenges_handle_uq").on(t.handleHash),
    index("webauthn_challenges_expires_idx").on(t.expiresAt),
  ],
);
