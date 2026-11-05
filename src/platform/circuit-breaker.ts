/**
 * Stop calling a dependency that is not answering.
 *
 * ── THE PROBLEM THIS SOLVES, AND WHY THE EXISTING GUARDS DID NOT ────────────────
 * Every outbound call already has a timeout, a per-message retry backoff and a pass-wide
 * budget. All three behaved exactly as written on 2026-09-01, and the billing clock still
 * fell three days behind. One business's SMTP host was unreachable, so every attempt paid
 * the full 10s connect timeout; at ~2,900 messages/day x 6 attempts that demands ~174,000
 * seconds of clock time per day, against the 86,400 a day contains.
 *
 * None of the three guards can close that gap:
 *
 *  - A TIMEOUT sets the price of one failed attempt. It does not reduce the number of them.
 *  - A per-message BACKOFF delays one message. The fault belongs to the relay, and with a
 *    backlog there is always another message due, so the pass spends its whole budget
 *    regardless — forever.
 *  - A pass BUDGET caps the damage per sweep, which is what phase 0 did. It does not let the
 *    mail drain: fewer attempts per sweep simply means the backlog grows instead.
 *
 * The missing move is to stop calling. A breaker converts "90 seconds of connect timeouts,
 * every sweep, forever" into "a few microseconds", and it is the only mechanism here whose
 * cost does not scale with how much mail the broken tenant generates.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────────
 * Standard three-state breaker, keyed per DEPENDENCY INSTANCE rather than per message:
 *
 *   closed     → calling normally. `FAILURE_THRESHOLD` consecutive transport faults opens it.
 *   open       → not calling. Fails instantly until `next_probe_at`.
 *   half_open  → exactly one probe is allowed through. Success closes it; failure re-opens
 *                with a longer cooldown.
 *
 * Only a TRANSPORT fault counts (`MailerSendError.fault`, or a webhook fetch that threw).
 * A relay that answers and refuses one message is healthy — breaking on that would suppress
 * every other business sharing the relay over one merchant's bad From address.
 *
 * ── THE COST THIS DELIBERATELY REFUSES TO PAY ───────────────────────────────────
 * A breaker that queried per row would have reintroduced a per-row cost to remove one. So
 * the read is a SNAPSHOT: `loadOpenDependencies()` once at the start of a pass, decisions
 * made in memory against it, and writes only when a state actually changes. A pass therefore
 * costs one extra SELECT, and a healthy system writes nothing at all.
 *
 * The snapshot is stale by at most one pass, which is the correct trade in both directions:
 * a host that dies mid-pass is caught next pass (having cost one timeout, not hundreds), and
 * a host that recovers mid-pass waits at most one pass to be probed.
 */
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { systemDb } from "./db";
import { config } from "./config";
import { dependencyHealth } from "@db/schema";
import { createLogger } from "./logger";

const log = createLogger("circuit-breaker");

/** What sort of dependency a key names — the ops page's label, and part of the key. */
export type DependencyKind = "smtp" | "ses" | "esp" | "webhook" | "integration";

/**
 * Build a dependency key.
 *
 * `<kind>:<businessId|platform>:<host>`. Scoped per BUSINESS on purpose: two tenants
 * pointing at the same relay with different credentials fail independently, and one
 * merchant's wrong password must not silence the other's mail. Where the host itself is
 * genuinely shared and unauthenticated the caller passes the same host and gets one row per
 * tenant anyway — a little redundant, never wrong.
 */
export function dependencyKey(
  kind: DependencyKind,
  businessId: string | null,
  host: string,
): string {
  return `${kind}:${businessId ?? "platform"}:${host}`;
}

/**
 * The set of dependencies that are currently NOT callable, as of this instant.
 *
 * A row is callable again once `next_probe_at` has passed — that is the half-open moment,
 * and it is resolved here rather than stored, so a cooldown that elapses between passes does
 * not need a writer to notice it.
 */
export type OpenDependencies = ReadonlySet<string>;

/** Nothing is open. Shared, so a caller with the breaker disabled allocates nothing. */
const NONE: OpenDependencies = new Set<string>();

/**
 * Read the open set once, at the start of a pass.
 *
 * Returns only rows that are open AND still inside their cooldown. A row whose cooldown has
 * elapsed is deliberately absent: the next attempt against it IS the half-open probe, and
 * modelling that as "callable" keeps the caller's decision to a single set lookup.
 */
export async function loadOpenDependencies(now: Date): Promise<OpenDependencies> {
  if (!config.CIRCUIT_BREAKER_ENABLED) return NONE;
  try {
    return await loadOpenDependenciesInner(now);
  } catch (e) {
    // Fail OPEN: an unreadable breaker table means "call as normal", never "send nothing".
    log.error(e, { event: "circuit_breaker_read_failed" });
    return NONE;
  }
}

