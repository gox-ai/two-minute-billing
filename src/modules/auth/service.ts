import { randomBytes, scrypt, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { and, desc, eq, gt, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { systemDb, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { insertOrganization } from "@/modules/tenancy/service";
import { rejectPassword } from "@/modules/auth/password-policy";
import { base32Encode, matchTotpStep, otpauthUri } from "@/modules/auth/totp";
import { encryptSecret, decryptSecret } from "@/platform/secrets";
import {
  users,
  memberships,
  sessions,
  organizations,
  authTokens,
  loginAttempts,
  userMfa,
  userPasskeys,
  webauthnChallenges,
  roles,
} from "@db/schema";
import {
  effectivePermissions,
  fixedRolePermissions,
  isFixedRole,
  type FixedRole,
} from "@/modules/auth/permissions";
import { config } from "@/platform/config";
import {
  effectiveAbsoluteTtlHours,
  effectiveIdleMinutes,
  rolesRequiringMfa,
  type OrgSessionPolicy,
} from "./session-policy";
import { signupOffered } from "@/platform/edition";
import { writeAuditLog } from "@/modules/audit/service";
import { resolveMailer } from "@/modules/emails/mailer-resolver";
import {
  renderPasswordResetEmail,
  renderInviteEmail,
  renderMembershipInviteEmail,
} from "@/modules/emails/templates";
import { accountBrand } from "@/modules/emails/account-brand";
import { createLogger } from "@/platform/logger";
import {
  pendingMfaReset,
  recordFailedSecondFactor,
  securityEvent,
} from "@/modules/auth/security-events";
import {
  forgetAllTrustedBrowsers,
  isTrustedBrowser,
  trustBrowser,
} from "@/modules/auth/trusted-browsers";
import {
  OrganizationRequiresTwoFactorError,
  organizationsRequiringTwoFactor,
  twoFactorStanding,
} from "@/modules/auth/org-two-factor";
import {
  PasskeyError,
  authenticationOptions,
  listPasskeys,
  normalisePasskeyName,
  registrationOptions,
  suggestPasskeyName,
  verifyAuthentication,
  verifyRegistration,
  type PasskeyView,
} from "@/modules/auth/passkeys";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

const log = createLogger("auth");

/** A fixed role, or `custom` when the membership holds a custom role (0390). */
export type Role = FixedRole | "custom";

/** The custom role a membership holds, as read with the membership. */
export interface CustomRoleRef {
  id: string;
  publicId: string;
  name: string;
  version: number;
  permissions: string[];
}

/** A member's effective permission keys. */
export function permissionsOf(u: { role: Role; customRole?: CustomRoleRef | null }) {
  return effectivePermissions(u.role, u.customRole);
}

/** Granting or touching something the actor does not hold (escalation guard). Routes answer 403. */
export class PermissionEscalationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionEscalationError";
  }
}

/** Owner is senior to admin: only an owner grants, changes or removes the owner role. 403. */
export class OwnerRequiredError extends PermissionEscalationError {
  readonly code = "owner_required";
  constructor(message: string) {
    super(message);
    this.name = "OwnerRequiredError";
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

// --- password hashing (audit L1) ---
//
// Format: `scrypt$N$r$p$salt$hash`, all hex for the last two. SELF-DESCRIBING, which is
// the point: `verifyPassword` reads the parameters from the row instead of assuming
// today's constants, so raising SCRYPT_COST_LOG2 re-hashes people on their next login
// rather than locking every existing password out. The previous format was a bare
// `salt:hash` with Node's defaults (N=2^14) baked in implicitly and no way to change them.
//
// `maxmem` is required, not decorative: scrypt needs roughly 128·N·r bytes and Node caps
// it at 32MB by default, so anything above N=2^15 throws without this.
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 512 * 1024 * 1024;
const KEYLEN = 64;

export function hashPassword(password: string): string {
  const N = 1 << config.SCRYPT_COST_LOG2;
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, {
    N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** The pre-L1 `salt:hash` at Node's defaults. Kept so nobody is locked out. */
function verifyLegacyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = scryptSync(password, Buffer.from(saltHex, "hex"), KEYLEN);
  const expected = Buffer.from(hashHex, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

/** True when the stored hash is not in the current format and should be upgraded. */
export function passwordHashNeedsUpgrade(stored: string): boolean {
  if (!stored.startsWith("scrypt$")) return true;
  const n = Number(stored.split("$")[1]);
  return !Number.isFinite(n) || n < 1 << config.SCRYPT_COST_LOG2;
}

function verifyPassword(password: string, stored: string): boolean {
  if (!stored.startsWith("scrypt$")) return verifyLegacyPassword(password, stored);
  const [, n, r, p, saltHex, hashHex] = stored.split("$");
  if (!n || !r || !p || !saltHex || !hashHex) return false;
  const N = Number(n);
  // A row could name a cost this process cannot afford; refusing beats throwing out of a
  // login path, and the log line is how anyone would ever find out.
  if (!Number.isFinite(N) || N < 1 << 10 || N > 1 << 22) return false;
  const hash = scryptSync(password, Buffer.from(saltHex, "hex"), KEYLEN, {
    N,
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT_MAXMEM,
  });
  const expected = Buffer.from(hashHex, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

/**
 * A session has TWO deadlines, and `sessions` already carries both columns.
 *
 * `expiresAt` is the IDLE deadline: pushed forward every time the session is used.
 * `createdAt` fixes the ABSOLUTE ceiling, which nothing ever extends. One bounds an
 * unattended browser, the other bounds the credential itself; a session needs to pass
 * both. Before this, only the absolute bound existed and it was stamped once at
 * sign-in, so an abandoned session stayed valid for the remainder of the week.
 */
// The organization may shorten both (0482, `session-policy.ts`); never lengthen them.
const idleWindowMs = (org?: Partial<OrgSessionPolicy> | null) => effectiveIdleMinutes(org) * 60_000;
const absoluteTtlMs = (org?: Partial<OrgSessionPolicy> | null) =>
  effectiveAbsoluteTtlHours(org) * 3600_000;

/**
 * Don't write on every single request. Once dashboard traffic authenticates by session,
 * `resolveSession` runs on every API call, and an unthrottled refresh would turn each
 * one into a row update. Rewriting only after a minute of drift keeps the idle window
 * accurate to within a minute — far finer than the 30 it is measuring.
 */
const REFRESH_THROTTLE_MS = 60_000;

export const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Where a credential attempt came from. Optional everywhere — a caller with no request
 * context (a script, a fixture) records nulls rather than inventing values.
 */
export interface LoginContext {
  ip?: string | null;
  userAgent?: string | null;
  /** The browser's trusted-browser cookie (0329), if it sent one. */
  trustedBrowserToken?: string | null;
}

export type LoginOutcome =
  | "success"
  | "bad_password"
  | "unknown_user"
  | "locked"
  | "unverified"
  | "mfa_failed";

/**
 * Record one credential attempt (audit M5).
 *
 * BEST-EFFORT by construction: a failure to write the audit row must never change the outcome
 * of the login itself. Refusing a valid sign-in because an INSERT failed would turn an
 * observability feature into an availability incident; the opposite failure — a login that
 * succeeds while the trail loses a row — surfaces in the error log instead.
 *
 * The address is hashed here, once, so no caller has to remember to. See
 * `db/migrations/0201_login_attempts.sql` for why it is hashed at all.
 */
async function recordLoginAttempt(
  outcome: LoginOutcome,
  input: { email: string; userId?: string | null; ctx?: LoginContext },
): Promise<void> {
  try {
    await systemDb.insert(loginAttempts).values({
      outcome,
      userId: input.userId ?? null,
      emailHash: createHash("sha256").update(input.email.trim().toLowerCase()).digest("hex"),
      ip: input.ctx?.ip ?? null,
      userAgent: input.ctx?.userAgent?.slice(0, 500) ?? null,
    });
  } catch (e) {
    log.error(e, { event: "login_attempt_not_recorded", outcome });
  }
}

export interface AuthedUser {
  userId: string;
  userPublicId: string;
  email: string;
  organizationId: string;
  organizationPublicId: string;
  role: Role;
  /** Set by `resolveSession` when `role` is `custom`. */
  customRole?: CustomRoleRef | null;
}

/**
 * An organization, its dashboard credential, and its owner, in the caller's transaction.
 * No session and no checks: `signup` and the self-host bootstrap check the password and the
 * email first, each in its own way.
 */
export async function createOwnerAccount(
  tx: Tx,
  input: { email: string; password: string; name?: string; organizationName: string },
) {
  const org = await insertOrganization(tx, { name: input.organizationName });
  const [user] = await tx
    .insert(users)
    .values({
      publicId: publicId("usr"),
      email: input.email,
      name: input.name ?? null,
      passwordHash: hashPassword(input.password),
    })
    .returning();
  await tx
    .insert(memberships)
    .values({ organizationId: org.organization.id, userId: user!.id, role: "owner" });
  return { org, user: user! };
}

/**
 * Sign up: create a brand-new organization, its first user (role=owner), and a
 * session. This is how a new merchant onboards to the portal.
 */
export async function signup(input: {
  email: string;
  password: string;
  name?: string;
  organizationName: string;
}): Promise<{ token: string; user: AuthedUser; dashboardKeySecret: string }> {
  const email = input.email.toLowerCase().trim();
  // One shared policy (audit M4). The email is passed where it is known, so a password
  // containing the local part is refused.
  const rejected = await rejectPassword(input.password, email);
  if (rejected) throw new AuthError(rejected);
  const [existing] = await systemDb.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw new AuthError("An account with that email already exists");

  const { org, user } = await systemDb.transaction((tx) =>
    createOwnerAccount(tx, {
      email,
      password: input.password,
      name: input.name,
      organizationName: input.organizationName,
    }),
  );

  const token = await createSession(
    user.id,
    org.organization.id,
    {},
    {
      authMethod: "password",
      mfaAt: null,
      stepUpAt: new Date(),
    },
  );
  log.log("organization created via signup", {
    organizationId: org.organization.publicId,
    user: user.publicId,
  });
  return {
    token,
    /**
     * The org's bootstrap credential, `kind: 'dashboard'` (0150/0151) — NOT one of the
     * organization's API keys. It is what the dashboard authenticates with, it is
     * hidden from `GET /v1/api_keys`, it cannot be revoked over the API, and its
     * requests are recorded as `source='dashboard'` attributed to the signed-in
     * operator rather than being filed as third-party integration traffic.
     *
     * Named for what it is. It used to be `apiKeySecret`, which is the same
     * conflation 0150 exists to end: callers printed it as "api key", so the one
     * credential an operator must NOT hand to an integration was the one every
     * bootstrap path advertised as an API key. A real integration key is minted
     * separately — `POST /v1/api_keys`, or `scripts/create-api-key.ts`.
     */
    dashboardKeySecret: org.secret,
    user: {
      userId: user.id,
      userPublicId: user.publicId,
      email,
      organizationId: org.organization.id,
      organizationPublicId: org.organization.publicId,
      role: "owner",
    },
  };
}

/** Invite a user into an existing org with a role (admin action). */
export async function inviteUser(input: {
  organizationId: string;
  email: string;
  /** A fixed role code, or a custom role's `role_…` id. */
  role: string;
  /**
   * The inviter's effective permissions. When given, the role must be a subset ("grant only
   * what you hold"). A seed or script passes none.
   */
  actorPermissions?: ReadonlySet<string>;
  name?: string;
  /** Base URL of the dashboard, for composing the link. No base ⇒ no mail (logged). */
  dashboardBaseUrl?: string | null;
  /**
   * The admin doing the inviting, for the audit row (2026-08-30). Optional because a seed has
   * no operator — and `writeAuditLog` then falls back to `system`, which is the honest
   * answer rather than an invented one.
   */
  actorEmail?: string | null;
  /** The inviter. Only an owner may invite into the owner role; a seed passes none. */
  actorUserId?: string;
}): Promise<AuthedUser> {
  const target = await resolveAssignableRole(input.organizationId, input.role);
  if (input.actorPermissions) assertGrantable(input.actorPermissions, target.permissions);
  if (target.role === "owner" && input.actorUserId) {
    await assertActorIsOwner(
      systemDb,
      input.organizationId,
      input.actorUserId,
      "We could not send the invite. Only an owner can give the owner role.",
    );
  }
  const email = input.email.toLowerCase().trim();

  let [user] = await systemDb.select().from(users).where(eq(users.email, email)).limit(1);
  // An account someone can already sign into joins only when that person accepts (0498).
  // Until then the org sees what the inviter typed and a fresh id, as for a new invitee.
  const pending = !!user && hasCredential(user);
  if (!user) {
    [user] = await systemDb
      .insert(users)
      // NO PASSWORD (0197). The inviter does not choose it, does not see it, and cannot
      // learn it — they are adding a colleague, not issuing them a credential. NULL means
      // "cannot be signed into yet", and `login` refuses it; the invitee sets their own
      // through `acceptInvite`, which is also what proves they hold the address.
      /**
       * `|| null`, not `?? null`: the dashboard's invite form posts `name: ''` when the
       * optional field is left blank, and an empty string is not a name — it is a record
       * claiming to HAVE one that happens to be blank, which then defeats every
       * `name ?? email` fallback downstream (the Team table rendered a nameless cell).
       * Normalised here rather than in the form, because the record is the service's.
       */
      .values({
        publicId: publicId("usr"),
        email,
        name: input.name?.trim() || null,
        passwordHash: null,
      })
      .returning();
  }
  const [existingMembership] = await systemDb
    .select()
    .from(memberships)
    .where(
      and(eq(memberships.organizationId, input.organizationId), eq(memberships.userId, user!.id)),
    )
    .limit(1);
  if (existingMembership) throw new AuthError("User is already a member of this organization");
  const inviteId = pending ? publicId("usr") : null;
  await systemDb.insert(memberships).values({
    organizationId: input.organizationId,
    userId: user!.id,
    role: target.role,
    customRoleId: target.customRole?.id ?? null,
    ...(pending ? { acceptedAt: null, inviteId, inviteName: input.name?.trim() || null } : {}),
  });

  const [org] = await systemDb
    .select()
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);
  const inviter = await inviterOf(input.actorUserId);
  if (pending) {
    await sendMembershipInviteEmail({
      user: user!,
      org: org!,
      dashboardBaseUrl: input.dashboardBaseUrl,
      inviter,
    });
  } else {
    await sendInviteEmail({
      user: user!,
      org: org!,
      dashboardBaseUrl: input.dashboardBaseUrl,
      inviter,
    });
  }
  const shownId = inviteId ?? user!.publicId;
  // An invite GRANTS A ROLE, so it belongs in the audit log next to the changes and
  // removals (2026-08-30). It was the one operator-privilege write with no trail at all.
  await writeAuditLog({
    organizationId: input.organizationId,
    action: "team.invite",
    resourceType: "user",
    resourceId: shownId,
    beforeFull: null,
    after: { email, role: target.role, custom_role: customRoleAudit(target.customRole) },
    actor: input.actorEmail ?? null,
    source: input.actorEmail ? "dashboard" : null,
  });

  return {
    userId: user!.id,
    userPublicId: shownId,
    email,
    organizationId: input.organizationId,
    organizationPublicId: org!.publicId,
    role: target.role,
    customRole: target.customRole,
  };
}

/** What an assignment resolves to: the stored role, its custom role, and its keys. */
interface AssignableRole {
  role: Role;
  customRole: CustomRoleRef | null;
  permissions: ReadonlySet<string>;
}

/** A fixed role code, or a live custom role of this organization by its `role_…` id. */
async function resolveAssignableRole(
  organizationId: string,
  role: string,
  db: Pick<typeof systemDb, "select"> = systemDb,
): Promise<AssignableRole> {
  if (isFixedRole(role)) return { role, customRole: null, permissions: fixedRolePermissions(role) };
  if (role.startsWith("role_")) {
    const [r] = await db
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.organizationId, organizationId),
          eq(roles.publicId, role),
          isNull(roles.deletedAt),
        ),
      )
      .limit(1);
    if (r) {
      const customRole = customRoleRef(r);
      return {
        role: "custom",
        customRole,
        permissions: effectivePermissions("custom", customRole),
      };
    }
    throw new AuthError(`No such role: ${role}`);
  }
  throw new AuthError(`Invalid role: ${role}`);
}

export function customRoleRef(r: typeof roles.$inferSelect): CustomRoleRef {
  return {
    id: r.id,
    publicId: r.publicId,
    name: r.name,
    version: r.version,
    permissions: r.permissions,
  };
}

const customRoleAudit = (r: CustomRoleRef | null | undefined) =>
  r ? { id: r.publicId, name: r.name } : null;

/** Refuse when `wanted` holds a key the actor lacks. */
export function assertGrantable(actor: ReadonlySet<string>, wanted: Iterable<string>): void {
  const missing = [...wanted].filter((k) => !actor.has(k));
  if (missing.length > 0) {
    throw new PermissionEscalationError(
      `We could not do this. The role has permissions that you do not have: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}. You can give only permissions that you have.`,
    );
  }
}

type Inviter = { name: string | null; email: string };

/** The person who sent an invite, named in its email. A seed or script has none. */
async function inviterOf(actorUserId?: string | null): Promise<Inviter | null> {
  if (!actorUserId) return null;
  const [a] = await systemDb
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, actorUserId))
    .limit(1);
  return a ?? null;
}

/**
 * Mint an invite token and mail the link.
 *
 * Failures are logged and swallowed. The membership is already committed by this point,
 * so throwing here would fail the admin's request after the colleague had in fact been
 * added — leaving a half-done invite and an error the admin would reasonably retry, which
 * then reports "already a member". A missing email is recoverable (resend); a phantom
 * failure is not.
 */
async function sendInviteEmail(input: {
  user: typeof users.$inferSelect;
  org: typeof organizations.$inferSelect;
  dashboardBaseUrl?: string | null;
  inviter?: Inviter | null;
}): Promise<void> {
  const base = input.dashboardBaseUrl?.replace(/\/$/, "");
  if (!base) {
    log.warn("user invited but DASHBOARD_BASE_URL is unset — no invite mail sent", {
      user: input.user.publicId,
    });
    return;
  }
  const token = `invt_${randomBytes(32).toString("base64url")}`;
  await systemDb.insert(authTokens).values({
    userId: input.user.id,
    tokenHash: sessionHash(token),
    purpose: "invite",
    // Longer than a password reset: a reset is something you asked for seconds ago, an
    // invite arrives unannounced and may sit until someone is back at their desk.
    expiresAt: new Date(Date.now() + config.INVITE_TTL_HOURS * 3600_000),
  });
  const rendered = renderInviteEmail({
    name: input.user.name,
    organizationName: input.org.name,
    link: `${base}/invite/s/${token}`,
    ttlHours: config.INVITE_TTL_HOURS,
    requiresTwoFactor: input.org.requireMfa,
    inviter: input.inviter,
  });
  try {
    await resolveMailer(null).send({
      to: input.user.email,
      from: config.MAIL_FROM,
      fromName: accountBrand().name,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    log.log("invite sent", { user: input.user.publicId, organizationId: input.org.publicId });
  } catch (err) {
    log.error(err, { event: "invite_send_failed", user: input.user.publicId });
  }
}

/** Holds a way to sign in: a password or a linked Google identity. */
function hasCredential(u: { passwordHash: string | null; googleSub: string | null }): boolean {
  return u.passwordHash !== null || u.googleSub !== null;
}

/** The pending-invite mail (0498). No token: accepting needs the person's own session. */
async function sendMembershipInviteEmail(input: {
  user: typeof users.$inferSelect;
  org: typeof organizations.$inferSelect;
  dashboardBaseUrl?: string | null;
  inviter?: Inviter | null;
}): Promise<void> {
  const base = input.dashboardBaseUrl?.replace(/\/$/, "");
  if (!base) {
    log.warn("membership invite but DASHBOARD_BASE_URL is unset — no mail sent", {
      user: input.user.publicId,
    });
    return;
  }
  const rendered = renderMembershipInviteEmail({
    name: input.user.name,
    organizationName: input.org.name,
    link: `${base}/invitations`,
    inviter: input.inviter,
  });
  try {
    await resolveMailer(null).send({
      to: input.user.email,
      from: config.MAIL_FROM,
      fromName: accountBrand().name,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    log.log("membership invite sent", {
      user: input.user.publicId,
      organizationId: input.org.publicId,
    });
  } catch (err) {
    log.error(err, { event: "invite_send_failed", user: input.user.publicId });
  }
}

/** Refuse unless the actor is an accepted OWNER of this organization. */
async function assertActorIsOwner(
  db: Pick<typeof systemDb, "select">,
  organizationId: string,
  actorUserId: string,
  message: string,
): Promise<void> {
  const [a] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.userId, actorUserId),
        isNotNull(memberships.acceptedAt),
      ),
    )
    .limit(1);
  if (a?.role !== "owner") throw new OwnerRequiredError(message);
}

/**
 * Accept an invite: spend the token, set the password the INVITEE chose, and sign them in.
 *
 * Doing both in one step is the point. The password is theirs alone from the first moment
 * the account is usable — there is no window in which someone else knew it — and receiving
 * the token is itself proof they control the address, so acceptance verifies the email
 * without a second round trip. That is why there is no separate "verify your email" flow
 * for invited operators: it would ask them to prove something they just proved.
 *
 * Single-use is enforced in the consuming UPDATE's own WHERE clause, and the purpose is
 * part of it — a password-reset token cannot be spent here.
 */
export async function acceptInvite(
  token: string,
  password: string,
  ctx: LoginContext = {},
): Promise<{ token: string; user: AuthedUser }> {
  if (!token.startsWith("invt_"))
    throw new AuthError("This invite link is not valid or is expired");
  // No email yet — the invitee is resolved from the token below. Length and the common-list
  // are the substantive checks; the similarity check is skipped rather than faked.
  const rejectedInvite = await rejectPassword(password);
  if (rejectedInvite) throw new AuthError(rejectedInvite);

  const now = new Date();
  const [claimed] = await systemDb
    .update(authTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authTokens.tokenHash, sessionHash(token)),
        eq(authTokens.purpose, "invite"),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    .returning();
  // One message for expired, spent, unknown and wrong-purpose alike — the route is
  // unauthenticated and the differences help only someone testing guesses.
  if (!claimed) throw new AuthError("This invite link is not valid or is expired");

  const [user] = await systemDb
    .update(users)
    .set({
      passwordHash: hashPassword(password),
      // They received mail at this address and acted on it. That IS the verification.
      emailVerifiedAt: now,
      failedLoginCount: 0,
      lockedUntil: null,
    })
    // Only an account nobody can sign into yet. A link must never set the password of an
    // account in use: that person joins through their own session (0498).
    .where(and(eq(users.id, claimed.userId!), isNull(users.passwordHash), isNull(users.googleSub)))
    .returning();
  if (!user) throw new AuthError("This invite link is not valid or is expired");
  // Other links to this account (a second org's invite) would otherwise still set a password.
  await systemDb
    .update(authTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authTokens.userId, user.id),
        eq(authTokens.purpose, "invite"),
        isNull(authTokens.consumedAt),
      ),
    );

  log.log("invite accepted", { user: user.publicId });
  // Through the choke point: an existing account with a second factor still owes its code.
  return completeSignIn(user, "password", ctx);
}

/**
 * Reset a user's password (admin/operator action — there is no public reset
 * flow yet). Re-hashes with the same scrypt scheme and revokes all existing
 * sessions so any leaked/old session is invalidated.
 */
export async function resetPassword(email: string, newPassword: string): Promise<void> {
  const e = email.toLowerCase().trim();
  const rejectedReset = await rejectPassword(newPassword, e);
  if (rejectedReset) throw new AuthError(rejectedReset);
  const [user] = await systemDb.select().from(users).where(eq(users.email, e)).limit(1);
  if (!user) throw new AuthError(`No account with email ${e}`);
  await systemDb
    .update(users)
    .set({ passwordHash: hashPassword(newPassword) })
    .where(eq(users.id, user.id));
  await systemDb.delete(sessions).where(eq(sessions.userId, user.id));
  // A password reset revokes every session for the account — the one auth event
  // an operator always wants a timestamped record of.
  log.info("password reset — all sessions revoked", { user: user.publicId });
  await forgetAllTrustedBrowsers(user.id, "password_reset");
  await securityEvent(user.id, "password_reset", { metadata: { by: "operator" } });
}

/**
 * Whether this account can be signed into with a password at all. A NULL hash means Google-only
 * (invited, settled with Google, never set one). Surfaced on `GET /auth/me` so the dashboard can
 * omit a "Current password" field that such an operator could not possibly satisfy — a field
 * nobody can fill is the dead control CLAUDE.md forbids, one layer in.
 */
export async function hasPassword(userId: string): Promise<boolean> {
  const [user] = await systemDb
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return Boolean(user?.passwordHash);
}

/**
 * The what's-new highwater — how many release notes this person had acknowledged.
 *
 * NULL means never initialised, and the DASHBOARD decides what that means (it reads it as
 * "caught up" and writes the current total back). The engine deliberately holds no opinion:
 * the notes are markdown files in the dashboard's own repo, so this side cannot know how many
 * exist, what they say, or when one shipped. An opaque integer is the entire contract.
 */
export async function releaseNotesSeenCount(userId: string): Promise<number | null> {
  const [user] = await systemDb
    .select({ seen: users.releaseNotesSeenCount })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user?.seen ?? null;
}

/**
 * Move the highwater. The caller supplies the count because only it can see the notes;
 * clamped to a non-negative integer so a malformed client cannot write nonsense. It can only
 * ever affect that person's own badge, so there is nothing here to authorize beyond the session.
 */
export async function markReleaseNotesSeen(userId: string, count: number): Promise<void> {
  const safe = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  await systemDb.update(users).set({ releaseNotesSeenCount: safe }).where(eq(users.id, userId));
}

/** Whether this person has finished or dismissed the product tour (0500). */
export async function productTourSeen(userId: string): Promise<boolean> {
  const [user] = await systemDb
    .select({ at: users.productTourSeenAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  // A missing row is treated as seen: never offer a tour on a read we could not make.
  return !user || user.at != null;
}

/** Record that the tour was finished or dismissed. Keeps the first time; a replay is a no-op. */
export async function markProductTourSeen(userId: string): Promise<void> {
  await systemDb
    .update(users)
    .set({ productTourSeenAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.productTourSeenAt)));
}

// ── the person's own profile and sessions (0327) ─────────────────────────────

export type ThemePreference = "light" | "dark" | "system";

export type AvatarSource = "upload" | "google";

export interface UserProfile {
  name: string | null;
  /** The photo to show: the uploaded one, else the Google account's, else null (initials). */
  avatarUrl: string | null;
  avatarSource: AvatarSource | null;
  theme: ThemePreference | null;
}

/** An uploaded photo wins over the Google one. */
export function effectiveAvatar(u: { avatarUrl: string | null; googlePictureUrl: string | null }): {
  url: string | null;
  source: AvatarSource | null;
} {
  if (u.avatarUrl) return { url: u.avatarUrl, source: "upload" };
  if (u.googlePictureUrl) return { url: u.googlePictureUrl, source: "google" };
  return { url: null, source: null };
}

export async function userProfile(userId: string): Promise<UserProfile> {
  const [u] = await systemDb
    .select({
      name: users.name,
      avatarUrl: users.avatarUrl,
      googlePictureUrl: users.googlePictureUrl,
      theme: users.theme,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const avatar = effectiveAvatar({
    avatarUrl: u?.avatarUrl ?? null,
    googlePictureUrl: u?.googlePictureUrl ?? null,
  });
  return {
    name: u?.name ?? null,
    avatarUrl: avatar.url,
    avatarSource: avatar.source,
    theme: (u?.theme as ThemePreference | null) ?? null,
  };
}

/**
 * Only the keys present change. An empty name clears it — the person then shows as their email.
 * `avatarUrl` is the UPLOADED photo; clearing it falls back to the Google one.
 */
export async function updateProfile(
  userId: string,
  patch: { name?: string | null; theme?: ThemePreference; avatarUrl?: string | null },
): Promise<UserProfile> {
  const set: Partial<typeof users.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name?.trim() || null;
  if (patch.theme !== undefined) set.theme = patch.theme;
  if (patch.avatarUrl !== undefined) set.avatarUrl = patch.avatarUrl;
  if (Object.keys(set).length) await systemDb.update(users).set(set).where(eq(users.id, userId));
  return userProfile(userId);
}

/**
 * Set or clear the UPLOADED photo and return the one it replaced, so the caller can delete
 * that object once this has committed. The row lock stops two concurrent replacements from
 * both reading the same "previous" and leaving one upload unaccounted for.
 */
export async function setUploadedAvatar(
  userId: string,
  url: string | null,
): Promise<{ profile: UserProfile; previousUpload: string | null }> {
  const previousUpload = await systemDb.transaction(async (tx) => {
    const [row] = await tx
      .select({ avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.id, userId))
      .for("update")
      .limit(1);
    await tx.update(users).set({ avatarUrl: url }).where(eq(users.id, userId));
    return row?.avatarUrl ?? null;
  });
  return {
    profile: await userProfile(userId),
    previousUpload: previousUpload === url ? null : previousUpload,
  };
}

export interface SessionSummary {
  id: string;
  createdAt: Date;
  /**
   * Derived: the idle deadline minus the idle window, so accurate to `REFRESH_THROTTLE_MS`.
   * Nothing else records use, and a second column would cost a write per request.
   */
  lastActiveAt: Date;
  createdIp: string | null;
  userAgent: string | null;
  authMethod: string | null;
  organizationName: string;
  current: boolean;
}

/** The person's live sessions across every organization, this browser first. */
export async function listSessions(
  userId: string,
  currentToken: string,
): Promise<SessionSummary[]> {
  const now = new Date();
  const rows = await systemDb
    .select({
      s: sessions,
      orgName: organizations.name,
      org: {
        sessionIdleMinutes: organizations.sessionIdleMinutes,
        sessionAbsoluteTtlHours: organizations.sessionAbsoluteTtlHours,
      },
    })
    .from(sessions)
    .innerJoin(organizations, eq(organizations.id, sessions.organizationId))
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)))
    .orderBy(desc(sessions.expiresAt));
  const mine = sessionHash(currentToken);
  return rows
    .filter(({ s, org }) => s.createdAt.getTime() + absoluteTtlMs(org) > now.getTime())
    .map(({ s, orgName }) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastActiveAt:
        s.lastActiveAt ??
        new Date(Math.max(s.createdAt.getTime(), s.expiresAt.getTime() - idleWindowMs())),
      createdIp: s.createdIp,
      userAgent: s.userAgent,
      authMethod: s.authMethod,
      organizationName: orgName,
      current: s.tokenHash === mine,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current));
}

