/**
 * Google sign-in for OPERATORS (0194) — the engine's half. Two routes:
 * `POST /auth/google/exchange` (authorization code, server-to-server) and
 * `POST /auth/google/one-tap` (an id_token the BROWSER was handed).
 *
 * ── WHO DOES WHAT, AND WHY IT SPLITS HERE ────────────────────────────────────────
 * The browser talks to the DASHBOARD; the dashboard talks to us. Concretely:
 *
 *   1. dashboard `/auth/google/start` mints a random `state`, puts it in an HttpOnly
 *      cookie on the DASHBOARD's origin, and redirects to Google's consent screen.
 *   2. Google returns the browser to the dashboard's `/auth/google/callback` with a
 *      one-time `code` and the `state`.
 *   3. the dashboard compares `state` against its own cookie, then POSTs the `code`
 *      here — server-to-server, the same way every other dashboard→API call works.
 *   4. we exchange the code with Google using the CLIENT SECRET, check the claims,
 *      resolve the operator, and return a session token in the response BODY.
 *   5. the dashboard sets that token as its own HttpOnly cookie and redirects to `/`.
 *
 * The split matters. `state` belongs to whoever started the flow — putting it on this
 * origin would mean a cookie set during a redirect chain the browser began elsewhere.
 * The client SECRET belongs here and must never reach the dashboard's browser bundle or
 * its env. And critically, **the session token is never in a URL**: it travels once, in
 * a server-to-server response body, from us to the dashboard. Redirecting the browser
 * with `?token=…` would have been the same CWE-598 mistake W1 and 0193 exist to undo.
 *
 * ── TWO PATHS, TWO DIFFERENT PROOFS OF ORIGIN ────────────────────────────────────
 * On the CODE path the browser never carries anything we trust. It carries a one-time
 * code, and the id_token comes back to US over TLS from Google's own token endpoint, on
 * a request only we could have made because only we hold the secret. That connection is
 * the proof of origin, which is why Google documents a signature check as unnecessary
 * there — so `verifyIdTokenClaims` only asks the questions TLS does not answer (`iss`,
 * `aud`, `exp`: "about our app, and still valid").
 *
 * The ONE TAP path has no such transport. The credential is handed to page script by
 * Google Identity Services and posted to us, so every byte of it is attacker-suppliable
 * and the SIGNATURE is the only thing standing between a forged JSON blob and a session.
 * `verifyGoogleOneTapToken` therefore verifies RS256 against Google's rotating JWKS
 * before any claim is read. It uses `jose` rather than a hand-rolled verifier: this is
 * the line that decides who is signed in, and a reviewed implementation of signature
 * checking, key caching and rotation is worth more than one dependency.
 *
 * ⚠ Do not "unify" the two by feeding a browser-supplied token to `decodeIdTokenPayload`.
 * That function decodes and does not verify, and it is named so it cannot be mistaken for
 * one; reaching it from the One Tap route would make the whole signature check optional.
 *
 * ── REPLAY, AND WHY THE NONCE IS NOT OPTIONAL ────────────────────────────────────
 * A Google id_token is a bearer credential valid for about an hour, and on this path it
 * reaches page script — so anything that can read it once can post it to us later. The
 * dashboard mints a random `nonce`, parks it in an HttpOnly cookie on its own origin and
 * hands the public copy to Google; Google seals it into the token; we refuse a token
 * whose `nonce` is not the one that attempt began with. The cookie is single-use, so a
 * captured token has no second attempt to be replayed into.
 *
 * ── INVITE-ONLY ──────────────────────────────────────────────────────────────────
 * Nothing here creates an account. `loginWithGoogle` refuses an address holding no
 * membership, so this is a way for an existing operator to sign in — not a way in.
 */
import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";
import { AUTH_WINDOW_MS } from "@/platform/rate-limit";
import type { FastifyInstance } from "fastify";
import {
  loginWithGoogle,
  AuthError,
  GoogleSignupRequired,
  MfaRequiredError,
} from "@/modules/auth/service";
import { signGoogleSignupTicket } from "@/modules/auth/signup";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";

const log = createLogger("auth.google");

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Google's two accepted issuer spellings. Both legitimate; neither optional. */
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/**
 * Configured only when all three are present — the config guard makes it all-or-none,
 * so this is never half-true. The dashboard reads the same fact (via `GET /auth/google`)
 * to decide whether to render the button, so there is one source of truth for
 * "is this available" rather than two that can disagree.
 */
export const googleEnabled = (): boolean =>
  Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REDIRECT_URI);

/**
 * The claims we read. Everything else the id_token carries — locale, hosted domain — is
 * deliberately ignored: a field we do not read cannot mislead us. `picture` is read only as
 * a display URL (see `safePicture`).
 */
