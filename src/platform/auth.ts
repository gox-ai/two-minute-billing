// Type-only, for the same reason it is type-only in `modules/tenancy/service`.
import type { Role } from "@/modules/auth/service";
import type { KeyPermissionMap } from "@/modules/auth/permissions";
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import {
  authenticateApiKey,
  getBusinessByPublicId,
  markApiKeyUsed,
  type AuthContext,
} from "@/modules/tenancy/service";
import { systemDb } from "@/platform/db";
import { organizations } from "@db/schema";
import { resolvePortalSession } from "@/modules/customer-portal/service";
import { resolveCheckoutSession } from "@/modules/checkout/service";
import {
  permissionsOf,
  resolveSession,
  roleRequiresMfa,
  hasConfirmedMfa,
} from "@/modules/auth/service";
import { standingFor } from "@/modules/auth/org-two-factor";
import type { ApiKeyKind, ApiKeyScope, KeyMode } from "@/platform/api-key";
import { updateEventContext } from "@/platform/event-context";
import { updateTraceContext } from "@/platform/trace";
import { createLogger } from "./logger";
import { config } from "@/platform/config";
import { effectiveLiveAccess, effectiveOrganizationStatus, isCloud } from "@/platform/edition";
import { consumePublicRateLimit, consumeRateLimit } from "@/platform/rate-limit";
import { noteRequestLogAuth, noteRequestLogBusiness } from "@/modules/request-log/capture";

const log = createLogger("auth.api");

/**
 * One shape for every rejected credential, on all three token surfaces (operator
 * API key, portal token, checkout token). Carries the route and the reason and
 * NOTHING from the Authorization header — not even a prefix: a partial credential
 * in a log sink is still a credential in a log sink. The request's traceId is on
 * the line already, so a caller quoting their `x-trace-id` finds the exact refusal.
 */
function logAuthFailure(req: FastifyRequest, reason: string): void {
  log.info("authentication rejected", {
    reason,
    method: req.method,
    url: req.url,
    ip: req.ip,
  });
}

/**
 * The organization fields carried on the request.
 *
 * A WHITELIST, not the row — so a new column is invisible here until it is added, and
 * `/v1/me` then reports "not set" whatever the database holds. That has now cost three
 * fields (timezone, legalName, baseCurrency). `verify:org-view` asserts this view
 * serializes identically to the full row; add a column to the serializer and it goes red.
 */
export type LiveAccess = "locked" | "enabled";

export function authOrganizationView(o: {
  id: string;
  publicId: string;
  name: string;
  isPlatform?: boolean | null;
  timezone?: string | null;
  legalName?: string | null;
  address?: unknown;
  taxRegistrationNumber?: string | null;
  baseCurrency?: string | null;
  iconUrl?: string | null;
  liveAccess?: string | null;
  status?: string | null;
  restrictedReason?: string | null;
}) {
  return {
    id: o.id,
    publicId: o.publicId,
    name: o.name,
    // Marks the operator's own organization; nothing in this repo authorizes on it now. Coerced because the column is new (0196) and a row read
    // through an older path may not carry it; absent means NOT the platform, which is
    // the safe direction.
    isPlatform: o.isPlatform === true,
    // Display preference for org-scoped dashboard screens (0216). Carried on the
    // request so `/v1/me` can answer without a second read — nothing in the billing
    // path reads it; term boundaries key off the BUSINESS zone.
    timezone: o.timezone ?? null,
    // The registered entity (0235), for businesses that issue invoices under the
    // organization. Carried for the same reason as `timezone`: `/v1/me` serializes this
    // row, so a field missing here reads as "not set" on the settings screen no matter
    // what was saved. The INVOICE does not read this — it loads the org itself.
    legalName: o.legalName ?? null,
    address: o.address ?? null,
    taxRegistrationNumber: o.taxRegistrationNumber ?? null,
    // Reporting currency (0268). Carried for the same reason as the fields above:
    // `/v1/me` serializes THIS object, so omitting it reads as "not set" whatever the
    // row holds. Nothing in the billing path converts — this is a read-time choice.
    baseCurrency: o.baseCurrency ?? null,
    // Sidebar logo (0322); carried so `/v1/me` returns it.
    iconUrl: o.iconUrl ?? null,
    // Sandbox lock and read-only status (0354), as the edition enforces them: on self-hosted
    // always `enabled` and `active`. Absent means a row read before the column: the default.
    liveAccess: effectiveLiveAccess(o.liveAccess),
    status: effectiveOrganizationStatus(o.status),
    restrictedReason: o.restrictedReason ?? null,
  };
}

