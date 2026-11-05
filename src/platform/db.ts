import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { config } from "./config";
import * as schema from "@db/schema";
import { createLogger } from "./logger";
import { activeClockPin } from "./clock";

const log = createLogger("db");

// Single pooled client for the service. `snake_case` casing matches the schema
// definitions (camelCase in TS ↔ snake_case in Postgres).
const queryClient = postgres(config.DATABASE_URL, {
  // `DB_POOL_MAX`, not a literal: this is the fourth constraint that binds when the clock's
  // passes run concurrently (after TICK_SCAN_LIMIT, the pass budget and the gateway's own
  // rate limit), and it was the only one that could not be seen or changed from config.
  max: config.DB_POOL_MAX,
  onnotice: () => {},
  // Opt-in per process (see config.PG_STATEMENT_TIMEOUT_MS). The worker sets it so a
  // query that never returns cannot become a tick that never ends; the API, importer
  // and verify suites leave it unset because they run legitimately long queries.
  ...(config.PG_STATEMENT_TIMEOUT_MS
    ? { connection: { statement_timeout: config.PG_STATEMENT_TIMEOUT_MS } }
    : {}),
});

const pool = drizzle(queryClient, { schema, casing: "snake_case" });

/**
 * The connection with NO tenant: row-level security does not filter it. Only for work that spans
 * organizations or runs before one is known (sign-in, API-key and token lookups, the clock's
 * scans, the back-office). Org-scoped work goes through `withTenant`. Importers in `src/` and
 * `backoffice/` are an allowlist that `verify:rls` checks.
 */
export const systemDb = pool;
export type DB = typeof pool;

/** The transaction handle passed to `withTenant` callbacks. */
export type Tx = Parameters<Parameters<typeof pool.transaction>[0]>[0];

// ── "side effects began" tracking (idempotency, 2026-08-03) ───────────────────
//
// `idempotencyOnSend` has to answer one question a status code cannot answer:
// **did this request already make a durable change?** A 404 from `resolveBusiness`
// and a 500 raised right after a gateway charge are both "non-2xx", but the first
// must free the Idempotency-Key (a stored record would poison it) and the second
// must NOT — a retry that re-executes can charge the card twice.
//
// We do not guess from the status code, and we do not ask services to report it
// (one forgotten call site = a silent double-charge). We ask **Postgres**:
// `pg_current_xact_id_if_assigned()` is null until a transaction actually writes,
// and non-null the moment it does. `set local role` / `set_config` / plain SELECTs
// do not assign an xid (verified on PG 17), so a read-only tenant transaction —
// which is all a pre-write early return runs — reads as "clean".
//
// The stamp is issued INSIDE the writing transaction, so it is atomic with the
// write it describes: the write commits ⇒ the mark commits; the write rolls back
// ⇒ the mark rolls back. There is no window where money moved and the key looks
// untouched.
//
// Known limits (deliberate, documented rather than papered over):
//  - Writes made through `systemDb` (cross-org admin paths) are outside
//    any tenant transaction and are NOT tracked.
//  - A gateway call whose db write never lands (process death between the two) is
//    invisible here; provider-side idempotency keys are the defence there.
//  - `SELECT … FOR UPDATE` over existing rows assigns an xid, so a read path that
//    used it would read as "wrote". Only one call site uses it and it is already a
//    write path (`webhooks/endpoints.ts` redeliver).
//  - Conservative in the safe direction: a write rolled back by an inner SAVEPOINT
//    leaves the xid assigned, so a request that wrote-then-undid reads as dirty.
//    That refuses a silent re-execution — it never permits one.

/** Per-request tracking slot: which idempotency record this request's writes belong to. */
export interface WriteScope {
  organizationId: string;
  key: string;
  /** True once a stamp has COMMITTED — after that there is nothing left to detect. */
  marked: boolean;
}

