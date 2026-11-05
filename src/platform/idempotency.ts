import type { FastifyReply, FastifyRequest, onSendHookHandler } from "fastify";
import { createHash } from "node:crypto";
import { and, eq, lt, isNull, or } from "drizzle-orm";
import { withTenant, trackWritesFor, stopTrackingWrites, systemDb } from "./db";
import { idempotencyKeys } from "@db/schema";
import { createLogger } from "./logger";
import { noteIdempotencyOutcome } from "@/modules/request-log/capture";

const log = createLogger("idempotency");

// Tracks, per request, whether we created an in-progress idempotency record that
// onSend must finalize (and whether it already did — see idempotencyOnSend).
declare module "fastify" {
  interface FastifyRequest {
    _idempotency?: { key: string; finalized?: boolean };
  }
  // Per-route `config`, readable from any hook as `request.routeOptions.config`.
  interface FastifyContextConfig {
    /** See `idempotentNoStore` — this route's response body must never be persisted. */
    idempotencyNoStore?: boolean;
  }
}

/**
 * Route `config` opt-out: **stay idempotent, but never persist the response body.**
 *
 * Spread into a route's options next to the hook pair:
 *
 *   { preHandler: [authenticate, idempotency], onSend: idempotencyOnSend, config: idempotentNoStore }
 *
 * WHY IT EXISTS (2026-08-04, 🔶 security). `idempotencyOnSend` stores `responseBody`
 * verbatim into a plain `jsonb` column. That is exactly right for ordinary resources
 * and exactly wrong for a route whose 2xx body carries a **one-time secret**:
 * `POST /v1/api_keys` returns a raw `sk_…` while `api_keys` itself stores only
 * `hashed_key`, so a keyed create made `idempotency_keys.response_body` the credential's
 * ONLY plaintext home. Same RLS tenant scope as the resource, so never a cross-tenant
 * leak — but a secret-at-rest downgrade, and it silently repealed "shown once".
 *
 * The old trade-off was "duplicate credential vs stored secret, pick one". This flag
 * removes it: the `idempotency` preHandler still runs, the unique `(organization_id, key)`
 * index still serialises concurrent duplicates, and a retry still NEVER re-executes the
 * handler — only the body is dropped, replaced by `notStoredBody()` below.
 *
 * Per-route rather than a global body scrubber on purpose: a field-name denylist cannot
 * see that `portal_sessions`' `url` embeds its bearer token, and would silently stop
 * covering a field added tomorrow. The route that mints the secret is the only place that
 * knows it minted one.
 */
export const idempotentNoStore = { idempotencyNoStore: true } as const;

/** Stable hash of method + path + body, to detect key reuse with a different payload. */
function fingerprint(req: FastifyRequest): string {
  const body = req.body ? JSON.stringify(req.body) : "";
  return createHash("sha256").update(`${req.method}:${req.url}:${body}`).digest("hex");
}

/**
 * The tenant this write belongs to. Operator routes set `req.organization`; the
 * buyer-token routes (portal / checkout) set only their session — resolve the
 * org from whichever is present so idempotency works (and doesn't crash) on all
 * three surfaces.
 */
function requestOrgId(req: FastifyRequest): string | null {
  return (
    req.organization?.id ??
    req.portalSession?.organizationId ??
    req.checkoutSession?.organizationId ??
    null
  );
}

/**
 * The buyer SESSION an idempotency record belongs to, or null for an operator/API-key
 * request. Prefixes are fixed (`cs:` / `ps:`) so a scoped key can never be confused
 * with another session's, whatever the buyer put in the header.
 *
 * SECURITY (2026-08-28, 🔴). The tenant is NOT a sufficient scope on the buyer
 * surfaces. `/checkout/v1/*` and `/portal/v1/*` authenticate with a session token, and
 * every buyer of one business resolves to the same `organization_id` — so under the old
 * `(organization_id, key)` record, two strangers shopping the same storefront shared one
 * cache entry. Measured: checkout session B posted session A's key with a byte-identical
 * body and got 200 + `Idempotent-Replayed: true` carrying **A's customer id**, while B's
 * own `resulting_customer_id` stayed NULL — B's handler never ran, and B's card was then
 * vaulted against A's identity.
 *
 * That is not a contrived collision. Both storefronts mint their keys client-side, and a
 * key derived from the STEP ("checkout-customer-step") rather than from the session is
 * identical for every visitor on the page.
 *
 * The precedence deliberately MIRRORS `requestOrgId` above, org first, so the scope and
 * the tenant can never be read off two different surfaces of one request.
 */
