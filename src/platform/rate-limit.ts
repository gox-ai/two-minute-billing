/**
 * API rate limiting (#6) — the last pure-code item on the go-live blocker list.
 *
 * One fixed-window counter per (API key, minute), held in Postgres so the ceiling is
 * real across processes. The full rationale for window-vs-bucket and
 * per-key-counter-vs-per-org-limit lives in migration `0180_api_rate_limiting.sql`;
 * this file is the mechanism.
 *
 * **The unauthenticated surface** — dashboard login and signup, the buyer's portal
 * magic-link request — is covered by `consumePublicRateLimit` at the bottom of this
 * file (W3, table added in 0191). It is the same fixed-window mechanism against a
 * different key, because those callers hold no API key to count against. Until W3 that
 * gap was stated here and left open; the paragraph is kept in the history because the
 * shape of the omission is the point: a limiter that covers only credentialled callers
 * covers nobody who is attacking you.
 *
 * **Operator sessions** (the dashboard) hold no API key: `finishAuthentication` counts them per
 * user in the public table, scope `session`, against `RATE_LIMIT_SESSION_PER_MINUTE`.
 *
 * **Still not covered, stated rather than implied:** the authenticated buyer routes
 * `/portal/v1/*` and `/checkout/v1/*` once a session exists. Those hold a session token
 * whose issue is already throttled at the point the link is requested, so the useful
 * limit is on minting, not on use. Revisit if a buyer route ever becomes expensive.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";

const log = createLogger("rate-limit");

/**
 * Default window length, and the unit `rate_limit_per_minute` is expressed in — keep those
 * two equal. The API-key limiter (`consumeRateLimit`) always uses this.
 */
const WINDOW_MS = 60_000;

/**
 * Credential routes count over FIFTEEN minutes, which is the unit the standard states its
 * numbers in: "max 10 attempts per IP per 15 minutes, max 5 per email per 15 minutes"
 * (§3.3, restated in §7.1). Applying those counts to a one-minute window — which is what
 * this module did until 2026-08-27 — permitted 450 per IP and 75 per email over the same
 * fifteen minutes, 45× and 15× the policy.
 */
export const AUTH_WINDOW_MS = 15 * 60_000;

/**
 * Signup counts over an HOUR: "max 10 signups per IP per hour" (§3.1). A different unit
 * from login, which is easy to miss — on a one-minute window the old configuration allowed
 * 1,800 signups per IP per hour against a policy of 10.
 */
export const SIGNUP_WINDOW_MS = 60 * 60_000;

/** An hour, for scopes whose limit is stated per hour (invites, ad hoc emails, collects). */
export const HOUR_WINDOW_MS = 60 * 60_000;

/** Image uploads are counted per hour: a person changes a photo a few times, not dozens. */
export const UPLOAD_WINDOW_MS = 60 * 60_000;
export const UPLOAD_LIMIT_MESSAGE = "You uploaded too many images in one hour. Try again later.";

/**
 * How long a spent window's row is kept: two of the LONGEST window in use.
 *
 * Deliberately keyed to the longest and not to `WINDOW_MS`. Retention used to be two
 * minutes, which was correct while every window was a minute — but a row in a 60-minute
 * window has a `window_start` up to an hour old and is still being counted against, so a
 * minute-based cutoff would delete a live counter and hand the caller a fresh allowance.
 * Widening this is the price of per-scope windows; the rows are tiny and the sweep is cheap.
 */
export const RETENTION_MS = 2 * SIGNUP_WINDOW_MS;

export interface RateLimitDecision {
  /** false → the caller must be refused with 429. */
  allowed: boolean;
  /** The ceiling in force for this key, after the per-org override. */
  limit: number;
  /** Requests left in this window (never negative). */
  remaining: number;
  /** When the current window ends and the allowance resets. */
  resetAt: Date;
  /** Seconds until `resetAt`, rounded up — the `Retry-After` value. At least 1. */
  retryAfterSeconds: number;
}

/**
 * Start of the fixed window containing `now`, truncated to `windowMs`.
 *
 * Truncation is what keeps a bucket key stable for every caller inside one window without
 * storing a window id anywhere — and it is why two scopes with different lengths cannot
 * collide even on the same bucket string: their `window_start` values differ.
 */