interface GoogleClaims {
  iss: string;
  aud: string;
  exp: number;
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
}

/** Google's photo URL, or null. Only `https:` — it is rendered as an `<img src>`. */
export function safePicture(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Decode the id_token payload. NOT a signature check, and named so it cannot be
 * mistaken for one — the transport carries that guarantee (see the file header).
 */
function decodeIdTokenPayload(idToken: string): GoogleClaims | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as GoogleClaims;
  } catch {
    return null;
  }
}

/**
 * Reject a token that is not about US, or not about now.
 *
 * `aud` is the easiest of these to skip and the worst to skip. Without it we would
 * accept an id_token minted for a DIFFERENT Google application — one an attacker
 * controls and can mint freely — and sign its bearer in as whoever it names.
 */
function verifyIdTokenClaims(
  c: GoogleClaims | null,
): { ok: true; claims: GoogleClaims } | { ok: false; reason: string } {
  if (!c) return { ok: false, reason: "unparseable_id_token" };
  if (!ISSUERS.has(c.iss)) return { ok: false, reason: "bad_issuer" };
  if (c.aud !== config.GOOGLE_CLIENT_ID) return { ok: false, reason: "bad_audience" };
  // Seconds, not millis. Refused even though we just received it — cheap, and it closes
  // replay of a token captured from a log.
  if (!Number.isFinite(c.exp) || c.exp * 1000 <= Date.now())
    return { ok: false, reason: "expired" };
  if (!c.sub) return { ok: false, reason: "no_subject" };
  return { ok: true, claims: c };
}

/** `email_verified` arrives as a boolean or the string "true" depending on the path. */
const isVerified = (v: boolean | string | undefined): boolean => v === true || v === "true";

/**
 * Exchange the one-time code and return the verified identity, or a reason.
 *
 * Reasons are for OUR logs. The caller maps every one of them to a single generic
 * message, because the differences between "bad audience", "expired" and "Google said
 * no" are useful to someone tuning an attack and useless to an operator.
 */
export async function exchangeGoogleCode(code: string): Promise<
  | {
      ok: true;
      sub: string;
      email: string;
      emailVerified: boolean;
      name: string | null;
      picture: string | null;
    }
  | { ok: false; reason: string }
> {
  let idToken: string | undefined;
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.GOOGLE_CLIENT_ID!,
        client_secret: config.GOOGLE_CLIENT_SECRET!,
        // OUR configured value, never one supplied by the caller. Google re-checks it
        // against the registered list, but taking it from the request would let a
        // caller steer the exchange, and there is no reason to accept that input.
        redirect_uri: config.GOOGLE_REDIRECT_URI!,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) {
      // Google's error body names the redirect URI and the state of the client secret.
      // Exactly what we need in a log, exactly what nobody else should be handed.
      log.warn("google token exchange failed", {
        event: "google_token_exchange_failed",
        status: res.status,
        detail: (await res.text()).slice(0, 400),
      });
      return { ok: false, reason: `token_endpoint_${res.status}` };
    }
    idToken = ((await res.json()) as { id_token?: string }).id_token;
  } catch (err) {
    log.error(err, { event: "google_token_exchange_error" });
    return { ok: false, reason: "token_endpoint_unreachable" };
  }
  if (!idToken) return { ok: false, reason: "no_id_token" };

  const verdict = verifyIdTokenClaims(decodeIdTokenPayload(idToken));
  if (!verdict.ok) {
    log.info("google id_token rejected", {
      event: "google_id_token_rejected",
      reason: verdict.reason,
    });
    return { ok: false, reason: verdict.reason };
  }
  const { claims } = verdict;
  if (!claims.email) return { ok: false, reason: "no_email" };
  return {
    ok: true,
    sub: claims.sub,
    email: claims.email,
    emailVerified: isVerified(claims.email_verified),
    name: claims.name ?? null,
    picture: safePicture(claims.picture),
  };
}

/**
 * Google's public signing keys. ONE module-level set, on purpose: `createRemoteJWKSet`
 * caches the fetch and re-fetches only when a token names a `kid` it has not seen, which
 * is exactly what key rotation looks like from here. Building it per request would turn
 * every sign-in into an outbound round trip and hand anyone who can call this route a
 * way to make us hammer Google.
 *
 * `cooldownDuration` bounds that refetch: an unknown `kid` is also what a forged token
 * looks like, and without a cooldown a stream of them is a stream of JWKS fetches.
 */
/**
 * Constant-time comparison of two ASCII values that may differ in length.
 *
 * `timingSafeEqual` throws on a length mismatch, so length is checked first — not itself
 * constant-time, but the nonce is a fixed-width random value, so a candidate of the wrong
 * length is already wrong for a reason anyone can see without timing anything. Mirrors
 * the dashboard's `sameState`, which guards the code path's CSRF token the same way.
 */