/**
 * Sign out one of the person's OTHER sessions. Matched on the user as well as the id, so a
 * guessed or leaked id from someone else's account deletes nothing. This browser is refused:
 * that is "Sign out", which also clears the cookie.
 */
export async function revokeSession(
  userId: string,
  sessionId: string,
  currentToken: string,
  ctx: LoginContext = {},
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new AuthError("No such session");
  const gone = await systemDb
    .delete(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.userId, userId),
        ne(sessions.tokenHash, sessionHash(currentToken)),
      ),
    )
    .returning({ id: sessions.id });
  if (gone.length === 0) throw new AuthError("No such session");
  log.info("session signed out by its owner", { user: userId });
  await securityEvent(userId, "session_revoked", { ctx, metadata: { session: sessionId } });
}

/** "Sign out of other browsers": every session but this one. */
export async function revokeOtherSessions(
  userId: string,
  keepToken: string,
  ctx: LoginContext = {},
): Promise<number> {
  const gone = await systemDb
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, sessionHash(keepToken))))
    .returning({ id: sessions.id });
  log.info("other sessions signed out", { user: userId, signedOut: gone.length });
  await forgetAllTrustedBrowsers(userId, "signed_out_other_browsers", ctx);
  await securityEvent(userId, "sessions_revoked", { ctx, metadata: { signed_out: gone.length } });
  return gone.length;
}