function requestSessionScope(req: FastifyRequest): string | null {
  if (req.organization) return null; // operator / API key — the tenant IS the scope
  if (req.portalSession) return `ps:${req.portalSession.sessionPublicId}`;
  if (req.checkoutSession) return `cs:${req.checkoutSession.sessionPublicId}`;
  return null;
}

/**
 * The value actually stored in `idempotency_keys.key`: the caller's header value on the
 * operator surface, that value prefixed with the buyer session on a buyer surface.
 *
 * Folding the session into the KEY rather than into `fingerprint()` is the whole design.
 * A fingerprint-only scope would leave the two buyers on ONE row, so the second would get
 * a permanent 409 "reused with a different payload" — a dead end for a legitimate buyer
 * whose only mistake was picking the same key string. Distinct keys give each session its
 * own record, which is what the unique `(organization_id, key)` index already serialises
 * concurrent duplicates against. It also needs no schema change: the column is `text`.
 *
 * The operator path returns the raw value UNCHANGED — byte-for-byte the rows
 * `verify:idempotency-race` seeds and reads back, and the reaper's staleness sweeps and
 * the `(org, key)` index are all indifferent to the extra prefix on a buyer row.
 */
function recordKey(req: FastifyRequest, key: string): string {
  const scope = requestSessionScope(req);
  return scope === null ? key : `${scope}|${key}`;
}

/**
 * The lifecycle of an idempotency record. `in_progress` → `side_effects` is stamped
 * by `withTenant` itself, atomically with the request's first durable write (see
 * platform/db.ts); the two terminal states are written by `idempotencyOnSend`.
 *
 *  - `in_progress`  — running, nothing durable written yet.
 *  - `side_effects` — running, and it HAS written something durable.
 *  - `completed`    — finished 2xx; the stored response is replayed.
 *  - `failed`       — finished non-2xx *after* writing something durable; the stored
 *                     response is replayed too, because re-executing could double
 *                     the side effect. A clean non-2xx stores nothing at all — the
 *                     row is deleted and the key stays free.
 */
type RecordStatus = "in_progress" | "side_effects" | "completed" | "failed";

/**
 * BUG FIX (2026-08-03): a process that dies mid-request used to leave its record at
 * `in_progress`/`side_effects` FOREVER — safe (it can never re-execute), but every
 * later retry of that key got a 409 with no way out short of manual DB surgery.
 * `locked_at` existed on the row already, unused; it is now the staleness clock.
 *
 * How stale is "dead"? Long enough that no legitimate in-flight request could still
 * be running, short enough a human isn't stuck. The longest outbound call the engine
 * makes is Stripe's own HTTP client — `stripe-node`'s `DEFAULT_TIMEOUT` is 80_000ms
 * (`node_modules/stripe/cjs/stripe.core.js`), the only DOCUMENTED upper bound on a
 * single gateway round trip anywhere in this codebase (the RazorPay/PayPal adapters'
 * `providerFetch`, `providers/http.ts`, set no client-side timeout at all). A real
 * request can make a few such calls plus DB work, so 5 minutes — roughly 4x that
 * bound — is comfortably longer than any genuine attempt and still resolves a crash
 * well inside a support ticket's SLA instead of needing a shell into Postgres.
 */
export const IDEMPOTENCY_STALE_MS = 5 * 60_000;

/** The HTTP status stamped on a row terminally orphaned by a stale-`side_effects` reap. */
const ORPHANED_STATUS = 409;

/**
 * The response an orphaned key replays forever. `side_effects` means a durable write
 * landed before the crash — re-running the handler could double it (a second
 * charge), so this NEVER frees the key for re-execution; it only explains, clearly
 * and permanently, why the caller is not getting a normal answer.
 */
