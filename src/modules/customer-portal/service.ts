import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { portalSessions, customers, businesses } from "@db/schema";
import { createLogger } from "@/platform/logger";
import { resolveStorefrontConfig } from "@/modules/checkout/storefront-config";

const log = createLogger("customer-portal");

/**
 * Customer portal sessions (P14 slice). An operator mints a short-lived,
 * customer-scoped bearer token; the buyer opens /portal/s/<token> — which moves the
 * token into an HttpOnly cookie and redirects to a clean /portal (W1) — and manages
 * their payment methods through the /portal/v1/* routes, which authenticate
 * with THIS token only — the org API key never reaches the buyer's browser.
 *
 * Mirrors the operator session model (auth/service.ts): the token is returned
 * once and only its SHA-256 hash is stored.
 *
 * ⚠ There is NO self-serve way in, and that is a decision rather than a gap. A buyer
 * cannot ask for their own portal link; an operator or an integration mints one. The
 * emailed-magic-link version of this (`requestPortalMagicLink`, `POST
 * /portal/v1/request_link` and `/portal/request`) was deleted on 2026-08-30 because the
 * shape is wrong, not because nobody had built it — mail clients and security scanners
 * PREFETCH links, so a single-use link is routinely spent before the human clicks.
 * The argument in full, and what the right shape is (a typed one-time PASSWORD, which
 * cannot be prefetched), is in README.md § "Self-serve access".
 * Do not re-add a link-shaped one.
 */

/** Portal links are short-lived — 72h, not the operator session's 7 days. */
const PORTAL_SESSION_TTL_MS = 72 * 3600_000;

/**
 * How long the ENTRY credential in the link stays usable: one hour from the moment the
 * `access_url` was created.
 *
 * Distinct from `PORTAL_SESSION_TTL_MS` above, and the distinction is the point (0193).
 * The entry window bounds how long a link left in an inbox, a chat log or a proxy
 * access log is worth anything; the session TTL bounds how long the buyer stays signed
 * in once they have actually arrived. Collapsing the two — which is what we had — means
 * the value most likely to leak is also the one that lives longest.
 */
const PORTAL_ACCESS_TTL_MS = 3600_000;

/**
 * The entry window for a link that goes in an EMAIL, rather than to an integration.
 *
 * Five days: once an Update payment method link is sent it stays valid that long. The
 * one-hour window above is right for `access_url` — minted by an API call and opened
 * moments later — and wrong for a dunning notice, which is read the
 * next morning, after a weekend, or when someone comes back from leave. An hour would
 * mean the button in almost every billing email is dead before it is pressed.
 *
 * The SESSION ceiling (`PORTAL_SESSION_TTL_MS`) does not move, so a five-day link still
 * buys at most a 72-hour session once opened.
 */
const PORTAL_EMAIL_ACCESS_TTL_MS = 5 * 24 * 3600_000;

/**
 * The portal pages a link may open on: the portal itself and each of its sections
 * (`?tab=` is the page's own deep link, see the storefront's `portal-tabs.ts`).
 */
export const PORTAL_FORWARD_PATHS = [
  "/portal",
  "/portal?tab=invoices",
  "/portal?tab=plan",
  "/portal?tab=methods",
  "/portal?tab=details",
] as const;

/** Where a portal link is destined. Picks the entry window; see 0195. */
export type PortalLinkKind = "api" | "email";

/** The entry window: the business's own setting (Phase 4), else the built-in one. */
const accessTtlFor = (kind: PortalLinkKind, biz?: { storefrontConfig: unknown } | null): number => {
  const cfg = biz ? resolveStorefrontConfig(biz) : null;
  if (kind === "email")
    return cfg?.portalEmailLinkDays != null
      ? cfg.portalEmailLinkDays * 86_400_000
      : PORTAL_EMAIL_ACCESS_TTL_MS;
  return cfg?.portalLinkHours != null ? cfg.portalLinkHours * 3_600_000 : PORTAL_ACCESS_TTL_MS;
};