/**
 * Self-serve password change for a logged-in user: verify the current password,
 * set the new one, and revoke the user's OTHER sessions (the current session,
 * identified by keepSessionToken, stays valid so the user isn't logged out).
 */
export async function changePassword(input: {
  userId: string;
  /** Absent is legal only when the account HAS no password — see below. */
  currentPassword?: string;
  newPassword: string;
  keepSessionToken?: string;
  ctx?: LoginContext;
}): Promise<void> {
  const [user] = await systemDb.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!user) throw new AuthError("Current password is incorrect");
  /**
   * A NULL hash means the account has NO password — it was invited and settled with Google
   * sign-in. Nothing to verify, so nothing is asked (2026-09-02, our user's instruction), and
   * this is the only route by which such an operator can ever acquire one: `loginWithGoogle`
   * spends the invite token that `acceptInvite` would otherwise have used.
   *
   * The reasoning this replaces — "must not become a way to set one without the invite token" —
   * guarded a state that no longer exists. A NULL hash then meant an UNACCEPTED invite with a
   * live token; reaching this line requires a valid session, which for a passwordless account
   * can only have come from Google.
   */
  if (user.passwordHash && !verifyPassword(input.currentPassword ?? "", user.passwordHash)) {
    throw new AuthError("Current password is incorrect");
  }
  // Policy check AFTER the current password is verified, deliberately (audit M4). This
  // route is authenticated, so there is no enumeration concern in that ordering — and
  // checking here is what makes the user's own email available to the similarity rule,
  // which is the whole reason it is not up with the other argument validation.
  const rejected = await rejectPassword(input.newPassword, user.email);
  if (rejected) throw new AuthError(rejected);
  await systemDb
    .update(users)
    .set({ passwordHash: hashPassword(input.newPassword) })
    .where(eq(users.id, user.id));
  if (input.keepSessionToken) {
    await systemDb
      .delete(sessions)
      .where(
        and(
          eq(sessions.userId, user.id),
          ne(sessions.tokenHash, sessionHash(input.keepSessionToken)),
        ),
      );
  } else {
    await systemDb.delete(sessions).where(eq(sessions.userId, user.id));
  }
  await forgetAllTrustedBrowsers(
    user.id,
    user.passwordHash ? "password_changed" : "password_added",
    input.ctx,
  );
  await securityEvent(user.id, user.passwordHash ? "password_changed" : "password_added", {
    ctx: input.ctx,
  });
}

/**
 * Log in with email+password → session token.
 *
 * Two controls, and they defend against different attacks (0191):
 *   - the per-account lockout below stops many passwords against ONE account;
 *   - the rate limit in `api/auth-routes.ts` stops one password against MANY accounts.
 * Neither substitutes for the other. With only the first, a credential-stuffing run
 * never trips anything: each account sees a single failure.
 */
/**
 * Raised when the password was right but a second factor is still required (audit M3).
 *
 * A DISTINCT error, not the generic refusal, and that is safe: the caller has already proven
 * the password, so telling them "now the code" reveals nothing they did not just demonstrate
 * they knew. Collapsing it into "Invalid email or password" would be indistinguishable from a
 * wrong password and leave them retyping a password that was correct.
 */
/** A verified Google identity with no account, on a deployment that allows sign-up (0354). */
export class GoogleSignupRequired extends Error {
  constructor(
    readonly identity: { sub: string; email: string; name: string | null; picture: string | null },
  ) {
    super("google sign-up required");
  }
}

export class MfaRequiredError extends AuthError {
  /**
   * A short-lived, single-use token standing for "this password was correct".
   *
   * It exists so the second step posts ONLY the code: the password is never re-sent, never
   * held in a hidden field, and never lands in browser history. Same shape as the reset and
   * invite tokens — hashed at rest, purpose-bound, spent in the consuming UPDATE's own WHERE.
   */
  readonly challenge: string;
  /** Who is signing in and how — the code step shows them, so a person can tell it is their attempt. */
  readonly email: string;
  readonly authMethod: FirstFactor;
  /** When support will turn this person's 2FA off, if a reset is pending — the code step says so. */
  readonly resetEffectiveAt: Date | null;
  /** Which methods the second step can offer (0330). Passkey names let it say "MacBook Pro or Pixel 8". */
  readonly methods: SecondStepMethods;
  constructor(
    challenge: string,
    email: string,
    authMethod: FirstFactor,
    resetEffectiveAt: Date | null = null,
    methods: SecondStepMethods = { passkeyNames: [], authenticatorApp: true },
    message = "Enter the code from your authenticator app",
  ) {
    super(message);
    this.name = "MfaRequiredError";
    this.challenge = challenge;
    this.email = email;
    this.authMethod = authMethod;
    this.resetEffectiveAt = resetEffectiveAt;
    this.methods = methods;
  }
}

export async function login(
  email: string,
  password: string,
  ctx: LoginContext = {},
  /** The TOTP or recovery code, when the caller already has one. */
  mfaCode?: string,
): Promise<{ token: string; user: AuthedUser }> {
  const e = email.toLowerCase().trim();
  const [user] = await systemDb.select().from(users).where(eq(users.email, e)).limit(1);

  // A locked account is refused BEFORE the hash runs, and answers with the same
  // message as a wrong password. Saying "this account is locked" would confirm the
  // address exists — turning the lockout into the account-enumeration oracle the
  // constant-time compare below exists to deny (SR-2026-010).
  const locked = !!user?.lockedUntil && user.lockedUntil > new Date();

  // Always run a hash comparison to avoid leaking which emails exist (timing). A user
  // with a NULL hash is an unaccepted INVITE (0197) — it cannot be signed into, and it
  // takes the dummy comparison like an unknown address so the refusal is
  // indistinguishable from a wrong password and reveals nothing about the account state.
  // Built in the CURRENT format at the CURRENT cost, and that is load-bearing (audit L1).
  // A literal legacy `salt:hash` dummy would be verified at Node's defaults — 36ms here —
  // while a real hash now costs 172ms at N=2^16. That difference IS the enumeration oracle
  // this dummy exists to deny: an unknown address would answer measurably faster than a
  // known one. Deriving it from the same parameters keeps the two indistinguishable.
  //
  // Residual, and small: a user whose stored hash is still legacy verifies faster than an
  // unknown address until their next successful login re-hashes them. It shrinks to nothing
  // as people sign in, and is the reverse direction from the leak that matters.
  const DUMMY = `scrypt$${1 << config.SCRYPT_COST_LOG2}$${SCRYPT_R}$${SCRYPT_P}$${"00".repeat(16)}$${"00".repeat(64)}`;
  const ok = user?.passwordHash
    ? verifyPassword(password, user.passwordHash)
    : verifyPassword(password, DUMMY);
  if (!user || !user.passwordHash || !ok || locked) {
    if (user && !locked) await recordFailedLogin(user.id, user.failedLoginCount);
    // The TABLE carries the address and the outcome; the log line still carries neither
    // (audit M5). That split is the point — `login_attempts` is queryable by whoever is
    // investigating, while the log sink is shipped off-box and read by more people, so it
    // keeps saying nothing about which addresses exist.
    await recordLoginAttempt(locked ? "locked" : user ? "bad_password" : "unknown_user", {
      email,
      userId: user?.id,
      ctx,
    });
    // No email in the line: the whole point of the constant-time compare above is
    // not to reveal which addresses exist, and a log sink is not a private place.
    log.info("failed dashboard login", { userKnown: !!user, locked });
    throw new AuthError("Invalid email or password");
  }

  // Clear the counter on success — the threshold counts CONSECUTIVE failures, so a
  // user who mistypes twice and then gets it right starts from zero again. Written
  // only when there is something to clear, so the ordinary login stays one read.
  if (user.failedLoginCount > 0 || user.lockedUntil) {
    await systemDb
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, user.id));
  }

  // Upgrade the stored hash opportunistically (audit L1). This is the only moment the
  // plaintext is available, so it is the only moment a re-hash is possible — which is why
  // raising SCRYPT_COST_LOG2 is a config change and not a migration. Failing to write the
  // upgrade must not fail a login that already succeeded.
  if (passwordHashNeedsUpgrade(user.passwordHash)) {
    try {
      await systemDb
        .update(users)
        .set({ passwordHash: hashPassword(password) })
        .where(eq(users.id, user.id));
    } catch (e) {
      log.warn("password hash upgrade failed — login still succeeded", {
        detail: (e as Error).message,
      });
    }
  }

  return completeSignIn(user, "password", ctx, { email, mfaCode });
}

/** A first factor: what proves who you are before the second step. */
export type FirstFactor = "password" | "google";
/** A passkey sign-in (0330) is both factors at once. */
export type SignInMethod = FirstFactor | "passkey";
/** What `sessions.auth_method` records: the first factor, and whether a trusted browser skipped the code. */
export type SessionAuthMethod = SignInMethod | `${FirstFactor}+trusted_browser`;

export interface SecondStepMethods {
  passkeyNames: string[];
  authenticatorApp: boolean;
}

/**
 * The ONLY place a verified first factor becomes a session. Every sign-in door — password,
 * Google redirect, One Tap, invite acceptance — ends here, so none can skip the second factor.
 *
 * With a confirmed second factor and no code, nothing is minted: the caller gets a challenge.
 */
async function completeSignIn(
  user: typeof users.$inferSelect,
  authMethod: SignInMethod,
  ctx: LoginContext,
  opts: { email?: string; mfaCode?: string } = {},
): Promise<{ token: string; user: AuthedUser }> {
  const email = opts.email ?? user.email;
  // A passkey is possession plus a fingerprint, face or PIN: it is the second factor.
  if (authMethod === "passkey") {
    return finishSignIn(user, ctx, { authMethod, mfaAt: new Date(), email });
  }
  if (await hasConfirmedMfa(user.id)) {
    // A trusted browser skips the step, and only the step: the session gets no `mfa_at`, so it
    // never counts as a second factor (0329).
    if (!opts.mfaCode && (await isTrustedBrowser(user.id, ctx.trustedBrowserToken))) {
      return finishSignIn(user, ctx, {
        authMethod: `${authMethod}+trusted_browser`,
        mfaAt: null,
        email,
      });
    }
    if (!opts.mfaCode) {
      // Not counted as a failed login: the first factor was right, and counting it would let
      // anyone who knows a password lock the account out by never sending a code.
      await recordLoginAttempt("mfa_failed", { email, userId: user.id, ctx });
      throw new MfaRequiredError(
        await mintMfaChallenge(user.id, ctx, authMethod),
        user.email,
        authMethod,
        await pendingMfaReset(user.id),
        await secondStepMethods(user.id),
      );
    }
    const check = await verifyMfaForLogin(user.id, opts.mfaCode);
    if (!check.ok) {
      // A wrong code counts against the same lockout a wrong password uses.
      await recordFailedLogin(user.id, user.failedLoginCount);
      await recordLoginAttempt("mfa_failed", { email, userId: user.id, ctx });
      await recordFailedSecondFactor(user.id, authMethod, ctx);
      log.info("failed second factor", { user: user.id });
      throw new AuthError("That code is not valid");
    }
    await noteRecoveryCodeUsed(user.id, check, ctx, "sign_in");
    return finishSignIn(user, ctx, { authMethod, mfaAt: new Date(), email });
  }
  return finishSignIn(user, ctx, { authMethod, mfaAt: null, email });
}

/** Record the success and mint the session. Successes are logged so "did anything succeed?" is answerable. */
async function finishSignIn(
  user: typeof users.$inferSelect,
  ctx: LoginContext,
  how: { authMethod: SessionAuthMethod; mfaAt: Date | null; email: string },
): Promise<{ token: string; user: AuthedUser }> {
  await recordLoginAttempt("success", { email: how.email, userId: user.id, ctx });
  await systemDb
    .update(users)
    .set({ lastLoginAt: new Date(), lastLoginIp: ctx.ip ?? null })
    .where(eq(users.id, user.id));
  return startSessionFor(user, ctx, {
    authMethod: how.authMethod,
    mfaAt: how.mfaAt,
    // A sign-in is a step-up, unless a trusted browser skipped the second factor (0329).
    stepUpAt: how.authMethod.endsWith("+trusted_browser") ? null : new Date(),
  });
}

/**
 * Which organization a sign-in opens, for a user who may belong to several (0194).
 *
 * `lastOrganizationId` is a PREFERENCE and is re-checked against a live membership
 * every time. That re-check is the whole point: a user removed from an org still
 * carries the pointer, and honouring it blindly would walk them back in. Falls back to
 * the oldest membership — deterministic, unlike the previous `LIMIT 1` with no
 * `ORDER BY`, which returned whichever row Postgres felt like and could differ between
 * two logins by the same person.
 */
async function resolveLoginOrganization(userId: string, preferred: string | null) {
  const rows = await systemDb
    .select()
    .from(memberships)
    // A pending invite (0498) is never a place to land.
    .where(and(eq(memberships.userId, userId), isNotNull(memberships.acceptedAt)))
    .orderBy(memberships.createdAt);
  if (rows.length === 0) return null;
  return rows.find((m) => m.organizationId === preferred) ?? rows[0]!;
}

/** Mint a session in the user's resolved organization. Shared by password and Google sign-in. */
export async function startSessionFor(
  user: typeof users.$inferSelect,
  ctx: LoginContext,
  how: SessionOrigin,
): Promise<{ token: string; user: AuthedUser }> {
  const m = await resolveLoginOrganization(user.id, user.lastOrganizationId);
  if (!m) throw new AuthError("User has no organization membership");
  const [org] = await systemDb
    .select()
    .from(organizations)
    .where(eq(organizations.id, m.organizationId))
    .limit(1);

  // Remember where they landed, so the next sign-in opens the same place. Only when it
  // actually changed — an ordinary repeat login should not write.
  if (user.lastOrganizationId !== m.organizationId) {
    await systemDb
      .update(users)
      .set({ lastOrganizationId: m.organizationId })
      .where(eq(users.id, user.id));
  }

  const token = await createSession(user.id, m.organizationId, ctx, how);
  return {
    token,
    user: {
      userId: user.id,
      userPublicId: user.publicId,
      email: user.email,
      organizationId: m.organizationId,
      organizationPublicId: org!.publicId,
      role: m.role as Role,
    },
  };
}