async function loadOpenDependenciesInner(now: Date): Promise<OpenDependencies> {
  const rows = await systemDb
    .select({ key: dependencyHealth.key })
    .from(dependencyHealth)
    .where(
      and(
        eq(dependencyHealth.state, "open"),
        // A NULL probe time would mean "open forever", which no transition writes and
        // nothing should be able to produce. Treated as still-open rather than callable:
        // if that row ever exists it is a bug, and failing closed makes it visible on the
        // ops page instead of silently resuming a dead host.
        or(isNull(dependencyHealth.nextProbeAt), gt(dependencyHealth.nextProbeAt, now)),
      ),
    );
  return new Set(rows.map((r) => r.key));
}

/**
 * Record a TRANSPORT fault. Opens the breaker on the `FAILURE_THRESHOLD`-th consecutive one.
 *
 * The upsert is a single statement so two workers racing the same dependency cannot lose a
 * count — `consecutive_failures` is incremented from the stored value, never from one this
 * process read earlier.
 */
export async function recordFailure(
  key: string,
  kind: DependencyKind,
  businessId: string | null,
  error: string,
  now: Date,
): Promise<void> {
  if (!config.CIRCUIT_BREAKER_ENABLED) return;
  // FAIL OPEN. The breaker is an optimisation — it makes a dead dependency cheap — and it
  // is never a precondition for delivery. So its own bookkeeping must not be able to stop
  // a send, let alone stop the whole pass for every tenant.
  //
  // This wrapper exists because it already happened: a `bigint out of range` in the
  // backoff arithmetic (see below) threw out of here, out of `deliverPendingEmails`, and
  // killed the email lane for everybody. The arithmetic is fixed, and this makes the class
  // of mistake survivable rather than trusting the next one to be correct.
  try {
    await recordFailureInner(key, kind, businessId, error, now);
  } catch (e) {
    log.error(e, { event: "circuit_breaker_write_failed", dependency: key, op: "failure" });
  }
}

async function recordFailureInner(
  key: string,
  kind: DependencyKind,
  businessId: string | null,
  error: string,
  now: Date,
): Promise<void> {
  const threshold = config.CIRCUIT_BREAKER_FAILURE_THRESHOLD;
  const base = config.CIRCUIT_BREAKER_COOLDOWN_MS;
  const cap = config.CIRCUIT_BREAKER_MAX_COOLDOWN_MS;

  const [row] = await systemDb
    .insert(dependencyHealth)
    .values({
      key,
      kind,
      businessId,
      state: threshold <= 1 ? "open" : "closed",
      consecutiveFailures: 1,
      lastError: error.slice(0, 1000),
      openedAt: threshold <= 1 ? now : null,
      nextProbeAt: threshold <= 1 ? new Date(now.getTime() + base) : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: dependencyHealth.key,
      set: {
        consecutiveFailures: sql`${dependencyHealth.consecutiveFailures} + 1`,
        lastError: error.slice(0, 1000),
        updatedAt: now,
        // Open once the count reaches the threshold, and STAY open on every failure after
        // that (a failed half-open probe lands here too).
        state: sql`case when ${dependencyHealth.consecutiveFailures} + 1 >= ${threshold}
                        then 'open' else ${dependencyHealth.state} end`,
        // Keep the ORIGINAL opened_at across re-opens, so "down for 40 minutes" stays true
        // through a failed probe instead of resetting to zero every cooldown.
        openedAt: sql`case when ${dependencyHealth.consecutiveFailures} + 1 >= ${threshold}
                           then coalesce(${dependencyHealth.openedAt}, ${now.toISOString()}::timestamptz) else ${dependencyHealth.openedAt} end`,
        // Exponential backoff on the PROBE, capped. Doubling per consecutive failure past
        // the threshold turns a day-long outage into ~a dozen calls rather than 1,440.
        //
        // ⚠ THE EXPONENT IS CLAMPED, AND THAT CLAMP IS LOAD-BEARING. Capping only the
        // RESULT with `least(..., cap)` is not enough: the multiplication happens first,
        // and `60000 * 2^57` is 8.6e21, which overflows bigint (max 9.2e18). Postgres
        // raises `bigint out of range` before `least` is ever evaluated.
        //
        // That is not theoretical. Measured 2026-09-02 during a deliberate soak against an
        // unreachable SMTP host: at 51 consecutive failures — under an hour of a permanent
        // fault — this statement began to throw, `recordFailure` propagated the error out
        // of `deliverPendingEmails`, and **the entire email lane died for every business,
        // not just the broken one**. 70 `email_outbox_nudge` jobs failed in a row. The
        // breaker had reintroduced the tenant-isolation failure phase 2 removed, worse:
        // no mail was attempted at all.
        //
        // 30 is far above anything reachable in practice — with a 60s base and a 900s cap
        // the multiplier is already pinned by exponent 4 — and 2^30 keeps the product at
        // 6.4e13, four orders of magnitude clear of the limit.
        nextProbeAt: sql`case when ${dependencyHealth.consecutiveFailures} + 1 >= ${threshold}
                              then ${now.toISOString()}::timestamptz + least(
                                ${base}::bigint * power(2, least(greatest(0, ${dependencyHealth.consecutiveFailures} + 1 - ${threshold}), 30))::bigint,
                                ${cap}::bigint
                              ) * interval '1 millisecond'
                              else ${dependencyHealth.nextProbeAt} end`,
      },
    })
    .returning({ state: dependencyHealth.state, failures: dependencyHealth.consecutiveFailures });

  // Logged on the TRANSITION only. A line per failed message is what made this invisible in
  // the first place: 5,000 identical warnings that nobody groups and nobody reads.
  if (row?.state === "open" && row.failures === threshold) {
    log.warn("dependency circuit opened", {
      event: "circuit_opened",
      dependency: key,
      kind,
      failures: row.failures,
      error: error.slice(0, 300),
    });
  }
}