/** How long a session lasts once open: the business's setting, else 72 hours. */
const sessionTtlFor = (biz?: { storefrontConfig: unknown } | null): number => {
  const hours = biz ? resolveStorefrontConfig(biz).portalSessionHours : null;
  return hours != null ? hours * 3_600_000 : PORTAL_SESSION_TTL_MS;
};

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export interface PortalSessionRef {
  publicId: string;
  /**
   * The single-use ENTRY credential (`pstk_…`) — returned exactly once at mint, never
   * stored in plaintext, and accepted by nothing except `exchangePortalAccessToken`.
   * This is what goes in the link.
   */
  accessToken: string;
  /** When the link stops working. One hour out. */
  accessExpiresAt: Date;
  /** Absolute ceiling on the session the exchange will mint. */
  expiresAt: Date;
}

/** Mint a portal session for one customer. Runs tenant-scoped (RLS). */
export async function createPortalSession(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  /** API key public id that minted the link (audit trail). */
  createdBy?: string;
  /** Where the link is going — picks the entry window. Defaults to the API's one hour. */
  kind?: PortalLinkKind;
  /** Where the buyer lands after signing out (absolute http(s) URL). Absent = the portal's own signed-out card. */
  redirectUrl?: string | null;
  /** Portal path the link opens on (one of `PORTAL_FORWARD_PATHS`). Absent = `/portal`. */
  forwardUrl?: string | null;
  /**
   * Run inside an EXISTING transaction instead of opening one.
   *
   * The email outbox mints a link while already inside the transaction that writes the
   * message row, so the link and the mail that carries it commit together or not at all.
   * Opening a second `withTenant` there would take a separate connection mid-transaction
   * — a deadlock waiting to happen, and a link that can survive a rolled-back email.
   * The caller is responsible for the tenant scope when it passes one.
   */
  tx?: Tx;
}): Promise<PortalSessionRef> {
  const accessToken = `pstk_${randomBytes(32).toString("base64url")}`;
  const psessId = publicId("psess");
  const now = Date.now();
  const kind: PortalLinkKind = input.kind ?? "api";
  const bizRow = async (tx: Tx) =>
    (
      await tx
        .select({ storefrontConfig: businesses.storefrontConfig })
        .from(businesses)
        .where(eq(businesses.id, input.businessId))
        .limit(1)
    )[0] ?? null;
  const biz = await (input.tx ? bizRow(input.tx) : withTenant(input.organizationId, bizRow));
  const expiresAt = new Date(now + sessionTtlFor(biz));
  const accessExpiresAt = new Date(now + accessTtlFor(kind, biz));
  const insert = (tx: Tx) =>
    tx.insert(portalSessions).values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: input.customerId,
      publicId: psessId,
      // No session token yet. The exchange mints one; until then this row cannot
      // authenticate anything, which is what makes the link in the operator's hand an
      // entry ticket rather than a session.
      tokenHash: null,
      accessTokenHash: tokenHash(accessToken),
      accessKind: kind,
      accessExpiresAt,
      status: "created",
      createdBy: input.createdBy ?? null,
      expiresAt,
      redirectUrl: input.redirectUrl ?? null,
      forwardUrl: input.forwardUrl ?? null,
    });
  await (input.tx ? insert(input.tx) : withTenant(input.organizationId, insert));
  // A portal session is a bearer credential handed to an end customer. Never log the
  // token — the session's public id is what correlates it with its later requests.
  log.log("portal session minted", {
    session: psessId,
    customerId: input.customerId,
    businessId: input.businessId,
    createdBy: input.createdBy ?? null,
    kind,
  });
  return { publicId: psessId, accessToken, accessExpiresAt, expiresAt };
}