// The authenticated organization is attached to the request for downstream handlers.
declare module "fastify" {
  interface FastifyRequest {
    organization?: {
      /** Registered-entity fields (0235) — see where this object is built. */
      legalName?: string | null;
      address?: unknown;
      taxRegistrationNumber?: string | null;
      baseCurrency?: string | null;
      /** Sidebar logo URL (0322). */
      iconUrl?: string | null;
      id: string;
      publicId: string;
      name: string;
      isPlatform: boolean;
      /** Display timezone for org-scoped screens (0216); null = UTC. */
      timezone: string | null;
      /** Sandbox lock (0354): `locked` refuses live-business writes. */
      liveAccess: LiveAccess;
      /** `active`, or read-only (0354). */
      status: string;
      /** Why it is read-only (0356): `unpaid` or `over_limit`. */
      restrictedReason?: string | null;
    };
    /** Mode of the authenticating API key: 'test' | 'live' | 'all'. */
    keyLivemode?: KeyMode;
    /**
     * What the authenticating credential is: 'api' (an integration's key) or
     * 'dashboard' (the credential our own UI runs on). Drives the request's
     * recorded provenance — see `authenticate` below.
     */
    apiKeyKind?: ApiKeyKind;
    /** What the authenticating KEY may do: 'read' | 'write'. Null for an operator session. */
    apiKeyScope?: ApiKeyScope | null;
    /**
     * The signed-in operator's role, when the credential is a SESSION. Undefined for an API
     * key — a key is not a person and has no role. Read by `requirePerm` (audit H1).
     */
    operatorRole?: Role;
    /** The signed-in operator's user id (uuid), when the credential is a SESSION. */
    operatorUserId?: string;
    /**
     * Whether a PERSON is behind this request. True only for an operator session.
     *
     * `apiKeyKind` cannot answer this: a session and the dashboard's own key both report
     * `'dashboard'`, and only the session has an operator. `requirePerm` needs the
     * distinction to be explicit rather than inferred from a missing role, or forgetting to
     * populate the role somewhere new would silently switch RBAC off.
     */
    hasOperator?: boolean;
    /** The signed-in member's effective permission keys (fixed or custom role). */
    operatorPermissions?: ReadonlySet<string>;
    /** The signed-in member's email and custom role id (`role_…`), when a session. */
    operatorEmail?: string;
    operatorCustomRoleId?: string | null;
    /** The key's per-resource map (0391). Null = by `apiKeyScope`. */
    apiKeyPermissions?: KeyPermissionMap | null;
  }
}

/** The dashboard's session cookie. Set by `/auth/login`, forwarded on every API call. */
export const SESSION_COOKIE = "tmb_session";

/**
 * POSTs a READ-scoped key may still make (audit H1.3), because they only compute.
 *
 * Enforcement is by METHOD rather than by annotation, deliberately: a rule that depends on
 * every route remembering to declare something is a rule with holes, and "no writes" is exactly
 * the kind of claim that must hold for routes nobody thought about. That leaves this short list
 * of POSTs which mutate nothing — three estimates and a template preview. Refusing them would
 * make a read key unable to answer "what would this cost", which is most of what read access is
 * for.
 *
 * Matched against the ROUTE PATTERN (`routeOptions.url`), never the raw URL, so a path
 * containing the word "estimate" cannot smuggle itself in.
 *
 * `gateway_accounts/:gwa/verify` is deliberately NOT here: it reaches out to the provider and
 * is an administrative action, not a query.
 */