export interface MembershipSummary {
  organizationId: string;
  organizationPublicId: string;
  organizationName: string;
  /** The organization's sidebar logo (0322), or null. */
  organizationIconUrl: string | null;
  role: Role;
  /** True for the org this session is currently acting in. */
  current: boolean;
}

/** Every organization this user belongs to. Drives the switcher. */
export async function listMemberships(
  userId: string,
  currentOrganizationId: string,
): Promise<MembershipSummary[]> {
  const rows = await systemDb
    .select({ m: memberships, o: organizations })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.userId, userId), isNotNull(memberships.acceptedAt)))
    .orderBy(memberships.createdAt);
  return rows.map(({ m, o }) => ({
    organizationId: m.organizationId,
    organizationPublicId: o.publicId,
    organizationName: o.name,
    organizationIconUrl: o.iconUrl ?? null,
    role: m.role as Role,
    current: m.organizationId === currentOrganizationId,
  }));
}

// ── pending invites (0498) ───────────────────────────────────────────────────────────
//
// An invite to an address that already has an account waits for that person. The session is
// the proof of control: only the account's own signed-in session can list, accept or decline.

export interface PendingInvite {
  organizationPublicId: string;
  organizationName: string;
  organizationIconUrl: string | null;
  role: Role;
  customRoleName: string | null;
  invitedAt: Date;
}

/** The signed-in person's pending invites, oldest first. */
export async function listPendingInvites(userId: string): Promise<PendingInvite[]> {
  const rows = await systemDb
    .select({ m: memberships, o: organizations, r: roles })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .leftJoin(roles, eq(roles.id, memberships.customRoleId))
    .where(and(eq(memberships.userId, userId), isNull(memberships.acceptedAt)))
    .orderBy(memberships.createdAt);
  return rows.map(({ m, o, r }) => ({
    organizationPublicId: o.publicId,
    organizationName: o.name,
    organizationIconUrl: o.iconUrl ?? null,
    role: m.role as Role,
    customRoleName: r?.name ?? null,
    invitedAt: m.createdAt,
  }));
}

const NO_SUCH_INVITE = "We could not find this invite. It was accepted, declined or cancelled.";

/** The pending row of this user in the org named by public id, or a refusal. */
async function pendingInviteFor(tx: Tx, userId: string, organizationPublicId: string) {
  const [row] = await tx
    .select({ m: memberships, o: organizations })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(organizations.publicId, organizationPublicId),
        isNull(memberships.acceptedAt),
      ),
    )
    .limit(1);
  if (!row) throw new AuthError(NO_SUCH_INVITE);
  return row;
}

/** Accept a pending invite. From here the org sees the account as it is. */
export async function acceptMembershipInvite(input: {
  userId: string;
  userPublicId: string;
  email: string;
  organizationPublicId: string;
}): Promise<{ organizationPublicId: string }> {
  const accepted = await systemDb.transaction(async (tx) => {
    const { m, o } = await pendingInviteFor(tx, input.userId, input.organizationPublicId);
    await lockMemberships(tx, m.organizationId);
    const [done] = await tx
      .update(memberships)
      .set({ acceptedAt: new Date(), inviteId: null, inviteName: null })
      .where(and(eq(memberships.id, m.id), isNull(memberships.acceptedAt)))
      .returning({ id: memberships.id });
    if (!done) throw new AuthError(NO_SUCH_INVITE);
    await writeAuditLog(
      {
        organizationId: m.organizationId,
        action: "team.accept_invite",
        resourceType: "user",
        resourceId: input.userPublicId,
        before: { invite: m.inviteId },
        after: { email: input.email, role: m.role },
        actor: input.email,
        source: "dashboard",
      },
      tx,
    );
    return o.publicId;
  });
  log.log("membership invite accepted", { user: input.userPublicId, organizationId: accepted });
  return { organizationPublicId: accepted };
}

/** Decline a pending invite: the row goes, the account is untouched. */
export async function declineMembershipInvite(input: {
  userId: string;
  email: string;
  organizationPublicId: string;
}): Promise<void> {
  await systemDb.transaction(async (tx) => {
    const { m } = await pendingInviteFor(tx, input.userId, input.organizationPublicId);
    await lockMemberships(tx, m.organizationId);
    const gone = await tx
      .delete(memberships)
      .where(and(eq(memberships.id, m.id), isNull(memberships.acceptedAt)))
      .returning({ id: memberships.id });
    if (gone.length === 0) throw new AuthError(NO_SUCH_INVITE);
    // The org never saw the account's id, so the trail names the invite's.
    await writeAuditLog(
      {
        organizationId: m.organizationId,
        action: "team.decline_invite",
        resourceType: "user",
        resourceId: m.inviteId,
        before: { email: input.email, role: m.role },
        after: null,
        actor: input.email,
        source: "dashboard",
      },
      tx,
    );
  });
}

// ── team management (2026-08-30) ────────────────────────────────────────────────────
//
// The Team screen could invite and nothing else: no list of who is in the org, no way to
// change a role, no way to take access away. An org that can only ever gain members is not
// an access-control surface, and "remove the person who left" was a psql job.
//
// EVERY GUARD BELOW LIVES HERE, NOT IN THE ROUTE. The route decides who may call; this
// decides what is a legal end state. A guard in a route is a guard one caller has —
// a second entry point (a CLI, a support tool, the next route someone adds) would not
// inherit it, and the invariant these protect is that an organization never becomes
// unadministrable.
//
// Never gated on re-authentication, and now trivially so: `requireStepUp` was deleted on
// 2026-09-02 (audit M3.3 rolled back on our user's instruction — docs/PROGRESS.md). The
// original reasoning still holds and is why this should not grow a one-sided gate later:
// `/auth/invite` grants a role too, so gating only the role CHANGE would be theatre — the
// same privilege is reachable one field away. If operator-privilege changes should need a
// re-authentication, both routes get it together.

export interface TeamMemberSummary {
  /** `usr_…` — the public id, which is what the dashboard sends back. Never the uuid. */
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: Role;
  /** The custom role, when `role` is `custom`. */
  customRole: { id: string; name: string } | null;
  /**
   * `invited` = the invite is outstanding: the account holds no credential yet, or the row is
   * a pending invite to an existing account (0498) that its owner has not accepted.
   */
  status: "active" | "invited";
  /** Has a CONFIRMED second factor. */
  mfaEnabled: boolean;
  /**
   * Required to hold one: the organization requires 2FA (0329), or the deprecated
   * `MFA_REQUIRED_ROLES` names this role. `mfaRequired && !mfaEnabled` = owes us an enrolment.
   */
  mfaRequired: boolean;
  /** The organization's requirement: the last day they may go without 2FA (YYYY-MM-DD, org zone). */
  mfaDeadlineDay: string | null;
  /** Past that day without 2FA: the API refuses their session in this organization. */
  mfaBlocked: boolean;
  lastLoginAt: Date | null;
  /** When they were added to THIS organization. */
  memberSince: Date;
  /** True for the caller's own row. The UI disables its own controls; the service refuses them anyway. */
  isSelf: boolean;
}

/** Fixed roles that administer the org. An org keeps at least one member with one, and one owner. */
const ADMINISTERS: ReadonlySet<string> = new Set(["owner", "admin"]);

/** Everyone in one organization, oldest membership first. Drives the Team screen. */
export async function listTeam(
  organizationId: string,
  actorUserId: string,
): Promise<TeamMemberSummary[]> {
  const rows = await systemDb
    .select({ m: memberships, u: users, mfa: userMfa.confirmedAt, r: roles })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(userMfa, eq(userMfa.userId, memberships.userId))
    .leftJoin(roles, eq(roles.id, memberships.customRoleId))
    .where(eq(memberships.organizationId, organizationId))
    .orderBy(memberships.createdAt);
  const [org] = await systemDb
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  const now = new Date();
  return rows.map(({ m, u, mfa, r }) => {
    // Pending (0498): only what the inviter entered. Nothing of the account reaches the org,
    // so the row reads exactly like a brand-new invitee's.
    const pending = m.acceptedAt === null;
    const satisfied = !pending && !!mfa;
    const standing = org
      ? twoFactorStanding({ org, joinedAt: m.acceptedAt ?? m.createdAt, satisfied, now })
      : null;
    return {
      id: pending ? m.inviteId! : u.publicId,
      email: u.email,
      name: pending ? m.inviteName : u.name,
      avatarUrl: pending ? null : effectiveAvatar(u).url,
      role: m.role as Role,
      customRole: r ? { id: r.publicId, name: r.name } : null,
      status: pending || !hasCredential(u) ? "invited" : "active",
      mfaEnabled: satisfied,
      mfaRequired: roleRequiresMfa(m.role, org) || !!standing?.required,
      mfaDeadlineDay: standing?.required ? standing.deadlineDay : null,
      mfaBlocked: !!standing?.blocked,
      lastLoginAt: pending ? null : u.lastLoginAt,
      memberSince: m.createdAt,
      isSelf: u.id === actorUserId,
    };
  });
}

/**
 * Resolve one membership in this org by the target's PUBLIC id, with its custom role.
 *
 * By membership, never by user id alone: a lookup that finds the user first and checks the
 * org second is one forgotten `&&` away from editing a member of another org. Not found and
 * not-a-member give one answer, so this cannot probe which addresses have accounts.
 *
 * A pending row answers only to its invite id: the account's own id would confirm it exists.
 */
async function memberByPublicId(
  organizationId: string,
  targetPublicId: string,
  db: Pick<typeof systemDb, "select"> = systemDb,
) {
  const [row] = await db
    .select({ m: memberships, u: users, r: roles })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(roles, eq(roles.id, memberships.customRoleId))
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        or(
          and(eq(users.publicId, targetPublicId), isNotNull(memberships.acceptedAt)),
          and(eq(memberships.inviteId, targetPublicId), isNull(memberships.acceptedAt)),
        ),
      ),
    )
    .limit(1);
  if (!row) throw new AuthError("No such team member");
  const pending = row.m.acceptedAt === null;
  return { ...row, pending, shownId: pending ? row.m.inviteId! : row.u.publicId };
}

/**
 * Serialise every membership write of one organization. The last-admin and last-owner counts
 * are read under it, so two admins demoting each other at once cannot both pass the count.
 */