function orphanedResponseBody(): { error: { type: string; message: string } } {
  return {
    error: {
      type: "idempotency_error",
      message:
        "The request that used this Idempotency-Key crashed after it made a durable change. We " +
        "cannot retry it safely and automatically. A second run could double the side effect, for " +
        "example with a second charge. Every future request that uses this key again gets this " +
        "response. Examine the ledger and the gateway to find what actually happened. Then use a NEW " +
        "Idempotency-Key for a fresh attempt.",
    },
  };
}

/**
 * The one key that marks a row as "this route opted out of storing its body"
 * (`idempotentNoStore`). Deliberately in the ROW, not re-derived from route config at
 * replay time: a row written today must keep replaying correctly even if the route's
 * config is edited, moved, or deleted tomorrow. Underscore-prefixed and namespaced so it
 * can never collide with a real API field.
 */
const NO_STORE_MARKER = "__idempotency_response_not_stored";

/** What a no-store route persists INSTEAD of its response body. Carries no secret. */
function notStoredBody(originalStatus: number): Record<string, unknown> {
  return { [NO_STORE_MARKER]: true, original_response_status: originalStatus };
}

function isNotStored(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>)[NO_STORE_MARKER] === true
  );
}

/**
 * The HTTP status a replayed no-store SUCCESS answers with. 409, not the original 2xx,
 * and that choice is the whole design:
 *
 *  - A 2xx replay would have to be a resource-shaped body with the secret missing. Every
 *    SDK and client treats 2xx as "here is your object", so the caller's happy path would
 *    read `secret` as undefined and carry on — the operator never learns the key exists,
 *    which is the exact failure this route's protection is supposed to prevent. A 2xx that
 *    cannot deliver the one field the caller asked for is a lie.
 *  - 409 Conflict is literally true: the request conflicts with an identical one that
 *    already completed. It lands in the caller's error path, where the message is read.
 *
 * "Already created, secret is gone" is told apart from "your request failed" by three
 * signals, not by the status alone: the `Idempotent-Replayed: true` header, an explicit
 * `created: true`, and `original_response_status` reporting the real 2xx the first attempt
 * returned. A failed-then-replayed no-store row instead answers with its ORIGINAL non-2xx
 * status and `created: false`, so the two are never confusable.
 */
const NO_STORE_REPLAY_STATUS = 409;

/**
 * The answer a replay of a no-store route gets. `completed` (the first attempt succeeded)
 * and `failed` (it left a durable change behind and then errored) are worded and statused
 * differently on purpose — see `NO_STORE_REPLAY_STATUS`.
 */
function notStoredReplay(rowStatus: "completed" | "failed", originalStatus: number) {
  const succeeded = rowStatus === "completed";
  return {
    status: succeeded ? NO_STORE_REPLAY_STATUS : originalStatus,
    body: {
      error: {
        type: "idempotency_error",
        code: "response_not_replayable",
        created: succeeded,
        original_response_status: originalStatus,
        message: succeeded
          ? `The request that first used this Idempotency-Key SUCCEEDED (HTTP ${originalStatus}). This is NOT a ` +
            "failure. We did not execute this retry, so nothing was duplicated. Its response body carried a " +
            "one-time secret, such as an API key, a session bearer token or a signing secret. This route " +
            "deliberately never stores that secret, so we cannot show the original response again. List the " +
            "resource to confirm that it exists. If you need a usable secret, create a new one with a fresh " +
            "Idempotency-Key and revoke the one that you cannot read."
          : `The request that first used this Idempotency-Key FAILED with HTTP ${originalStatus} after it ` +
            "made a durable change. It is not safe to retry automatically, so we did not execute this retry. " +
            "This route's responses can carry a one-time secret, so we never store its body and cannot " +
            "replay it exactly. Examine the resource. Then use a NEW Idempotency-Key for a fresh attempt.",
      },
    },
  };
}

/**
 * `locked_at < cutoff`, treating a NULL `locked_at` (any row from before this fix
 * shipped) as if it were locked at `created_at` instead — so a key already stuck by
 * the bug this closes is recognized as stale too, not grandfathered in forever.
 */
function staleGuard(cutoff: Date) {
  return or(
    lt(idempotencyKeys.lockedAt, cutoff),
    and(isNull(idempotencyKeys.lockedAt), lt(idempotencyKeys.createdAt, cutoff)),
  );
}

