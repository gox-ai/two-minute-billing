/**
 * Persistence for the TM Billing Test Gateway (C4). Uses `systemDb` connection
 * (these are the gateway's own platform-global tables, not tenant data — same
 * pattern as `provider_events`).
 */
import { and, asc, eq, gte, inArray, isNull, lt, lte } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { scanBusinessFilter } from "@/platform/clock";
import { tmtestVault, tmtestCharges, tmtestOutbound } from "@db/schema";

export type TmtestVault = typeof tmtestVault.$inferSelect;
export type TmtestCharge = typeof tmtestCharges.$inferSelect;
export type TmtestOutbound = typeof tmtestOutbound.$inferSelect;

export async function insertVault(row: typeof tmtestVault.$inferInsert): Promise<TmtestVault> {
  const [r] = await systemDb.insert(tmtestVault).values(row).returning();
  return r!;
}

export async function getVault(vaultId: string): Promise<TmtestVault | null> {
  const [r] = await systemDb
    .select()
    .from(tmtestVault)
    .where(eq(tmtestVault.vaultId, vaultId))
    .limit(1);
  return r ?? null;
}

/** Delete a vaulted instrument (CUST-7 GDPR clear). Idempotent. */
export async function deleteVault(vaultId: string): Promise<void> {
  await systemDb.delete(tmtestVault).where(eq(tmtestVault.vaultId, vaultId));
}

export async function insertCharge(row: typeof tmtestCharges.$inferInsert): Promise<TmtestCharge> {
  const [r] = await systemDb.insert(tmtestCharges).values(row).returning();
  return r!;
}

export async function getCharge(chargeId: string): Promise<TmtestCharge | null> {
  const [r] = await systemDb
    .select()
    .from(tmtestCharges)
    .where(eq(tmtestCharges.chargeId, chargeId))
    .limit(1);
  return r ?? null;
}

/** Gateway-side idempotency lookup: a replayed charge key returns the SAME charge. */
export async function getChargeByIdempotencyKey(
  businessId: string,
  key: string,
): Promise<TmtestCharge | null> {
  const [r] = await systemDb
    .select()
    .from(tmtestCharges)
    .where(and(eq(tmtestCharges.businessId, businessId), eq(tmtestCharges.idempotencyKey, key)))
    .limit(1);
  return r ?? null;
}

export async function setChargeStatus(
  chargeId: string,
  status: string,
  errorCode?: string | null,
): Promise<void> {
  await systemDb
    .update(tmtestCharges)
    .set({ status, errorCode: errorCode ?? null })
    .where(eq(tmtestCharges.chargeId, chargeId));
}

/**
 * Bind the instrument a SETUP intent produced to its intent row. A setup intent
 * has no vault at creation — the buyer supplies the card during the challenge —
 * so `vault_id` is stamped when the challenge resolves, and `consumeIntent` then
 * hands that instrument back as the intent's product.
 */
export async function setChargeVault(chargeId: string, vaultId: string): Promise<void> {
  await systemDb.update(tmtestCharges).set({ vaultId }).where(eq(tmtestCharges.chargeId, chargeId));
}

/**
 * Record a FAILED attempt against an intent without consuming it (C7 multi-attempt).
 * The intent keeps its `authorized` status — that is the whole point: the engine
 * can attempt it again — and `error_code` carries `attempt_failed:<key>` so that
 * (a) the next, differently-keyed attempt knows a failure was already spent, and
 * (b) a replay of the SAME key replays the same failure instead of succeeding.
 */
export const ATTEMPT_FAILED_PREFIX = "attempt_failed:";

export async function markIntentAttemptFailed(chargeId: string, key: string | null): Promise<void> {
  await systemDb
    .update(tmtestCharges)
    .set({ errorCode: `${ATTEMPT_FAILED_PREFIX}${key ?? ""}` })
    .where(eq(tmtestCharges.chargeId, chargeId));
}