async function lockMemberships(tx: Tx, organizationId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"members:" + organizationId}))`);
}

/** Refuse a change that leaves no owner, or no owner-or-admin. Run under `lockMemberships`. */
async function assertAdministrable(
  tx: Tx,
  organizationId: string,
  targetUserId: string,
  from: string,
  to: string | null,
): Promise<void> {
  const others = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        ne(memberships.userId, targetUserId),
        // A pending invite administers nothing until it is accepted (0498).
        isNotNull(memberships.acceptedAt),
      ),
    );
  if (
    ADMINISTERS.has(from) &&
    !(to && ADMINISTERS.has(to)) &&
    !others.some((o) => ADMINISTERS.has(o.role))
  ) {
    throw new AuthError("The organization must keep at least one owner or admin");
  }
  if (from === "owner" && to !== "owner" && !others.some((o) => o.role === "owner")) {
    throw new AuthError("The organization must keep at least one owner");
  }
}

/** The actor must hold everything the member's current role holds before touching it. */
function assertMayTouch(actor: ReadonlySet<string> | undefined, current: ReadonlySet<string>) {
  if (!actor) return;
  if ([...current].some((k) => !actor.has(k))) {
    throw new PermissionEscalationError(
      "We could not change this member. Their role has permissions that you do not have. Ask an owner or admin.",
    );
  }
}

/**
 * Change a member's role: a fixed role code or a custom role's `role_…` id.
 *
 * Bites on their NEXT REQUEST with nothing to invalidate: `resolveSession` reads the membership
 * (and its custom role) on every call.
 */
export async function changeMemberRole(input: {
  organizationId: string;
  actorUserId: string;
  actorEmail: string;
  /** The actor's effective permissions; the escalation guard needs them. */
  actorPermissions?: ReadonlySet<string>;
  targetPublicId: string;
  role: string;
}): Promise<TeamMemberSummary> {
  const changed = await systemDb.transaction(async (tx) => {
    await lockMemberships(tx, input.organizationId);
    const { m, u, r, pending, shownId } = await memberByPublicId(
      input.organizationId,
      input.targetPublicId,
      tx,
    );
    // Self-demotion can lock a young org out; another owner or admin must do it.
    if (u.id === input.actorUserId) {
      throw new AuthError("You cannot change your own role. Ask another owner or admin.");
    }
    const target = await resolveAssignableRole(input.organizationId, input.role, tx);
    const currentRef = r ? customRoleRef(r) : null;
    assertMayTouch(input.actorPermissions, effectivePermissions(m.role, currentRef));
    if (input.actorPermissions) assertGrantable(input.actorPermissions, target.permissions);
    if (m.role === target.role && (m.customRoleId ?? null) === (target.customRole?.id ?? null)) {
      return null;
    }
    if (!pending) await assertAdministrable(tx, input.organizationId, u.id, m.role, target.role);
    if (m.role === "owner" || target.role === "owner") {
      await assertActorIsOwner(
        tx,
        input.organizationId,
        input.actorUserId,
        m.role === "owner"
          ? "We could not change this member. Only an owner can change the role of an owner."
          : "We could not change this member. Only an owner can give the owner role.",
      );
    }

    await tx
      .update(memberships)
      .set({ role: target.role, customRoleId: target.customRole?.id ?? null })
      .where(eq(memberships.id, m.id));
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        action: "team.role_change",
        resourceType: "user",
        resourceId: shownId,
        before: { role: m.role, custom_role: customRoleAudit(currentRef) },
        after: { role: target.role, custom_role: customRoleAudit(target.customRole) },
        actor: input.actorEmail,
        source: "dashboard",
      },
      tx,
    );
    return { userId: u.id, publicId: shownId, from: m.role, to: target, pending };
  });
  // No notice to a pending invitee: they have not joined, and the mail would name the org.
  if (changed && !changed.pending) {
    const [org] = await systemDb
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .limit(1);
    const roleName = changed.to.customRole?.name ?? changed.to.role;
    await securityEvent(changed.userId, "role_changed", {
      metadata: { organization: org?.name ?? "", role: roleName },
      email: { organizationName: org?.name ?? "", roleName },
    });
    log.log("member role changed", {
      organizationId: input.organizationId,
      user: changed.publicId,
      from: changed.from,
      to: changed.to.role,
    });
  }
  return single(input.organizationId, input.actorUserId, input.targetPublicId);
}

/**
 * Remove a member from the organization: the membership and this org's sessions for them.
 *
 * The USER row survives. A person may belong to several organizations, and their address is
 * the actor on every audit row they wrote.
 */
export async function removeMember(input: {
  organizationId: string;
  actorUserId: string;
  actorEmail: string;
  actorPermissions?: ReadonlySet<string>;
  targetPublicId: string;
}): Promise<{ email: string }> {
  const removed = await systemDb.transaction(async (tx) => {
    await lockMemberships(tx, input.organizationId);
    const { m, u, r, pending, shownId } = await memberByPublicId(
      input.organizationId,
      input.targetPublicId,
      tx,
    );
    if (u.id === input.actorUserId) {
      throw new AuthError("You cannot remove yourself from the organization");
    }
    assertMayTouch(
      input.actorPermissions,
      effectivePermissions(m.role, r ? customRoleRef(r) : null),
    );
    if (!pending) await assertAdministrable(tx, input.organizationId, u.id, m.role, null);
    if (m.role === "owner") {
      await assertActorIsOwner(
        tx,
        input.organizationId,
        input.actorUserId,
        "We could not remove this member. Only an owner can remove an owner.",
      );
    }

    await tx.delete(memberships).where(eq(memberships.id, m.id));
    await tx
      .delete(sessions)
      .where(and(eq(sessions.userId, u.id), eq(sessions.organizationId, input.organizationId)));

    // Revoke outstanding invite links only when this was their last membership: `auth_tokens`
    // has no organization column, so deleting by user would void an invite to another org.
    const remaining = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.userId, u.id))
      .limit(1);
    if (remaining.length === 0) {
      await tx
        .delete(authTokens)
        .where(
          and(
            eq(authTokens.userId, u.id),
            eq(authTokens.purpose, "invite"),
            isNull(authTokens.consumedAt),
          ),
        );
    }

    await writeAuditLog(
      {
        organizationId: input.organizationId,
        action: "team.remove",
        resourceType: "user",
        resourceId: shownId,
        before: {
          email: u.email,
          role: m.role,
          custom_role: r ? { id: r.publicId, name: r.name } : null,
        },
        after: null,
        actor: input.actorEmail,
        source: "dashboard",
      },
      tx,
    );
    return { publicId: shownId, email: u.email, role: m.role };
  });
  log.log("member removed", {
    organizationId: input.organizationId,
    user: removed.publicId,
    role: removed.role,
  });
  return { email: removed.email };
}

/**
 * Mail a fresh invite link to a member who has not accepted yet.
 *
 * Without this an expired invite (72h) was a dead end: the address already holds a
 * membership, so re-inviting answers "already a member of this organization", and there
 * was no other way to produce a new link.
 *
 * Refused for a member who already holds a credential, because for them there is
 * nothing to accept — they sign in and switch organization, and if they have forgotten
 * their password that is what the reset flow is for. Sending an invite link would offer
 * a second, admin-triggered path to set a password on an existing account.
 *
 * Earlier links are left alone rather than invalidated: more than one may legitimately
 * be outstanding (see the note on `auth_tokens`), each is single-use, and each carries
 * its own expiry.
 *
 * A pending invite to an existing account (0498) gets its tokenless mail again.
 */
export async function resendMemberInvite(input: {
  organizationId: string;
  actorUserId: string;
  actorEmail: string;
  targetPublicId: string;
  dashboardBaseUrl?: string | null;
}): Promise<{ email: string }> {
  const { u, pending, shownId } = await memberByPublicId(
    input.organizationId,
    input.targetPublicId,
  );
  if (!pending && hasCredential(u)) {
    throw new AuthError("This member has already accepted their invite and can sign in");
  }
  const [org] = await systemDb
    .select()
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);
  const inviter = await inviterOf(input.actorUserId);
  if (pending) {
    await sendMembershipInviteEmail({
      user: u,
      org: org!,
      dashboardBaseUrl: input.dashboardBaseUrl,
      inviter,
    });
  } else {
    await sendInviteEmail({
      user: u,
      org: org!,
      dashboardBaseUrl: input.dashboardBaseUrl,
      inviter,
    });
  }
  await writeAuditLog({
    organizationId: input.organizationId,
    action: "team.resend_invite",
    resourceType: "user",
    resourceId: shownId,
    after: { email: u.email },
    actor: input.actorEmail,
    source: "dashboard",
  });
  return { email: u.email };
}

/** One member, re-read after a write so the caller renders what the DB now holds. */
async function single(
  organizationId: string,
  actorUserId: string,
  targetPublicId: string,
): Promise<TeamMemberSummary> {
  const all = await listTeam(organizationId, actorUserId);
  const found = all.find((r) => r.id === targetPublicId);
  if (!found) throw new AuthError("No such team member");
  return found;
}

/**
 * Move this session into another of the user's organizations.
 *
 * ⚠ THE MEMBERSHIP CHECK BELOW IS THE WHOLE SECURITY OF THIS FUNCTION. Two Minute
 * Reports shipped the same feature without it — `set-selected-team` accepted any team
 * id the caller named and updated their context to it (SR-2026-008 Issue #4), which
 * turned a convenience into cross-tenant access. The organization is looked up BY
 * MEMBERSHIP, never by the id alone, so an org the user does not belong to cannot be
 * found here at all.
 *
 * Rotates the session token as well as re-scoping it. Changing which tenant a
 * credential acts in is a privilege change, and a privilege change should not leave the
 * old bearer value working — anyone holding a copy of the pre-switch token would
 * otherwise silently follow the user into the new organization.
 */
export async function switchOrganization(
  sessionToken: string,
  organizationPublicId: string,
): Promise<{ token: string; user: AuthedUser }> {
  const actor = await resolveSession(sessionToken);
  if (!actor) throw new AuthError("Not signed in");

  const [row] = await systemDb
    .select({ m: memberships, o: organizations })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(
      and(
        eq(memberships.userId, actor.userId),
        eq(organizations.publicId, organizationPublicId),
        // A pending invite (0498) answers like no membership at all.
        isNotNull(memberships.acceptedAt),
      ),
    )
    .limit(1);
  // Not a member, or no such organization — one answer for both. Distinguishing them
  // would confirm an org id exists to someone who cannot reach it.
  if (!row) throw new AuthError("No such organization");

  // The rotated session keeps how the old one was proven; switching is not a sign-in.
  const [old] = await systemDb
    .delete(sessions)
    .where(eq(sessions.tokenHash, sessionHash(sessionToken)))
    .returning({
      authMethod: sessions.authMethod,
      mfaAt: sessions.mfaAt,
      stepUpAt: sessions.stepUpAt,
    });
  await systemDb
    .update(users)
    .set({ lastOrganizationId: row.m.organizationId })
    .where(eq(users.id, actor.userId));
  const token = await createSession(
    actor.userId,
    row.m.organizationId,
    {},
    {
      authMethod: (old?.authMethod as SessionAuthMethod | null) ?? null,
      mfaAt: old?.mfaAt ?? null,
      stepUpAt: old?.stepUpAt ?? null,
    },
  );
  log.log("organization switched", { user: actor.userPublicId, organizationId: row.o.publicId });
  return {
    token,
    user: {
      userId: actor.userId,
      userPublicId: actor.userPublicId,
      email: actor.email,
      organizationId: row.m.organizationId,
      organizationPublicId: row.o.publicId,
      role: row.m.role as Role,
    },
  };
}

/**
 * Sign in an operator whose Google identity has already been VERIFIED by the caller
 * (`api/google-oauth.ts` exchanges the code at Google's token endpoint over TLS and
 * checks the id-token claims). This function trusts its inputs and does the account
 * work; it must never be reachable from unverified data.
 *
 * INVITE-ONLY, by product decision. An address Google authenticates but that holds no
 * membership is refused — nothing here creates a user or an organization. So Google is
 * a way for an existing operator to sign in, not a way in.
 *
 * Identity is the `sub`, not the address. Email resolves the invited user ONCE, on
 * first sign-in, and only when Google asserts the address is verified; from then on the
 * `sub` is the link. Matching on email forever would be wrong twice over — a person who
 * changes their Google address becomes a stranger, and whoever later acquires a
 * recycled address inherits their account.
 */
export async function loginWithGoogle(
  input: {
    googleSub: string;
    email: string;
    emailVerified: boolean;
    name?: string | null;
    /** Google's photo URL, already limited to `https:`. Absent or null clears the stored one. */
    picture?: string | null;
  },
  /**
   * The client that signed in. Defaulted so the signature stays additive, but the caller
   * DOES pass one — without it `last_login_ip` and the attempt row have no address, which
   * is most of what makes them useful after a suspicious burst.
   */
  ctx: LoginContext = {},
): Promise<{ token: string; user: AuthedUser }> {
  const e = input.email.toLowerCase().trim();

  let [user] = await systemDb
    .select()
    .from(users)
    .where(eq(users.googleSub, input.googleSub))
    .limit(1);

  if (!user) {
    // First Google sign-in for this account. Google must vouch for the address before
    // it can be used to claim an existing user — an unverified address on a Google
    // account is a self-asserted string, and honouring it would let anyone who can set
    // one take over the invited operator who really owns it.
    if (!input.emailVerified) {
      log.info("google sign-in refused — address not verified by Google", { userKnown: false });
      throw new AuthError("Your Google account has no verified email address");
    }
    [user] = await systemDb.select().from(users).where(eq(users.email, e)).limit(1);
    if (!user && signupOffered()) {
      // Self-serve sign-up (0354). Google proved the address, so offering the form reveals
      // nothing about anyone else's.
      throw new GoogleSignupRequired({
        sub: input.googleSub,
        email: e,
        name: input.name ?? null,
        picture: input.picture ?? null,
      });
    }
    if (!user) {
      // Invite-only. Deliberately the SAME message as a user who exists without a
      // membership below: neither answer should reveal whether an address is known here.
      log.info("google sign-in refused — no account for this address");
      throw new AuthError(
        "No tmbilling account is linked to that Google address. Ask an administrator for an invite.",
      );
    }
    if (user.googleSub && user.googleSub !== input.googleSub) {
      // The address matches a user already bound to a DIFFERENT Google account. Refuse
      // rather than re-bind: this is what a takeover attempt looks like.
      log.info("google sign-in refused — address is bound to another Google account", {
        user: user.publicId,
      });
      throw new AuthError("That address is already linked to a different Google account");
    }
    await systemDb
      .update(users)
      .set({
        googleSub: input.googleSub,
        emailVerifiedAt: new Date(),
        ...(user.name ? {} : { name: input.name ?? null }),
      })
      .where(eq(users.id, user.id));
    user = { ...user, googleSub: input.googleSub };
    log.log("google account linked", { user: user.publicId });
  }

  const [m] = await systemDb
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, user.id), isNotNull(memberships.acceptedAt)))
    .limit(1);
  if (!m) {
    throw new AuthError(
      "No tmbilling account is linked to that Google address. Ask an administrator for an invite.",
    );
  }
  // A locked account stays locked whichever door is tried. Google sign-in bypassing the
  // lockout would make the lockout a password-only control and the attacker's job a
  // matter of choosing the other entrance.
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    log.info("google sign-in refused — account locked", { user: user.publicId });
    throw new AuthError("Invalid email or password");
  }

  // Kept current on every Google sign-in, and cleared when Google sends none: a photo the
  // person removed from Google must not stay on their profile here.
  const picture = input.picture ?? null;
  if (user.googlePictureUrl !== picture) {
    await systemDb.update(users).set({ googlePictureUrl: picture }).where(eq(users.id, user.id));
  }

  /**
   * An invited person who signs in with Google never spends their emailed link — and that
   * link is a live password-setting credential (`acceptInvite` asks for no other proof of
   * identity). Spend it here: they have proved the address a different way, so the link has
   * done its job, and whoever else still holds a copy of that mail must not be able to set a
   * password on an account that is now in use.
   *
   * Conditioned on a NULL hash because that is exactly "invited, never accepted" — a user
   * with a password spent their token in `acceptInvite`, so there is nothing outstanding and
   * this does not run for them. Not scoped to unexpired rows either: an expired token is
   * already refused when consumed, and marking it spent costs nothing while leaving one
   * `consumed_at IS NULL` row behind invites exactly the wrong conclusion from the table.
   */
  if (!user.passwordHash) {
    const spent = await systemDb
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(authTokens.userId, user.id),
          eq(authTokens.purpose, "invite"),
          isNull(authTokens.consumedAt),
        ),
      )
      .returning({ id: authTokens.id });
    if (spent.length > 0) {
      log.log("invite settled by google sign-in — link spent", {
        user: user.publicId,
        tokens: spent.length,
      });
    }
  }

  /**
   * RECORD THE SIGN-IN. This door did neither of these, and both matter.
   *
   * `recordLoginAttempt` is the security one. The password path's own comment says why it
   * logs successes: "or 'did anything succeed?' stays unanswerable — which is the first
   * question asked after a burst of failures, and exactly the one a failures-only table
   * cannot answer." A Google-backed account was exactly that blind spot: the burst showed
   * up, the outcome did not.
   *
   * `lastLoginAt` is the visible one. Our user found this — the Team screen read "Never"
   * for ten of twelve operators and showed a five-day-old timestamp for the owner who was
   * signed in at that moment, because those figures only ever counted PASSWORD logins and
   * most of the team uses Google.
   *
   * Deliberately NOT touching `failedLoginCount` / `lockedUntil`, which `login` clears on
   * success. The lock is already honoured on this door ("a locked account stays locked
   * whichever door is tried"), so nothing is bypassed by leaving them — and resetting a
   * PASSWORD failure counter from a Google success is a change to lockout semantics, not a
   * missing write. Recorded in docs/PROGRESS.md as a question rather than decided here.
   *
   * `completeSignIn` does both, and asks for the second factor: Google proves the first
   * factor only.
   */
  return completeSignIn(user, "google", ctx);
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Password reset (0194)
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Begin a reset. **Always resolves void, whatever happened.**
 *
 * The silence is the control, not politeness. A route that answers differently for a
 * known and an unknown address is an account-enumeration oracle — SR-2026-010 is a
 * whole report about one — and "forgot password" is the easiest such oracle to build by
 * accident, because the obvious implementation says "no account with that email".
 * Everything below therefore returns the same nothing: no account, a locked account, no
 * configured mail transport, a send that fails.
 *
 * The caller (`api/auth-routes.ts`) answers 200 unconditionally and throttles by client
 * address AND by RECIPIENT, so this cannot be used to flood an inbox either.
 */
export async function requestPasswordReset(input: {
  email: string;
  ip?: string | null;
  /** Base URL of the dashboard, for composing the link. No base ⇒ no mail. */
  dashboardBaseUrl?: string | null;
}): Promise<void> {
  const e = input.email.toLowerCase().trim();
  if (!e) return;
  const base = input.dashboardBaseUrl?.replace(/\/$/, "");
  if (!base) {
    // Loud in the log, silent to the caller: an operator asking why resets never arrive
    // needs this line, and the requester must learn nothing either way.
    log.warn("password reset requested but DASHBOARD_BASE_URL is unset — no mail sent");
    return;
  }

  const [user] = await systemDb.select().from(users).where(eq(users.email, e)).limit(1);
  if (!user) return;

  const token = `prst_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + config.PASSWORD_RESET_TTL_MINUTES * 60_000);
  await systemDb.insert(authTokens).values({
    userId: user.id,
    tokenHash: sessionHash(token),
    purpose: "password_reset",
    expiresAt,
    requestedIp: input.ip ?? null,
  });

  // `/reset-password/s/<token>` is the EXCHANGE route, not the form — same shape as the
  // portal link (0193). It moves the token into a short-lived HttpOnly cookie and
  // redirects to a clean `/reset-password`, so the credential is not in the URL of the
  // page the operator actually sits on, and cannot leave in a `Referer`.
  const link = `${base}/reset-password/s/${token}`;
  const rendered = renderPasswordResetEmail({
    name: user.name,
    link,
    ttlMinutes: config.PASSWORD_RESET_TTL_MINUTES,
  });

  // Sent through the DEPLOYMENT mailer (`resolveMailer(null)`), not a business's SMTP:
  // this is operator identity mail and belongs to no tenant. Failures are logged and
  // swallowed — the requester must not be able to tell a failed send from an unknown
  // address, and there is nothing they could do about it either way.
  try {
    await resolveMailer(null).send({
      to: user.email,
      from: config.MAIL_FROM,
      fromName: accountBrand().name,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    log.log("password reset link sent", { user: user.publicId });
  } catch (err) {
    log.error(err, { event: "password_reset_send_failed", user: user.publicId });
  }
}

/**
 * Spend a reset token and set the new password.
 *
 * Single-use is enforced in the consuming UPDATE's own WHERE clause rather than by a
 * read-then-write, so two concurrent redemptions cannot both succeed — the same
 * reasoning as the portal exchange in 0193.
 *
 * Every session for the account is revoked, including the one that may be sitting in
 * the browser doing this. A password reset is what a person does when they believe
 * someone else is in their account, and the entire value of it is that the other party
 * is put out. `changePassword` deliberately spares the current session; this does not.
 */
export async function resetPasswordWithToken(
  token: string,
  newPassword: string,
  ctx: LoginContext = {},
): Promise<void> {
  if (!token.startsWith("prst_")) throw new AuthError("This reset link is not valid or is expired");
  // As with acceptInvite: the user is resolved from the token further down.
  const rejectedTokenReset = await rejectPassword(newPassword);
  if (rejectedTokenReset) throw new AuthError(rejectedTokenReset);

  const now = new Date();
  const [claimed] = await systemDb
    .update(authTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authTokens.tokenHash, sessionHash(token)),
        // The purpose is part of the claim, not decoration: without it an INVITE token —
        // which any administrator can cause to be mailed to any address — would also work
        // here, and would reset the password of an account that already exists (0197).
        eq(authTokens.purpose, "password_reset"),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    .returning();
  // One message for expired, spent and unknown alike — the route is unauthenticated and
  // the differences are of no use to anyone but someone testing guesses.
  if (!claimed) throw new AuthError("This reset link is not valid or is expired");

  await systemDb
    .update(users)
    .set({
      passwordHash: hashPassword(newPassword),
      // Clear the lockout too. Someone who proved control of the mailbox and set a new
      // password should not then be told to wait out a lock earned by whoever was
      // guessing at them.
      failedLoginCount: 0,
      lockedUntil: null,
    })
    .where(eq(users.id, claimed.userId!));

  await systemDb.delete(sessions).where(eq(sessions.userId, claimed.userId!));
  // Any OTHER outstanding reset for this account dies with it: a second link in the
  // inbox must not still work after the first has been used.
  await systemDb
    .update(authTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authTokens.userId, claimed.userId!),
        eq(authTokens.purpose, "password_reset"),
        isNull(authTokens.consumedAt),
      ),
    );

  log.info("password reset completed — all sessions revoked", { userId: claimed.userId });
  await forgetAllTrustedBrowsers(claimed.userId!, "password_reset", ctx);
  await securityEvent(claimed.userId!, "password_reset", { ctx, metadata: { by: "email_link" } });
}