function sameNonce(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), {
  cooldownDuration: 30_000,
  timeoutDuration: 5_000,
});

/**
 * Verify an id_token the BROWSER handed us (One Tap), and return the identity it names.
 *
 * Unlike the code path, nothing about the transport vouches for this token — so the
 * signature is checked FIRST and nothing below runs on an unverified payload. `jwtVerify`
 * also enforces `iss`, `aud` and `exp` itself; they are passed here rather than re-checked
 * afterwards so there is no window in which a claim has been read but not validated.
 *
 * `expectedNonce` is compared in constant time against the value this attempt started
 * with. It is not a secret — it travels through the browser by design — but comparing it
 * byte-by-byte costs nothing and keeps one habit for every credential comparison here.
 */
export async function verifyGoogleOneTapToken(
  idToken: string,
  expectedNonce: string,
): Promise<
  | {
      ok: true;
      sub: string;
      email: string;
      emailVerified: boolean;
      name: string | null;
      picture: string | null;
    }
  | { ok: false; reason: string }
> {
  let claims: GoogleClaims & { nonce?: string };
  try {
    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: [...ISSUERS],
      audience: config.GOOGLE_CLIENT_ID!,
      // Google's clock and ours are both NTP-disciplined; a token minted seconds ago
      // should not need slack, and slack on `exp` is slack on replay.
      clockTolerance: 5,
    });
    claims = payload as GoogleClaims & { nonce?: string };
  } catch (err) {
    // A bad signature, a wrong audience and an expired token all land here and all mean
    // the same thing to the caller. The class name is kept for OUR logs because "which
    // check failed" is the first question when a deployment's client id is wrong.
    const reason =
      err instanceof joseErrors.JOSEError ? `jwt_${err.code ?? "error"}` : "jwt_unverified";
    log.info("google one-tap id_token rejected", {
      event: "google_one_tap_rejected",
      reason,
    });
    return { ok: false, reason };
  }

  // The nonce is what makes this token belong to THIS sign-in attempt. A token with none
  // is refused rather than waved through — a missing check and a passing check must never
  // look the same.
  if (typeof claims.nonce !== "string" || !sameNonce(claims.nonce, expectedNonce)) {
    return { ok: false, reason: "nonce_mismatch" };
  }
  if (!claims.sub) return { ok: false, reason: "no_subject" };
  if (!claims.email) return { ok: false, reason: "no_email" };
  return {
    ok: true,
    sub: claims.sub,
    email: claims.email,
    emailVerified: isVerified(claims.email_verified),
    name: claims.name ?? null,
    picture: safePicture(claims.picture),
  };
}

/**
 * Registered by `registerAuthRoutes`. Kept in this file so the whole Google surface —
 * the exchange, the claim checks and the route — reads as one thing.
 */