export const READ_SCOPE_POSTS: ReadonlySet<string> = new Set([
  "/v1/businesses/:biz/subscriptions/:sub/estimate",
  "/v1/businesses/:biz/subscriptions/:sub/cancel_estimate",
  "/v1/businesses/:biz/customers/:cus/subscription_estimate",
  "/v1/businesses/:biz/emails/templates/:type/preview",
  "/v1/businesses/:biz/prices/:price/rate_change_preview",
]);

/** Methods that never change state. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** Read or write, by the read scope's rule. The request log keeps reads and writes apart. */
export function requestKind(method: string, route: string): "read" | "write" {
  return SAFE_METHODS.has(method) || READ_SCOPE_POSTS.has(route) ? "read" : "write";
}

/**
 * Pull the dashboard session token out of a request's headers — the `tmb_session`
 * cookie, or `Authorization: Bearer sess_…` for non-browser clients.
 *
 * Lives here rather than in `api/auth-routes.ts` because BOTH the session routes and
 * `authenticate` need it, and the second is the reason it moved: a request can carry a
 * key in `Authorization` AND a session in `Cookie` at the same time, which is exactly
 * what the dashboard sends.
 */
export function sessionTokenFromHeaders(headers: Record<string, unknown>): string | null {
  const cookie = headers["cookie"];
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const [k, v] = part.trim().split("=");
      if (k === SESSION_COOKIE && v) return v;
    }
  }
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer sess_"))
    return auth.slice("Bearer ".length);
  return null;
}

/**
 * Who to record as the actor of a request made with a `dashboard` credential.
 *
 * The credential says WHICH ORGANIZATION; the forwarded session says WHICH PERSON.
 * They are checked against each other — a session belonging to a different org is
 * ignored rather than trusted, so a leaked session from org B can never sign an action
 * taken against org A. The mismatch is not an auth failure (the key already authorised
 * the org); it only means we don't know who acted, so we say so.
 *
 * With no usable session the actor is the literal `dashboard`: honest about what we
 * know. Never a placeholder person, and never the key id — attributing an operator's
 * click to `key_…` is the confusion this whole line of work exists to remove.
 */
async function dashboardActor(req: FastifyRequest, organizationId: string): Promise<string> {
  const token = sessionTokenFromHeaders(req.headers as Record<string, unknown>);
  if (!token) return "dashboard";
  const user = await resolveSession(token);
  if (!user || user.organizationId !== organizationId) return "dashboard";
  return user.email;
}

/**
 * Resolve an operator SESSION to an `AuthContext` — the dashboard's credential (0198).
 *
 * This is the point of the change: the organization comes from the signed-in person, so
 * switching organizations moves the DATA and not just the chrome. Before, the dashboard
 * authenticated with one env-var key bound to one org, and `switchOrganization` rotated
 * a session the data path never consulted — the UI said org B while every `/v1/*` call
 * returned org A's rows, and answered 200 while doing it.
 *
 * Lives here rather than beside `authenticateApiKey` in `modules/tenancy/service`
 * because that module is imported BY `modules/auth/service`, and reaching back for
 * `resolveSession` would close the cycle. `platform/auth` already depends on both.
 *
 * `keyLivemode: 'all'` matches what `kind='dashboard'` keys have always been minted
 * with (`tenancy/service.ts` § createOrganization), so the test/live partition behaves
 * exactly as it did.
 */
