import { createLogger } from "@/platform/logger";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { LIMITS } from "./limits";
import {
  login,
  logout,
  resolveSession,
  inviteUser,
  changePassword,
  AuthError,
  PermissionEscalationError,
  OwnerRequiredError,
  permissionsOf,
  listMemberships,
  listPendingInvites,
  acceptMembershipInvite,
  declineMembershipInvite,
  switchOrganization,
  requestPasswordReset,
  resetPasswordWithToken,
  acceptInvite,
  type AuthedUser,
  MfaRequiredError,
  completeMfaLogin,
  mfaStatus,
  startMfaEnrollment,
  confirmMfaEnrollment,
  disableMfa,
  regenerateRecoveryCodes,
  acknowledgeRecoveryCodes,
  mfaEnrollmentRequired,
  hasPassword,
  releaseNotesSeenCount,
  markReleaseNotesSeen,
  productTourSeen,
  markProductTourSeen,
  stepUp,
  stepUpFresh,
  stepUpMethodFor,
  listTeam,
  changeMemberRole,
  removeMember,
  resendMemberInvite,
  type TeamMemberSummary,
  userProfile,
  updateProfile,
  setUploadedAvatar,
  listSessions,
  revokeSession,
  revokeOtherSessions,
  type SessionSummary,
  PasskeyError,
  LastTwoFactorMethodError,
  passkeySecondStepOptions,
  completeMfaLoginWithPasskey,
  passkeySignInOptions,
  signInWithPasskey,
  startPasskeyRegistration,
  addPasskey,
  renamePasskey,
  removePasskey,
  removeAuthenticatorApp,
  type MfaLoginResult,
} from "@/modules/auth/service";
import { pendingMfaReset } from "@/modules/auth/security-events";
import { permissionDef, type PermissionKey } from "@/modules/auth/permissions";
import { MEMBER_TAG, PERMISSION_TAG, badRequest, missingPermission } from "./helpers";
import { parseRequest } from "./strict-params";
import {
  OrganizationRequiresTwoFactorError,
  TwoFactorSetupRequiredError,
  organizationTwoFactorSummary,
  setOrganizationRequireMfa,
  standingInOrganization,
} from "@/modules/auth/org-two-factor";
import {
  forgetAllTrustedBrowsers,
  forgetTrustedBrowser,
  listTrustedBrowsers,
  type TrustedBrowserSummary,
} from "@/modules/auth/trusted-browsers";
import { cancelMfaReset, MfaResetCancelError } from "@/modules/auth/mfa-reset";
import {
  organizationSessionPolicy,
  policyView,
  SessionPolicyError,
  setOrganizationSessionPolicy,
} from "@/modules/auth/session-policy";
import {
  ObjectStoreNotConfiguredError,
  allowedTypesFor,
  deleteStoredImage,
  isObjectStoreConfigured,
  uploadBrandImage,
} from "@/platform/object-store";
import { ImageUploadError, MAX_IMAGE_BYTES } from "@/platform/image-upload";
import { SESSION_COOKIE, sessionTokenFromHeaders } from "@/platform/auth";
import { config, secureTransport } from "@/platform/config";
import {
  consumePublicRateLimit,
  AUTH_WINDOW_MS,
  SIGNUP_WINDOW_MS,
  UPLOAD_WINDOW_MS,
  HOUR_WINDOW_MS,
  UPLOAD_LIMIT_MESSAGE,
} from "@/platform/rate-limit";
import { verifyTurnstile, turnstileRefuses } from "@/platform/turnstile";
import { accountStateOf } from "@/modules/tenancy/service";
import {
  effectiveLiveAccess,
  effectiveOrganizationStatus,
  isCloud,
  signupOffered,
  signupOnFreePlan,
} from "@/platform/edition";
import {
  BILLING_VOLUMES,
  SIGNUP_GATEWAYS,
  beginPasswordSignup,
  completeGoogleSignup,
  completeInvitedSignup,
  completePasswordSignup,
  readSignupInvite,
  type SignupProfile,
} from "@/modules/auth/signup";
import { submitSignupRequest } from "@/modules/auth/signup-requests";
import { refusedByRateLimit } from "./helpers";
import { registerGoogleRoutes } from "./google-oauth";

// Portal authentication: session-cookie based, SEPARATE from API-key auth (which
// stays for programmatic access). These power the dashboard login.

const COOKIE = SESSION_COOKIE;

/**
 * Everything about the cookie EXCEPT its value and lifetime, written once so that the
 * set and the clear cannot drift apart. They previously repeated the attribute list,
 * which is how a cookie ends up cleared with a different scope than it was set with —
 * and therefore not cleared at all.
 *
 * `Secure` comes from `secureTransport()`, the same function that decides whether the
 * service sends HSTS, so the deployment makes ONE statement about its transport rather
 * than two that can disagree (see platform/config.ts).
 *
 * `SameSite=Lax` is doing real work and is worth naming: it is what keeps a
 * cross-site POST from carrying this cookie, which is CSRF protection for every
 * state-changing route on the dashboard's session surface without a token scheme.
 */
const cookieAttrs = () => `Path=/; HttpOnly; SameSite=Lax${secureTransport() ? "; Secure" : ""}`;

/**
 * `Max-Age` tracks the session's ABSOLUTE ceiling, not its 30-minute idle window — the
 * DB is the authority on idleness and pushes that deadline forward on use, so a cookie
 * that expired every 30 minutes would log out an active operator the browser had no way
 * to know was active. A cookie outliving its row is harmless (the server rejects it);
 * the reverse would sign people out early, so this is the safe side to err on.
 */
function setSessionCookie(reply: FastifyReply, token: string) {
  const maxAge = config.SESSION_ABSOLUTE_TTL_HOURS * 3600;
  reply.header("set-cookie", `${COOKIE}=${token}; ${cookieAttrs()}; Max-Age=${maxAge}`);
}
function clearSessionCookie(reply: FastifyReply) {
  reply.header("set-cookie", `${COOKIE}=; ${cookieAttrs()}; Max-Age=0`);
}
// One parser, shared with `platform/auth`'s `authenticate` — which needs it because a
// dashboard request carries an API key in `Authorization` AND a session in `Cookie`.
/**
 * "The first factor was right; a code is owed." 200, not 401 — nothing was rejected. Safe to
 * distinguish from a refusal: the caller has just proven that first factor. Shared by every door.
 */
export function mfaChallengeBody(e: MfaRequiredError) {
  return {
    object: "mfa_challenge" as const,
    challenge: e.challenge,
    email: e.email,
    auth_method: e.authMethod,
    message: e.message,
    // A support reset is pending: the code step says when, and how to stop it.
    reset_effective_at: e.resetEffectiveAt?.toISOString() ?? null,
    // Who to ask when every method is lost ("Get help signing in"). Null = "your administrator".
    support_email: config.SUPPORT_EMAIL ?? null,
    reset_wait_days: config.MFA_RESET_WAIT_DAYS,
    // Which second steps to offer (0330). A passkey, when there is one, is shown first.
    passkey_names: e.methods.passkeyNames,
    authenticator_app: e.methods.authenticatorApp,
  };
}

/** A session that a second step (code or passkey) finished — one shape for both. */
function mfaSessionBody(r: MfaLoginResult) {
  return {
    object: "session" as const,
    user: publicUser(r.user),
    // Present only when a recovery code finished the sign-in, so the dashboard can say so.
    ...(r.recoveryCodesLeft !== undefined ? { recovery_codes_left: r.recoveryCodesLeft } : {}),
    // The raw cookie value, once. The dashboard stores it on its own origin.
    ...(r.trustedBrowser
      ? {
          trusted_browser: {
            token: r.trustedBrowser.token,
            expires_at: r.trustedBrowser.expiresAt.toISOString(),
          },
        }
      : {}),
  };
}

/** A refused passkey ceremony. `not_found` tells the browser to forget that credential. */
function passkeyRefusal(reply: FastifyReply, e: PasskeyError) {
  return reply.code(e.reason === "not_found" ? 404 : 400).send({
    error: { type: "passkey_error", reason: e.reason, message: e.message },
  });
}

/** Removing the last method needs `confirm_turn_off`; an organization's rule can refuse it. */
function methodRemovalRefusal(reply: FastifyReply, e: unknown) {
  if (e instanceof LastTwoFactorMethodError)
    return reply.code(409).send({ error: { type: "last_two_factor_method", message: e.message } });
  if (e instanceof OrganizationRequiresTwoFactorError)
    return reply.code(409).send({
      error: {
        type: "organization_requires_two_factor",
        message: e.message,
        organizations: e.organizations.map((o) => ({ id: o.publicId, name: o.name })),
      },
    });
  if (e instanceof PasskeyError) return passkeyRefusal(reply, e);
  if (e instanceof AuthError)
    return reply.code(400).send({ error: { type: "invalid_request_error", message: e.message } });
  return null;
}

function tokenFromReq(req: FastifyRequest): string | null {
  return sessionTokenFromHeaders(req.headers as Record<string, unknown>);
}

/**
 * 403 `step_up_required` unless this session stepped up (or signed in) within the window.
 *
 * Only on 2FA and passkey management (2026-11-04, audit P2-PASSKEY): a stolen session must not
 * add its own factor, mint recovery codes or switch 2FA off. Returns true when it has answered.
 */
