import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { mfaResetRequests, securityEvents, userMfa, users } from "@db/schema";
import { config } from "@/platform/config";
import { resolveMailer } from "@/modules/emails/mailer-resolver";
import {
  renderAccountSecurityEmail,
  type AccountSecurityEmailInput,
  type AccountSecurityEmailKind,
} from "@/modules/emails/templates";
import { accountBrand } from "@/modules/emails/account-brand";
import { createLogger } from "@/platform/logger";

const log = createLogger("auth.security");

/** What `security_events.kind` can say. */
export type SecurityEventKind =
  | "two_factor_enabled"
  | "two_factor_method_added"
  | "two_factor_method_removed"
  | "two_factor_disabled"
  | "authenticator_changed"
  | "recovery_codes_generated"
  | "recovery_code_used"
  | "mfa_failed"
  | "mfa_failed_alert"
  | "password_changed"
  | "password_added"
  | "password_reset"
  | "session_revoked"
  | "sessions_revoked"
  | "mfa_reset_requested"
  | "mfa_reset_cancelled"
  | "mfa_reset_completed"
  | "org_two_factor_required_on"
  | "org_two_factor_required_off"
  | "org_two_factor_required"
  | "org_two_factor_deadline_reminder"
  | "trusted_browser_added"
  | "trusted_browser_forgotten"
  | "trusted_browsers_forgotten"
  | "passkey_counter_regression"
  | "role_changed";

/** The kinds that also email the person, and which notice they get. */
const EMAIL_FOR: Partial<Record<SecurityEventKind, AccountSecurityEmailKind>> = {
  two_factor_enabled: "two_factor_enabled",
  two_factor_method_added: "two_factor_method_added",
  two_factor_method_removed: "two_factor_method_removed",
  two_factor_disabled: "two_factor_disabled",
  authenticator_changed: "authenticator_changed",
  recovery_codes_generated: "recovery_codes_generated",
  recovery_code_used: "recovery_code_used",
  mfa_failed_alert: "mfa_failed_attempts",
  password_changed: "password_changed",
  password_added: "password_added",
  password_reset: "password_reset",
  mfa_reset_requested: "two_factor_reset_requested",
  mfa_reset_completed: "two_factor_reset_completed",
  org_two_factor_required: "org_two_factor_required",
  org_two_factor_deadline_reminder: "org_two_factor_deadline",
  role_changed: "role_changed",
};

export interface SecurityContext {
  ip?: string | null;
  userAgent?: string | null;
}

export type SecurityMetadata = Record<string, string | number | boolean | null>;

/** Keys that could carry a credential. Dropped, never stored. */
const FORBIDDEN_KEY = /code|secret|token|challenge|password|otp|hash/i;

/** Extra facts for the email that are not worth storing on the event. */
type EmailExtras = Partial<
  Pick<
    AccountSecurityEmailInput,
    | "method"
    | "passkeyName"
    | "codesLeft"
    | "recoveryContext"
    | "firstFactor"
    | "effectiveAt"
    | "cancelLink"
    | "organizationName"
    | "requiredBy"
    | "deadlineDay"
    | "deadlineIsToday"
    | "roleName"
  >
>;

/**
 * Append one row to the security trail. Best-effort: a failed INSERT is logged and the action it
 * describes still succeeds — the same rule as `login_attempts`.
 */