/** Has this intent row already spent its one simulated failure? */
export function attemptAlreadyFailed(row: TmtestCharge): boolean {
  return (row.errorCode ?? "").startsWith(ATTEMPT_FAILED_PREFIX);
}

/** True when `key` is the key that recorded the stored failure (idempotent replay). */
export function isFailedAttemptKey(row: TmtestCharge, key: string | null): boolean {
  return (
    attemptAlreadyFailed(row) &&
    (row.errorCode ?? "").slice(ATTEMPT_FAILED_PREFIX.length) === (key ?? "")
  );
}

/**
 * True once ANY charge on this vaulted instrument has failed in this business.
 * The retry card's "first attempt fails, the next succeeds" needs an attempt
 * counter, and for the plain (non-intent) charge path the ledger of prior charge
 * rows IS that counter — no extra column required.
 */
export async function hasFailedChargeForVault(
  businessId: string,
  vaultId: string,
): Promise<boolean> {
  const [r] = await systemDb
    .select({ id: tmtestCharges.id })
    .from(tmtestCharges)
    .where(
      and(
        eq(tmtestCharges.businessId, businessId),
        eq(tmtestCharges.vaultId, vaultId),
        eq(tmtestCharges.status, "failed"),
      ),
    )
    .limit(1);
  return !!r;
}

/**
 * Atomically void an intent that has NOT been captured. Returns 'voided' on the
 * winning call, 'already_voided' when a prior call got there (idempotent),
 * 'captured' when the money already moved (a real gateway refuses to void a
 * captured authorization — it must be refunded instead), 'not_found' otherwise.
 */
/**
 * Void an intent, and say whether anything was actually HELD.
 *
 * The prior status is the whole answer and the single-statement version threw it away:
 * `authorized` means the gateway was holding the buyer's funds, while `inited` /
 * `requires_action` mean the buyer never completed anything and nothing was ever held.
 * Booking a `payment_reversal` for the second shape invents a release of money the bank
 * never took — 63 of 102 intent reversals in the dev database were exactly that (#21).
 * `UPDATE ... RETURNING` yields the NEW row, so the claim is made in two narrower
 * statements instead: each is still atomic and idempotent, and which one wins IS the
 * discriminator. `already_voided` reports `held: undefined` on purpose — we no longer
 * know what it was before, and guessing "not held" is the error this exists to prevent.
 */
export async function voidIntentCharge(
  chargeId: string,
): Promise<{ outcome: "voided" | "already_voided" | "captured" | "not_found"; held?: boolean }> {
  const [heldWon] = await systemDb
    .update(tmtestCharges)
    .set({ status: "voided" })
    .where(and(eq(tmtestCharges.chargeId, chargeId), eq(tmtestCharges.status, "authorized")))
    .returning();
  if (heldWon) return { outcome: "voided", held: true };
  const [unheldWon] = await systemDb
    .update(tmtestCharges)
    .set({ status: "voided" })
    .where(
      and(
        eq(tmtestCharges.chargeId, chargeId),
        inArray(tmtestCharges.status, ["inited", "requires_action"]),
      ),
    )
    .returning();
  if (unheldWon) return { outcome: "voided", held: false };
  const row = await getCharge(chargeId);
  if (!row) return { outcome: "not_found" };
  if (row.status === "voided") return { outcome: "already_voided" };
  return { outcome: "captured" };
}

/** The child row of a given kind (`refund` / `void`) recorded against a parent charge. */
export async function getChildCharge(
  parentChargeId: string,
  kind: string,
): Promise<TmtestCharge | null> {
  const [r] = await systemDb
    .select()
    .from(tmtestCharges)
    .where(and(eq(tmtestCharges.parentChargeId, parentChargeId), eq(tmtestCharges.kind, kind)))
    .limit(1);
  return r ?? null;
}