/**
 * Scheduled sweep — called once per `billing_clock_tick` (`platform/jobs.ts`), the
 * durable Postgres job queue (locked decision #6), never an in-memory timer. Bounds
 * table growth and gives instant relief to a retry that hasn't hit the lazy check in
 * `idempotency()` below yet.
 *
 * Cross-organization by design — like `reapStuckTransfers` in `modules/transfer/
 * service.ts`, the direct precedent for this shape — so it runs on `systemDb`
 * handle rather than `withTenant`: there is no single tenant to scope a platform-wide
 * maintenance pass to (`platform/db.ts`'s rationale for admin-only cross-org ops).
 *
 * The two statuses are handled OPPOSITELY, same as the lazy path: `in_progress` (no
 * durable write yet) is deleted outright — freeing the key exactly like a clean
 * non-2xx already does in `idempotencyOnSend`; `side_effects` is never deleted or
 * freed, only converted to a terminal `failed` with `orphanedResponseBody()`.
 */
export async function reapStaleIdempotencyKeys(
  now: Date = new Date(),
): Promise<{ freed: number; orphaned: number }> {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_STALE_MS);

  const freedRows = await systemDb
    .delete(idempotencyKeys)
    .where(and(eq(idempotencyKeys.status, "in_progress"), staleGuard(cutoff)))
    .returning({ id: idempotencyKeys.id });

  const orphanedRows = await systemDb
    .update(idempotencyKeys)
    .set({
      status: "failed",
      responseStatus: ORPHANED_STATUS,
      responseBody: orphanedResponseBody(),
    })
    .where(and(eq(idempotencyKeys.status, "side_effects"), staleGuard(cutoff)))
    .returning({ id: idempotencyKeys.id });

  if (orphanedRows.length > 0) {
    log.error(
      "reaped idempotency keys stuck in 'side_effects' — marked failed (a durable write was made " +
        "before the crash), replayable but they will NEVER re-execute",
      {
        event: "idempotency_keys_reaped",
        reaped: orphanedRows.length,
        staleMs: IDEMPOTENCY_STALE_MS,
      },
    );
  }
  return { freed: freedRows.length, orphaned: orphanedRows.length };
}

/**
 * preHandler for write routes. Honors an OPTIONAL `Idempotency-Key` header — making it
 * mandatory is audit L6, attempted and reverted; see the note at the top of the function:
 *  - replays the stored response if the same key already finished (2xx *or* a
 *    failure that left side effects behind),
 *  - 409 if the key is still in flight or was reused with a different payload,
 *  - otherwise records an in-progress row for onSend to finalize.
 * Must run AFTER `authenticate` (needs req.organization). RLS-scoped via withTenant.
 *
 * LAZY REAP (2026-08-03): a stale `in_progress`/`side_effects` row — one whose
 * `locked_at` is older than `IDEMPOTENCY_STALE_MS`, meaning the process that owned
 * it is dead — is handled right here too, not just by the scheduled sweep, so the
 * caller who is ACTUALLY blocked on it gets relief on this very request instead of
 * waiting for the next tick. `in_progress` (nothing durable written) is reclaimed
 * in place for this request; `side_effects` (a write landed) is converted to a
 * terminal `failed` and then falls through the ordinary finished-record path below
 * — it is never freed for re-execution, only explained. Both mutations are guarded
 * UPDATEs keyed on `id` + the very status/staleness just observed, so this request,
 * a concurrent retry, and the scheduled sweep can never all believe they won.
 */
