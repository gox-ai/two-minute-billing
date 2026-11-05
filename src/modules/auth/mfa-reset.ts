import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { mfaResetRequests, users } from "@db/schema";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";
import { disableMfa, hasConfirmedMfa } from "@/modules/auth/service";
import {
  pendingMfaReset,
  securityEvent,
  type SecurityContext,
} from "@/modules/auth/security-events";

const log = createLogger("auth.mfa_reset");

/**
 * Support-assisted 2FA reset (0328), for someone who lost every method and every recovery code.
 *
 * Support files it after checking a second proof; it takes effect MFA_RESET_WAIT_DAYS later. The
 * wait is the defence: the real owner gets an email with a cancel link before anything changes,
 * so talking support into a reset buys an attacker nothing if the owner reads their mail.
 */

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export type MfaResetRefusal = "unknown_account" | "no_two_factor" | "already_pending";

export class MfaResetRefusedError extends Error {
  constructor(
    readonly reason: MfaResetRefusal,
    message: string,
  ) {
    super(message);
    this.name = "MfaResetRefusedError";
  }
}

export interface MfaResetPlan {
  userId: string;
  email: string;
  effectiveAt: Date;
}

/**
 * File a reset (or, with `commit: false`, only check that one could be filed). Refuses an unknown
 * address, an account without 2FA, and a second open request.
 */
export async function requestMfaReset(input: {
  email: string;
  proof: string;
  requestedBy: string;
  commit: boolean;
  now?: Date;
}): Promise<MfaResetPlan & { filed: boolean }> {
  const email = input.email.trim().toLowerCase();
  const [user] = await systemDb
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) throw new MfaResetRefusedError("unknown_account", `No account with email ${email}`);
  if (!(await hasConfirmedMfa(user.id))) {
    throw new MfaResetRefusedError(
      "no_two_factor",
      `${email} does not have two-factor authentication enabled`,
    );
  }
  if (await pendingMfaReset(user.id)) {
    throw new MfaResetRefusedError("already_pending", `${email} already has a reset waiting`);
  }
  const now = input.now ?? new Date();
  const effectiveAt = new Date(now.getTime() + config.MFA_RESET_WAIT_DAYS * 86_400_000);
  const plan = { userId: user.id, email: user.email, effectiveAt };
  if (!input.commit) return { ...plan, filed: false };

  const token = `mfrc_${randomBytes(32).toString("base64url")}`;
  try {
    await systemDb.insert(mfaResetRequests).values({
      userId: user.id,
      proof: input.proof.slice(0, 500),
      requestedBy: input.requestedBy.slice(0, 200),
      cancelTokenHash: tokenHash(token),
      requestedAt: now,
      effectiveAt,
    });
  } catch (e) {
    // The partial unique index lost a race with another filing.
    if ((e as { code?: string }).code === "23505") {
      throw new MfaResetRefusedError("already_pending", `${email} already has a reset waiting`);
    }
    throw e;
  }
  const base = config.DASHBOARD_BASE_URL?.replace(/\/$/, "");
  if (!base)
    log.warn("2FA reset filed but DASHBOARD_BASE_URL is unset — the email has no cancel link");
  await securityEvent(user.id, "mfa_reset_requested", {
    metadata: {
      requested_by: input.requestedBy.slice(0, 200),
      effective_at: effectiveAt.toISOString(),
    },
    email: {
      effectiveAt,
      // The exchange route moves the token into a cookie, so it never sits in a page URL.
      cancelLink: base ? `${base}/two-factor-reset/s/${token}` : null,
    },
  });
  log.info("2FA reset filed", { user: user.id, effectiveAt: effectiveAt.toISOString() });
  return { ...plan, filed: true };
}

export class MfaResetCancelError extends Error {
  constructor(
    readonly reason: "not_found" | "completed",
    message: string,
  ) {
    super(message);
    this.name = "MfaResetCancelError";
  }
}

/** Stop a pending reset. A request already cancelled answers success again. */
export async function cancelMfaReset(
  token: string,
  ctx: SecurityContext = {},
): Promise<{ alreadyCancelled: boolean }> {
  const notFound = () =>
    new MfaResetCancelError("not_found", "This link does not operate. It may have expired.");
  if (!token.startsWith("mfrc_")) throw notFound();
  const hash = tokenHash(token);
  const [claimed] = await systemDb
    .update(mfaResetRequests)
    .set({ cancelledAt: new Date() })
    .where(
      and(
        eq(mfaResetRequests.cancelTokenHash, hash),
        isNull(mfaResetRequests.cancelledAt),
        isNull(mfaResetRequests.completedAt),
      ),
    )
    .returning({ userId: mfaResetRequests.userId });
  if (claimed) {
    await securityEvent(claimed.userId, "mfa_reset_cancelled", { ctx });
    log.info("2FA reset cancelled by its owner", { user: claimed.userId });
    return { alreadyCancelled: false };
  }
  const [row] = await systemDb
    .select({
      cancelledAt: mfaResetRequests.cancelledAt,
      completedAt: mfaResetRequests.completedAt,
    })
    .from(mfaResetRequests)
    .where(eq(mfaResetRequests.cancelTokenHash, hash))
    .limit(1);
  if (!row) throw notFound();
  if (row.completedAt) {
    throw new MfaResetCancelError("completed", "The reset is complete. You cannot cancel it now.");
  }
  return { alreadyCancelled: true };
}

/**
 * Complete every due, uncancelled reset: 2FA off, every session signed out, the person told.
 * Each request is claimed by the UPDATE that completes it, so two sweeps never both act; a failure
 * after the claim releases it for the next run.
 */
export async function sweepMfaResets(
  now: Date = new Date(),
): Promise<{ completed: number; failed: number }> {
  const due = await systemDb
    .select({ id: mfaResetRequests.id })
    .from(mfaResetRequests)
    .where(
      and(
        isNull(mfaResetRequests.completedAt),
        isNull(mfaResetRequests.cancelledAt),
        lte(mfaResetRequests.effectiveAt, now),
      ),
    )
    .limit(100);
  let completed = 0;
  let failed = 0;
  for (const { id } of due) {
    const [claimed] = await systemDb
      .update(mfaResetRequests)
      .set({ completedAt: sql`now()` })
      .where(
        and(
          eq(mfaResetRequests.id, id),
          isNull(mfaResetRequests.completedAt),
          isNull(mfaResetRequests.cancelledAt),
          lte(mfaResetRequests.effectiveAt, now),
        ),
      )
      .returning({ userId: mfaResetRequests.userId, requestedBy: mfaResetRequests.requestedBy });
    if (!claimed) continue;
    try {
      const r = await disableMfa({ userId: claimed.userId, by: "support" });
      await securityEvent(claimed.userId, "mfa_reset_completed", {
        metadata: { requested_by: claimed.requestedBy, signed_out: r.signedOutSessions },
      });
      completed++;
    } catch (e) {
      await systemDb
        .update(mfaResetRequests)
        .set({ completedAt: null })
        .where(eq(mfaResetRequests.id, id));
      log.error(e, { event: "mfa_reset_complete_failed", request: id });
      failed++;
    }
  }
  if (completed > 0) log.info("2FA resets completed", { completed });
  return { completed, failed };
}