/** Returns (`kind: 'return'`) this business's settlement report shows in `[since, until)`. */
export async function listReturns(
  businessId: string,
  since: Date,
  until: Date,
): Promise<TmtestCharge[]> {
  return systemDb
    .select()
    .from(tmtestCharges)
    .where(
      and(
        eq(tmtestCharges.businessId, businessId),
        eq(tmtestCharges.kind, "return"),
        gte(tmtestCharges.createdAt, since),
        lt(tmtestCharges.createdAt, until),
      ),
    )
    .orderBy(asc(tmtestCharges.createdAt));
}

/**
 * Atomically capture an intent charge row: authorized → succeeded, stamping the
 * consume key. Returns 'captured' on the winning call, 'replay' when the same
 * key retries a completed capture, 'already_consumed' for a different caller.
 */
export async function captureIntentCharge(
  chargeId: string,
  consumeKey: string | null,
): Promise<"captured" | "replay" | "already_consumed" | "not_found"> {
  const [won] = await systemDb
    .update(tmtestCharges)
    // errorCode is cleared so a captured intent doesn't keep advertising the
    // failed attempt it survived (see markIntentAttemptFailed).
    .set({ status: "succeeded", consumeIdempotencyKey: consumeKey, errorCode: null })
    .where(and(eq(tmtestCharges.chargeId, chargeId), eq(tmtestCharges.status, "authorized")))
    .returning();
  if (won) return "captured";
  const row = await getCharge(chargeId);
  if (!row) return "not_found";
  if (row.status === "succeeded" && consumeKey != null && row.consumeIdempotencyKey === consumeKey)
    return "replay";
  return "already_consumed";
}

export async function enqueueOutbound(
  row: typeof tmtestOutbound.$inferInsert,
): Promise<TmtestOutbound> {
  const [r] = await systemDb.insert(tmtestOutbound).values(row).returning();
  return r!;
}

/**
 * Pending (undelivered) outbound webhooks. `all=true` (used by /advance) returns
 * every pending row regardless of `deliver_after`, so tests don't have to sleep;
 * otherwise only rows whose `deliver_after` has passed (the clock-driven pass).
 */
export async function listPendingOutbound(
  now: Date,
  opts?: { all?: boolean; businessId?: string },
): Promise<TmtestOutbound[]> {
  const conds = [isNull(tmtestOutbound.deliveredAt)];
  if (!opts?.all) conds.push(lte(tmtestOutbound.deliverAfter, now));
  if (opts?.businessId) conds.push(eq(tmtestOutbound.businessId, opts.businessId));
  // Clock-scope (finale review blocker): a time-travel travel at simulated `now`
  // must not fire OTHER businesses' delayed gateway webhooks (late declines,
  // timeouts) through the real reconciliation pipeline — and the real tick must
  // skip time-travelled businesses.
  const scope = scanBusinessFilter(tmtestOutbound.businessId);
  if (scope) conds.push(scope);
  return systemDb
    .select()
    .from(tmtestOutbound)
    .where(and(...conds))
    .orderBy(asc(tmtestOutbound.deliverAfter));
}

export async function markDelivered(id: string, at: Date): Promise<void> {
  await systemDb.update(tmtestOutbound).set({ deliveredAt: at }).where(eq(tmtestOutbound.id, id));
}

/**
 * Atomically CLAIM an outbound row for delivery (finale review: a travel step and
 * the real tick can scan concurrently — claim-then-deliver so a row is processed
 * exactly once). Returns false when another pass already claimed it.
 */
export async function claimOutbound(id: string, at: Date): Promise<boolean> {
  const rows = await systemDb
    .update(tmtestOutbound)
    .set({ deliveredAt: at })
    .where(and(eq(tmtestOutbound.id, id), isNull(tmtestOutbound.deliveredAt)))
    .returning({ id: tmtestOutbound.id });
  return rows.length > 0;
}

/** Whether any refund names this charge. */
export async function hasRefund(parentChargeId: string): Promise<boolean> {
  const rows = await systemDb
    .select({ id: tmtestCharges.chargeId })
    .from(tmtestCharges)
    .where(and(eq(tmtestCharges.kind, "refund"), eq(tmtestCharges.parentChargeId, parentChargeId)))
    .limit(1);
  return rows.length > 0;
}