export async function idempotency(req: FastifyRequest, reply: FastifyReply) {
  const headerKey = req.headers["idempotency-key"];
  // Optional for now. Making it REQUIRED is audit L6, and `CLAUDE.md` already says every API
  // write takes one — so this is a known, deliberate gap rather than an oversight.
  //
  // ⚠ DO NOT just flip this to a 400. That was tried on 2026-08-28 and reverted, because
  // enforcing it makes `verify:idempotency-race` HANG rather than fail — indefinitely, on the
  // first request that omits the header, reproducibly from a clean database. A caller who
  // forgot the header would wait forever instead of being told, which is a worse failure than
  // the double-execute the change was meant to prevent.
  //
  // Already ruled out, so nobody repeats the work: `idempotencyOnSend` (returns early when
  // there is no record), a database lock (no blocked queries, nothing idle-in-transaction),
  // and pool exhaustion (connections idle). Execution reaches past the suite's `createApiKey`
  // call. The open lead is a tracking asymmetry in this file — `stopTrackingWrites()` is
  // called in EXACTLY ONE place, inside the onSend hook, so any path that skips onSend leaves
  // write-tracking switched on.
  //
  // Everything else enforcement needs is already done: the SDK, both storefront clients and
  // the suite helpers all mint a key now, so this becomes a one-line change once the hang is
  // understood. Full write-up in `.claude/SECURITY_TODO.md` under L6.
  /**
   * REQUIRED (audit L6). `CLAUDE.md` has said "every API write takes an Idempotency-Key"
   * since the beginning; this is the line that finally makes it true.
   *
   * ── THE HANG THAT BLOCKED THIS FOR THREE ATTEMPTS WAS NEVER HERE ────────────────
   * Enforcing this was tried and reverted twice, because `verify:idempotency-race` HUNG
   * rather than failed, and the hang was read as a defect in this middleware. Three
   * investigations searched the server: `idempotencyOnSend`, database locks, pool
   * exhaustion, `createApiKey`. All of them came back clean, because the server was clean.
   *
   * The experiment nobody had run was to ask the server directly. With enforcement on, a
   * keyless write returns this 400 in **36 milliseconds**. The hang was entirely in the
   * harness: `verify-idempotency-race.ts` installs `uncaughtException` and
   * `unhandledRejection` listeners that push into a `crashes` array — that is how it counts
   * double-sends — and its fixture calls passed no key. Enforcement turned them into 400s,
   * every fixture id became `undefined`, its `requireFixtures` guard threw, the throw was
   * SWALLOWED by those listeners, and nothing closed the app or the pool. The open Postgres
   * handles kept the event loop alive forever.
   *
   * Two lessons worth more than the fix: a gate that hangs is worse than one that fails,
   * because a failure names itself. And when several careful investigations of one half of a
   * system all come back clean, the next question is whether the fault is in the other half —
   * not a fourth pass through the same half.
   *
   * `requireFixtures` now prints and exits instead of throwing into that void.
   *
   * ── WHY A DISTINCT ERROR TYPE ───────────────────────────────────────────────────
   * `idempotency_required`, not a bare 400: a caller who cannot tell "add this header" from
   * "your body is wrong" has no way to comply.
   *
   * Callers were ready long before this landed — the SDK, both storefront clients and the
   * suite helpers all mint keys, which is why this is one line and not a migration. The
   * `verify:idempotency-race` E5 check used to assert the header stayed OPTIONAL precisely
   * so that would be true when the time came.
   */
  if (!headerKey || typeof headerKey !== "string") {
    noteIdempotencyOutcome(req, "missing");
    return reply.code(400).send({
      error: {
        type: "idempotency_required",
        message: "This write requires an Idempotency-Key header",
      },
    });
  }
  const orgId = requestOrgId(req);
  if (!orgId) return; // no tenant context (unauthenticated route) — nothing to scope by
  // Scope the record to the buyer session BEFORE anything touches the database — see
  // `recordKey`. The insert, every re-read, the write-tracking scope and `onSend`'s
  // finalize all key off this one value and never off the raw header, so they can never
  // disagree about which row belongs to this request.
  const key = recordKey(req, headerKey);
  const fp = fingerprint(req);

  const outcome = await withTenant(orgId, async (tx) => {
    const reread = async () => {
      const [row] = await tx
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, key))
        .limit(1);
      return row;
    };
    const insertFresh = async () => {
      const inserted = await tx
        .insert(idempotencyKeys)
        .values({
          organizationId: orgId,
          key,
          requestFingerprint: fp,
          status: "in_progress",
          lockedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();
      return inserted[0];
    };

    let existing = await reread();
    if (!existing) {
      existing = await insertFresh();
      if (existing) return { type: "new" as const };
      // Lost a concurrent race — re-read the row the other request inserted.
      existing = await reread();
    }
    if (!existing) return { type: "new" as const };

    const status0 = existing.status as RecordStatus;
    if (status0 === "in_progress" || status0 === "side_effects") {
      const lockedSince = existing.lockedAt ?? existing.createdAt;
      if (Date.now() - lockedSince.getTime() > IDEMPOTENCY_STALE_MS) {
        const cutoff = new Date(Date.now() - IDEMPOTENCY_STALE_MS);
        if (status0 === "in_progress") {
          // Nothing durable was written under the dead process — safe to hand this
          // key straight to the request retrying it right now.
          const [reclaimed] = await tx
            .update(idempotencyKeys)
            .set({
              requestFingerprint: fp,
              lockedAt: new Date(),
              responseStatus: null,
              responseBody: null,
            })
            .where(
              and(
                eq(idempotencyKeys.id, existing.id),
                eq(idempotencyKeys.status, "in_progress"),
                staleGuard(cutoff),
              ),
            )
            .returning();
          if (reclaimed) return { type: "new" as const };
          // Lost the race (another retry reclaimed it, or the dead attempt actually
          // finished a beat before it looked dead) — re-read, or insert if it's now
          // gone entirely (a clean non-2xx finalize would delete it).
          existing = (await reread()) ?? (await insertFresh()) ?? existing;
        } else {
          // A durable write landed before the crash. NEVER freed for re-execution —
          // converted to a terminal `failed` and left to the ordinary finished-record
          // handling below, so it replays (or 409-mismatches on a different payload)
          // exactly like any other terminal record, forever.
          const [converted] = await tx
            .update(idempotencyKeys)
            .set({
              status: "failed",
              responseStatus: ORPHANED_STATUS,
              responseBody: orphanedResponseBody(),
            })
            .where(
              and(
                eq(idempotencyKeys.id, existing.id),
                eq(idempotencyKeys.status, "side_effects"),
                staleGuard(cutoff),
              ),
            )
            .returning();
          if (converted) {
            log.error(
              "idempotency key stuck in 'side_effects' — marked failed (orphaned by a crash), " +
                "replayable but it will NEVER re-execute",
              { event: "idempotency_key_orphaned", key, staleMs: IDEMPOTENCY_STALE_MS },
            );
            existing = converted;
          } else {
            existing = (await reread()) ?? existing;
          }
        }
      }
    }

    if (existing.requestFingerprint !== fp) return { type: "mismatch" as const };
    const status = existing.status as RecordStatus;
    if (status === "completed" || status === "failed") {
      // Both are FINISHED requests. Replaying the failure is the point: the first
      // attempt got as far as writing something durable, so re-running it is how a
      // card gets charged twice. A retry of the same key is a duplicate of the same
      // attempt and gets the same answer; a genuinely new attempt (the caller fixed
      // the card, say) is a new request and takes a new key.
      const originalStatus = existing.responseStatus ?? (status === "completed" ? 200 : 500);
      // A no-store route (`idempotentNoStore`) has no body to replay — synthesize the
      // terminal answer that explains what happened without re-sharing the secret. The
      // handler is still not re-executed, which is the point of protecting it at all.
      if (isNotStored(existing.responseBody)) {
        const synthesized = notStoredReplay(status, originalStatus);
        return { type: "replay" as const, status: synthesized.status, body: synthesized.body };
      }
      return {
        type: "replay" as const,
        status: originalStatus,
        body: existing.responseBody,
      };
    }
    return { type: "in_progress" as const, dirty: status === "side_effects" };
  });

  noteIdempotencyOutcome(req, outcome.type === "replay" ? "replayed" : outcome.type);
  switch (outcome.type) {
    case "mismatch":
      return reply.code(409).send({
        error: {
          type: "idempotency_error",
          message: "Idempotency-Key was reused with a different request payload",
        },
      });
    case "in_progress":
      return reply.code(409).send({
        error: {
          type: "idempotency_error",
          message: outcome.dirty
            ? "A request with this Idempotency-Key is already in progress and has already made changes"
            : "A request with this Idempotency-Key is already in progress",
        },
      });
    case "replay":
      reply.header("Idempotent-Replayed", "true");
      return reply.code(outcome.status).send(outcome.body);
    case "new":
      req._idempotency = { key };
      // From here on, any durable write this request makes stamps the record
      // `side_effects` in its own transaction. Started AFTER the insert above so
      // the placeholder row does not count as a side effect of itself.
      trackWritesFor(orgId, key);
      return;
  }
}