async function authenticateOperatorSession(token: string): Promise<AuthContext | null> {
  const user = await resolveSession(token);
  if (!user) return null;
  const [organization] = await systemDb
    .select()
    .from(organizations)
    .where(eq(organizations.id, user.organizationId))
    .limit(1);
  if (!organization) return null;
  return {
    organization,
    // No key row stands behind an operator session.
    apiKeyId: null,
    apiKeyPublicId: null,
    keyLivemode: "all",
    apiKeyKind: "dashboard",
    // Null, not 'write': a session's reach is decided by the PERSON's role, and giving it a
    // key scope would invite someone to check the wrong axis for an operator.
    apiKeyScope: null,
    apiKeyPermissions: null,
    // From the membership `resolveSession` already read: what `requirePerm` checks.
    operator: {
      userId: user.userId,
      email: user.email,
      role: user.role,
      customRoleId: user.customRole?.publicId ?? null,
      permissions: permissionsOf(user),
    },
  };
}

/**
 * Fastify preHandler: require a credential — an operator SESSION or an
 * `Authorization: Bearer <api_key>`.
 * On success, attaches `req.organization` + `req.keyLivemode` + `req.apiKeyKind`,
 * and records the request's provenance (an `api` key is attributed to the key; a
 * `dashboard` credential to the signed-in operator). On failure, replies 401 and
 * short-circuits.
 *
 * Test/live partition: when the route addresses a business (`:biz` param), a
 * test key only reaches test businesses and a live key only live ones ('all'
 * keys reach both). A mode mismatch answers 404 — same as a nonexistent
 * business — so key mode never leaks the other partition's ids.
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  // A request may carry BOTH a session cookie and an API key — that is the dashboard
  // mid-migration off its key, and it is also any proxy that forwards a browser's
  // cookies while adding a key of its own. So the two claims are resolved and then
  // CHECKED AGAINST EACH OTHER, exactly as `dashboardActor` has always done for the
  // actor:
  //
  //  - Only a session         → the session is the credential (0198): the organization
  //                             comes from the signed-in person, so switching orgs moves
  //                             the data and the actor is exact by construction.
  //  - Session + key, SAME org → the session still wins, so the key cannot silently
  //                             override the operator's choice of organization.
  //  - Session + key, DIFFERENT orgs → the session is IGNORED, not believed. A cookie is
  //                             ambient (the browser attaches it, and a proxy forwards
  //                             whatever it was sent); the key was presented
  //                             deliberately. Letting the ambient credential redirect a
  //                             key-authorised call into another tenant would let a
  //                             planted session divert an operator's writes — and their
  //                             customers' data — into the session holder's
  //                             organization, signed with that person's name. The key
  //                             decides the org; the actor then falls back to the
  //                             literal `dashboard`, because we no longer know who.
  //  - Only a key             → the integration path, unchanged.
  const sessionToken = sessionTokenFromHeaders(req.headers as Record<string, unknown>);
  const header = req.headers["authorization"];
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  // `Authorization: Bearer sess_…` IS the session (non-browser clients send it that
  // way) — never re-read it as an API key.
  const keyToken = bearer && bearer !== sessionToken ? bearer : null;

  const sessionCtx = sessionToken ? await authenticateOperatorSession(sessionToken) : null;
  // An expired/unknown session is not a refusal when a valid key is also present: that
  // is an integration's call, so it falls through to the key below.
  const keyCtx = keyToken ? await authenticateApiKey(keyToken) : null;
  // B12: off the critical path — never awaited, never throws.
  if (keyCtx?.apiKeyId) markApiKeyUsed(keyCtx.apiKeyId);

  if (sessionCtx && (!keyCtx || keyCtx.organization.id === sessionCtx.organization.id)) {
    if (await refuseUntilEnrolled(req, reply, sessionCtx)) return;
    return finishAuthentication(req, reply, sessionCtx);
  }

  if (keyCtx) {
    if (sessionCtx) {
      // Not an auth failure — the key authorised the org — but a cross-tenant credential
      // combination is worth a line: it is either a misconfigured proxy or someone
      // testing whether a foreign session is believed.
      log.warn("forwarded session belongs to another organization; ignored", {
        reason: "session_org_mismatch",
        method: req.method,
        route: req.routeOptions?.url ?? req.url,
        organizationId: keyCtx.organization.publicId,
        ip: req.ip,
      });
    }
    return finishAuthentication(req, reply, keyCtx);
  }

  if (!bearer) {
    // 401s are logged (4xx generally is not) because a run of them is the signal
    // itself: a rotated key nobody updated, an integration pointed at the wrong
    // environment, or someone trying keys. Never log the credential — the route and
    // the reason are what you need, and a log sink is not a private place.
    logAuthFailure(req, "missing_bearer");
    return reply.code(401).send({
      error: { type: "authentication_error", message: "Missing Bearer API key" },
    });
  }

  logAuthFailure(req, "invalid_api_key");
  return reply.code(401).send({
    error: { type: "authentication_error", message: "Invalid API key" },
  });
}

/**
 * Refuse a mandated role that has not yet enrolled a second factor (audit M3.1).
 *
 * ── WHY IT LIVES HERE AND NOT IN `login` ────────────────────────────────────────
 * Refusing the LOGIN is the obvious design and it is a trap: the enrolment page is behind the
 * login, so the deploy that turns the policy on locks the whole team out with no route back in.
 * A mandated role therefore still gets a session. What it does not get is `/v1/*` — and because
 * `authenticate` is a per-route preHandler on `/v1/*` alone, the reachable set falls out of the
 * routing rather than from an allow-list someone has to remember to maintain: every `/auth/*`
 * route still answers, which is exactly `mfa/enroll` + `mfa/confirm` to comply, `me` and
 * `logout` to see who you are and leave, and nothing that touches tenant data.
 *
 * ── WHY API KEYS ARE UNTOUCHED ──────────────────────────────────────────────────
 * Only the session branch calls this. A key is not a person, has no role and cannot enrol in
 * anything, so applying a human policy to it would break every integration in the organization
 * to no security benefit — the key's own scope (H1.3) is the control that applies to it.
 *
 * Returns true when it has answered the request.
 */