export function windowStartFor(now: Date, windowMs: number = WINDOW_MS): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * Count one request against `apiKeyId` and say whether it may proceed.
 *
 * The increment and the read are ONE statement, so two concurrent requests cannot both
 * see the pre-increment count and both be allowed through a boundary. `count` is
 * incremented even when the request is refused — that is deliberate: it makes a caller
 * hammering a closed window visible in the counter instead of pinning it at the limit,
 * and the window's end is fixed regardless, so it cannot extend anyone's penalty.
 *
 * A limit of 0 refuses everything for that organization (see the column's docs).
 *
 * **Fails OPEN.** If the counter cannot be written, the request is allowed. A rate
 * limiter that turns a database hiccup into a total API outage is a worse failure than
 * a brief unmetered window — and unlike a money path, letting one extra request through
 * costs nothing that has to be unwound. The failure is logged at error level so it is
 * not silent.
 */
export async function consumeRateLimit(input: {
  apiKeyId: string;
  /** The org's own ceiling, or null to use the deployment default. */
  orgLimitPerMinute: number | null;
  now?: Date;
}): Promise<RateLimitDecision> {
  const now = input.now ?? new Date();
  const limit = input.orgLimitPerMinute ?? config.RATE_LIMIT_PER_MINUTE;
  const start = windowStartFor(now);
  const resetAt = new Date(start.getTime() + WINDOW_MS);
  // Math.max(1): a request landing in the last few milliseconds of a window must not be
  // told to retry after 0 seconds, which reads as "immediately" and invites a hot loop.
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));

  // A zero ceiling needs no counter row — nothing is ever allowed, and writing one per
  // refused request would be pure churn for a blocked organization.
  if (limit === 0) {
    return { allowed: false, limit, remaining: 0, resetAt, retryAfterSeconds };
  }

  try {
    // ONE statement: the increment and the read cannot be split, so two concurrent
    // requests can never both observe the pre-increment count.
    const rows = (await systemDb.execute(sql`
      insert into rate_limit_counters (api_key_id, window_start, count)
      values (${input.apiKeyId}, ${start.toISOString()}, 1)
      on conflict (api_key_id, window_start)
        do update set count = rate_limit_counters.count + 1
      returning count
    `)) as unknown as Array<{ count: number }>;
    const count = Number(rows[0]?.count ?? 0);
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt,
      retryAfterSeconds,
    };
  } catch (e) {
    log.error(e, {
      event: "rate_limit_counter_failed",
      api_key_id: input.apiKeyId,
      detail: "failing OPEN — this request was allowed unmetered",
    });
    return { allowed: true, limit, remaining: limit, resetAt, retryAfterSeconds };
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The unauthenticated surface (W3)
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * How a caller is identified on a route with no credential. Two kinds, because one is
 * not enough and the reason is the whole finding:
 *
 * - `ip` alone is defeated by a botnet, and one office behind a NAT shares a counter.
 * - `email` alone is defeated by rotating the address, which costs nothing.
 *
 * Applied together they cover each other. SR-2026-009 Finding 3 step 2 says to key on
 * "client address AND submitted email address, so distributing an attack across
 * addresses does not evade the limit" — an attacker must now spread across both axes at
 * once, and the mail-flooding case (`recipient`) is keyed on the VICTIM rather than the
 * requester precisely so that spreading the request side achieves nothing.
 */
export type PublicLimitKind =
  | "ip"
  | "email"
  | "recipient"
  | "user"
  | "organization"
  /** One of our own rows (an invoice, a business, an endpoint), by its id. */
  | "resource";

/**
 * Build the stored bucket key.
 *
 * Addresses go in plain; email addresses are hashed. See 0191's header for why — in
 * short, a table of addresses that recently attempted a login is an account directory,
 * and a counter only ever compares for equality.
 */
function bucketKey(scope: string, kind: PublicLimitKind, value: string): string {
  // `user` / `organization` are internal uuids on authenticated routes: not a directory of
  // anything, so they go in plain like an address.
  const plain = kind === "ip" || kind === "user" || kind === "organization" || kind === "resource";
  const v = plain
    ? value
    : createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex");
  return `${scope}:${kind}:${v}`;
}

export interface PublicLimitRule {
  /** Names the route family, e.g. `login`. Keeps counters from colliding. */
  scope: string;
  /** Which axes to count this call against. Every one of them must be under its limit. */
  keys: Array<{ kind: PublicLimitKind; value: string | null | undefined; limit: number }>;
  /**
   * Window length for THIS scope, defaulting to one minute. Credential scopes pass
   * `AUTH_WINDOW_MS`; signup passes `SIGNUP_WINDOW_MS`. The API-key limiter is unaffected —
   * its unit is the minute, because that is what `rate_limit_per_minute` means.
   */
  windowMs?: number;
  /**
   * REFUSE rather than allow when a counter cannot be written (audit M2).
   *
   * Fail-open is right for `/v1/*`: a database hiccup should not become a total API
   * outage. On a credential route the calculus inverts. Refusing logins for the length of
   * an outage costs nothing — the login could not have succeeded anyway, since verifying
   * it reads the same database — while allowing them removes the ONLY control that stops
   * one password being tried against many accounts. The per-account lockout does not
   * cover that case, as `modules/auth/service.ts` says in its own comment: a
   * credential-stuffing run leaves exactly one failure per account and trips no
   * per-account counter.
   *
   * Set on every scope that mints or checks a credential. Left unset elsewhere.
   */
  failClosed?: boolean;
  now?: Date;
}

/**
 * Count one unauthenticated request against every key in the rule, and say whether it
 * may proceed.
 *
 * ALL keys are consumed even once one has already refused. That is deliberate: the
 * counters are also the record of what happened, and stopping early would leave an
 * attacker's per-email counter frozen the moment their per-IP counter tripped, hiding
 * the shape of the attack in exactly the logs you would go looking at. Same reasoning
 * as `consumeRateLimit` incrementing on a refused request.
 *
 * A key whose value is null/empty is SKIPPED, not treated as a shared empty bucket —
 * a login attempt with no email in the body must not share a counter with every other
 * malformed request, or one bad client denies the route to everyone.
 *
 * Fails OPEN **by default**, for the same reason `consumeRateLimit` does: a database
 * hiccup that turns into a total outage is a worse failure than a brief unmetered window,
 * and nothing here has to be unwound afterwards. Logged at error level either way, so it
 * is never silent.
 *
 * Credential scopes pass `failClosed` and invert that — see the field's own comment. The
 * default stays open so a new non-credential scope cannot accidentally become a
 * single-point-of-failure for its route.
 */
export async function consumePublicRateLimit(rule: PublicLimitRule): Promise<RateLimitDecision> {
  const now = rule.now ?? new Date();
  const windowMs = rule.windowMs ?? WINDOW_MS;
  const start = windowStartFor(now, windowMs);
  const resetAt = new Date(start.getTime() + windowMs);
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));

  // The SAME kill switch the API-key limiter reads (`platform/auth.ts`). A deployment
  // that terminates rate limiting at the proxy turns off one variable and gets both,
  // rather than discovering later that half the limiter was still counting.
  if (config.RATE_LIMIT_ENABLED !== "TRUE") {
    return { allowed: true, limit: 0, remaining: 0, resetAt, retryAfterSeconds };
  }

  const active = rule.keys.filter((k) => k.value != null && String(k.value).trim() !== "");
  if (active.length === 0) {
    return { allowed: true, limit: 0, remaining: 0, resetAt, retryAfterSeconds };
  }

  let allowed = true;
  // Reported to the caller as the TIGHTEST of the rule's axes, so the `X-RateLimit-*`
  // headers describe the constraint actually in force rather than whichever key
  // happened to be listed first.
  let tightestLimit = Number.POSITIVE_INFINITY;
  let tightestRemaining = Number.POSITIVE_INFINITY;

  for (const key of active) {
    const bucket = bucketKey(rule.scope, key.kind, String(key.value));
    try {
      const rows = (await systemDb.execute(sql`
        insert into public_rate_limit_counters (bucket, window_start, count)
        values (${bucket}, ${start.toISOString()}, 1)
        on conflict (bucket, window_start)
          do update set count = public_rate_limit_counters.count + 1
        returning count
      `)) as unknown as Array<{ count: number }>;
      const count = Number(rows[0]?.count ?? 0);
      const remaining = Math.max(0, key.limit - count);
      if (count > key.limit) {
        allowed = false;
        // The refusal is the clearest signal available that an attack is in progress,
        // and SR-2026-009 Finding 3 step 6 notes it is currently invisible. `kind` and
        // `scope` are logged; the VALUE is not — hashed for email, and for an address
        // the access log already carries it on the same traceId.
        log.info("public rate limit exceeded", {
          event: "public_rate_limit_exceeded",
          scope: rule.scope,
          kind: key.kind,
          limit: key.limit,
          count,
        });
      }
      if (key.limit < tightestLimit) {
        tightestLimit = key.limit;
        tightestRemaining = remaining;
      }
    } catch (e) {
      // An unwritable counter means this request was NOT metered. On a credential scope
      // that is the moment the control matters most, so refuse instead of waving it
      // through; everywhere else, waving it through beats an outage.
      if (rule.failClosed) allowed = false;
      log.error(e, {
        event: "public_rate_limit_counter_failed",
        scope: rule.scope,
        kind: key.kind,
        detail: rule.failClosed
          ? "failing CLOSED — credential scope, request refused"
          : "failing OPEN — this key was not counted",
      });
    }
  }

  return {
    allowed,
    limit: Number.isFinite(tightestLimit) ? tightestLimit : 0,
    remaining: Number.isFinite(tightestRemaining) ? tightestRemaining : 0,
    resetAt,
    retryAfterSeconds,
  };
}