export async function recordSecurityEvent(
  userId: string,
  kind: SecurityEventKind,
  ctx: SecurityContext = {},
  metadata: SecurityMetadata = {},
): Promise<void> {
  const clean: SecurityMetadata = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (FORBIDDEN_KEY.test(k)) {
      log.error(new Error(`security_events metadata key "${k}" refused`), { kind });
      continue;
    }
    clean[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  try {
    await systemDb.insert(securityEvents).values({
      userId,
      kind,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent?.slice(0, 500) ?? null,
      metadata: clean,
    });
  } catch (e) {
    log.error(e, { event: "security_event_not_recorded", kind });
  }
}

const inFlight = new Set<Promise<void>>();

/**
 * Wait for notices already handed to the mailer. A request never waits on mail; a script, the
 * reset sweep and the verify suites do, so they don't exit (or assert) before the send lands.
 */
export async function flushSecurityMail(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

/** Send one notice. Never throws: a mail outage must not undo a security change. */
function sendNotice(
  userId: string,
  kind: AccountSecurityEmailKind,
  at: Date,
  ctx: SecurityContext,
  extras: EmailExtras,
) {
  const p = (async () => {
    try {
      const [user] = await systemDb
        .select({ email: users.email, name: users.name, publicId: users.publicId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) return;
      const base = config.DASHBOARD_BASE_URL?.replace(/\/$/, "");
      const rendered = renderAccountSecurityEmail({
        kind,
        email: user.email,
        name: user.name,
        at,
        userAgent: ctx.userAgent ?? null,
        accountLink: base ? `${base}/account` : null,
        supportEmail: config.SUPPORT_EMAIL ?? null,
        ...extras,
      });
      await resolveMailer(null).send({
        to: user.email,
        from: config.MAIL_FROM,
        fromName: accountBrand().name,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      log.info("security notice sent", { user: user.publicId, kind });
    } catch (e) {
      log.error(e, { event: "security_notice_send_failed", kind });
    }
  })();
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
}

/**
 * Record a security event and, for the kinds that warrant one, email the person. The mail is
 * dispatched, not awaited, so a slow relay never holds up a sign-in or a settings change.
 */
export async function securityEvent(
  userId: string,
  kind: SecurityEventKind,
  opts: { ctx?: SecurityContext; metadata?: SecurityMetadata; email?: EmailExtras | false } = {},
): Promise<void> {
  const ctx = opts.ctx ?? {};
  await recordSecurityEvent(userId, kind, ctx, opts.metadata);
  const mail = EMAIL_FOR[kind];
  if (mail && opts.email !== false) sendNotice(userId, mail, new Date(), ctx, opts.email ?? {});
}

/** Wrong second-step codes, inside this window and since the last good one, that raise the alert. */
const FAILED_CODE_ALERT_AT = 5;
const FAILED_CODE_WINDOW_MS = 15 * 60_000;
const FAILED_CODE_ALERT_EVERY_MS = 24 * 3600_000;

/**
 * A wrong code at the sign-in second step. The first factor was right, so after 5 of these the
 * person is told someone may have their password (or Google account) — at most once a day.
 *
 * Counts only failures since the person's last ACCEPTED code, so someone who fumbles and then gets
 * in is not told they are under attack.
 */
export async function recordFailedSecondFactor(
  userId: string,
  firstFactor: "password" | "google",
  ctx: SecurityContext = {},
): Promise<void> {
  await recordSecurityEvent(userId, "mfa_failed", ctx, { first_factor: firstFactor });
  try {
    const now = Date.now();
    const [mfa] = await systemDb
      .select({ lastUsedAt: userMfa.lastUsedAt })
      .from(userMfa)
      .where(eq(userMfa.userId, userId))
      .limit(1);
    const since = new Date(Math.max(now - FAILED_CODE_WINDOW_MS, mfa?.lastUsedAt?.getTime() ?? 0));
    const [row] = await systemDb
      .select({ n: sql<number>`count(*)::int` })
      .from(securityEvents)
      .where(
        and(
          eq(securityEvents.userId, userId),
          eq(securityEvents.kind, "mfa_failed"),
          gt(securityEvents.at, since),
        ),
      );
    if ((row?.n ?? 0) < FAILED_CODE_ALERT_AT) return;

    // Serialised per person, so two concurrent fifth failures cannot both send.
    const fire = await systemDb.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}::text, 7420))`);
      const [recent] = await tx
        .select({ id: securityEvents.id })
        .from(securityEvents)
        .where(
          and(
            eq(securityEvents.userId, userId),
            eq(securityEvents.kind, "mfa_failed_alert"),
            gt(securityEvents.at, new Date(now - FAILED_CODE_ALERT_EVERY_MS)),
          ),
        )
        .limit(1);
      if (recent) return false;
      await tx.insert(securityEvents).values({
        userId,
        kind: "mfa_failed_alert",
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent?.slice(0, 500) ?? null,
        metadata: { first_factor: firstFactor },
      });
      return true;
    });
    if (fire) sendNotice(userId, "mfa_failed_attempts", new Date(), ctx, { firstFactor });
  } catch (e) {
    log.error(e, { event: "mfa_failed_alert_check_failed" });
  }
}

/** When support will turn this person's 2FA off, if a reset is pending. */
export async function pendingMfaReset(userId: string): Promise<Date | null> {
  const [row] = await systemDb
    .select({ effectiveAt: mfaResetRequests.effectiveAt })
    .from(mfaResetRequests)
    .where(
      and(
        eq(mfaResetRequests.userId, userId),
        isNull(mfaResetRequests.cancelledAt),
        isNull(mfaResetRequests.completedAt),
      ),
    )
    .orderBy(desc(mfaResetRequests.requestedAt))
    .limit(1);
  return row?.effectiveAt ?? null;
}

/** Drop security events past SECURITY_EVENT_RETENTION_DAYS. */
export async function sweepSecurityEvents(now: Date = new Date()): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - config.SECURITY_EVENT_RETENTION_DAYS * 86_400_000);
  const res = await systemDb.delete(securityEvents).where(lt(securityEvents.at, cutoff));
  return { deleted: (res as unknown as { count?: number }).count ?? 0 };
}