/**
 * Spend the entry credential and mint the session (0193). This is the only thing that
 * accepts a `pstk_…`, and it accepts each one exactly once.
 *
 * Single-use is enforced in the UPDATE's own WHERE clause, not by a read-then-write.
 * Two requests arriving together — a buyer double-clicking, a link opened in two tabs —
 * both pass a prior existence check, and the loser would otherwise mint a second
 * session against the same spent ticket. Postgres decides it here instead: the first
 * UPDATE sets `consumed_at`, the second matches no row and returns nothing.
 *
 * Returns null for every failure — expired, already spent, revoked, unknown, malformed.
 * ONE answer on purpose: this route is unauthenticated, so telling a caller which of
 * those applied is a free oracle for testing guessed tokens. The buyer sees the same
 * "ask for a new link" card either way.
 */
export async function exchangePortalAccessToken(
  accessToken: string,
  ip?: string | null,
): Promise<{
  token: string;
  expiresAt: Date;
  sessionPublicId: string;
  forwardUrl: string | null;
  businessPublicId: string | null;
} | null> {
  if (!accessToken.startsWith("pstk_")) return null;
  const now = new Date();
  const sessionToken = `psst_${randomBytes(32).toString("base64url")}`;

  // Runs on `db`, not `withTenant`: the caller is an anonymous browser and there is no
  // tenant context to enter — resolving WHICH tenant is what this call is for. Same
  // shape as `resolvePortalSession` below, and the row is found by a hash of a secret
  // the caller had to already hold.
  // 0193: "the session TTL bounds how long the buyer stays signed in once they have
  // actually arrived". Stamped HERE rather than at mint, so it measures from arrival —
  // with a one-hour entry window the difference was invisible, but a five-day email link
  // makes it the difference between a working button and a dead one.
  const sessionExpiresAt = new Date(now.getTime() + PORTAL_SESSION_TTL_MS);
  const [row] = await systemDb
    .update(portalSessions)
    .set({
      tokenHash: tokenHash(sessionToken),
      expiresAt: sessionExpiresAt,
      consumedAt: now,
      loginAt: now,
      loginIp: ip ?? null,
      status: "logged_in",
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(portalSessions.accessTokenHash, tokenHash(accessToken)),
        isNull(portalSessions.consumedAt),
        // The ENTRY window is the gate before a session exists. `expires_at` is
        // deliberately NOT checked here: until the exchange runs there is no session for
        // it to bound, and gating on it capped every link at the session TTL — invisible
        // while links lived an hour, fatal for a five-day email link, which was refused on
        // day four despite its entry window still being open. The exchange stamps the real
        // ceiling below, measured from arrival, which is what 0193 says it means.
        gt(portalSessions.accessExpiresAt, now),
        isNull(portalSessions.revokedAt),
      ),
    )
    .returning();

  if (!row) return null;
  const [biz] = await systemDb
    .select({ publicId: businesses.publicId, storefrontConfig: businesses.storefrontConfig })
    .from(businesses)
    .where(eq(businesses.id, row.businessId))
    .limit(1);
  // The business's own session length (Phase 4); the update above used the built-in one.
  let expiresAtFinal = sessionExpiresAt;
  const ttl = sessionTtlFor(biz);
  if (ttl !== PORTAL_SESSION_TTL_MS) {
    expiresAtFinal = new Date(now.getTime() + ttl);
    await systemDb
      .update(portalSessions)
      .set({ expiresAt: expiresAtFinal })
      .where(eq(portalSessions.id, row.id));
  }
  log.log("portal session opened", {
    session: row.publicId,
    customerId: row.customerId,
    businessId: row.businessId,
  });
  return {
    token: sessionToken,
    expiresAt: expiresAtFinal,
    sessionPublicId: row.publicId,
    forwardUrl: row.forwardUrl,
    businessPublicId: biz?.publicId ?? null,
  };
}

/**
 * What an entry link will open, WITHOUT spending it (Phase 4b). The click-to-continue page
 * reads this so a mail scanner that loads the page spends nothing; only the button does.
 * Null for any link that cannot be exchanged — one answer, like the exchange.
 */