/**
 * Delete counter rows for windows that have closed and passed retention, from BOTH
 * counter tables. Run by the billing clock; there is nothing to reconcile, so a failure
 * is not worth isolating beyond the pass's own error capture.
 */
export async function sweepRateLimitCounters(now: Date = new Date()): Promise<{ deleted: number }> {
  const cutoff = new Date(windowStartFor(now).getTime() - RETENTION_MS);
  const res = await systemDb.execute(sql`
    delete from rate_limit_counters where window_start < ${cutoff.toISOString()}
  `);
  const pub = await systemDb.execute(sql`
    delete from public_rate_limit_counters where window_start < ${cutoff.toISOString()}
  `);
  // Usage ingest counters are 1-second windows; two minutes is plenty (ingest-rate.ts).
  const ingest = await systemDb.execute(sql`
    delete from ingest_rate_counters
    where window_start < ${new Date(now.getTime() - 2 * 60_000).toISOString()}::timestamptz
  `);
  // `.count` on the driver's result, matching time-travel/service.ts's wipe loop.
  const deleted =
    ((res as unknown as { count?: number }).count ?? 0) +
    ((pub as unknown as { count?: number }).count ?? 0) +
    ((ingest as unknown as { count?: number }).count ?? 0);
  return { deleted };
}