/** Drop spent and expired reset rows. Run by the billing clock; nothing to reconcile. */
export async function sweepPasswordResetTokens(
  now: Date = new Date(),
): Promise<{ deleted: number }> {
  const res = await systemDb.delete(authTokens).where(lt(authTokens.expiresAt, now));
  return { deleted: (res as unknown as { count?: number }).count ?? 0 };
}

/**
 * Drop credential attempts past their retention window (audit M5; standard §9.3).
 *
 * 90 days, which is the standard's own figure. The table grows with every sign-in AND every
 * failure, so a credential-stuffing run against a public dashboard writes to it as fast as the
 * rate limiter refuses — unswept, the attack's own traffic becomes the largest thing in the
 * database. Ninety days is also long enough that an incident discovered late still has the
 * evidence, which is the reason to keep any of it.
 */
export async function sweepLoginAttempts(now: Date = new Date()): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - config.LOGIN_ATTEMPT_RETENTION_DAYS * 86_400_000);
  const res = await systemDb.delete(loginAttempts).where(lt(loginAttempts.at, cutoff));
  return { deleted: (res as unknown as { count?: number }).count ?? 0 };
}

/**
 * Count one failed login, and lock the account once the threshold is met.
 *
 * The lock is a TIMESTAMP, not a flag, and it is short (config
 * `LOGIN_LOCKOUT_MINUTES`). A lock that only an operator can lift would hand anyone
 * who knows an email address a way to keep that person out at will — the denial-of-
 * service inversion SR-2026-009 Finding 3 calls out, where the defence becomes the
 * attack. Self-expiring, the worst an attacker achieves is a delay.
 */
async function recordFailedLogin(userId: string, current: number): Promise<void> {
  const next = current + 1;
  const lock = next >= config.LOGIN_LOCKOUT_THRESHOLD;
  await systemDb
    .update(users)
    .set({
      // Reset the run on lock so the next window starts clean rather than locking
      // again on the first failure after it expires.
      failedLoginCount: lock ? 0 : next,
      ...(lock
        ? { lockedUntil: new Date(Date.now() + config.LOGIN_LOCKOUT_MINUTES * 60_000) }
        : {}),
    })
    .where(eq(users.id, userId));
  if (lock) {
    // The one auth event worth a timestamped record without being asked: it is both
    // the signal that someone is guessing and the explanation for the support ticket
    // that follows. No email — the public id identifies the account for anyone who
    // can already query it.
    log.warn("account locked after repeated failed logins", {
      event: "login_lockout",
      minutes: config.LOGIN_LOCKOUT_MINUTES,
      userId,
    });
  }
}

/** How a session was established, carried on its row (0326). */
interface SessionOrigin {
  /** Null only when carried over from a session older than 0326. */
  authMethod: SessionAuthMethod | null;
  mfaAt: Date | null;
  /** Set by an interactive sign-in, carried by an org switch. Absent = not stepped up. */
  stepUpAt?: Date | null;
}

async function createSession(
  userId: string,
  organizationId: string,
  ctx: LoginContext,
  how: SessionOrigin,
): Promise<string> {
  const token = `sess_${randomBytes(32).toString("base64url")}`;
  const [policy] = await systemDb
    .select({
      sessionIdleMinutes: organizations.sessionIdleMinutes,
      sessionAbsoluteTtlHours: organizations.sessionAbsoluteTtlHours,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  // `expiresAt` starts as the idle deadline; `createdAt` defaults to now and is what the
  // absolute ceiling is measured from. `createdIp`/`userAgent` record where the session BEGAN
  // (audit M5): a session whose later requests move continents is the hijack signal, and it
  // is invisible without this. Null when the caller has no request context.
  await systemDb.insert(sessions).values({
    userId,
    organizationId,
    tokenHash: sessionHash(token),
    expiresAt: new Date(Date.now() + idleWindowMs(policy)),
    lastActiveAt: new Date(),
    createdIp: ctx.ip ?? null,
    userAgent: ctx.userAgent?.slice(0, 500) ?? null,
    authMethod: how.authMethod,
    mfaAt: how.mfaAt,
    stepUpAt: how.stepUpAt ?? null,
  });
  return token;
}

/**
 * Resolve a session token to the authed user, or null if invalid, idle-expired, or past
 * its absolute ceiling. Using a live session pushes its idle deadline forward.
 */
export async function resolveSession(token: string): Promise<AuthedUser | null> {
  const now = new Date();
  const [s] = await systemDb
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, sessionHash(token)), gt(sessions.expiresAt, now)))
    .limit(1);
  if (!s) return null;
  const [org] = await systemDb
    .select()
    .from(organizations)
    .where(eq(organizations.id, s.organizationId))
    .limit(1);

  // The ceiling is deliberately checked in code rather than folded into the query
  // above: a session that has run out its full life should be DELETED, not merely
  // filtered out, or the row lingers and is re-evaluated on every later request.
  if (s.createdAt.getTime() + absoluteTtlMs(org) <= now.getTime()) {
    await systemDb.delete(sessions).where(eq(sessions.id, s.id));
    log.log("session reached its absolute ceiling", { user: s.userId });
    return null;
  }
  const [user] = await systemDb.select().from(users).where(eq(users.id, s.userId)).limit(1);
  // The custom role rides on the membership read: same round trip, read fresh every request.
  const [mr] = await systemDb
    .select({ m: memberships, r: roles })
    .from(memberships)
    .leftJoin(roles, eq(roles.id, memberships.customRoleId))
    .where(
      and(
        eq(memberships.userId, s.userId),
        eq(memberships.organizationId, s.organizationId),
        isNotNull(memberships.acceptedAt),
      ),
    )
    .limit(1);
  const m = mr?.m;
  if (!user || !m || !org) return null;
  // Idle past the org's window, even one shortened after this deadline was stamped. A row
  // from before 0482 has no last use: its deadline was stamped with the deployment window.
  const lastActive = s.lastActiveAt?.getTime() ?? s.expiresAt.getTime() - idleWindowMs();
  if (lastActive + idleWindowMs(org) <= now.getTime()) {
    await systemDb.delete(sessions).where(eq(sessions.id, s.id));
    log.log("session passed its organization's idle window", { user: s.userId });
    return null;
  }

  // Push the idle deadline forward — but only once the current one has drifted by more
  // than the throttle, so a burst of calls rendering one page costs a single write.
  // Deliberately NOT awaited-into the response path's critical section beyond this: the
  // refresh failing must not fail the request, since the session is already valid.
  // Also when the deadline is further off than the window: the organization shortened it.
  const left = s.expiresAt.getTime() - now.getTime();
  if (left < idleWindowMs(org) - REFRESH_THROTTLE_MS || left > idleWindowMs(org)) {
    await systemDb
      .update(sessions)
      .set({ expiresAt: new Date(now.getTime() + idleWindowMs(org)), lastActiveAt: now })
      .where(eq(sessions.id, s.id));
  }

  return {
    userId: user.id,
    userPublicId: user.publicId,
    email: user.email,
    organizationId: org.id,
    organizationPublicId: org.publicId,
    role: m.role as Role,
    customRole: mr.r ? customRoleRef(mr.r) : null,
  };
}

export async function logout(token: string): Promise<void> {
  await systemDb.delete(sessions).where(eq(sessions.tokenHash, sessionHash(token)));
}

// Role → permission keys: `src/modules/auth/permissions.ts` (`permissionsOf`).

// ── second factor (audit M3) ──────────────────────────────────────────────────

/** How many recovery codes an enrolment gets. Enough to survive a lost phone and a bad day. */
const RECOVERY_CODE_COUNT = 10;
/** How long a started-but-unconfirmed authenticator setup stays usable. */
const MFA_SETUP_TTL_MS = 15 * 60_000;

/** No 0/O/1/I/L: these are read off a screen and typed by a person under stress. */
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** 16 characters of a 31-letter alphabet ≈ 79 bits. */
const RECOVERY_CODE_LENGTH = 16;
/** Pre-0326 codes: 8 characters, stored as a bare SHA-256. Still accepted, never minted. */
const LEGACY_RECOVERY_CODE_LENGTH = 8;
/** Recovery-code KDF. scrypt N=2^14 per code; stored as `rc1$<salt>$<hash>`. */
const RC_N = 1 << 14;
const RC_KEYLEN = 32;

const normalizeRecoveryCode = (code: string) => code.replace(/[\s-]/g, "").toUpperCase();

const legacyRecoveryHash = (normalized: string) =>
  createHash("sha256").update(normalized).digest("hex");

