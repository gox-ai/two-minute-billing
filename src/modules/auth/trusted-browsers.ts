import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { trustedBrowsers } from "@db/schema";
import { securityEvent, type SecurityContext } from "./security-events";

/**
 * "Don't ask again on this browser for 30 days" (0329). Skips ONLY the sign-in second step. A
 * session started this way has no `mfa_at`: it is not a 2FA confirmation, so a stolen laptop with
 * a saved password gets a session, never a fresh second factor.
 *
 * The raw token lives only in the browser's cookie; the table holds its sha256.
 */

export const TRUSTED_BROWSER_TTL_MS = 30 * 24 * 3600_000;
const TOKEN_RE = /^tb_[A-Za-z0-9_-]{43}$/;
const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** Remember this browser for the person. Returns the cookie value, which exists nowhere else. */
export async function trustBrowser(
  userId: string,
  ctx: SecurityContext = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = `tb_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + TRUSTED_BROWSER_TTL_MS);
  const [row] = await systemDb
    .insert(trustedBrowsers)
    .values({
      userId,
      tokenHash: hashToken(token),
      userAgent: ctx.userAgent?.slice(0, 500) ?? null,
      ip: ctx.ip ?? null,
      expiresAt,
    })
    .returning({ id: trustedBrowsers.id });
  await securityEvent(userId, "trusted_browser_added", {
    ctx,
    metadata: { trusted_browser: row!.id },
  });
  return { token, expiresAt };
}

/**
 * Whether this cookie names a live trusted browser OF THIS PERSON. Keyed on both, so a cookie
 * left by one person on a shared machine never skips the step for another.
 */
export async function isTrustedBrowser(
  userId: string,
  raw: string | null | undefined,
): Promise<boolean> {
  if (!raw || !TOKEN_RE.test(raw)) return false;
  const now = new Date();
  const [row] = await systemDb
    .update(trustedBrowsers)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(trustedBrowsers.tokenHash, hashToken(raw)),
        eq(trustedBrowsers.userId, userId),
        isNull(trustedBrowsers.revokedAt),
        gt(trustedBrowsers.expiresAt, now),
      ),
    )
    .returning({ id: trustedBrowsers.id });
  return !!row;
}

export interface TrustedBrowserSummary {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  /** The browser making this request. */
  current: boolean;
}

/** The person's live trusted browsers, newest first. */
export async function listTrustedBrowsers(
  userId: string,
  currentRaw?: string | null,
): Promise<TrustedBrowserSummary[]> {
  const currentHash = currentRaw && TOKEN_RE.test(currentRaw) ? hashToken(currentRaw) : null;
  const rows = await systemDb
    .select()
    .from(trustedBrowsers)
    .where(
      and(
        eq(trustedBrowsers.userId, userId),
        isNull(trustedBrowsers.revokedAt),
        gt(trustedBrowsers.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(trustedBrowsers.createdAt));
  return rows.map((r) => ({
    id: r.id,
    userAgent: r.userAgent,
    ip: r.ip,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    current: r.tokenHash === currentHash,
  }));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Forget one of the person's own trusted browsers. False when it is not theirs or not live. */
export async function forgetTrustedBrowser(
  userId: string,
  id: string,
  ctx: SecurityContext = {},
): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const [row] = await systemDb
    .update(trustedBrowsers)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(trustedBrowsers.id, id),
        eq(trustedBrowsers.userId, userId),
        isNull(trustedBrowsers.revokedAt),
      ),
    )
    .returning({ id: trustedBrowsers.id });
  if (!row) return false;
  await securityEvent(userId, "trusted_browser_forgotten", {
    ctx,
    metadata: { trusted_browser: row.id },
  });
  return true;
}

/**
 * Forget every trusted browser of this person. Called whenever their credentials or 2FA change,
 * and on "sign out of other browsers". Records an event only when something was forgotten.
 */
export async function forgetAllTrustedBrowsers(
  userId: string,
  reason: string,
  ctx: SecurityContext = {},
): Promise<number> {
  const rows = await systemDb
    .update(trustedBrowsers)
    .set({ revokedAt: new Date() })
    .where(and(eq(trustedBrowsers.userId, userId), isNull(trustedBrowsers.revokedAt)))
    .returning({ id: trustedBrowsers.id });
  if (rows.length > 0) {
    await securityEvent(userId, "trusted_browsers_forgotten", {
      ctx,
      metadata: { reason, count: rows.length },
    });
  }
  return rows.length;
}

/** Drop rows that stopped mattering: expired or forgotten more than 30 days ago. */
export async function sweepTrustedBrowsers(now: Date = new Date()): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - TRUSTED_BROWSER_TTL_MS);
  const gone = await systemDb
    .delete(trustedBrowsers)
    .where(or(lt(trustedBrowsers.expiresAt, cutoff), lt(trustedBrowsers.revokedAt, cutoff)))
    .returning({ id: trustedBrowsers.id });
  return { deleted: gone.length };
}