async function refuseUntilEnrolled(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: AuthContext,
): Promise<boolean> {
  const operator = ctx.operator;
  if (!operator) return false;

  // The organization's own requirement (0329). Same shape as the role mandate below — a session
  // still exists, only `/v1/*` is shut — but bounded by a deadline: inside the grace period the
  // member works normally and the dashboard nags; past it, every `/v1/*` call is refused.
  // `standingFor` runs no query unless the organization requires 2FA.
  const standing = await standingFor(operator.userId, ctx.organization);
  if (standing.blocked) {
    log.info("refused: organization requires 2FA and the deadline has passed", {
      reason: "two_factor_required",
      route: req.routeOptions?.url ?? req.url,
      organizationId: ctx.organization.publicId,
    });
    reply.code(403).send({
      error: {
        type: "two_factor_required",
        message: `${ctx.organization.name} requires two-factor authentication. Enable it to continue.`,
        organization: { id: ctx.organization.publicId, name: ctx.organization.name },
        deadline: standing.deadline?.toISOString() ?? null,
      },
    });
    return true;
  }

  // ⚠ DEPRECATED (0329): `MFA_REQUIRED_ROLES` is a deployment-wide switch kept working for the
  // deployments that set it; an organization's "Require two-factor authentication" is the real
  // control. Cheap sync check first: with the policy off (the default) this costs nothing.
  if (!roleRequiresMfa(operator.role, ctx.organization)) return false;
  if (await hasConfirmedMfa(operator.userId)) return false;
  log.info("refused: second factor mandatory for this role and not enrolled", {
    reason: "mfa_enrollment_required",
    role: operator.role,
    route: req.routeOptions?.url ?? req.url,
    organizationId: ctx.organization.publicId,
  });
  // A DISTINCT error type, not a generic 403. The dashboard routes on it to send the person to
  // the enrolment screen, and a caller who cannot tell "you must enrol" from "you may never do
  // this" has no way to comply with the policy.
  reply.code(403).send({
    error: {
      type: "mfa_enrollment_required",
      message:
        "Your role requires two-factor authentication. Enrol a second factor to continue. Until you do, all other actions are unavailable.",
    },
  });
  return true;
}