async function refuseUnlessSteppedUp(
  req: FastifyRequest,
  reply: FastifyReply,
  actor: AuthedUser,
): Promise<boolean> {
  const token = tokenFromReq(req);
  if (token && (await stepUpFresh(token))) return false;
  reply.code(403).send({
    error: {
      type: "step_up_required",
      code: "step_up_required",
      message:
        "We could not change your two-factor settings. For this change, you must confirm your identity again. Then try again.",
      method: await stepUpMethodFor(actor.userId),
      window_minutes: config.STEP_UP_WINDOW_MINUTES,
    },
  });
  return true;
}

/** Where a request came from, for the security trail and its emails. */
const reqCtx = (req: FastifyRequest) => ({
  ip: req.ip,
  userAgent: req.headers["user-agent"] ?? null,
});

/**
 * The trusted-browser cookie, as the dashboard forwards it (0329). The dashboard owns the cookie
 * on its own origin; it reaches us only on the sign-in calls that can use it.
 */
export const TRUSTED_BROWSER_HEADER = "x-tmb-trusted-browser";
const trustedBrowserFrom = (req: FastifyRequest): string | null => {
  const v = req.headers[TRUSTED_BROWSER_HEADER];
  return typeof v === "string" && v.length <= 200 ? v : null;
};
/** `reqCtx` plus the trusted-browser cookie, for the doors that sign someone in. */
export const signInCtx = (req: FastifyRequest) => ({
  ...reqCtx(req),
  trustedBrowserToken: trustedBrowserFrom(req),
});

/** Resolve the session user, or reply 401. Use as a preHandler for portal endpoints. */
export async function requireUser(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthedUser | null> {
  const token = tokenFromReq(req);
  const user = token ? await resolveSession(token) : null;
  if (!user) {
    reply.code(401).send({ error: { type: "authentication_error", message: "Not signed in" } });
    return null;
  }
  return user;
}

/** Sign-up answers (0354). Required: they shape the sandbox and who we follow up with. */
const signupProfile = {
  name: z.string().trim().min(1).max(200),
  organization_name: z.string().trim().min(1).max(200),
  country: z.string().regex(/^[A-Z]{2}$/),
  billing_volume: z.enum(BILLING_VOLUMES),
  gateway: z.enum(SIGNUP_GATEWAYS),
  /** The country of the sign-up request's IP, from the dashboard's CDN header. Sets the billing currency. */
  ip_country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  turnstile_token: z.string().max(4096).optional(),
};
const signupBody = z.union([
  z.object({
    ...signupProfile,
    email: z.string().max(LIMITS.email).email(),
    password: z.string().max(LIMITS.password).min(LIMITS.passwordMin),
  }),
  z.object({ ...signupProfile, google_ticket: z.string().min(1).max(4096) }),
]);
const signupConfirmBody = z.object({ token: z.string().min(1).max(200) });
const signupInviteBody = z.object({
  ...signupProfile,
  token: z.string().min(1).max(200),
  password: z.string().max(LIMITS.password).min(LIMITS.passwordMin),
});
const signupRequestBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().max(LIMITS.email).email(),
  company: z.string().trim().min(1).max(200),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  billing_volume: z.enum(BILLING_VOLUMES).optional(),
  gateway: z.enum(SIGNUP_GATEWAYS).optional(),
  message: z.string().trim().max(2000).optional(),
  turnstile_token: z.string().max(4096).optional(),
});
const log = createLogger("auth.routes");

const loginBody = z.object({
  email: z.string().max(LIMITS.email).email(),
  password: z.string().max(LIMITS.password).min(1),
});
const mfaLoginBody = z.object({
  challenge: z.string().max(200).min(1),
  code: z.string().max(20).min(1),
  /** "Don't ask again on this browser for 30 days" (0329). */
  trust_browser: z.boolean().optional(),
});
const requireMfaBody = z.object({ enabled: z.boolean() }).strict();
const sessionPolicyBody = z
  .object({
    session_idle_minutes: z.number().int().positive().nullable(),
    session_absolute_ttl_hours: z.number().int().positive().nullable(),
    mfa_required_roles: z.array(z.string().max(32)).max(10).nullable(),
  })
  .strict();
/**
 * A WebAuthn response as `@simplewebauthn/browser` produces it. Only the envelope is checked
 * here; the library verifies everything inside, signature included.
 */
const webauthnResponse = z
  .object({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal("public-key"),
    response: z.object({}).passthrough(),
  })
  .passthrough();
/** The browser carries back the handle each ceremony's options were issued with. */
const passkeyHandle = z.string().min(1).max(100);
const passkeySecondStepBody = z.object({
  challenge: z.string().max(200).min(1),
  handle: passkeyHandle,
  response: webauthnResponse,
  trust_browser: z.boolean().optional(),
});
const passkeySignInBody = z.object({ handle: passkeyHandle, response: webauthnResponse });
const passkeyAddBody = z.object({
  handle: passkeyHandle,
  response: webauthnResponse,
  name: z.string().max(200).nullable().optional(),
});
const passkeyRenameBody = z.object({ name: z.string().min(1).max(200) }).strict();
const passkeyIdParam = z.object({ id: z.string().uuid() });
/** `?confirm_turn_off=true`: the caller knows this removes the last method. */
const confirmTurnOffQuery = z.object({ confirm_turn_off: z.enum(["true", "false"]).optional() });
const mfaCodeBody = z.object({ code: z.string().max(20).min(1) });
// The dashboard's own count of release notes. Bounded rather than open: this is a UI highwater,
// and an unbounded integer here would let a client store a value no future note count can reach,
// permanently silencing its own badge.
const releaseNotesSeenBody = z.object({ count: z.number().int().min(0).max(100000) });
// No control characters: a name is rendered in lists, menus and audit lines.
const profileBody = z
  .object({
    name: z
      .string()
      .max(LIMITS.name)
      .refine(
        (v) => ![...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f),
        "Name cannot contain control characters",
      )
      .nullable()
      .optional(),
    theme: z.enum(["light", "dark", "system"]).optional(),
  })
  .strict();
const avatarBody = z
  .object({
    data: z
      .string()
      .min(1)
      .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4),
    content_type: z.string().max(128).optional(),
  })
  .strict();
const stepUpBody = z.object({
  code: z.string().max(20).optional(),
  password: z.string().max(LIMITS.password).optional(),
});
const changePasswordBody = z.object({
  // OPTIONAL since 2026-09-02: an account with no password hash has none to send, and
  // `changePassword` asks for one only when a hash exists.
  current_password: z.string().max(LIMITS.password).optional(),
  new_password: z.string().max(LIMITS.password).min(LIMITS.passwordMin),
});
const switchOrgBody = z.object({ organization: z.string().min(1).max(100) });
/**
 * 2026-08-30: the role enum is spelled out rather than `z.string()` — an unknown role would be
 * refused by the service too, but a 400 naming the field is a better answer than a 400
 * naming the role, and it keeps the accepted set visible at the edge.
 */
const memberRoleBody = z.object({
  role: z.union([
    z.enum(["owner", "admin", "manager", "ops", "developer"]),
    z
      .string()
      .regex(/^role_[A-Za-z0-9]+$/)
      .max(LIMITS.id),
  ]),
});
const forgotBody = z.object({
  email: z.string().email().max(254),
  /**
   * The Turnstile token (audit M3.2). Optional, because the challenge is optional: a
   * deployment with no `TURNSTILE_SECRET_KEY` has no widget in front of this form and would
   * otherwise be unable to submit it at all.
   */
  turnstile_token: z.string().max(2048).optional(),
});
const resetBody = z.object({
  token: z.string().min(1).max(200),
  // Bounded at both ends. `.max(128)` is the NIST/OWASP ceiling and it matters here
  // specifically: this route runs scrypt, whose cost scales with input length, on an
  // UNAUTHENTICATED request (SEC-004).
  new_password: z.string().min(LIMITS.passwordMin).max(128),
});
// No `password`. The inviter does not choose their colleague's credential — 0197 —
// so there is no field here for one, which also means no client can send one.
const inviteBody = z.object({
  email: z.string().max(LIMITS.email).email(),
  // A fixed role code, or a custom role's `role_…` id.
  role: z.union([
    z.enum(["owner", "admin", "manager", "ops", "developer"]),
    z
      .string()
      .regex(/^role_[A-Za-z0-9]+$/)
      .max(LIMITS.id),
  ]),
  name: z.string().max(200).optional(),
});
const mfaResetCancelBody = z.object({ token: z.string().min(1).max(200) });
const acceptInviteBody = z.object({
  token: z.string().min(1).max(200),
  // Bounded at both ends: scrypt cost scales with input length and this route is
  // UNAUTHENTICATED (SEC-004).
  password: z.string().min(LIMITS.passwordMin).max(128),
});