export async function peekPortalAccessToken(accessToken: string): Promise<{
  kind: string;
  forwardUrl: string | null;
  organizationId: string;
  businessId: string;
  businessPublicId: string;
  customerId: string;
} | null> {
  if (!accessToken.startsWith("pstk_")) return null;
  const now = new Date();
  const [row] = await systemDb
    .select({
      kind: portalSessions.accessKind,
      forwardUrl: portalSessions.forwardUrl,
      organizationId: portalSessions.organizationId,
      businessId: portalSessions.businessId,
      customerId: portalSessions.customerId,
      businessPublicId: businesses.publicId,
    })
    .from(portalSessions)
    .innerJoin(businesses, eq(businesses.id, portalSessions.businessId))
    .where(
      and(
        eq(portalSessions.accessTokenHash, tokenHash(accessToken)),
        isNull(portalSessions.consumedAt),
        gt(portalSessions.accessExpiresAt, now),
        isNull(portalSessions.revokedAt),
      ),
    )
    .limit(1);
  return row ? { ...row, kind: row.kind ?? "api" } : null;
}

async function businessPublicIdOf(businessId: string): Promise<string | null> {
  const [b] = await systemDb
    .select({ publicId: businesses.publicId })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return b?.publicId ?? null;
}

/**
 * The business behind a link that FAILED to exchange — spent, expired or revoked — so the
 * portal can show that business's own message. Null for an unknown or malformed token.
 * Reveals only whose a dead link was; it never reopens one.
 */
export async function businessOfDeadPortalLink(accessToken: string): Promise<string | null> {
  if (!accessToken.startsWith("pstk_")) return null;
  const [row] = await systemDb
    .select({ businessId: portalSessions.businessId })
    .from(portalSessions)
    .where(eq(portalSessions.accessTokenHash, tokenHash(accessToken)))
    .limit(1);
  return row ? businessPublicIdOf(row.businessId) : null;
}

/** What a buyer locked out of the portal sees for a business: its brand and message. */
/**
 * The business a signed-out portal page names, with the tenant to enter. Unauthenticated
 * callers have no tenant context yet; resolving it is the point (sign-in by email code).
 */
export async function findPortalBusiness(businessPublicId: string) {
  const [b] = await systemDb
    .select({
      id: businesses.id,
      organizationId: businesses.organizationId,
      publicId: businesses.publicId,
      name: businesses.name,
      storefrontConfig: businesses.storefrontConfig,
    })
    .from(businesses)
    .where(eq(businesses.publicId, businessPublicId))
    .limit(1);
  return b ?? null;
}

export async function getPortalLinkNotice(businessPublicId: string) {
  const [b] = await systemDb
    .select()
    .from(businesses)
    .where(eq(businesses.publicId, businessPublicId))
    .limit(1);
  if (!b) return null;
  return {
    name: b.name,
    logoUrl: b.logoUrl,
    iconUrl: b.iconUrl,
    faviconUrl: b.faviconUrl,
    brandColor: b.brandColor,
    html: resolveStorefrontConfig(b).portalLinkErrorHtml,
    /** Phase 4: the signed-out card offers "email me a code". */
    emailCode: resolveStorefrontConfig(b).portalEmailCode,
  };
}

/**
 * End a portal session (`logout`). Clears the session credential outright
 * rather than only stamping a status — a cookie kept after logout must authenticate
 * nothing, and leaving the hash in place would make that depend on every future reader
 * remembering to check `status`.
 */
export async function logoutPortalSession(
  token: string,
  ip?: string | null,
): Promise<{ redirectUrl: string | null }> {
  if (!token.startsWith("psst_")) return { redirectUrl: null };
  const now = new Date();
  const [row] = await systemDb
    .update(portalSessions)
    .set({
      tokenHash: null,
      status: "logged_out",
      logoutAt: now,
      logoutIp: ip ?? null,
      updatedAt: now,
    })
    .where(eq(portalSessions.tokenHash, tokenHash(token)))
    .returning({ redirectUrl: portalSessions.redirectUrl });
  return { redirectUrl: row?.redirectUrl ?? null };
}

export type PortalSessionRow = typeof portalSessions.$inferSelect;