/**
 * Everything that happens once a credential — key OR operator session — has resolved
 * to an organization: rate limiting, request scoping, provenance, and the test/live
 * partition. Shared so the two credential paths cannot drift apart; a rule enforced
 * for one and not the other is the kind of gap this whole change exists to close.
 */
async function finishAuthentication(req: FastifyRequest, reply: FastifyReply, ctx: AuthContext) {
  // Before the rate limit, so its 429 is logged too.
  noteRequestLogAuth(req, {
    organizationId: ctx.organization.id,
    source: ctx.apiKeyKind === "dashboard" ? "dashboard" : "api",
    apiKeyId: ctx.apiKeyId,
    memberUserId: ctx.operator?.userId ?? null,
    keyMode: ctx.keyLivemode,
  });
  // ── Rate limit (#6) ────────────────────────────────────────────────────────
  // Checked here — after the credential is known, before anything expensive. The
  // `dashboardActor` lookup below and the business/livemode read after it are both
  // avoidable work for a caller that is about to be refused, and neither is needed to
  // decide the refusal.
  //
  // Counted per API KEY against a limit configured per ORGANIZATION, so a runaway
  // integration cannot lock the operator out of the dashboard (a separate
  // `kind='dashboard'` credential of the same org, with its own counter). Every input
  // is already on `ctx` — no extra query. See platform/rate-limit.ts.
  // An operator session holds no key: it counts per PERSON in the public counter table,
  // against its own limit. Not the org's API limit: that one is tuned for integrations and
  // can be 0 to stop them, which must not lock staff out of the dashboard.
  // Usage ingest routes count per organization per second instead (platform/ingest-rate.ts).
  const sessionUserId = !ctx.apiKeyId ? (ctx.operator?.userId ?? null) : null;
  if (
    config.RATE_LIMIT_ENABLED === "TRUE" &&
    (ctx.apiKeyId || sessionUserId) &&
    req.routeOptions?.config?.usageIngest !== true
  ) {
    const orgLimitPerMinute = ctx.organization.rateLimitPerMinute ?? null;
    const rl = ctx.apiKeyId
      ? await consumeRateLimit({ apiKeyId: ctx.apiKeyId, orgLimitPerMinute })
      : await consumePublicRateLimit({
          scope: "session",
          keys: [
            {
              kind: "user",
              value: sessionUserId,
              limit: config.RATE_LIMIT_SESSION_PER_MINUTE,
            },
          ],
        });
    // Advertised on EVERY response, not just the 429: a client can only back off before
    // being refused if it can see the allowance draining.
    reply.header("X-RateLimit-Limit", String(rl.limit));
    reply.header("X-RateLimit-Remaining", String(rl.remaining));
    reply.header("X-RateLimit-Reset", String(Math.floor(rl.resetAt.getTime() / 1000)));
    if (!rl.allowed) {
      reply.header("Retry-After", String(rl.retryAfterSeconds));
      // Logged for the same reason 401s are: a run of these is the signal — an
      // integration in a retry loop, or a limit set too low for a legitimate workload.
      log.info("rate limit exceeded", {
        event: "rate_limited",
        organizationId: ctx.organization.publicId,
        api_key: ctx.apiKeyPublicId,
        user_id: sessionUserId,
        method: req.method,
        route: req.routeOptions?.url ?? req.url,
        limit: rl.limit,
        retry_after_s: rl.retryAfterSeconds,
      });
      return reply.code(429).send({
        error: {
          type: "rate_limit_error",
          message:
            `Rate limit exceeded: ${rl.limit} requests per minute for this ${ctx.apiKeyId ? "API key" : "user"}. ` +
            `Retry after ${rl.retryAfterSeconds}s.`,
        },
      });
    }
  }

  req.organization = authOrganizationView(ctx.organization);
  req.keyLivemode = ctx.keyLivemode;
  req.apiKeyKind = ctx.apiKeyKind;
  req.apiKeyScope = ctx.apiKeyScope;
  req.apiKeyPermissions = ctx.apiKeyPermissions;
  req.operatorPermissions = ctx.operator?.permissions;
  req.operatorEmail = ctx.operator?.email;
  req.operatorCustomRoleId = ctx.operator?.customRoleId ?? null;
  req.operatorRole = ctx.operator?.role;
  req.operatorUserId = ctx.operator?.userId;
  req.hasOperator = !!ctx.operator;

  // A READ-scoped key may not change anything (audit H1.3). Checked here, on the credential,
  // rather than per-route: this has to hold for routes nobody remembered to annotate, and it is
  // the only thing standing between a leaked integration key and a rewritten ledger.
  //
  // 403 and not 404: the caller's key is valid and the route exists — they simply used a
  // read-only credential for a write, and saying so is what lets them fix it.
  if (
    ctx.apiKeyScope === "read" &&
    !SAFE_METHODS.has(req.method) &&
    !READ_SCOPE_POSTS.has(req.routeOptions?.url ?? "")
  ) {
    logAuthFailure(req, "read_scope_write_attempt");
    return reply.code(403).send({
      error: {
        type: "permission_error",
        message: 'This API key is read-only. Mint a key with scope "write" to make changes.',
      },
    });
  }

  // Read-only organization (0354): its plan is unpaid, or staff approved it after it billed more
  // than its plan covers (0356). Reads, exports and estimates still work. Checked on the
  // credential, like the read scope. Cloud only: a self-hosted install has no plan.
  if (
    isCloud() &&
    ctx.organization.status !== "active" &&
    !SAFE_METHODS.has(req.method) &&
    !READ_SCOPE_POSTS.has(req.routeOptions?.url ?? "")
  ) {
    return reply.code(403).send({
      error: {
        type: "permission_error",
        code: "account_restricted",
        message:
          ctx.organization.restrictedReason === "over_limit"
            ? "This organization is read-only because it billed more than its plan covers. Change to a larger plan in Settings → Billing to make changes again."
            : "This organization is read-only because its plan is unpaid. Pay the open invoice in Settings → Billing to make changes again.",
      },
    });
  }

  // Fill in the provenance on the request-scoped event context established at
  // onRequest (source='api', actor=null); emitEvent() in the handler stamps it (EV-2).
  //
  // A `dashboard` credential is not an integration — it is what our own UI runs on, so
  // the request is recorded as `source='dashboard'` with the PERSON who is signed in
  // as the actor, resolved from the session the dashboard forwards. Attributing it to
  // `key_…` filed every operator click as third-party API traffic, against a
  // credential we also (wrongly) advertised in the org's API-key list.
  //
  // One extra indexed lookup per dashboard request, and only for that kind of
  // credential: an integration's key never pays for it.
  //
  // The IP established at onRequest is deliberately left in place: unlike the clock
  // or a seed, there IS a real request behind this one, and its origin is exactly
  // what the audit trail's `actor_ip` is for.
  updateEventContext(
    ctx.apiKeyKind === "dashboard"
      ? {
          source: "dashboard",
          // A session-authenticated request already knows the person, and knows the org
          // came FROM them — no second lookup, and no mismatch to guard against.
          actor: ctx.operator?.email ?? (await dashboardActor(req, ctx.organization.id)),
        }
      : { actor: ctx.apiKeyPublicId },
  );
  // Same moment, the trace side: `TraceContext` has declared `organizationId` since it
  // was written, documented as "filled in once auth resolves them" — and nothing ever
  // did, so `labels.organizationId` was empty on every API line and the per-tenant
  // query in deploy/README § Logs matched nothing. This is where it becomes knowable.
  // The PUBLIC id, not the row UUID: a person debugging arrives holding `org_…` from a
  // URL, the dashboard footer or a support ticket, and filtering by a UUID they would
  // first have to look up is a log field nobody uses.
  updateTraceContext({ organizationId: ctx.organization.publicId });

  const biz = (req.params as { biz?: string } | undefined)?.biz;
  if (biz && ctx.keyLivemode !== "all") {
    const business = await getBusinessByPublicId(ctx.organization.id, biz);
    if (business?.livemode === ctx.keyLivemode) noteRequestLogBusiness(req, business);
    if (!business || business.livemode !== ctx.keyLivemode) {
      return reply.code(404).send({
        error: { type: "invalid_request_error", message: `No such business: ${biz}` },
      });
    }
  }

  // Sandbox (0354), Cloud only: until the org has a paid plan, nothing in a live business can change.
  // Every business-scoped write carries `:biz`, so this one check covers routes nobody
  // annotated, as the read-scope check above does. Copying a test catalogue to live still
  // works: a transfer's `:biz` is the test source.
  if (
    isCloud() &&
    biz &&
    ctx.organization.liveAccess !== "enabled" &&
    !SAFE_METHODS.has(req.method) &&
    !READ_SCOPE_POSTS.has(req.routeOptions?.url ?? "")
  ) {
    const business = await getBusinessByPublicId(ctx.organization.id, biz);
    if (business?.livemode === "live") {
      return reply.code(403).send({
        error: {
          type: "permission_error",
          code: "live_access_required",
          message:
            "Live mode is off for this organization. Use test mode, or contact us to turn live mode on.",
        },
      });
    }
  }
}