/**
 * onSend for write routes. Finalizes the idempotency record once a response is
 * ready, BEFORE the bytes reach the client — so a client that saw a 2xx can always
 * replay it, even if the process dies immediately after.
 *
 * THREE outcomes, not two — the middle one is the whole point:
 *
 *  - 2xx → `completed` + the stored response, for replay (locked decision #5).
 *  - non-2xx, record still `in_progress` → the placeholder row is DELETED. Nothing
 *           durable was written (Postgres itself says so — the request never
 *           assigned a transaction id), so there is nothing to replay, and keeping a
 *           record would poison the key: the caller could never reuse it, not even
 *           once the cause is gone (`POST …/biz_typo/…` then the same key against
 *           the real business would come back 409 "reused with a different
 *           payload"). Dropping it means "this key was never spent" — a retry is
 *           free, and the unique (organization_id, key) index still serialises
 *           concurrent duplicates while the request is in flight.
 *  - non-2xx, record already `side_effects` → `failed` + the stored response. This
 *           is the case the old two-way rule got wrong: a 500 raised after a charge,
 *           or a 402 surfaced once the gateway had already been asked, dropped the
 *           record — so the client's retry RE-EXECUTED instead of replaying, and on
 *           a billing path that means charging twice. Now the retry replays the
 *           failure. The key is spent; a fresh attempt takes a fresh key.
 *
 * All three are unchanged by `idempotentNoStore` — the row, its status, and its real
 * `response_status` are recorded exactly the same way. Only the BODY is swapped for
 * `notStoredBody()`, so protection, the fingerprint 409, the pre-write delete and the
 * reaper's `in_progress`/`side_effects` asymmetry all behave identically.
 *
 * The choice between the last two is never inferred from the status code (a 400 or
 * 404 out of a `catch` can sit downstream of a real write, and a heuristic that
 * guesses wrong here charges a customer twice). It is decided by the row's own
 * status, stamped inside the writing transaction by `withTenant`.
 *
 * Because this hook AWAITS a DB write, the reply is not `sent` while it runs — which
 * is what made bare-`return` early exits double-send and crash the process. The fix
 * lives in `platform/reply-guard.ts` (one send chain per reply) plus the awaited
 * replies in `api/helpers.ts`; this hook stays durable-before-flush on purpose.
 */