/** One portal session, scoped to its business and customer (null otherwise). */
export async function getPortalSession(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  sessionPublicId: string;
}): Promise<PortalSessionRow | null> {
  const [row] = await withTenant(input.organizationId, (tx) =>
    tx
      .select()
      .from(portalSessions)
      .where(
        and(
          eq(portalSessions.publicId, input.sessionPublicId),
          eq(portalSessions.businessId, input.businessId),
          eq(portalSessions.customerId, input.customerId),
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

/** What a revoke reports back: enough to render the outcome, no credential. */
export interface RevokedPortalSession {
  publicId: string;
  /** Untouched by revocation — `revoked_at` is orthogonal to the lifecycle status. */
  status: string;
  revokedAt: Date;
}

/**
 * Kill a portal session — both of its credentials at once (F-9). Runs tenant-scoped (RLS).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
 * `revoked_at` has been on this table, and honoured by BOTH readers of it
 * (`exchangePortalAccessToken` and `resolvePortalSession`), with nothing in the product
 * ever setting it. That is two problems in one: an operator whose portal link had leaked
 * had no lever at all, and a guard no code path exercises is a guard nobody would notice
 * breaking. This is the writer; `verify:customer-portal` is the exercise. Exactly the
 * hole that was closed for `checkout_sessions.revoked_at` on 2026-08-28, and this mirrors
 * that design rather than inventing a second one.
 *
 * `logoutPortalSession` was not the lever: it needs the buyer's own `psst_…`, which is in
 * the buyer's cookie and nowhere the operator can reach. An offboarded employee, a shared
 * inbox, a forwarded link — the operator holds the `psess_…` id and nothing else.
 *
 * ── ONE WRITE, BOTH CREDENTIALS ────────────────────────────────────────────────
 * A portal session has TWO credentials where a checkout session has one (0193): the
 * single-use `pstk_…` ENTRY token that appears in the link, and the `psst_…` SESSION
 * token the exchange mints from it. Revocation has to end both, and it does so with ONE
 * write, because both readers already filter `isNull(revokedAt)`:
 *   - a link never opened cannot be entered at all — `exchangePortalAccessToken`'s
 *     UPDATE matches no row, so `POST /portal/v1/session` answers its usual single 401;
 *   - a session already in flight stops working — `resolvePortalSession` returns null, so
 *     `authenticatePortal` never authenticates the request and EVERY `/portal/v1/*`
 *     route, the readable ones included, answers 401.
 *
 * Deliberately NOT also clearing `token_hash`, which is what `logoutPortalSession` does.
 * Two reasons. The row is the audit trail an operator revoked against — which session,
 * opened when, from where — and blanking the credential it names weakens that for no
 * gain. And redundant belt-and-braces here would make the `revoked_at` guard untestable:
 * blinding a resolver to `revoked_at` would still fail closed on the missing hash, so the
 * mutation that proves the guard works could never go red. The guard is the mechanism;
 * it is asserted as the mechanism.
 *
 * ── REVOKED IS NOT LOGGED OUT ──────────────────────────────────────────────────
 * `status` is left alone. `created → logged_in → logged_out` is the lifecycle
 * `portal_sessions` reports and the answer to "was this link ever opened"; revocation is
 * a kill switch beside it, not a step in it. A `created` link and a `logged_in` session
 * are both revocable, and so is a `logged_out` one — logout cleared the session
 * credential but left the ENTRY token's row, and revoking is what makes it unambiguous.
 *
 * Idempotent, like `revokeCheckoutSession` and `revokeApiKey`: revoking an
 * already-revoked session reports the SAME success with the ORIGINAL timestamp (a second
 * call must not move the moment the session died), and only a session that is not this
 * customer's answers null → the route's 404. A session from another organization is
 * invisible under `withTenant`, so it takes the same null path as an unknown id — an
 * operator learns nothing about ids that are not theirs.
 */
export async function revokePortalSession(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  /** `psess_…` public id. */
  sessionPublicId: string;
}): Promise<RevokedPortalSession | null> {
  const now = new Date();
  const cols = {
    publicId: portalSessions.publicId,
    status: portalSessions.status,
    revokedAt: portalSessions.revokedAt,
  };
  // Scoped by BUSINESS and CUSTOMER as well as by the RLS org, mirroring the mint route
  // this is the counterpart to (`/v1/businesses/:biz/customers/:cus/portal_sessions`):
  // a portal session belongs to exactly one customer, and the operator reached this
  // through that customer's path. A session id that is real but somebody else's takes
  // the same null path as one that does not exist.
  const scope = and(
    eq(portalSessions.publicId, input.sessionPublicId),
    eq(portalSessions.businessId, input.businessId),
    eq(portalSessions.customerId, input.customerId),
  );
  const [revoked] = await withTenant(input.organizationId, (tx) =>
    tx
      .update(portalSessions)
      // No `bump_row_version` trigger on this table — the service stamps `updated_at`
      // itself, as `resolvePortalSession` does for `last_used_at`.
      .set({ revokedAt: now, updatedAt: now })
      .where(and(scope, isNull(portalSessions.revokedAt)))
      .returning(cols),
  );
  if (revoked?.revokedAt) {
    // A credential going away explains every 401 that follows it.
    log.warn("portal session revoked — its link and its session are dead", {
      event: "portal_session_revoked",
      session: revoked.publicId,
      status: revoked.status,
      customerId: input.customerId,
      organizationId: input.organizationId,
    });
    return { publicId: revoked.publicId, status: revoked.status, revokedAt: revoked.revokedAt };
  }
  // Nothing updated: either already revoked (report it unchanged) or not ours (null).
  const [existing] = await withTenant(input.organizationId, (tx) =>
    tx.select(cols).from(portalSessions).where(scope).limit(1),
  );
  if (!existing) return null;
  // `revoked_at` is never cleared anywhere, so a row the guarded UPDATE missed is by
  // definition already revoked; the `?? now` only satisfies the column's nullability.
  return {
    publicId: existing.publicId,
    status: existing.status,
    revokedAt: existing.revokedAt ?? now,
  };
}

export interface PortalContext {
  sessionPublicId: string;
  organizationId: string;
  businessId: string;
  customerId: string;
}

/**
 * Resolve a portal token → tenant context, or null. Like API-key resolution
 * this spans organizations, so it uses `systemDb` (the org isn't known
 * until the token is found); everything downstream goes through withTenant.
 */
export async function resolvePortalSession(token: string): Promise<PortalContext | null> {
  // `psst_`, not `pstk_` (0193). The entry credential in the link is deliberately NOT
  // accepted here — it buys one exchange and nothing else, so a leaked link cannot be
  // replayed against the API even inside its one-hour window.
  if (!token.startsWith("psst_")) return null;
  const [s] = await systemDb
    .select()
    .from(portalSessions)
    .where(
      and(
        eq(portalSessions.tokenHash, tokenHash(token)),
        eq(portalSessions.status, "logged_in"),
        gt(portalSessions.expiresAt, new Date()),
        isNull(portalSessions.revokedAt),
      ),
    )
    .limit(1);
  if (!s) return null;
  // Touch last_used_at (no bump_row_version trigger — the service stamps updated_at).
  await systemDb
    .update(portalSessions)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(portalSessions.id, s.id));
  return {
    sessionPublicId: s.publicId,
    organizationId: s.organizationId,
    businessId: s.businessId,
    customerId: s.customerId,
  };
}

/** The customer row a portal session is scoped to (tenant-scoped read). */
export async function getPortalCustomer(ctx: PortalContext) {
  return withTenant(ctx.organizationId, async (tx) => {
    const [c] = await tx.select().from(customers).where(eq(customers.id, ctx.customerId)).limit(1);
    return c ?? null;
  });
}

/** Display info for the business a portal session belongs to (name for the header). */
export async function getPortalBusiness(ctx: PortalContext) {
  return withTenant(ctx.organizationId, async (tx) => {
    const [b] = await tx
      .select()
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId))
      .limit(1);
    return b ?? null;
  });
}