/**
 * Record a success. Closes the breaker and clears the count.
 *
 * Deliberately a no-op write when the row is already closed with zero failures — the common
 * case by far, and worth not touching the table for. Callers pass `wasOpen` from the pass
 * snapshot so a healthy system performs no writes at all.
 */
export async function recordSuccess(key: string, now: Date, wasOpen: boolean): Promise<void> {
  if (!config.CIRCUIT_BREAKER_ENABLED) return;
  // Fail open, same reasoning as `recordFailure` — and here the stakes are higher still:
  // the message has ALREADY been delivered by the time this runs, so throwing would turn a
  // successful send into a failed row and a duplicate on the next pass.
  try {
    await recordSuccessInner(key, now, wasOpen);
  } catch (e) {
    log.error(e, { event: "circuit_breaker_write_failed", dependency: key, op: "success" });
  }
}

async function recordSuccessInner(key: string, now: Date, wasOpen: boolean): Promise<void> {
  const updated = await systemDb
    .update(dependencyHealth)
    .set({
      state: "closed",
      consecutiveFailures: 0,
      openedAt: null,
      nextProbeAt: null,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(dependencyHealth.key, key),
        // Only touch rows that are actually dirty. Without this every successful send would
        // write a row, which is a write per message on a healthy system.
        or(
          sql`${dependencyHealth.consecutiveFailures} > 0`,
          sql`${dependencyHealth.state} <> 'closed'`,
        ),
      ),
    )
    .returning({ key: dependencyHealth.key });

  if (updated.length && wasOpen) {
    log.info("dependency circuit closed", { event: "circuit_closed", dependency: key });
  }
}

/**
 * Forget a dependency's state entirely.
 *
 * Called when the configuration behind it changes — a merchant correcting an SMTP port
 * should not have to wait out a cooldown to find out whether they got it right. Pairs with
 * `invalidateMailer` in `modules/emails/mailer-resolver.ts`, which drops the cached
 * transport at the same moment for the same reason.
 */
export async function resetDependencies(businessId: string): Promise<void> {
  // Gated like every other entry point: `CIRCUIT_BREAKER_ENABLED=FALSE` must mean this
  // module touches nothing at all, or the kill switch only half-works and the one thing it
  // exists for — reverting to exactly the previous behaviour — is not something it can do.
  if (!config.CIRCUIT_BREAKER_ENABLED) return;
  await systemDb.delete(dependencyHealth).where(eq(dependencyHealth.businessId, businessId));
}

/** Every non-closed dependency, for the ops API. Newest breach first. */
export async function openDependencyReport(now: Date) {
  return systemDb
    .select()
    .from(dependencyHealth)
    .where(
      or(
        eq(dependencyHealth.state, "open"),
        eq(dependencyHealth.state, "half_open"),
        sql`${dependencyHealth.consecutiveFailures} > 0`,
      ),
    )
    .orderBy(sql`${dependencyHealth.openedAt} desc nulls last`)
    .limit(100)
    .then((rows) =>
      rows.map((r) => ({
        ...r,
        /** Resolved here, not stored: a cooldown elapses without anyone writing a row. */
        probeDue: r.nextProbeAt != null && r.nextProbeAt <= now,
      })),
    );
}

/**
 * How long a dependency has been open, in ms — null when it is not open.
 * Used by the ops alert, which pages on "open for longer than its own cooldown".
 */
export function openForMs(openedAt: Date | null, now: Date): number | null {
  return openedAt ? now.getTime() - openedAt.getTime() : null;
}

/** Re-exported so callers do not each reach into config for the same two numbers. */
export const breakerSettings = () => ({
  enabled: config.CIRCUIT_BREAKER_ENABLED,
  threshold: config.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  cooldownMs: config.CIRCUIT_BREAKER_COOLDOWN_MS,
  maxCooldownMs: config.CIRCUIT_BREAKER_MAX_COOLDOWN_MS,
});