function scryptAsync(input: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(input, salt, RC_KEYLEN, { N: RC_N, r: SCRYPT_R, p: SCRYPT_P }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

async function hashRecoveryCode(code: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(normalizeRecoveryCode(code), salt);
  return `rc1$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** `ABCD-EFGH-JKMN-PQRS` — grouped in fours for transcription. */
function generateRecoveryCode(): string {
  // Rejection sampling: 256 is not a multiple of 31, and a plain modulo biases the first letters.
  const out: string[] = [];
  while (out.length < RECOVERY_CODE_LENGTH) {
    for (const b of randomBytes(RECOVERY_CODE_LENGTH)) {
      if (b < 248 && out.length < RECOVERY_CODE_LENGTH) out.push(RECOVERY_ALPHABET[b % 31]!);
    }
  }
  return out.join("").match(/.{4}/g)!.join("-");
}

async function mintRecoveryCodes(): Promise<{ codes: string[]; hashed: string[] }> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  return { codes, hashed: await Promise.all(codes.map(hashRecoveryCode)) };
}

/** The STORED entry `input` matches, or null. Format is chosen by the input's length. */
async function matchRecoveryCode(stored: string[], input: string): Promise<string | null> {
  const normalized = normalizeRecoveryCode(input);
  if (normalized.length === LEGACY_RECOVERY_CODE_LENGTH) {
    const h = legacyRecoveryHash(normalized);
    return stored.find((s) => !s.startsWith("rc1$") && s === h) ?? null;
  }
  if (normalized.length !== RECOVERY_CODE_LENGTH) return null;
  for (const s of stored) {
    const [tag, saltHex, hashHex] = s.split("$");
    if (tag !== "rc1" || !saltHex || !hashHex) continue;
    const key = await scryptAsync(normalized, Buffer.from(saltHex, "hex"));
    const expected = Buffer.from(hashHex, "hex");
    if (key.length === expected.length && timingSafeEqual(key, expected)) return s;
  }
  return null;
}

/**
 * True when two-factor authentication is ON, through any method — an authenticator app, a passkey
 * or both (0330). `user_mfa.confirmed_at` is that state; the app's secret within it is optional.
 */
export async function hasConfirmedMfa(userId: string): Promise<boolean> {
  const [row] = await systemDb.select().from(userMfa).where(eq(userMfa.userId, userId)).limit(1);
  return !!row?.confirmedAt;
}

/** True when an authenticator app is set up, i.e. a 6-digit code can be checked. */
async function hasAuthenticatorApp(userId: string): Promise<boolean> {
  const [row] = await systemDb
    .select({ secretEnc: userMfa.secretEnc, confirmedAt: userMfa.confirmedAt })
    .from(userMfa)
    .where(eq(userMfa.userId, userId))
    .limit(1);
  return !!row?.confirmedAt && !!row.secretEnc;
}

/** What the sign-in second step can offer this person. */
async function secondStepMethods(userId: string): Promise<SecondStepMethods> {
  const passkeys = await listPasskeys(userId);
  return {
    passkeyNames: passkeys.map((p) => p.name),
    authenticatorApp: await hasAuthenticatorApp(userId),
  };
}

/**
 * Is a second factor MANDATORY for this role (audit M3.1)?
 *
 * Policy comes from `MFA_REQUIRED_ROLES`, which is empty by default — see the note on that
 * setting for why the mechanism ships complete but the policy ships off.
 */
export function roleRequiresMfa(role: string, org?: Partial<OrgSessionPolicy> | null): boolean {
  return rolesRequiringMfa(org).includes(role.toLowerCase());
}

/**
 * Does this person owe us an enrolment before they may do anything?
 *
 * DERIVED, never stored: it clears itself the moment the factor is confirmed, and turning the
 * policy off restores everyone immediately.
 */
export async function mfaEnrollmentRequired(
  userId: string,
  role: string,
  organizationId?: string,
): Promise<boolean> {
  const [org] = organizationId
    ? await systemDb
        .select({ mfaRequiredRoles: organizations.mfaRequiredRoles })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1)
    : [];
  if (!roleRequiresMfa(role, org)) return false;
  return !(await hasConfirmedMfa(userId));
}

/** The newest unspent, unexpired authenticator setup for this person. */
async function pendingMfaSetup(userId: string) {
  const [row] = await systemDb
    .select()
    .from(authTokens)
    .where(
      and(
        eq(authTokens.userId, userId),
        eq(authTokens.purpose, "mfa_setup"),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(authTokens.createdAt))
    .limit(1);
  return row ?? null;
}

/** Spend every outstanding setup, so only the newest QR code can ever be confirmed. */
async function spendMfaSetups(userId: string): Promise<void> {
  await systemDb
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authTokens.userId, userId),
        eq(authTokens.purpose, "mfa_setup"),
        isNull(authTokens.consumedAt),
      ),
    );
}

/**
 * Begin authenticator setup: mint a secret and hold it, encrypted, in a 15-minute `mfa_setup`
 * token. Nothing in `user_mfa` changes until the code is confirmed, so a half-finished setup
 * never gates login and never disturbs an authenticator already in use ("Change app").
 */
export async function startMfaEnrollment(input: { userId: string; issuer?: string }): Promise<{
  otpauthUri: string;
  secret: string;
  expiresAt: Date;
  /** True when this replaces an authenticator that is already on. */
  replacing: boolean;
}> {
  const [user] = await systemDb.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!user) throw new AuthError("No such user");
  await spendMfaSetups(user.id);
  // 20 bytes = 160 bits, the RFC 4226 recommendation and what every authenticator expects.
  const secret = base32Encode(randomBytes(20));
  const expiresAt = new Date(Date.now() + MFA_SETUP_TTL_MS);
  await systemDb.insert(authTokens).values({
    userId: user.id,
    tokenHash: sessionHash(`mfas_${randomBytes(32).toString("base64url")}`),
    purpose: "mfa_setup",
    payload: encryptSecret(secret),
    expiresAt,
  });
  return {
    otpauthUri: otpauthUri({
      secretBase32: secret,
      account: user.email,
      issuer: input.issuer ?? "tmbilling",
    }),
    secret,
    expiresAt,
    replacing: await hasAuthenticatorApp(user.id),
  };
}

/**
 * Finish setup by proving the authenticator holds the secret.
 *
 * First setup: creates the factor AND its recovery codes in one transaction and returns the
 * codes — the only time they exist in readable form. Changing the app: swaps the secret and
 * keeps the codes (`recoveryCodes: null`).
 */
export async function confirmMfaEnrollment(input: {
  userId: string;
  code: string;
  ctx?: LoginContext;
}): Promise<{ recoveryCodes: string[] | null; replaced: boolean }> {
  const pending = await pendingMfaSetup(input.userId);
  if (!pending?.payload) {
    throw new AuthError("This setup expired. Start again.");
  }
  const step = matchTotpStep(decryptSecret(pending.payload), input.code);
  if (step === null) {
    throw new AuthError(
      "The code is not correct. Make sure that your phone sets its time automatically.",
    );
  }
  // Codes are minted (scrypt × 10) only for a first setup; "Change app" keeps the current set.
  const minted = (await hasConfirmedMfa(input.userId)) ? null : await mintRecoveryCodes();
  const now = new Date();
  const result = await systemDb.transaction(async (tx) => {
    const spent = await tx
      .update(authTokens)
      .set({ consumedAt: now })
      .where(and(eq(authTokens.id, pending.id), isNull(authTokens.consumedAt)))
      .returning({ id: authTokens.id });
    if (spent.length === 0) throw new AuthError("This setup expired. Start again.");

    const [existing] = await tx
      .select({ confirmedAt: userMfa.confirmedAt, secretEnc: userMfa.secretEnc })
      .from(userMfa)
      .where(eq(userMfa.userId, input.userId))
      .limit(1);
    if (existing?.confirmedAt || !minted) {
      if (!existing?.confirmedAt) throw new AuthError("This setup expired. Start again.");
      // 2FA is already on: either "Change app", or adding the app beside a passkey (0330).
      const replaced = !!existing.secretEnc;
      await tx
        .update(userMfa)
        .set({
          secretEnc: pending.payload!,
          lastUsedStep: step,
          lastUsedAt: now,
          updatedAt: now,
          totpAddedAt: now,
        })
        .where(eq(userMfa.userId, input.userId));
      return { recoveryCodes: null, replaced, added: !replaced };
    }
    const values = {
      userId: input.userId,
      secretEnc: pending.payload!,
      totpAddedAt: now,
      confirmedAt: now,
      recoveryCodesHashed: minted.hashed,
      recoveryCodesConfirmedAt: null,
      lastUsedStep: step,
      lastUsedAt: now,
      updatedAt: now,
    };
    await tx
      .insert(userMfa)
      .values(values)
      .onConflictDoUpdate({ target: userMfa.userId, set: values });
    return { recoveryCodes: minted.codes, replaced: false, added: false };
  });
  log.log(
    result.replaced
      ? "authenticator app changed"
      : result.added
        ? "authenticator app added"
        : "second factor enabled",
    { user: input.userId },
  );
  await securityEvent(
    input.userId,
    result.replaced
      ? "authenticator_changed"
      : result.added
        ? "two_factor_method_added"
        : "two_factor_enabled",
    { ctx: input.ctx, metadata: { method: "totp" }, email: { method: "totp" } },
  );
  return { recoveryCodes: result.recoveryCodes, replaced: result.replaced };
}

/**
 * Accept a TOTP code once. The step is recorded in the same UPDATE that accepts it, and only a
 * LATER step passes, so a code (or an earlier one still inside the skew window) never works twice.
 */
async function acceptTotp(userId: string, secretEnc: string, code: string): Promise<boolean> {
  const step = matchTotpStep(decryptSecret(secretEnc), code);
  if (step === null) return false;
  const accepted = await systemDb
    .update(userMfa)
    .set({ lastUsedStep: step, lastUsedAt: new Date() })
    .where(
      and(
        eq(userMfa.userId, userId),
        or(isNull(userMfa.lastUsedStep), lt(userMfa.lastUsedStep, step)),
      ),
    )
    .returning({ userId: userMfa.userId });
  return accepted.length > 0;
}

export interface MfaCheck {
  ok: boolean;
  method?: "totp" | "recovery_code";
  /** Set when a recovery code was spent. */
  recoveryCodesLeft?: number;
}

/**
 * Check a code — a TOTP code, or one recovery code, which is then spent.
 *
 * A recovery code is removed with `array_remove` in an UPDATE guarded on the array still holding
 * it: two concurrent redemptions cannot both win, and two DIFFERENT codes spent at once cannot
 * write each other's removal back.
 */
export async function verifyMfaForLogin(userId: string, code: string): Promise<MfaCheck> {
  const [row] = await systemDb.select().from(userMfa).where(eq(userMfa.userId, userId)).limit(1);
  if (!row?.confirmedAt) return { ok: false };
  if (/^\d{6}$/.test(code.replace(/\s/g, ""))) {
    // Passkey-only: there is no app, so no 6-digit code can be right (0330).
    if (!row.secretEnc) return { ok: false, method: "totp" };
    return { ok: await acceptTotp(userId, row.secretEnc, code), method: "totp" };
  }

  const stored = await matchRecoveryCode(row.recoveryCodesHashed, code);
  if (!stored) return { ok: false };
  const [updated] = await systemDb
    .update(userMfa)
    .set({
      recoveryCodesHashed: sql`array_remove(${userMfa.recoveryCodesHashed}, ${stored})`,
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userMfa.userId, userId),
        sql`${userMfa.recoveryCodesHashed} @> ARRAY[${stored}]::text[]`,
      ),
    )
    .returning({ left: userMfa.recoveryCodesHashed });
  if (!updated) return { ok: false }; // another request spent it first
  log.info("recovery code used", { user: userId, remaining: updated.left.length });
  return { ok: true, method: "recovery_code", recoveryCodesLeft: updated.left.length };
}

/** A recovery code finished a sign-in or a confirmation: record it and tell the person. */
async function noteRecoveryCodeUsed(
  userId: string,
  check: MfaCheck,
  ctx: LoginContext,
  context: "sign_in" | "step_up",
): Promise<void> {
  if (check.method !== "recovery_code") return;
  await securityEvent(userId, "recovery_code_used", {
    ctx,
    metadata: { remaining: check.recoveryCodesLeft ?? 0, context },
    email: { codesLeft: check.recoveryCodesLeft ?? 0, recoveryContext: context },
  });
}

/** Replace the recovery codes. The old set stops working at once; the new one is returned ONCE. */
export async function regenerateRecoveryCodes(
  userId: string,
  ctx: LoginContext = {},
): Promise<string[]> {
  if (!(await hasConfirmedMfa(userId))) {
    throw new AuthError("Enable two-factor authentication first.");
  }
  const minted = await mintRecoveryCodes();
  await systemDb
    .update(userMfa)
    .set({
      recoveryCodesHashed: minted.hashed,
      recoveryCodesConfirmedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(userMfa.userId, userId));
  log.info("recovery codes regenerated", { user: userId });
  await securityEvent(userId, "recovery_codes_generated", { ctx });
  return minted.codes;
}

/** The person says they saved the current recovery codes. */
export async function acknowledgeRecoveryCodes(userId: string): Promise<void> {
  await systemDb
    .update(userMfa)
    .set({ recoveryCodesConfirmedAt: new Date() })
    .where(and(eq(userMfa.userId, userId), isNotNull(userMfa.confirmedAt)));
}

/**
 * Turn the second factor off, and sign out every OTHER session of this person.
 *
 * No password here (2026-09-02). The ROUTE needs a recent step-up (2026-11-04, audit P2-PASSKEY).
 * Signing the others out means a thief cannot do it silently under the owner's other browsers.
 */
export async function disableMfa(input: {
  userId: string;
  /** The caller's own session, which survives. Omit to sign out every session. */
  keepSessionToken?: string;
  ctx?: LoginContext;
  /** A support reset records and announces itself; only a self-serve turn-off is noted here. */
  by?: "self" | "support";
}): Promise<{ signedOutSessions: number }> {
  // While an organization requires 2FA its members cannot turn theirs off. Support can: a reset
  // is how someone who lost every method gets back in, and they set it up again after.
  if (input.by !== "support") {
    const requiring = await organizationsRequiringTwoFactor(input.userId);
    if (requiring.length > 0) throw new OrganizationRequiresTwoFactorError(requiring);
  }
  // Every method goes: the app (with the row), every passkey, and any ceremony in flight.
  await systemDb.transaction(async (tx) => {
    await tx.delete(userMfa).where(eq(userMfa.userId, input.userId));
    await tx.delete(userPasskeys).where(eq(userPasskeys.userId, input.userId));
    await tx.delete(webauthnChallenges).where(eq(webauthnChallenges.userId, input.userId));
  });
  await spendMfaSetups(input.userId);
  const keep = input.keepSessionToken ? sessionHash(input.keepSessionToken) : null;
  const gone = await systemDb
    .delete(sessions)
    .where(
      keep
        ? and(eq(sessions.userId, input.userId), ne(sessions.tokenHash, keep))
        : eq(sessions.userId, input.userId),
    )
    .returning({ id: sessions.id });
  log.info("second factor disabled", { user: input.userId, signedOut: gone.length });
  await forgetAllTrustedBrowsers(input.userId, "two_factor_disabled", input.ctx);
  if (input.by !== "support") {
    await securityEvent(input.userId, "two_factor_disabled", {
      ctx: input.ctx,
      metadata: { signed_out: gone.length },
    });
  }
  return { signedOutSessions: gone.length };
}

/**
 * Mint the token that stands for "this first factor was correct" (audit M3 surface).
 *
 * Short-lived: it is a partial credential whose only job is to survive the round trip to a code
 * form. Carries the first factor's method so the finished session records it.
 */
async function mintMfaChallenge(
  userId: string,
  ctx: LoginContext,
  authMethod: FirstFactor,
): Promise<string> {
  const token = `mfac_${randomBytes(32).toString("base64url")}`;
  await systemDb.insert(authTokens).values({
    userId,
    tokenHash: sessionHash(token),
    purpose: "mfa_challenge",
    payload: authMethod,
    expiresAt: new Date(Date.now() + config.MFA_CHALLENGE_TTL_MINUTES * 60_000),
    requestedIp: ctx.ip ?? null,
  });
  return token;
}

/**
 * Finish a sign-in that stopped at the second factor.
 *
 * The challenge is spent in the consuming UPDATE's own WHERE, so it cannot be replayed. A WRONG
 * code spends nothing — a mistyped digit deserves another try — while the lockout bounds guessing.
 */
export async function completeMfaLogin(
  challenge: string,
  code: string,
  ctx: LoginContext = {},
  opts: { trustBrowser?: boolean } = {},
): Promise<MfaLoginResult> {
  const { claimed, user, authMethod } = await claimMfaChallenge(challenge);
  const check = await verifyMfaForLogin(user.id, code);
  if (!check.ok) {
    await failSecondStep(user, authMethod, ctx);
    throw new AuthError("That code is not valid");
  }
  await noteRecoveryCodeUsed(user.id, check, ctx, "sign_in");
  return finishMfaChallenge(claimed.id, user, authMethod, ctx, {
    // Not after a recovery code: that is how someone without the phone gets in, and it should
    // not also buy them 30 days of not being asked for it.
    trustBrowser: opts.trustBrowser === true && check.recoveryCodesLeft === undefined,
    recoveryCodesLeft: check.recoveryCodesLeft,
  });
}

export interface MfaLoginResult {
  token: string;
  user: AuthedUser;
  /** Set when a recovery code finished the sign-in. */
  recoveryCodesLeft?: number;
  /** Set when the person asked to trust this browser: the raw cookie value, shown nowhere else. */
  trustedBrowser?: { token: string; expiresAt: Date };
}

/**
 * Read an unspent, unexpired second-step challenge and its person. Spends nothing: a wrong code
 * deserves another try inside the window, while the lockout bounds guessing.
 */
async function claimMfaChallenge(challenge: string) {
  if (typeof challenge !== "string" || !challenge.startsWith("mfac_"))
    throw new AuthError("That sign-in attempt is expired. Start again.");
  const now = new Date();
  const [claimed] = await systemDb
    .select()
    .from(authTokens)
    .where(
      and(
        eq(authTokens.tokenHash, sessionHash(challenge)),
        eq(authTokens.purpose, "mfa_challenge"),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    .limit(1);
  if (!claimed) throw new AuthError("That sign-in attempt is expired. Start again.");

  const [user] = await systemDb.select().from(users).where(eq(users.id, claimed.userId!)).limit(1);
  if (!user) throw new AuthError("That sign-in attempt is expired. Start again.");

  // A locked account is refused here too — the lockout must not be escapable by getting as far
  // as the second step before it trips.
  if (user.lockedUntil && user.lockedUntil > now) throw new AuthError("That code is not valid");

  const authMethod: FirstFactor = claimed.payload === "google" ? "google" : "password";
  return { claimed, user, authMethod };
}

/** A wrong second step counts against the same lockout a wrong password uses. */
async function failSecondStep(
  user: typeof users.$inferSelect,
  authMethod: FirstFactor,
  ctx: LoginContext,
): Promise<void> {
  await recordFailedLogin(user.id, user.failedLoginCount);
  await recordLoginAttempt("mfa_failed", { email: user.email, userId: user.id, ctx });
  await recordFailedSecondFactor(user.id, authMethod, ctx);
  log.info("failed second factor", { user: user.id });
}

/** The second step passed: spend the challenge atomically, then mint the session. */
async function finishMfaChallenge(
  challengeId: string,
  user: typeof users.$inferSelect,
  authMethod: FirstFactor,
  ctx: LoginContext,
  opts: { trustBrowser: boolean; recoveryCodesLeft?: number },
): Promise<MfaLoginResult> {
  const now = new Date();
  const spent = await systemDb
    .update(authTokens)
    .set({ consumedAt: now })
    .where(and(eq(authTokens.id, challengeId), isNull(authTokens.consumedAt)))
    .returning();
  if (spent.length === 0) throw new AuthError("That sign-in attempt is expired. Start again.");

  if (user.failedLoginCount > 0 || user.lockedUntil) {
    await systemDb
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, user.id));
  }
  const session = await finishSignIn(user, ctx, { authMethod, mfaAt: now, email: user.email });
  const trustedBrowser = opts.trustBrowser ? await trustBrowser(user.id, ctx) : undefined;
  return { ...session, recoveryCodesLeft: opts.recoveryCodesLeft, trustedBrowser };
}

// ── passkeys (0330) ──────────────────────────────────────────────────────────

export { PasskeyError } from "@/modules/auth/passkeys";

/** Options for finishing a sign-in's second step with a passkey. */
export async function passkeySecondStepOptions(challenge: string) {
  const { user } = await claimMfaChallenge(challenge);
  return authenticationOptions("second_step", user.id);
}

/** Finish a sign-in's second step with a passkey. A failed assertion counts like a wrong code. */
export async function completeMfaLoginWithPasskey(
  challenge: string,
  handle: string,
  response: AuthenticationResponseJSON,
  ctx: LoginContext = {},
  opts: { trustBrowser?: boolean } = {},
): Promise<MfaLoginResult> {
  const { claimed, user, authMethod } = await claimMfaChallenge(challenge);
  try {
    await verifyAuthentication({
      purpose: "second_step",
      handle,
      response,
      expectedUserId: user.id,
      ctx,
    });
  } catch (e) {
    // An expired ceremony is not a guess.
    if (!(e instanceof PasskeyError && e.reason === "expired"))
      await failSecondStep(user, authMethod, ctx);
    throw e;
  }
  // "Last used" for 2FA, and what resets the failed-code alert's count.
  await systemDb.update(userMfa).set({ lastUsedAt: new Date() }).where(eq(userMfa.userId, user.id));
  return finishMfaChallenge(claimed.id, user, authMethod, ctx, {
    trustBrowser: opts.trustBrowser === true,
  });
}

/** Options for signing in with a passkey alone (the browser offers any it holds for us). */
export async function passkeySignInOptions() {
  return authenticationOptions("sign_in");
}

/**
 * Sign in with a passkey alone. It is both factors, so the session counts as 2FA. It still ends
 * in `completeSignIn`, and a locked account is refused exactly as at the password form.
 */
export async function signInWithPasskey(
  handle: string,
  response: AuthenticationResponseJSON,
  ctx: LoginContext = {},
): Promise<{ token: string; user: AuthedUser }> {
  const { userId } = await verifyAuthentication({ purpose: "sign_in", handle, response, ctx });
  const [user] = await systemDb.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new PasskeyError("This passkey is not linked to your account now.", "not_found");
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await recordLoginAttempt("locked", { email: user.email, userId: user.id, ctx });
    throw new AuthError("This account is locked now. Try again later.");
  }
  if (user.failedLoginCount > 0) {
    await systemDb.update(users).set({ failedLoginCount: 0 }).where(eq(users.id, user.id));
  }
  await systemDb.update(userMfa).set({ lastUsedAt: new Date() }).where(eq(userMfa.userId, user.id));
  return completeSignIn(user, "passkey", ctx);
}

/** Begin adding a passkey. */
export async function startPasskeyRegistration(userId: string) {
  const [user] = await systemDb.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AuthError("No such user");
  return registrationOptions({ id: user.id, email: user.email, name: user.name });
}

/**
 * Store a verified passkey. The FIRST method turns 2FA on and mints recovery codes in the same
 * transaction, returned once — exactly as the authenticator app's first setup does.
 */
export async function addPasskey(input: {
  userId: string;
  handle: string;
  response: RegistrationResponseJSON;
  name?: string | null;
  ctx?: LoginContext;
}): Promise<{ passkey: PasskeyView; recoveryCodes: string[] | null }> {
  const verified = await verifyRegistration(input.userId, input.handle, input.response);
  const name = input.name?.trim()
    ? normalisePasskeyName(input.name)
    : suggestPasskeyName(verified.aaguid, input.ctx?.userAgent);
  // Minted outside the transaction (scrypt × 10), used only when this turns 2FA on.
  const minted = (await hasConfirmedMfa(input.userId)) ? null : await mintRecoveryCodes();
  const now = new Date();
  const result = await systemDb.transaction(async (tx) => {
    const [existing] = await tx
      .select({ confirmedAt: userMfa.confirmedAt })
      .from(userMfa)
      .where(eq(userMfa.userId, input.userId))
      .for("update")
      .limit(1);
    const turnsOn = !existing?.confirmedAt;
    if (turnsOn && !minted) throw new AuthError("The time limit expired. Add the passkey again.");
    const [row] = await tx
      .insert(userPasskeys)
      .values({
        userId: input.userId,
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        counter: verified.counter,
        transports: verified.transports,
        aaguid: verified.aaguid,
        name,
        backedUp: verified.backedUp,
      })
      .onConflictDoNothing({ target: userPasskeys.credentialId })
      .returning();
    if (!row)
      throw new PasskeyError("This device already has a passkey for your account.", "duplicate");
    if (turnsOn) {
      const values = {
        userId: input.userId,
        secretEnc: null,
        totpAddedAt: null,
        confirmedAt: now,
        recoveryCodesHashed: minted!.hashed,
        recoveryCodesConfirmedAt: null,
        lastUsedStep: null,
        lastUsedAt: null,
        updatedAt: now,
      };
      await tx
        .insert(userMfa)
        .values(values)
        .onConflictDoUpdate({ target: userMfa.userId, set: values });
    }
    return { row, turnsOn };
  });
  const passkey: PasskeyView = {
    id: result.row.id,
    name: result.row.name,
    backedUp: result.row.backedUp,
    createdAt: result.row.createdAt,
    lastUsedAt: null,
  };
  log.log(result.turnsOn ? "second factor enabled" : "passkey added", { user: input.userId });
  await securityEvent(
    input.userId,
    result.turnsOn ? "two_factor_enabled" : "two_factor_method_added",
    {
      ctx: input.ctx,
      metadata: { method: "passkey", passkey: passkey.id },
      email: { method: "passkey", passkeyName: passkey.name },
    },
  );
  return { passkey, recoveryCodes: result.turnsOn ? minted!.codes : null };
}

export { renamePasskey, listPasskeys, type PasskeyView } from "@/modules/auth/passkeys";

/** Removing this method would leave none: the caller must say so, and it turns 2FA off. */
export class LastTwoFactorMethodError extends AuthError {
  constructor() {
    super(
      "This is your only two-factor method. If you remove it, we disable two-factor authentication.",
    );
    this.name = "LastTwoFactorMethodError";
  }
}

/** How many second-factor methods remain besides the one being removed. */
async function otherMethods(userId: string, removing: { passkeyId?: string; app?: boolean }) {
  const passkeys = await listPasskeys(userId);
  const app = await hasAuthenticatorApp(userId);
  return (
    passkeys.filter((p) => p.id !== removing.passkeyId).length + (app && !removing.app ? 1 : 0)
  );
}

/**
 * Remove one passkey. If it is the last method, `confirmTurnOff` is required and this is
 * `disableMfa` — same rules: refused while an organization requires 2FA, other sessions signed
 * out, trusted browsers forgotten, the person emailed.
 */
export async function removePasskey(input: {
  userId: string;
  passkeyId: string;
  confirmTurnOff?: boolean;
  keepSessionToken?: string;
  ctx?: LoginContext;
}): Promise<{ twoFactorEnabled: boolean; signedOutSessions: number }> {
  const [row] = await systemDb
    .select()
    .from(userPasskeys)
    .where(and(eq(userPasskeys.id, input.passkeyId), eq(userPasskeys.userId, input.userId)))
    .limit(1);
  if (!row) throw new PasskeyError("This passkey is not on your account.", "not_found");
  if ((await otherMethods(input.userId, { passkeyId: row.id })) === 0) {
    if (!input.confirmTurnOff) throw new LastTwoFactorMethodError();
    const r = await disableMfa({
      userId: input.userId,
      keepSessionToken: input.keepSessionToken,
      ctx: input.ctx,
    });
    return { twoFactorEnabled: false, signedOutSessions: r.signedOutSessions };
  }
  await systemDb.delete(userPasskeys).where(eq(userPasskeys.id, row.id));
  await securityEvent(input.userId, "two_factor_method_removed", {
    ctx: input.ctx,
    metadata: { method: "passkey", passkey: row.id },
    email: { method: "passkey", passkeyName: row.name },
  });
  return { twoFactorEnabled: true, signedOutSessions: 0 };
}

/** Remove the authenticator app, keeping 2FA on through passkeys — or, if it is the last method, turn 2FA off. */
export async function removeAuthenticatorApp(input: {
  userId: string;
  confirmTurnOff?: boolean;
  keepSessionToken?: string;
  ctx?: LoginContext;
}): Promise<{ twoFactorEnabled: boolean; signedOutSessions: number }> {
  if (!(await hasAuthenticatorApp(input.userId))) {
    throw new AuthError("There is no authenticator app on your account.");
  }
  if ((await otherMethods(input.userId, { app: true })) === 0) {
    if (!input.confirmTurnOff) throw new LastTwoFactorMethodError();
    const r = await disableMfa({
      userId: input.userId,
      keepSessionToken: input.keepSessionToken,
      ctx: input.ctx,
    });
    return { twoFactorEnabled: false, signedOutSessions: r.signedOutSessions };
  }
  await systemDb
    .update(userMfa)
    .set({ secretEnc: null, totpAddedAt: null, lastUsedStep: null, updatedAt: new Date() })
    .where(eq(userMfa.userId, input.userId));
  await spendMfaSetups(input.userId);
  await securityEvent(input.userId, "two_factor_method_removed", {
    ctx: input.ctx,
    metadata: { method: "totp" },
    email: { method: "totp" },
  });
  return { twoFactorEnabled: true, signedOutSessions: 0 };
}

export interface MfaStatus {
  /** Kept for older callers; since 0326 a user_mfa row exists only once confirmed. */
  enrolled: boolean;
  confirmed: boolean;
  recoveryCodesLeft: number;
  /** False until the person says they saved the current codes. */
  recoveryCodesSaved: boolean;
  enabledAt: Date | null;
  lastUsedAt: Date | null;
  /** An authenticator setup was started and can still be confirmed. */
  setupPending: boolean;
  /** An authenticator app is set up (0330: 2FA can be on through passkeys alone). */
  authenticatorApp: boolean;
  authenticatorAppAddedAt: Date | null;
  passkeys: PasskeyView[];
}

/** Whether this person has a second factor, and the state the settings screen shows. */
export async function mfaStatus(userId: string): Promise<MfaStatus> {
  const [row] = await systemDb.select().from(userMfa).where(eq(userMfa.userId, userId)).limit(1);
  return {
    enrolled: !!row,
    confirmed: !!row?.confirmedAt,
    recoveryCodesLeft: row?.recoveryCodesHashed.length ?? 0,
    recoveryCodesSaved: !!row?.recoveryCodesConfirmedAt,
    enabledAt: row?.confirmedAt ?? null,
    lastUsedAt: row?.lastUsedAt ?? null,
    setupPending: !!(await pendingMfaSetup(userId)),
    authenticatorApp: !!row?.confirmedAt && !!row.secretEnc,
    authenticatorAppAddedAt: row?.secretEnc ? (row.totpAddedAt ?? row.confirmedAt) : null,
    passkeys: await listPasskeys(userId),
  };
}

// ── step-up re-authentication (audit M3.3) ────────────────────────────────────

/**
 * Prove the person behind this session is still there, and stamp the session.
 *
 * ── WHY EITHER A CODE OR A PASSWORD ─────────────────────────────────────────────
 * A TOTP code if they are enrolled, their current password if not. Requiring a code
 * specifically would mean step-up protects only the people who already opted into MFA — and
 * the operator most likely to have a session stolen is the one who has not. Either proof
 * establishes the same thing: possession of a factor the SESSION alone does not grant.
 *
 * An enrolled person must use their CODE, not their password. Accepting either would let an
 * attacker who phished a password bypass the second factor at exactly the moment it matters.
 */
export async function stepUp(input: {
  sessionToken: string;
  code?: string;
  password?: string;
}): Promise<{ method: "totp" | "password" }> {
  const actor = await resolveSession(input.sessionToken);
  if (!actor) throw new AuthError("Not signed in");
  const [user] = await systemDb.select().from(users).where(eq(users.id, actor.userId)).limit(1);
  if (!user) throw new AuthError("Not signed in");

  const enrolled = await hasConfirmedMfa(user.id);
  let method: "totp" | "password";

  if (enrolled) {
    if (!input.code) throw new AuthError("Enter the code from your authenticator app");
    const check = await verifyMfaForLogin(user.id, input.code);
    if (!check.ok) {
      await recordFailedLogin(user.id, user.failedLoginCount);
      log.info("failed step-up code", { user: user.id });
      throw new AuthError("That code is not valid");
    }
    await noteRecoveryCodeUsed(user.id, check, {}, "step_up");
    method = "totp";
  } else {
    if (!input.password) throw new AuthError("Enter your password");
    if (!user.passwordHash || !verifyPassword(input.password, user.passwordHash)) {
      // Counted, because this route verifies a password and is therefore a guessing oracle
      // for whoever holds a stolen session — the same reasoning as `changePassword`.
      await recordFailedLogin(user.id, user.failedLoginCount);
      log.info("failed step-up password", { user: user.id });
      throw new AuthError("That password is not correct");
    }
    method = "password";
  }

  await systemDb
    .update(sessions)
    .set({ stepUpAt: new Date() })
    .where(eq(sessions.tokenHash, sessionHash(input.sessionToken)));
  log.log("step-up granted", { user: user.id, method });
  return { method };
}

/**
 * Whether this session re-authenticated recently enough for a sensitive operation. Gates 2FA and
 * passkey management only (2026-11-04). A sign-in stamps the session too (`finishSignIn`).
 *
 * Reads the row directly rather than trusting anything on the request: the freshness is the
 * whole assertion, so it comes from the same place the session itself does.
 */
export async function stepUpFresh(sessionToken: string): Promise<boolean> {
  const [row] = await systemDb
    .select({ stepUpAt: sessions.stepUpAt })
    .from(sessions)
    .where(eq(sessions.tokenHash, sessionHash(sessionToken)))
    .limit(1);
  if (!row?.stepUpAt) return false;
  return Date.now() - row.stepUpAt.getTime() < config.STEP_UP_WINDOW_MINUTES * 60_000;
}

/** What the caller must supply to step up: a code if enrolled, otherwise a password. */
export async function stepUpMethodFor(userId: string): Promise<"totp" | "password"> {
  return (await hasConfirmedMfa(userId)) ? "totp" : "password";
}