const SIGNUP_CLOSED = {
  error: {
    type: "permission_error",
    message: "Self-serve sign-up is disabled on this deployment. Operators join by invitation.",
  },
} as const;

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post("/auth/signup", async (req, reply) => {
    // Closed by default (audit H2), and Cloud only. Refused before the body is parsed, so a
    // disabled deployment does no work and every caller gets the same answer.
    //
    // 403 rather than 404: the endpoint is real and documented, and pretending otherwise makes
    // a supported deployment look broken to whoever turns it on.
    if (!signupOffered()) return reply.code(403).send(SIGNUP_CLOSED);
    const p = signupBody.safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    const email = "email" in p.data ? p.data.email : null;
    // The most expensive unauthenticated route, and it mails an address the caller names: so
    // per client, and per RECIPIENT as for forgot_password.
    if (
      await refusedByRateLimit(req, reply, {
        scope: "signup",
        keys: [
          { kind: "ip", value: req.ip, limit: config.RATE_LIMIT_SIGNUP_PER_IP },
          ...(email
            ? [
                {
                  kind: "recipient" as const,
                  value: email,
                  limit: config.RATE_LIMIT_MAIL_PER_RECIPIENT,
                },
              ]
            : []),
        ],
        windowMs: SIGNUP_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    if (turnstileRefuses(await verifyTurnstile(p.data.turnstile_token, req.ip))) {
      return reply.code(400).send({
        error: {
          type: "invalid_request_error",
          message: "We could not check that you are a person. Try again.",
        },
      });
    }
    const profile: SignupProfile = {
      name: p.data.name,
      organizationName: p.data.organization_name,
      country: p.data.country,
      billingVolume: p.data.billing_volume,
      gateway: p.data.gateway,
      ipCountry: p.data.ip_country,
    };
    try {
      if ("google_ticket" in p.data) {
        const { token, user } = await completeGoogleSignup(
          p.data.google_ticket,
          profile,
          signInCtx(req),
        );
        setSessionCookie(reply, token);
        return reply.code(201).send({ object: "session", token, user: publicUser(user) });
      }
      // The same 202 for every address: a known one is emailed "sign in instead" (M9).
      await beginPasswordSignup({
        email: p.data.email,
        password: p.data.password,
        profile,
        ip: req.ip,
        dashboardBaseUrl: config.DASHBOARD_BASE_URL,
      });
      return reply.code(202).send({ object: "signup", status: "confirmation_sent" });
    } catch (e) {
      if (e instanceof AuthError)
        return reply
          .code(400)
          .send({ error: { type: "invalid_request_error", message: e.message } });
      throw e;
    }
  });

  /** Whether this deployment offers sign-up, so the dashboard shows the link only when it works. */
  app.get("/auth/signup", async () => ({
    object: "signup_config",
    enabled: signupOffered(),
    // Cloud with sign-up locked: the page takes an access request instead (0405).
    requests: isCloud() && !signupOffered(),
    // `sandbox` kept for older dashboards: true = sign-ups start on the Free plan.
    sandbox: signupOnFreePlan(),
  }));

  /**
   * An access request while sign-up is locked (0405). The same 202 for every address. Staff
   * answer it from the back-office with a sign-up link.
   */
  app.post("/auth/signup_requests", async (req, reply) => {
    if (!isCloud()) return reply.code(403).send(SIGNUP_CLOSED);
    if (signupOffered())
      return reply.code(409).send({
        error: {
          type: "invalid_request_error",
          message: "Sign-up is open. Create your account instead.",
        },
      });
    const p = signupRequestBody.safeParse(req.body);
    if (!p.success)
      return reply.code(400).send({
        error: { type: "invalid_request_error", message: "Correct the highlighted fields." },
      });
    if (
      await refusedByRateLimit(req, reply, {
        scope: "signup_request",
        keys: [
          { kind: "ip", value: req.ip, limit: config.RATE_LIMIT_SIGNUP_PER_IP },
          { kind: "recipient", value: p.data.email, limit: config.RATE_LIMIT_MAIL_PER_RECIPIENT },
        ],
        windowMs: SIGNUP_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    if (turnstileRefuses(await verifyTurnstile(p.data.turnstile_token, req.ip))) {
      return reply.code(400).send({
        error: {
          type: "invalid_request_error",
          message: "We could not check that you are a person. Try again.",
        },
      });
    }
    await submitSignupRequest({
      email: p.data.email,
      name: p.data.name,
      company: p.data.company,
      country: p.data.country,
      billingVolume: p.data.billing_volume,
      gateway: p.data.gateway,
      message: p.data.message,
      ip: req.ip,
    });
    return reply.code(202).send({ object: "signup_request", status: "received" });
  });

  /** The address and prefilled answers behind a sign-up link, for the form (0405). */
  app.get("/auth/signup/invite", async (req, reply) => {
    if (!isCloud())
      return reply.code(404).send({ error: { type: "not_found", message: "No such link." } });
    if (
      await refusedByRateLimit(req, reply, {
        scope: "signup_invite_read",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    const token = String((req.query as { token?: unknown }).token ?? "").slice(0, 200);
    const invite = await readSignupInvite(token);
    if (!invite)
      return reply.code(404).send({
        error: { type: "not_found", message: "This link is not valid or is expired." },
      });
    return {
      object: "signup_invite",
      email: invite.email,
      name: invite.name,
      company: invite.company,
      country: invite.country,
      billing_volume: invite.billingVolume,
      gateway: invite.gateway,
    };
  });

  /** Spend a sign-up link: create the account and sign in. Works while sign-up is locked. */
  app.post("/auth/signup/invite", async (req, reply) => {
    if (!isCloud()) return reply.code(403).send(SIGNUP_CLOSED);
    const p = signupInviteBody.safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    if (
      await refusedByRateLimit(req, reply, {
        scope: "signup_invite",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    try {
      const { token, user } = await completeInvitedSignup(
        p.data.token,
        p.data.password,
        {
          name: p.data.name,
          organizationName: p.data.organization_name,
          country: p.data.country,
          billingVolume: p.data.billing_volume,
          gateway: p.data.gateway,
          ipCountry: p.data.ip_country,
        },
        signInCtx(req),
      );
      setSessionCookie(reply, token);
      return reply.code(201).send({ object: "session", token, user: publicUser(user) });
    } catch (e) {
      if (e instanceof AuthError)
        return reply
          .code(400)
          .send({ error: { type: "invalid_request_error", message: e.message } });
      throw e;
    }
  });

  /** Spend the emailed confirmation link: create the account and sign in (0354). */
  app.post("/auth/signup/confirm", async (req, reply) => {
    // A closed sign-up creates no account, even from a link it sent while it was open.
    if (!signupOffered()) return reply.code(403).send(SIGNUP_CLOSED);
    const p = signupConfirmBody.safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    if (
      await refusedByRateLimit(req, reply, {
        scope: "signup_confirm",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    try {
      const { token, user } = await completePasswordSignup(p.data.token, signInCtx(req));
      setSessionCookie(reply, token);
      return reply.code(201).send({ object: "session", token, user: publicUser(user) });
    } catch (e) {
      if (e instanceof AuthError)
        return reply
          .code(400)
          .send({ error: { type: "invalid_request_error", message: e.message } });
      throw e;
    }
  });

  app.post("/auth/login", async (req, reply) => {
    const p = loginBody.safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    // The credential-stuffing route. The per-EMAIL axis is what the per-account
    // lockout in `auth/service.ts` cannot do, and the per-IP axis is what the lockout
    // cannot do either — one password against ten thousand accounts leaves one
    // failure on each. Both, or neither is worth much.
    if (
      await refusedByRateLimit(req, reply, {
        scope: "login",
        keys: [
          { kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP },
          { kind: "email", value: p.data.email, limit: config.RATE_LIMIT_AUTH_PER_EMAIL },
        ],
        windowMs: AUTH_WINDOW_MS,
        // Credential scope: refuse rather than wave through when the counter cannot be
        // written (audit M2). A login that cannot be metered also cannot be verified.
        failClosed: true,
      })
    )
      return;
    try {
      // The request context is what makes the audit trail worth having (audit M5): an
      // attempt with no address answers none of §9.1's questions. `req.ip` is
      // TRUST_PROXY_HOPS-aware, so it is the real peer rather than a forged header (H3).
      const { token, user } = await login(p.data.email, p.data.password, signInCtx(req));
      setSessionCookie(reply, token);
      return reply.code(200).send({ object: "session", user: publicUser(user) });
    } catch (e) {
      // The password was right and a second factor is outstanding (audit M3). 200, not 401:
      // nothing was rejected, the sign-in is half-finished. The caller gets a short-lived
      // challenge and posts the code to /auth/login/mfa — so the password is never re-sent.
      //
      // Safe to distinguish from a wrong password: the caller has just PROVEN the password, so
      // this reveals nothing they did not demonstrate they already knew.
      if (e instanceof MfaRequiredError) return reply.code(200).send(mfaChallengeBody(e));
      if (e instanceof AuthError)
        return reply
          .code(401)
          .send({ error: { type: "authentication_error", message: e.message } });
      throw e;
    }
  });

  app.post("/auth/logout", async (req, reply) => {
    const token = tokenFromReq(req);
    if (token) await logout(token);
    clearSessionCookie(reply);
    return reply.code(200).send({ object: "logout", ok: true });
  });

  app.get("/auth/me", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    // `mfa_enrollment_required` (audit M3.1) is what lets the dashboard send a mandated role to
    // the enrolment screen instead of letting it walk into a 403 on every page it opens. It is
    // computed here rather than stored, so it disappears the moment the factor is confirmed.
    return {
      object: "user",
      ...publicUser(user),
      // The member's effective permission keys: the dashboard shows and hides controls by them.
      permissions: [...permissionsOf(user)].sort(),
      mfa_enrollment_required: await mfaEnrollmentRequired(
        user.userId,
        user.role,
        user.organizationId,
      ),
      // Lets the dashboard omit a "Current password" field a Google-only operator cannot fill.
      // Computed, not stored, for the same reason as the flag above.
      has_password: await hasPassword(user.userId),
      // The what's-new highwater. Opaque here on purpose: the release notes are markdown files
      // in the dashboard's repo, so only that side can say how many exist. NULL means never
      // initialised, and the dashboard reads that as "caught up".
      release_notes_seen_count: await releaseNotesSeenCount(user.userId),
      ...publicProfile(await userProfile(user.userId)),
      // The current organization's "Require two-factor authentication" standing (0329): drives
      // the grace banner and the gate screen. The API refusal is the control; this is the map.
      organization_two_factor: publicStanding(
        await standingInOrganization(user.userId, user.organizationId),
      ),
      // Live-mode lock, read-only status and the over-limit notice (0354, 0356): drive the
      // shell's banners. Self-hosted reports `enabled` / `active` / no notice whatever the row holds.
      ...(await accountStateOf(user.organizationId).then((a) => ({
        organization_live_access: effectiveLiveAccess(a.liveAccess),
        organization_status: effectiveOrganizationStatus(a.status),
        organization_restricted_reason: isCloud() ? a.restrictedReason : null,
        organization_over_limit: isCloud() && a.overLimitSince != null,
        // First-run hints: the create-business form presets the currency from the country, and
        // the setup checklist names the gateway given at sign-up.
        organization_country: a.country,
        organization_signup_gateway: a.signupGateway,
      }))),
      // The product tour is offered once per person; NULL on the row reads as not yet seen.
      product_tour_seen: await productTourSeen(user.userId),
    };
  });

  /**
   * The person's own profile (0327): name and theme. A dashboard user preference like
   * `release_notes_seen`, so no `Idempotency-Key`: it SETS values, and a replay lands on them.
   */
  app.patch("/auth/me", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const p = profileBody.safeParse(req.body ?? {});
    if (!p.success)
      return reply.code(400).send({
        error: {
          type: "invalid_request_error",
          message: p.error.issues[0]?.message ?? "Invalid body",
          param: p.error.issues[0]?.path.join("."),
        },
      });
    const profile = await updateProfile(user.userId, p.data);
    return { object: "user_profile", ...publicProfile(profile) };
  });

  /** Whether a photo can be uploaded here, and which formats — so the picker matches the route. */
  app.get("/auth/me/avatar", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return {
      object: "avatar_capability",
      upload_enabled: isObjectStoreConfigured(),
      accepts: allowedTypesFor("avatar"),
      max_bytes: MAX_IMAGE_BYTES,
    };
  });

  /**
   * Store a profile photo and point the user at it, in one call. The bytes are checked by
   * their leading magic, not the declared type — same path as brand images.
   */
  app.post("/auth/me/avatar", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const p = avatarBody.safeParse(req.body ?? {});
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    // Counted before the bucket is touched; a malformed body above is not an upload.
    if (
      await refusedByRateLimit(
        req,
        reply,
        {
          scope: "avatar_upload",
          keys: [
            { kind: "user", value: user.userId, limit: config.RATE_LIMIT_AVATAR_UPLOADS_PER_USER },
          ],
          windowMs: UPLOAD_WINDOW_MS,
        },
        UPLOAD_LIMIT_MESSAGE,
      )
    )
      return;
    const owner = { kind: "user" as const, publicId: user.userPublicId };
    try {
      const stored = await uploadBrandImage({
        owner,
        asset: "avatar",
        buffer: Buffer.from(p.data.data, "base64"),
        declaredType: p.data.content_type ?? null,
      });
      const { profile, previousUpload } = await setUploadedAvatar(user.userId, stored.url);
      await deleteStoredImage({ url: previousUpload, owner });
      return reply.code(201).send({ object: "user_profile", ...publicProfile(profile) });
    } catch (e) {
      if (e instanceof ObjectStoreNotConfiguredError)
        return reply.code(503).send({
          error: {
            type: "api_error",
            message: "Photo uploads are not enabled on this deployment.",
          },
        });
      if (e instanceof ImageUploadError)
        return reply
          .code(400)
          .send({ error: { type: "invalid_request_error", message: e.message } });
      throw e;
    }
  });

  app.delete("/auth/me/avatar", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { profile, previousUpload } = await setUploadedAvatar(user.userId, null);
    // Only an uploaded photo can be deleted; a Google photo is not ours and never stored.
    await deleteStoredImage({
      url: previousUpload,
      owner: { kind: "user", publicId: user.userPublicId },
    });
    return { object: "user_profile", ...publicProfile(profile) };
  });

  // ——— The person's own sessions (0327) ————————————————————————————————————————

  app.get("/auth/sessions", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const rows = await listSessions(user.userId, tokenFromReq(req)!);
    return { object: "list", data: rows.map(publicSession) };
  });

  app.delete("/auth/sessions/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    try {
      await revokeSession(
        user.userId,
        (req.params as { id: string }).id,
        tokenFromReq(req)!,
        reqCtx(req),
      );
      return { object: "session", deleted: true };
    } catch (e) {
      if (e instanceof AuthError)
        return reply
          .code(404)
          .send({ error: { type: "invalid_request_error", message: e.message } });
      throw e;
    }
  });

  app.post("/auth/sessions/revoke_others", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const signedOut = await revokeOtherSessions(user.userId, tokenFromReq(req)!, reqCtx(req));
    return { object: "session_revocation", signed_out_sessions: signedOut };
  });

  /**
   * Move the what's-new highwater for the signed-in person.
   *
   * No `Idempotency-Key`: this is a per-user UI preference on the dashboard surface, not a
   * `/v1/*` write, and it is idempotent by construction — it SETS a count rather than
   * incrementing one, so a replay lands on the same value. The count comes from the caller
   * because the engine cannot see the notes; the service clamps it, and the only thing it can
   * affect is that person's own badge. Exempt by name in `verify-idempotency-race`'s coverage
   * lock, with the same reasoning recorded there.
   */
  app.post("/auth/me/release_notes_seen", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const p = releaseNotesSeenBody.safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    await markReleaseNotesSeen(user.userId, p.data.count);
    return reply.code(200).send({ object: "release_notes_seen", count: p.data.count });
  });

  /**
   * Mark the product tour finished or dismissed for the signed-in person. A per-user UI
   * preference like `release_notes_seen`: no `Idempotency-Key`, a replay is a no-op.
   */
  app.post("/auth/me/product_tour_seen", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    await markProductTourSeen(user.userId);
    return reply.code(200).send({ object: "product_tour_seen", seen: true });
  });

  // Self-serve password change for the logged-in user.
  /**
   * Finish a sign-in that stopped at the second factor (audit M3).
   *
   * Rate-limited on the ADDRESS as well as the challenge, because a six-digit code is a
   * 10^6 space and the challenge is the attacker's own: without an IP limit they could grind
   * a code inside one five-minute window. The per-account lockout in `completeMfaLogin` is the
   * other half.
   */
  app.post("/auth/login/mfa", async (req, reply) => {
    const p = mfaLoginBody.safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    if (
      await refusedByRateLimit(req, reply, {
        scope: "login",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    try {
      const r = await completeMfaLogin(p.data.challenge, p.data.code, reqCtx(req), {
        trustBrowser: p.data.trust_browser === true,
      });
      setSessionCookie(reply, r.token);
      return reply.code(200).send(mfaSessionBody(r));
    } catch (e) {
      if (e instanceof AuthError)
        return reply
          .code(401)
          .send({ error: { type: "authentication_error", message: e.message } });
      throw e;
    }
  });

  /**
   * Passkey as the second step (0330). Options are bound to the sign-in's challenge, so only
   * that person's passkeys are offered and only they can finish it.
   */
  app.post("/auth/login/mfa/passkey-options", async (req, reply) => {
    const p = z.object({ challenge: z.string().max(200).min(1) }).safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    if (
      await refusedByRateLimit(req, reply, {
        scope: "login",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    try {
      const r = await passkeySecondStepOptions(p.data.challenge);
      return { object: "passkey_options", handle: r.handle, options: r.options };
    } catch (e) {
      if (e instanceof AuthError)
        return reply
          .code(401)
          .send({ error: { type: "authentication_error", message: e.message } });
      throw e;
    }
  });

  /** Finish the second step with a passkey. Same limits as a code: a failure counts toward the lockout. */
  app.post("/auth/login/mfa/passkey", async (req, reply) => {
    const p = passkeySecondStepBody.safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    if (
      await refusedByRateLimit(req, reply, {
        scope: "login",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    try {
      const r = await completeMfaLoginWithPasskey(
        p.data.challenge,
        p.data.handle,
        p.data.response as never,
        reqCtx(req),
        { trustBrowser: p.data.trust_browser === true },
      );
      setSessionCookie(reply, r.token);
      return reply.code(200).send(mfaSessionBody(r));
    } catch (e) {
      if (e instanceof PasskeyError) return passkeyRefusal(reply, e);
      if (e instanceof AuthError)
        return reply
          .code(401)
          .send({ error: { type: "authentication_error", message: e.message } });
      throw e;
    }
  });

  /** "Sign in with a passkey" (0330): no email, no password — the browser offers what it holds. */
  app.post("/auth/passkey/options", async (req, reply) => {
    if (
      await refusedByRateLimit(req, reply, {
        scope: "login",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    const r = await passkeySignInOptions();
    return { object: "passkey_options", handle: r.handle, options: r.options };
  });

  /** A passkey is both factors, so this session counts as 2FA. No trusted-browser offer: there is no code step to skip. */
  app.post("/auth/passkey/verify", async (req, reply) => {
    const p = passkeySignInBody.safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    if (
      await refusedByRateLimit(req, reply, {
        scope: "login",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    try {
      const { token, user } = await signInWithPasskey(
        p.data.handle,
        p.data.response as never,
        reqCtx(req),
      );
      setSessionCookie(reply, token);
      return reply.code(200).send({ object: "session", user: publicUser(user) });
    } catch (e) {
      if (e instanceof PasskeyError) return passkeyRefusal(reply, e);
      if (e instanceof AuthError)
        return reply
          .code(401)
          .send({ error: { type: "authentication_error", message: e.message } });
      throw e;
    }
  });

  /**
   * Re-authenticate this session for a short window (audit M3.3).
   *
   * A code if the person is enrolled in MFA, their password if not — see `stepUp`. Rate-limited
   * on the account, because it verifies a credential and is therefore a guessing oracle for
   * whoever already holds the session.
   */
  app.post("/auth/step_up", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    const p = stepUpBody.safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    if (
      await refusedByRateLimit(req, reply, {
        scope: "change_password",
        keys: [{ kind: "email", value: actor.email, limit: config.RATE_LIMIT_AUTH_PER_EMAIL }],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    const token = sessionTokenFromHeaders(req.headers as Record<string, unknown>);
    if (!token)
      return reply
        .code(401)
        .send({ error: { type: "authentication_error", message: "Not signed in" } });
    try {
      const r = await stepUp({ sessionToken: token, code: p.data.code, password: p.data.password });
      return { object: "step_up", method: r.method, window_minutes: config.STEP_UP_WINDOW_MINUTES };
    } catch (e) {
      if (e instanceof AuthError)
        return reply
          .code(400)
          .send({ error: { type: "invalid_request_error", message: e.message } });
      throw e;
    }
  });

  /** What this session needs to step up, and whether it already has. */
  app.get("/auth/step_up", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    const token = sessionTokenFromHeaders(req.headers as Record<string, unknown>);
    return {
      object: "step_up_status",
      fresh: token ? await stepUpFresh(token) : false,
      method: await stepUpMethodFor(actor.userId),
      window_minutes: config.STEP_UP_WINDOW_MINUTES,
    };
  });

  /** Whether the signed-in person has a second factor, and how many recovery codes are left. */
  app.get("/auth/mfa", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    return {
      object: "mfa_status",
      ...(await mfaStatus(actor.userId)),
      resetEffectiveAt: (await pendingMfaReset(actor.userId))?.toISOString() ?? null,
    };
  });

  /**
   * Begin authenticator setup (or "Change app" while one is on). Returns the secret to scan; it
   * is held for 15 minutes and touches nothing until confirmed. Recovery codes come from confirm.
   * Step-up sits here, not on confirm, so a stale session never sees a secret.
   */
  app.post("/auth/mfa/enroll", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    if (await refuseUnlessSteppedUp(req, reply, actor)) return;
    try {
      const r = await startMfaEnrollment({ userId: actor.userId });
      return reply.code(201).send({
        object: "mfa_enrollment",
        otpauth_uri: r.otpauthUri,
        secret: r.secret,
        expires_at: r.expiresAt.toISOString(),
        replacing: r.replacing,
      });
    } catch (e) {
      if (e instanceof AuthError)
        return reply
          .code(400)
          .send({ error: { type: "invalid_request_error", message: e.message } });
      throw e;
    }
  });

  /** Prove the authenticator holds the secret. Until this succeeds, login is unaffected. */
  app.post("/auth/mfa/confirm", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    const p = mfaCodeBody.safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    // A confirm attempt is a code-guessing attempt like any other.
    if (
      await refusedByRateLimit(req, reply, {
        scope: "change_password",
        keys: [{ kind: "email", value: actor.email, limit: config.RATE_LIMIT_AUTH_PER_EMAIL }],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    try {
      const r = await confirmMfaEnrollment({
        userId: actor.userId,
        code: p.data.code,
        ctx: reqCtx(req),
      });
      // The codes are returned ONCE, here — only their hashes are stored. Null on "Change app".
      return {
        object: "mfa_status",
        ...(await mfaStatus(actor.userId)),
        replaced: r.replaced,
        recovery_codes: r.recoveryCodes,
      };
    } catch (e) {
      if (e instanceof AuthError)
        return reply
          .code(400)
          .send({ error: { type: "invalid_request_error", message: e.message } });
      throw e;
    }
  });

  /**
   * Turn it off. Needs a recent step-up (2026-11-04); no password field, so a Google-only
   * account is not asked for one it lacks. Metered all the same.
   */
  app.post("/auth/mfa/disable", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    if (await refuseUnlessSteppedUp(req, reply, actor)) return;
    if (
      await refusedByRateLimit(req, reply, {
        scope: "change_password",
        keys: [{ kind: "email", value: actor.email, limit: config.RATE_LIMIT_AUTH_PER_EMAIL }],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    try {
      // The caller's own session survives; every other one is signed out.
      const r = await disableMfa({
        userId: actor.userId,
        keepSessionToken: tokenFromReq(req) ?? undefined,
        ctx: reqCtx(req),
      });
      return {
        object: "mfa_status",
        ...(await mfaStatus(actor.userId)),
        signed_out_sessions: r.signedOutSessions,
      };
    } catch (e) {
      if (e instanceof OrganizationRequiresTwoFactorError)
        return reply.code(409).send({
          error: {
            type: "organization_requires_two_factor",
            message: e.message,
            organizations: e.organizations.map((o) => ({ id: o.publicId, name: o.name })),
          },
        });
      if (e instanceof AuthError)
        return reply
          .code(400)
          .send({ error: { type: "invalid_request_error", message: e.message } });
      throw e;
    }
  });

  /**
   * Replace the recovery codes. The old set stops working at once and the new one is returned
   * ONCE. Needs a recent step-up, like disable; metered all the same.
   */
  app.post("/auth/mfa/recovery_codes", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    if (await refuseUnlessSteppedUp(req, reply, actor)) return;
    if (
      await refusedByRateLimit(req, reply, {
        scope: "change_password",
        keys: [{ kind: "email", value: actor.email, limit: config.RATE_LIMIT_AUTH_PER_EMAIL }],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    try {
      const codes = await regenerateRecoveryCodes(actor.userId, reqCtx(req));
      return reply.code(201).send({ object: "recovery_codes", recovery_codes: codes });
    } catch (e) {
      if (e instanceof AuthError)
        return reply
          .code(400)
          .send({ error: { type: "invalid_request_error", message: e.message } });
      throw e;
    }
  });

  /** Begin adding a passkey (0330). */
  app.post("/auth/mfa/passkeys/options", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    if (await refuseUnlessSteppedUp(req, reply, actor)) return;
    const r = await startPasskeyRegistration(actor.userId);
    return { object: "passkey_options", handle: r.handle, options: r.options };
  });

  /**
   * Store the new passkey. The first method turns 2FA on, and its recovery codes come back ONCE,
   * as from `/auth/mfa/confirm`.
   */
  app.post("/auth/mfa/passkeys", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    if (await refuseUnlessSteppedUp(req, reply, actor)) return;
    const p = passkeyAddBody.safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    try {
      const r = await addPasskey({
        userId: actor.userId,
        handle: p.data.handle,
        response: p.data.response as never,
        name: p.data.name ?? null,
        ctx: reqCtx(req),
      });
      return reply.code(201).send({
        object: "mfa_status",
        ...(await mfaStatus(actor.userId)),
        passkey: r.passkey,
        recovery_codes: r.recoveryCodes,
      });
    } catch (e) {
      const refused = methodRemovalRefusal(reply, e);
      if (refused) return refused;
      throw e;
    }
  });

  app.patch("/auth/mfa/passkeys/:id", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    const id = passkeyIdParam.safeParse(req.params);
    const p = passkeyRenameBody.safeParse(req.body);
    if (!id.success || !p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid request" } });
    try {
      return { object: "passkey", ...(await renamePasskey(actor.userId, id.data.id, p.data.name)) };
    } catch (e) {
      if (e instanceof PasskeyError) return passkeyRefusal(reply, e);
      throw e;
    }
  });

  /** Remove a passkey. The last method needs `?confirm_turn_off=true` and turns 2FA off. */
  app.delete("/auth/mfa/passkeys/:id", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    if (await refuseUnlessSteppedUp(req, reply, actor)) return;
    const id = passkeyIdParam.safeParse(req.params);
    const q = confirmTurnOffQuery.safeParse(req.query);
    if (!id.success || !q.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid request" } });
    try {
      const r = await removePasskey({
        userId: actor.userId,
        passkeyId: id.data.id,
        confirmTurnOff: q.data.confirm_turn_off === "true",
        keepSessionToken: tokenFromReq(req) ?? undefined,
        ctx: reqCtx(req),
      });
      return {
        object: "mfa_status",
        ...(await mfaStatus(actor.userId)),
        signed_out_sessions: r.signedOutSessions,
      };
    } catch (e) {
      const refused = methodRemovalRefusal(reply, e);
      if (refused) return refused;
      throw e;
    }
  });

  /** Remove the authenticator app, keeping 2FA on through passkeys. The last method needs `?confirm_turn_off=true`. */
  app.delete("/auth/mfa/totp", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    if (await refuseUnlessSteppedUp(req, reply, actor)) return;
    const q = confirmTurnOffQuery.safeParse(req.query);
    if (!q.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid request" } });
    try {
      const r = await removeAuthenticatorApp({
        userId: actor.userId,
        confirmTurnOff: q.data.confirm_turn_off === "true",
        keepSessionToken: tokenFromReq(req) ?? undefined,
        ctx: reqCtx(req),
      });
      return {
        object: "mfa_status",
        ...(await mfaStatus(actor.userId)),
        signed_out_sessions: r.signedOutSessions,
      };
    } catch (e) {
      const refused = methodRemovalRefusal(reply, e);
      if (refused) return refused;
      throw e;
    }
  });

  /** "I've saved them" — clears the settings screen's "Not saved" warning. */
  app.post("/auth/mfa/recovery_codes/acknowledge", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    await acknowledgeRecoveryCodes(actor.userId);
    return { object: "mfa_status", ...(await mfaStatus(actor.userId)) };
  });

  app.post("/auth/change_password", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    const p = changePasswordBody.safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    // Authenticated, but still a password-guessing oracle FOR AN ACCOUNT THAT HAS A PASSWORD:
    // it verifies `current_password` whenever a hash exists, so whoever holds a stolen session
    // can grind the real one and convert temporary access into a permanent credential. Keyed on
    // the signed-in account, which is the axis that matters — the thief may well have a fresh
    // IP. (A passwordless Google account verifies nothing here, so it is not an oracle — but it
    // is the case where a stolen session can set a password outright, which is why the meter
    // stays on both paths.)
    if (
      await refusedByRateLimit(req, reply, {
        scope: "change_password",
        keys: [
          { kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP },
          { kind: "email", value: actor.email, limit: config.RATE_LIMIT_AUTH_PER_EMAIL },
        ],
        windowMs: AUTH_WINDOW_MS,
        // Credential scope: refuse rather than wave through when the counter cannot be
        // written (audit M2). A login that cannot be metered also cannot be verified.
        failClosed: true,
      })
    )
      return;
    try {
      await changePassword({
        userId: actor.userId,
        currentPassword: p.data.current_password,
        newPassword: p.data.new_password,
        keepSessionToken: tokenFromReq(req) ?? undefined,
        ctx: reqCtx(req),
      });
      return reply.code(200).send({ object: "password_change", ok: true });
    } catch (e) {
      if (e instanceof AuthError)
        return reply
          .code(400)
          .send({ error: { type: "invalid_request_error", message: e.message } });
      throw e;
    }
  });

  // ——— Multi-organization (0194) ———————————————————————————————————————————
  //
  // `memberships` always allowed a user to hold several; what was missing was a way to
  // see them and to move between them. `login` used to take `LIMIT 1` with no ORDER BY,
  // so a two-org user landed wherever Postgres felt like.

  /** Every organization this user belongs to, with the current one flagged. */
  app.get("/auth/organizations", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    const rows = await listMemberships(actor.userId, actor.organizationId);
    return {
      object: "list",
      data: rows.map((m) => ({
        id: m.organizationPublicId,
        name: m.organizationName,
        icon_url: m.organizationIconUrl,
        role: m.role,
        current: m.current,
      })),
    };
  });

  /**
   * Move this session into another of the user's organizations.
   *
   * The membership check lives in the service and is the entire security of this route
   * — see `switchOrganization`, and SR-2026-008 Issue #4 for the version of this feature
   * that shipped without one. The response re-sets the cookie because switching ROTATES
   * the session token: changing which tenant a credential acts in is a privilege change,
   * and the old bearer value must not keep working.
   */
  app.post("/auth/switch_organization", async (req, reply) => {
    const current = tokenFromReq(req);
    if (!current)
      return reply
        .code(401)
        .send({ error: { type: "authentication_error", message: "Not signed in" } });
    const p = switchOrgBody.safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    try {
      const { token, user } = await switchOrganization(current, p.data.organization);
      setSessionCookie(reply, token);
      // `token` in the body below is LOAD-BEARING, not a leak. The audit (L3) proposed
      // removing it on the grounds that "the dashboard reads the cookie" — it does not:
      // the caller is `switchOrganizationAction`, a Next server action, and its
      // SERVER-SIDE fetch does not pass our Set-Cookie on to the browser. It reads the
      // token from this body and plants the cookie itself (`storeToken`). Dropping it
      // breaks organization switching outright.
      //
      // This is the same server-to-server hand-off the audit accepts for
      // /auth/google/exchange: the body never reaches page script, a Referer, or a browser
      // cache. Remove it only together with Set-Cookie forwarding in the BFF.
      return reply.code(200).send({ object: "session", token, user: publicUser(user) });
    } catch (e) {
      if (e instanceof AuthError)
        return reply.code(403).send({ error: { type: "permission_error", message: e.message } });
      throw e;
    }
  });

  /**
   * Pending invites (0498): an invite to an address that already has an account waits for
   * that person. Only their own session lists, accepts or declines one.
   */
  app.get("/auth/invitations", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    const rows = await listPendingInvites(actor.userId);
    return {
      object: "list",
      data: rows.map((i) => ({
        organization: {
          id: i.organizationPublicId,
          name: i.organizationName,
          icon_url: i.organizationIconUrl,
        },
        role: i.role,
        custom_role: i.customRoleName ? { name: i.customRoleName } : null,
        invited_at: i.invitedAt.toISOString(),
      })),
    };
  });

  const answerInvite =
    (verb: "accept" | "decline") => async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = await requireUser(req, reply);
      if (!actor) return;
      const organization = (req.params as { organization: string }).organization;
      try {
        if (verb === "accept") {
          await acceptMembershipInvite({
            userId: actor.userId,
            userPublicId: actor.userPublicId,
            email: actor.email,
            organizationPublicId: organization,
          });
        } else {
          await declineMembershipInvite({
            userId: actor.userId,
            email: actor.email,
            organizationPublicId: organization,
          });
        }
        return reply.code(200).send({
          object: "invitation",
          organization,
          status: verb === "accept" ? "accepted" : "declined",
        });
      } catch (e) {
        if (e instanceof AuthError)
          return reply
            .code(404)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        throw e;
      }
    };
  app.post("/auth/invitations/:organization/accept", answerInvite("accept"));
  app.post("/auth/invitations/:organization/decline", answerInvite("decline"));

  // ——— Password reset (0194) ————————————————————————————————————————————————

  /**
   * Begin a reset. **Always 200, always the same body.**
   *
   * "No account with that email" is the single easiest account-enumeration oracle to
   * build by accident, and SR-2026-010 is an entire report about what one is worth to
   * an attacker. So the answer never varies: unknown address, known address, mail
   * transport down — all identical. The work happens only on a match, inside the
   * service, which is written to resolve void in every case.
   */
  app.post("/auth/forgot_password", async (req, reply) => {
    const p = forgotBody.safeParse(req.body);
    // Even a MALFORMED body answers 200. A 400 here would say "that is not an address
    // we would ever hold", which is a weaker oracle than the real one but an oracle
    // nonetheless — and there is nothing a legitimate caller does with the distinction.
    if (p.success) {
      // Two axes, per SR-2026-009 Finding 3 step 3. `recipient` is keyed on the VICTIM,
      // not the requester: this route sends mail to an address the caller names, so
      // spreading requests across source addresses must not raise the volume any one
      // inbox receives.
      const limited = await consumePublicRateLimit({
        scope: "forgot_password",
        keys: [
          { kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP },
          { kind: "recipient", value: p.data.email, limit: config.RATE_LIMIT_MAIL_PER_RECIPIENT },
        ],
        windowMs: AUTH_WINDOW_MS,
        // Credential scope: refuse rather than wave through when the counter cannot be
        // written (audit M2). A login that cannot be metered also cannot be verified.
        failClosed: true,
      });
      // A refusal is silent for the same reason the rest of this handler is: a 429 tells
      // the caller this address is being treated specially, which is the very thing the
      // uniform answer exists to deny.
      // The bot challenge (audit M3.2). AFTER the rate limit so a flood is still cheap to
      // refuse, and silent for exactly the reason the 429 above is silent: telling the caller
      // their challenge failed would say this address is being treated specially, which is the
      // one thing this route's uniform answer exists to deny. `skipped` (unconfigured) and
      // `passed` proceed; `failed` and `unavailable` quietly send nothing.
      const challenge = await verifyTurnstile(p.data.turnstile_token, req.ip);
      if (turnstileRefuses(challenge)) {
        log.info("password reset request refused by the bot challenge", { outcome: challenge });
      }
      if (limited.allowed && !turnstileRefuses(challenge)) {
        await requestPasswordReset({
          email: p.data.email,
          ip: req.ip,
          dashboardBaseUrl: config.DASHBOARD_BASE_URL,
        });
      }
    }
    return reply.code(200).send({ object: "password_reset_request", ok: true });
  });

  /** Spend a reset token and set the new password. Revokes EVERY session for the account. */
  app.post("/auth/reset_password", async (req, reply) => {
    const p = resetBody.safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    // Throttled on the address, because the token is the only thing standing between a
    // caller and an account — and guessing is the one attack a single-use token does not
    // itself prevent.
    if (
      await refusedByRateLimit(req, reply, {
        scope: "reset_password",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
        // Credential scope: refuse rather than wave through when the counter cannot be
        // written (audit M2). A login that cannot be metered also cannot be verified.
        failClosed: true,
      })
    )
      return;
    try {
      await resetPasswordWithToken(p.data.token, p.data.new_password, reqCtx(req));
      return reply.code(200).send({ object: "password_reset", ok: true });
    } catch (e) {
      if (e instanceof AuthError)
        return reply
          .code(400)
          .send({ error: { type: "invalid_request_error", message: e.message } });
      throw e;
    }
  });

  /**
   * Stop a support-filed 2FA reset, from the link in its email (0328). Public — the owner may be
   * locked out or on another device — so the token is the only credential, and the route is
   * throttled like every other token route. A repeat click on a cancelled request is success.
   */
  app.post("/auth/mfa/reset/cancel", async (req, reply) => {
    const p = mfaResetCancelBody.safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    if (
      await refusedByRateLimit(req, reply, {
        scope: "mfa_reset_cancel",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
        failClosed: true,
      })
    )
      return;
    try {
      const r = await cancelMfaReset(p.data.token, reqCtx(req));
      return reply.code(200).send({
        object: "mfa_reset",
        status: "cancelled",
        already_cancelled: r.alreadyCancelled,
      });
    } catch (e) {
      if (e instanceof MfaResetCancelError) {
        return reply.code(e.reason === "completed" ? 409 : 404).send({
          error: {
            type: "invalid_request_error",
            code: e.reason === "completed" ? "mfa_reset_completed" : "mfa_reset_not_found",
            message: e.message,
          },
          support_email: config.SUPPORT_EMAIL ?? null,
        });
      }
      throw e;
    }
  });

  /**
   * Accept an invite: spend the token, set the password the INVITEE chose, sign them in.
   *
   * Unauthenticated by necessity — the whole point is that the account cannot be signed
   * into until this succeeds — so it is throttled on the client address like every other
   * credential route.
   */
  app.post("/auth/accept_invite", async (req, reply) => {
    const p = acceptInviteBody.safeParse(req.body);
    if (!p.success)
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    if (
      await refusedByRateLimit(req, reply, {
        scope: "accept_invite",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
        // Credential scope: refuse rather than wave through when the counter cannot be
        // written (audit M2). A login that cannot be metered also cannot be verified.
        failClosed: true,
      })
    )
      return;
    try {
      const { token, user } = await acceptInvite(p.data.token, p.data.password, signInCtx(req));
      setSessionCookie(reply, token);
      // Load-bearing for the same reason as switch_organization above: `acceptInviteAction`
      // reads `token` from this body to plant the session cookie, because a server action
      // cannot inherit our Set-Cookie.
      return reply.code(200).send({ object: "session", token, user: publicUser(user) });
    } catch (e) {
      // An existing account with a second factor: the password is set, the code is still owed.
      if (e instanceof MfaRequiredError) return reply.code(200).send(mfaChallengeBody(e));
      if (e instanceof AuthError)
        return reply
          .code(400)
          .send({ error: { type: "invalid_request_error", message: e.message } });
      throw e;
    }
  });

  // Google sign-in (0194). Registered here so the whole operator-auth surface is one
  // file's worth of routes; the flow itself lives in api/google-oauth.ts.
  await registerGoogleRoutes(app, {
    setSessionCookie,
    publicUser,
    refusedByRateLimit,
    mfaChallengeBody,
    signInCtx,
  });

  // Invite a teammate: members:manage, and only into a role the inviter covers.
  app.post(
    "/auth/invite",
    { preHandler: requireMemberPermission("members:manage") },
    async (req, reply) => {
      const actor = req.member!;
      if (await refusedByOrgTwoFactor(actor, reply)) return;
      // Strict: an unknown field (`is_admin`, `permissions`) is a 400, not silently dropped.
      const p = parseRequest(inviteBody, req.body);
      if (!p.success) return badRequest(reply, p.error);
      // Each invite emails an address the caller chose, from our domain.
      if (
        await refusedByRateLimit(
          req,
          reply,
          {
            scope: "invite",
            keys: [
              { kind: "user", value: actor.userId, limit: config.RATE_LIMIT_INVITES_PER_USER },
              {
                kind: "organization",
                value: actor.organizationId,
                limit: config.RATE_LIMIT_INVITES_PER_ORG,
              },
            ],
            windowMs: HOUR_WINDOW_MS,
          },
          "You sent too many invites in one hour. Try again later.",
        )
      )
        return;
      try {
        const invited = await inviteUser({
          organizationId: actor.organizationId,
          email: p.data.email,
          role: p.data.role,
          name: p.data.name,
          dashboardBaseUrl: config.DASHBOARD_BASE_URL,
          actorEmail: actor.email,
          actorUserId: actor.userId,
          actorPermissions: permissionsOf(actor),
        });
        return reply.code(201).send({ object: "user", ...publicUser(invited) });
      } catch (e) {
        if (e instanceof PermissionEscalationError) return refuseEscalation(reply, e);
        if (e instanceof AuthError)
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        throw e;
      }
    },
  );

  /**
   * ── TEAM MANAGEMENT (2026-08-30) ───────────────────────────────────────────────────
   *
   * The org's members, and the three writes on them. All four require the `admin`
   * permission, which owner and admin hold; the substantive rules (no self-edit, keep at
   * least one administrator, only an unaccepted invite can be resent) live in the service
   * so a second caller cannot miss them.
   *
   * A member is addressed by their `usr_…` public id. The uuid is never in a URL.
   */
  app.get(
    "/auth/members",
    { preHandler: requireMemberPermission("members:view") },
    async (req, reply) => {
      const actor = req.member!;
      if (await refusedByOrgTwoFactor(actor, reply)) return;
      const data = await listTeam(actor.organizationId, actor.userId);
      return reply.code(200).send({ object: "list", data: data.map(publicMember) });
    },
  );

  app.patch(
    "/auth/members/:id",
    { preHandler: requireMemberPermission("members:manage") },
    async (req, reply) => {
      const actor = req.member!;
      if (await refusedByOrgTwoFactor(actor, reply)) return;
      // Strict: an unknown field (`is_admin`, `permissions`) is a 400, not silently dropped.
      const p = parseRequest(memberRoleBody, req.body);
      if (!p.success) return badRequest(reply, p.error);
      try {
        const member = await changeMemberRole({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          actorEmail: actor.email,
          targetPublicId: (req.params as { id: string }).id,
          role: p.data.role,
          actorPermissions: permissionsOf(actor),
        });
        return reply.code(200).send({ object: "member", ...publicMember(member) });
      } catch (e) {
        return authErrorReply(reply, e);
      }
    },
  );

  app.delete(
    "/auth/members/:id",
    { preHandler: requireMemberPermission("members:manage") },
    async (req, reply) => {
      const actor = req.member!;
      if (await refusedByOrgTwoFactor(actor, reply)) return;
      try {
        const { email } = await removeMember({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          actorEmail: actor.email,
          actorPermissions: permissionsOf(actor),
          targetPublicId: (req.params as { id: string }).id,
        });
        return reply.code(200).send({ object: "member", deleted: true, email });
      } catch (e) {
        return authErrorReply(reply, e);
      }
    },
  );

  app.post(
    "/auth/members/:id/resend_invite",
    { preHandler: requireMemberPermission("members:manage") },
    async (req, reply) => {
      const actor = req.member!;
      if (await refusedByOrgTwoFactor(actor, reply)) return;
      try {
        const { email } = await resendMemberInvite({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          actorEmail: actor.email,
          targetPublicId: (req.params as { id: string }).id,
          dashboardBaseUrl: config.DASHBOARD_BASE_URL,
        });
        return reply.code(200).send({ object: "member", resent: true, email });
      } catch (e) {
        return authErrorReply(reply, e);
      }
    },
  );
  // ── Organization "Require two-factor authentication" (0329) ────────────────────

  /** The Settings → Security card: the setting, who turned it on, and who still owes 2FA. */
  app.get(
    "/auth/organization/security",
    { preHandler: requireMemberPermission("security:view") },
    async (req, reply) => {
      const actor = req.member!;
      if (await refusedByOrgTwoFactor(actor, reply)) return;
      const s = await organizationTwoFactorSummary(actor.organizationId);
      return reply.code(200).send({
        object: "organization_security",
        require_two_factor: s.required,
        required_since: s.requiredSince?.toISOString() ?? null,
        required_by: s.requiredBy,
        grace_days: s.graceDays,
        deadline: s.deadline?.toISOString() ?? null,
        deadline_day: s.deadlineDay,
        members: s.members,
        members_with_two_factor: s.membersWithTwoFactor,
        members_in_grace: s.inGrace,
        members_in_grace_deadline_day: s.inGraceDeadlineDay,
        members_blocked: s.blocked,
        // Turning it on needs the caller's own 2FA; the card says so before they try.
        caller_has_two_factor: (await mfaStatus(actor.userId)).confirmed,
        caller_role: actor.role,
        // The org's own session policy (0482) and the installation limits it can only tighten.
        ...policyView(await organizationSessionPolicy(actor.organizationId)),
        deployment: {
          session_idle_minutes: config.SESSION_IDLE_MINUTES,
          session_absolute_ttl_hours: config.SESSION_ABSOLUTE_TTL_HOURS,
          mfa_required_roles: config.MFA_REQUIRED_ROLES,
        },
      });
    },
  );

  /**
   * Turn the requirement on or off. Admin only; ON needs the caller's own 2FA (409). Setting the
   * current value again is a no-op, so nobody's grace period restarts. A dashboard /auth/* write
   * like the member routes, so no Idempotency-Key: it SETS a value.
   */
  app.post(
    "/auth/organization/security/require_two_factor",
    { preHandler: requireMemberPermission("security:manage") },
    async (req, reply) => {
      const actor = req.member!;
      const p = requireMfaBody.safeParse(req.body ?? {});
      if (!p.success)
        return reply.code(400).send({
          error: { type: "invalid_request_error", message: "enabled must be true or false" },
        });
      try {
        const r = await setOrganizationRequireMfa({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          enabled: p.data.enabled,
          ctx: reqCtx(req),
        });
        return reply.code(200).send({
          object: "organization_security",
          require_two_factor: p.data.enabled,
          changed: r.changed,
          notified: r.notified,
        });
      } catch (e) {
        if (e instanceof TwoFactorSetupRequiredError)
          return reply
            .code(409)
            .send({ error: { type: "two_factor_setup_required", message: e.message } });
        throw e;
      }
    },
  );

  /**
   * The organization's session policy (0482): idle timeout, session lifetime, roles that must
   * use 2FA. Each field null = the installation value. Stricter only (400 otherwise); a role
   * list with the caller's own role needs the caller's 2FA (409). Sets values, so no
   * Idempotency-Key, like the toggle above.
   */
  app.post(
    "/auth/organization/security/session_policy",
    { preHandler: requireMemberPermission("security:manage") },
    async (req, reply) => {
      const actor = req.member!;
      const p = sessionPolicyBody.safeParse(req.body ?? {});
      if (!p.success)
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: p.error.issues[0]?.message ?? "Invalid body",
          },
        });
      try {
        const r = await setOrganizationSessionPolicy({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          policy: {
            sessionIdleMinutes: p.data.session_idle_minutes,
            sessionAbsoluteTtlHours: p.data.session_absolute_ttl_hours,
            mfaRequiredRoles: p.data.mfa_required_roles,
          },
        });
        return reply.code(200).send({
          object: "organization_session_policy",
          changed: r.changed,
          ...policyView(r.policy),
        });
      } catch (e) {
        if (e instanceof SessionPolicyError)
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        if (e instanceof TwoFactorSetupRequiredError)
          return reply
            .code(409)
            .send({ error: { type: "two_factor_setup_required", message: e.message } });
        throw e;
      }
    },
  );

  // ── Trusted browsers (0329) ─────────────────────────────────────────────────────

  app.get("/auth/trusted_browsers", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    const data = await listTrustedBrowsers(actor.userId, trustedBrowserFrom(req));
    return reply.code(200).send({ object: "list", data: data.map(publicTrustedBrowser) });
  });

  /** Forget one. Only the caller's own: an id that is not theirs answers 404 like a missing one. */
  app.delete("/auth/trusted_browsers/:id", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    const id = (req.params as { id: string }).id;
    if (!(await forgetTrustedBrowser(actor.userId, id, reqCtx(req))))
      return reply
        .code(404)
        .send({ error: { type: "invalid_request_error", message: "No such trusted browser" } });
    return reply.code(200).send({ object: "trusted_browser", id, deleted: true });
  });

  app.post("/auth/trusted_browsers/forget_all", async (req, reply) => {
    const actor = await requireUser(req, reply);
    if (!actor) return;
    const n = await forgetAllTrustedBrowsers(actor.userId, "forgotten_by_owner", reqCtx(req));
    return reply.code(200).send({ object: "trusted_browsers", forgotten: n });
  });
}

function publicProfile(p: {
  name: string | null;
  avatarUrl: string | null;
  avatarSource: string | null;
  theme: string | null;
}) {
  return { name: p.name, avatar_url: p.avatarUrl, avatar_source: p.avatarSource, theme: p.theme };
}

function publicSession(s: SessionSummary) {
  return {
    id: s.id,
    current: s.current,
    created_at: s.createdAt.toISOString(),
    last_active_at: s.lastActiveAt.toISOString(),
    ip: s.createdIp,
    user_agent: s.userAgent,
    auth_method: s.authMethod,
    organization: s.organizationName,
  };
}

function publicStanding(s: Awaited<ReturnType<typeof standingInOrganization>>) {
  return {
    organization: { id: s.organizationPublicId, name: s.organizationName },
    required: s.required,
    satisfied: s.satisfied,
    deadline: s.deadline?.toISOString() ?? null,
    deadline_day: s.deadlineDay,
    blocked: s.blocked,
  };
}

function publicTrustedBrowser(b: TrustedBrowserSummary) {
  return {
    id: b.id,
    current: b.current,
    user_agent: b.userAgent,
    ip: b.ip,
    created_at: b.createdAt.toISOString(),
    last_used_at: b.lastUsedAt?.toISOString() ?? null,
    expires_at: b.expiresAt.toISOString(),
  };
}

/**
 * The /auth/* routes outside the allowlist refuse a member the organization's 2FA requirement
 * has locked out, with the same 403 `/v1/*` answers. The allowlist (me, logout, mfa/*, sessions,
 * organizations, profile, trusted browsers) is every route that does not call this.
 */
async function refusedByOrgTwoFactor(actor: AuthedUser, reply: FastifyReply): Promise<boolean> {
  const s = await standingInOrganization(actor.userId, actor.organizationId);
  if (!s.blocked) return false;
  reply.code(403).send({
    error: {
      type: "two_factor_required",
      message: `${s.organizationName} requires two-factor authentication. Enable it to continue.`,
      organization: { id: s.organizationPublicId, name: s.organizationName },
      deadline: s.deadline?.toISOString() ?? null,
    },
  });
  return true;
}

function publicUser(u: AuthedUser) {
  return {
    id: u.userPublicId,
    email: u.email,
    role: u.role,
    custom_role: u.customRole ? { id: u.customRole.publicId, name: u.customRole.name } : null,
    organization: u.organizationPublicId,
  };
}

/**
 * 2026-08-30: the wire shape of a team member. `snake_case` and ISO strings, like every other
 * response body, so the dashboard's readers look the same as the ones for `/v1/*`.
 */
function publicMember(m: TeamMemberSummary) {
  return {
    id: m.id,
    email: m.email,
    name: m.name,
    avatar_url: m.avatarUrl,
    role: m.role,
    custom_role: m.customRole,
    status: m.status,
    mfa_enabled: m.mfaEnabled,
    mfa_required: m.mfaRequired,
    mfa_deadline_day: m.mfaDeadlineDay,
    mfa_blocked: m.mfaBlocked,
    last_login_at: m.lastLoginAt?.toISOString() ?? null,
    member_since: m.memberSince.toISOString(),
    is_self: m.isSelf,
  };
}

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in member, set by `requireMemberPermission`. */
    member?: AuthedUser;
  }
}

/**
 * Session-only permission check for the `/auth/*` team routes, which run without
 * `authenticate`. Resolves the member, then checks the key. Tagged for the boot gate.
 */
export function requireMemberPermission(key: PermissionKey) {
  const def = permissionDef(key)!;
  const fn = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    req.member = user;
    if (!permissionsOf(user).has(key)) return missingPermission(reply, def, true);
  };
  const tags = fn as unknown as Record<symbol, string | boolean>;
  tags[PERMISSION_TAG] = key;
  tags[MEMBER_TAG] = true;
  return fn;
}

const refuseEscalation = (reply: FastifyReply, e: Error) =>
  reply.code(403).send({
    error: {
      type: "permission_error",
      code: e instanceof OwnerRequiredError ? e.code : "permission_escalation",
      message: e.message,
    },
  });

/**
 * An `AuthError` from the team services is a REFUSED END STATE ("must keep at least one
 * owner or admin", "no such team member"), not a malformed request — and its message is
 * written to be shown to the person who tried. 400 with the message through, anything
 * else rethrown, so a genuine fault still reaches the error handler as a 500.
 */
function authErrorReply(reply: FastifyReply, e: unknown) {
  if (e instanceof PermissionEscalationError) return refuseEscalation(reply, e);
  if (e instanceof AuthError)
    return reply.code(400).send({ error: { type: "invalid_request_error", message: e.message } });
  throw e;
}