/**
 * A plain counter in the same table, for a decision that is NOT rate limiting and must work
 * whether `RATE_LIMIT_ENABLED` is on or not (the checkout bot check counts failed payments
 * per IP). Fixed windows of `windowMs`; the sweep above removes old ones.
 */
export async function countEvent(input: {
  scope: string;
  kind: PublicLimitKind;
  value: string;
  windowMs: number;
  now?: Date;
}): Promise<void> {
  const start = windowStartFor(input.now ?? new Date(), input.windowMs);
  const bucket = bucketKey(input.scope, input.kind, input.value);
  try {
    await systemDb.execute(sql`
      insert into public_rate_limit_counters (bucket, window_start, count)
      values (${bucket}, ${start.toISOString()}, 1)
      on conflict (bucket, window_start)
        do update set count = public_rate_limit_counters.count + 1
    `);
  } catch (e) {
    log.error(e, { event: "event_counter_failed", scope: input.scope });
  }
}

/** The count `countEvent` holds for the current window; 0 when unknown. */
export async function eventCount(input: {
  scope: string;
  kind: PublicLimitKind;
  value: string;
  windowMs: number;
  now?: Date;
}): Promise<number> {
  const start = windowStartFor(input.now ?? new Date(), input.windowMs);
  const bucket = bucketKey(input.scope, input.kind, input.value);
  try {
    const rows = (await systemDb.execute(sql`
      select count from public_rate_limit_counters
      where bucket = ${bucket} and window_start = ${start.toISOString()}
    `)) as unknown as Array<{ count: number }>;
    return Number(rows[0]?.count ?? 0);
  } catch (e) {
    log.error(e, { event: "event_counter_read_failed", scope: input.scope });
    return 0;
  }
}