// ——— Customer portal (P14) ———————————————————————————————————————————————

declare module "fastify" {
  interface FastifyRequest {
    /** Customer-scoped portal context (set by authenticatePortal, never by authenticate). */
    portalSession?: {
      sessionPublicId: string;
      organizationId: string;
      businessId: string;
      customerId: string;
    };
  }
}

/**
 * Fastify preHandler for the buyer-facing /portal/v1/* routes: require a valid
 * `Authorization: Bearer pstk_…` portal token. On success attaches
 * `req.portalSession` (org/business/customer scope). Org API keys are a
 * different token namespace and NEVER satisfy this — and portal tokens never
 * satisfy `authenticate` — so the two surfaces stay isolated.
 */
export async function authenticatePortal(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) {
    logAuthFailure(req, "missing_portal_token");
    return reply.code(401).send({
      error: { type: "authentication_error", message: "Missing portal token" },
    });
  }
  const ctx = await resolvePortalSession(header.slice("Bearer ".length).trim());
  if (!ctx) {
    logAuthFailure(req, "invalid_portal_token");
    return reply.code(401).send({
      error: { type: "authentication_error", message: "Invalid or expired portal token" },
    });
  }
  req.portalSession = ctx;
  updateEventContext({ actor: ctx.sessionPublicId });
}