/**
 * The slot is created at `onRequest` (before the key is known) and filled in by the
 * `idempotency` preHandler — the same mutable-store pattern as
 * `event-context.ts`, and for the same reason: `AsyncLocalStorage.enterWith` from a
 * preHandler does not reliably reach the route handler, while a store established
 * with `run(store, done)` at onRequest reaches the whole lifecycle.
 */
const writeScopeStore = new AsyncLocalStorage<{ scope: WriteScope | null }>();

/** Fastify onRequest hook: give this request a (initially empty) write-tracking slot. */
export function writeTrackingHook(_req: unknown, _reply: unknown, done: () => void): void {
  writeScopeStore.run({ scope: null }, done);
}

/**
 * Fastify onResponse hook: clear the slot unconditionally, whatever route the reply took.
 *
 * `stopTrackingWrites()` was called in exactly ONE place — inside `idempotencyOnSend` — so
 * any path that skipped onSend left write-tracking switched on for the rest of the request.
 * onSend covers the ordinary replies, but not an aborted connection or a failure in an
 * earlier hook, and "the tracking is off because one specific hook always runs" is a claim
 * about Fastify's lifecycle that nothing here was asserting.
 *
 * onResponse always runs. Making this the guarantee costs nothing and removes the asymmetry:
 * `idempotencyOnSend` still clears early (it wants tracking off before its own finalize
 * write), and this is the backstop for every path that never reaches it.
 *
 * Found while investigating the L6 hang. It was NOT the cause — that was a swallowed throw
 * in the test harness — but it is a real asymmetry and worth closing on its own.
 */
export function writeTrackingCleanupHook(_req: unknown, _reply: unknown, done: () => void): void {
  stopTrackingWrites();
  done();
}

/** Start attributing this request's durable writes to the (org, key) idempotency record. */
export function trackWritesFor(organizationId: string, key: string): void {
  const slot = writeScopeStore.getStore();
  if (slot) slot.scope = { organizationId, key, marked: false };
}

/**
 * Stop tracking (called before `idempotencyOnSend` finalizes). The finalize is
 * itself a write, and while it could never mis-stamp — the stamp only matches rows
 * still `in_progress`/`side_effects`, and the finalize has already moved the row
 * past both — not tracking it at all is one less thing to reason about.
 */
export function stopTrackingWrites(): void {
  const slot = writeScopeStore.getStore();
  if (slot) slot.scope = null;
}

/** The active write-tracking scope, or null when nothing is being tracked. */
export function currentWriteScope(): WriteScope | null {
  return writeScopeStore.getStore()?.scope ?? null;
}

/**
 * If this transaction has written anything, mark the tracked idempotency record
 * `side_effects` in the SAME transaction. Returns true when the record was found
 * (and is therefore stamped once this transaction commits).
 *
 * Two statements on purpose: an `UPDATE … WHERE pg_current_xact_id_if_assigned()
 * IS NOT NULL` would be asking Postgres whether the very statement doing the
 * writing has written yet. Probe first, then write — no evaluation-order subtlety.
 */
async function stampSideEffects(tx: Tx, organizationId: string, key: string): Promise<boolean> {
  const probe = await tx.execute(sql`select pg_current_xact_id_if_assigned() is not null as wrote`);
  const wrote = (probe as unknown as Array<{ wrote: boolean }>)[0]?.wrote === true;
  if (!wrote) return false;
  const res = await tx.execute(sql`
    update idempotency_keys
       set status = 'side_effects'
     where organization_id = ${organizationId}::uuid
       and key = ${key}
       and status in ('in_progress', 'side_effects')
    returning id
  `);
  return (res as unknown as unknown[]).length > 0;
}

const commitHooks = new AsyncLocalStorage<Array<() => Promise<void>>>();

/**
 * Run `fn` once the enclosing `withTenant` transaction commits (never on rollback). For work
 * that must not hold the transaction's locks — a wake-up nudge on a row every transaction
 * shares. False outside `withTenant`: the caller then decides whether to run it in place.
 */