export async function registerGoogleRoutes(
  app: FastifyInstance,
  deps: {
    setSessionCookie: (reply: import("fastify").FastifyReply, token: string) => void;
    publicUser: (u: import("@/modules/auth/service").AuthedUser) => unknown;
    refusedByRateLimit: typeof import("./helpers").refusedByRateLimit;
    mfaChallengeBody: (e: MfaRequiredError) => unknown;
    /** Request context plus the forwarded trusted-browser cookie (0329). */
    signInCtx: (
      req: import("fastify").FastifyRequest,
    ) => import("@/modules/auth/service").LoginContext;
  },
) {
  /**
   * Whether Google sign-in is available. Unauthenticated and deliberately dull: it
   * reveals a deployment configuration flag and nothing about any account. The
   * dashboard calls it to decide whether to render the button, rather than each side
   * keeping its own copy of the answer.
   */
  app.get("/auth/google", async () => ({
    object: "google_sign_in",
    enabled: googleEnabled(),
    /**
     * Returned so the DASHBOARD does not need its own copy of these. Both are public by
     * construction — the client id and the redirect URI are visible in the consent URL
     * the browser is sent to, so publishing them here discloses nothing. The SECRET is
     * never included and never leaves this service.
     *
     * One source of configuration. The alternative, which this replaces, was the same
     * two values in the API's `.env` and again in the dashboard's — and a pair of copies
     * that must agree is a pair of copies that will eventually not.
     */
    ...(googleEnabled()
      ? { client_id: config.GOOGLE_CLIENT_ID, redirect_uri: config.GOOGLE_REDIRECT_URI }
      : {}),
  }));

  app.post("/auth/google/exchange", async (req, reply) => {
    if (!googleEnabled()) {
      return reply.code(404).send({
        error: { type: "invalid_request_error", message: "Google sign-in is not configured" },
      });
    }
    // Unauthenticated, and it performs an outbound call plus account work — so it is
    // throttled per address like every other credential route. Without this it is a
    // free way to make us hammer Google's token endpoint from our own IP.
    if (
      await deps.refusedByRateLimit(req, reply, {
        scope: "google_exchange",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
        // Credential scope: refuse rather than wave through when the counter cannot be
        // written (audit M2). A login that cannot be metered also cannot be verified.
        failClosed: true,
      })
    )
      return;

    const code = (req.body as { code?: unknown } | undefined)?.code;
    if (typeof code !== "string" || code.length === 0 || code.length > 2048) {
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    }

    const identity = await exchangeGoogleCode(code);
    if (!identity.ok) {
      // ONE message for every reason. See `exchangeGoogleCode`.
      return reply.code(401).send({
        error: {
          type: "authentication_error",
          message: "We could not complete the Google sign-in. Try again.",
        },
      });
    }

    return issueSession(req, reply, identity);
  });

  /**
   * One Tap. The browser was handed an id_token by Google Identity Services and the
   * dashboard posts it here, with the nonce that attempt began with.
   *
   * Everything this route trusts comes from the SIGNATURE — see the file header. The
   * shape below is otherwise deliberately identical to the exchange route's, down to
   * sharing `issueSession`, so the two paths cannot drift on what a successful Google
   * sign-in does.
   */
  app.post("/auth/google/one-tap", async (req, reply) => {
    if (!googleEnabled()) {
      return reply.code(404).send({
        error: { type: "invalid_request_error", message: "Google sign-in is not configured" },
      });
    }
    if (
      await deps.refusedByRateLimit(req, reply, {
        scope: "google_one_tap",
        keys: [{ kind: "ip", value: req.ip, limit: config.RATE_LIMIT_AUTH_PER_IP }],
        windowMs: AUTH_WINDOW_MS,
        // Credential scope: refuse rather than wave through when the counter cannot be
        // written (audit M2). Signature verification is cheap but not free, and this is
        // the one Google route an unauthenticated caller can drive without us calling out.
        failClosed: true,
      })
    )
      return;

    const body = req.body as { credential?: unknown; nonce?: unknown } | undefined;
    const credential = body?.credential;
    const nonce = body?.nonce;
    // A Google id_token runs well under 2048 bytes; the bound is there so a verifier is
    // never handed an unbounded string.
    if (
      typeof credential !== "string" ||
      credential.length === 0 ||
      credential.length > 4096 ||
      typeof nonce !== "string" ||
      nonce.length === 0 ||
      nonce.length > 256
    ) {
      return reply
        .code(400)
        .send({ error: { type: "invalid_request_error", message: "Invalid body" } });
    }

    const identity = await verifyGoogleOneTapToken(credential, nonce);
    if (!identity.ok) {
      // ONE message for every reason, as on the exchange route.
      return reply.code(401).send({
        error: {
          type: "authentication_error",
          message: "We could not complete the Google sign-in. Try again.",
        },
      });
    }
    return issueSession(req, reply, identity);
  });

  /**
   * Turn a verified Google identity into a session. Shared by both routes so "what a
   * Google sign-in does" has one definition — `loginWithGoogle` is invite-only, so
   * neither path can create an account.
   */
  async function issueSession(
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
    identity: {
      sub: string;
      email: string;
      emailVerified: boolean;
      name: string | null;
      picture: string | null;
    },
  ) {
    try {
      const { token, user } = await loginWithGoogle(
        {
          googleSub: identity.sub,
          email: identity.email,
          emailVerified: identity.emailVerified,
          name: identity.name,
          picture: identity.picture,
        },
        // Same context the password route passes, so a Google sign-in lands in
        // `login_attempts` and `last_login_ip` with an address like any other, and a trusted
        // browser skips the code here exactly as it does after a password.
        deps.signInCtx(req),
      );
      // Set for a non-browser caller's convenience; the dashboard reads the token from
      // the BODY and sets its own cookie on its own origin.
      deps.setSessionCookie(reply, token);
      return reply.code(200).send({ object: "session", token, user: deps.publicUser(user) });
    } catch (e) {
      // Google proved the first factor only. A person with 2FA gets the same challenge the
      // password door issues, and finishes at /auth/login/mfa.
      if (e instanceof MfaRequiredError) return reply.code(200).send(deps.mfaChallengeBody(e));
      // No account yet: the dashboard carries the ticket to the sign-up form.
      if (e instanceof GoogleSignupRequired) {
        return reply.code(200).send({
          object: "google_signup",
          ticket: signGoogleSignupTicket(e.identity),
          email: e.identity.email,
          name: e.identity.name,
        });
      }
      // Invite-only refusals land here. Their message is already written to reveal
      // nothing about whether the address is one we know.
      if (e instanceof AuthError) {
        return reply
          .code(401)
          .send({ error: { type: "authentication_error", message: e.message } });
      }
      throw e;
    }
  }
}