export const idempotencyOnSend: onSendHookHandler = async (req, reply, payload) => {
  const idem = req._idempotency;
  if (!idem || idem.finalized) return payload;

  const status = reply.statusCode;
  const orgId = requestOrgId(req);
  if (!orgId) return payload;

  // `idempotentNoStore`: this route's body may carry a one-time secret. Store a
  // secret-free marker instead — and never parse the real payload here at all, so the
  // plaintext is not even handed to the DB driver. `notStoredReplay()` in the preHandler
  // turns the marker back into a clear terminal answer for every future retry.
  const noStore = req.routeOptions?.config?.idempotencyNoStore === true;
  let body: unknown = noStore ? notStoredBody(status) : payload;
  if (!noStore && typeof payload === "string") {
    try {
      body = JSON.parse(payload);
    } catch {
      body = { raw: payload };
    }
  }

  // Belt to the RLS braces: the (org, key) index is per-tenant, so scope the write
  // by organization_id too — one org's record can never be finalized by another's.
  const scope = and(eq(idempotencyKeys.organizationId, orgId), eq(idempotencyKeys.key, idem.key));
  idem.finalized = true;
  stopTrackingWrites();
  await withTenant(orgId, async (tx) => {
    if (status >= 200 && status < 300) {
      await tx
        .update(idempotencyKeys)
        .set({ status: "completed", responseStatus: status, responseBody: body })
        .where(scope);
      return;
    }
    // Two mutually exclusive statements, decided by the row's own status — no read,
    // so no window between deciding and acting. Exactly one of them matches.
    await tx.delete(idempotencyKeys).where(and(scope, eq(idempotencyKeys.status, "in_progress")));
    await tx
      .update(idempotencyKeys)
      .set({ status: "failed", responseStatus: status, responseBody: body })
      .where(and(scope, eq(idempotencyKeys.status, "side_effects")));
  });

  return payload;
};