export function afterCommit(fn: () => Promise<void>): boolean {
  const hooks = commitHooks.getStore();
  if (!hooks) return false;
  hooks.push(fn);
  return true;
}

/**
 * Run a function inside a transaction scoped to one organization, with RLS
 * ENFORCED. We switch to the non-privileged `tmbilling_app` role and set
 * `app.org_id` (both transaction-local), so every query the callback runs is
 * filtered to that organization by Postgres itself — not by app code.
 *
 * Use this for ALL org-scoped reads/writes. Admin-only operations that span
 * organizations (creating an org, resolving an API key) use `systemDb`.
 */
export async function withTenant<T>(
  organizationId: string,
  fn: (tx: Tx) => Promise<T>,
  /** e.g. one read-only snapshot: `{ isolationLevel: "repeatable read", accessMode: "read only" }`. */
  config?: {
    isolationLevel?: "read committed" | "repeatable read" | "serializable";
    accessMode?: "read only" | "read write";
  },
): Promise<T> {
  // Only probe while a request is tracking writes for THIS org and has not been
  // marked yet: every other caller (the worker, seeds, verify scripts, and every
  // request without an Idempotency-Key) pays nothing.
  const scope = currentWriteScope();
  const track = scope && !scope.marked && scope.organizationId === organizationId ? scope : null;
  let stamped = false;
  const hooks: Array<() => Promise<void>> = [];
  const result = await commitHooks.run(hooks, () =>
    pool.transaction(async (tx) => {
      await tx.execute(sql`set local role tmbilling_app`);
      await tx.execute(sql`select set_config('app.org_id', ${organizationId}, true)`);
      // Time Travel: `app_now()` column defaults read this. Unset outside a pin, so they
      // fall back to now(). ISO string — a Date in a raw sql fragment throws at runtime.
      const pin = activeClockPin();
      if (pin) {
        await tx.execute(
          sql`select set_config('app.business_now', ${pin.now.toISOString()}, true)`,
        );
      }
      const out = await fn(tx);
      // After the callback, so a write anywhere inside it counts — and before the
      // commit, so the mark is atomic with that write.
      if (track) stamped = await stampSideEffects(tx, organizationId, track.key);
      return out;
    }, config),
  );
  for (const hook of hooks) {
    try {
      await hook();
    } catch (e) {
      log.error(e, { event: "after_commit_hook_failed" });
    }
  }
  // Latch only once the transaction has COMMITTED. Latching inside would let a
  // stamp lost to a savepoint rollback silently disable tracking for the rest of
  // the request (the next write would then look clean).
  if (track && stamped) track.marked = true;
  return result;
}

/**
 * Run `fn` inside a CALLER-SUPPLIED transaction when there is one, else open a
 * fresh tenant transaction. The point is atomicity across module boundaries: a
 * service that opens its own `withTenant` can never be made to commit or roll
 * back together with its caller's write, because a nested `db.transaction` is a
 * SAVEPOINT — rolling it back leaves the outer transaction (and its writes)
 * standing. Passing the handle down is the only way to get one atomic unit.
 *
 * `organizationId` is used only on the open-a-new-one branch; an inherited `tx`
 * already has `app.org_id` set, and it is the caller's responsibility that it
 * belongs to the SAME organization (RLS would otherwise silently filter to the
 * outer org's rows).
 */
export async function withTenantTx<T>(
  organizationId: string,
  tx: Tx | null | undefined,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return tx ? fn(tx) : withTenant(organizationId, fn);
}

/** Liveness check used by the /health route. */
export async function pingDb(): Promise<boolean> {
  try {
    await queryClient`select 1`;
    return true;
  } catch (e) {
    // /health answers `degraded` on false. Without this line that is the whole
    // story — no host, no driver error, nothing to act on during the outage.
    log.error(e, { event: "db_ping_failed" });
    return false;
  }
}

export async function closeDb(): Promise<void> {
  await queryClient.end({ timeout: 5 });
}