// ——— Hosted checkout (#10d) ——————————————————————————————————————————————

declare module "fastify" {
  interface FastifyRequest {
    /** Checkout context (set by authenticateCheckout, never by authenticate/authenticatePortal). */
    checkoutSession?: import("@/modules/checkout/service").CheckoutContext;
  }
}

/**
 * Fastify preHandler for the buyer-facing /checkout/v1/* routes: require a valid
 * `Authorization: Bearer cstk_…` checkout token. On success attaches
 * `req.checkoutSession` (org/business/price scope). Org API keys and portal
 * tokens are different namespaces and NEVER satisfy this — keeping the hosted
 * checkout surface isolated from both the operator API and the portal.
 */
export async function authenticateCheckout(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) {
    logAuthFailure(req, "missing_checkout_token");
    return reply.code(401).send({
      error: { type: "authentication_error", message: "Missing checkout token" },
    });
  }
  const ctx = await resolveCheckoutSession(header.slice("Bearer ".length).trim());
  if (!ctx) {
    logAuthFailure(req, "invalid_checkout_token");
    return reply.code(401).send({
      error: { type: "authentication_error", message: "Invalid or expired checkout token" },
    });
  }
  req.checkoutSession = ctx;
  updateEventContext({ actor: ctx.sessionPublicId });
}
