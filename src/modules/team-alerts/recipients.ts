/**
 * Team alert recipients outside the organization confirm by email (0495).
 *
 * A member of the organization gets alerts at once. Any other address gets one confirmation
 * mail with a single-use link that expires, and no alert until it is confirmed. Removing an
 * address marks its row `removed`; adding it back sends a new link. The row is kept so the
 * send limit holds across a remove and add.
 *
 * `systemDb` for two reads only: the public confirm (the token names no organization) and the
 * per-address send count across every business.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { teamAlertRecipients } from "@db/schema";
import { systemDb, withTenant } from "@/platform/db";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";
import { resolveMailer } from "@/modules/emails/mailer-resolver";
import { escapeHtml } from "@/modules/emails/sanitize";
import { isTeamAddress } from "@/modules/emails/test-mode";

const log = createLogger("team-alerts.recipients");

/** The link works for this long. */
export const CONFIRM_TTL_MS = 7 * 24 * 3600_000;
/** One business may mail one address at most this often… */
export const RESEND_MIN_INTERVAL_MS = 10 * 60_000;
/** …and this many times in a rolling day. */
export const SENDS_PER_DAY_PER_BUSINESS = 3;
/** Every business together may mail one address this many times in a rolling day. */
export const SENDS_PER_DAY_PER_ADDRESS = 10;
const DAY_MS = 24 * 3600_000;

export type RecipientState = "member" | "confirmed" | "pending";

export class TeamAlertRecipientError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "rate_limited" | "not_pending" | "no_link",
  ) {
    super(message);
  }
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const norm = (e: string) => e.trim().toLowerCase();

async function memberSet(organizationId: string, emails: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const e of emails) if (await isTeamAddress(organizationId, e)) out.add(e);
  return out;
}

/**
 * The recipients an alert may go to now: members, and confirmed addresses. Order kept.
 */
export async function deliverableRecipients(
  organizationId: string,
  businessId: string,
  recipients: string[],
): Promise<string[]> {
  if (recipients.length === 0) return [];
  const members = await memberSet(organizationId, recipients);
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({ email: teamAlertRecipients.email })
      .from(teamAlertRecipients)
      .where(
        and(
          eq(teamAlertRecipients.businessId, businessId),
          eq(teamAlertRecipients.status, "confirmed"),
          inArray(teamAlertRecipients.email, recipients),
        ),
      ),
  );
  const confirmed = new Set(rows.map((r) => r.email));
  return recipients.filter((e) => members.has(e) || confirmed.has(e));
}

/** Each configured address and its state, for Settings → Team alerts. */
export async function listRecipientStates(
  organizationId: string,
  businessId: string,
  recipients: string[],
): Promise<Array<{ email: string; state: RecipientState; lastSentAt: Date | null }>> {
  const members = await memberSet(organizationId, recipients);
  const rows = recipients.length
    ? await withTenant(organizationId, (tx) =>
        tx
          .select()
          .from(teamAlertRecipients)
          .where(
            and(
              eq(teamAlertRecipients.businessId, businessId),
              inArray(teamAlertRecipients.email, recipients),
            ),
          ),
      )
    : [];
  const byEmail = new Map(rows.map((r) => [r.email, r]));
  return recipients.map((email) => {
    const row = byEmail.get(email);
    return {
      email,
      state: members.has(email) ? "member" : row?.status === "confirmed" ? "confirmed" : "pending",
      lastSentAt: row?.lastSentAt ?? null,
    };
  });
}

/**
 * After the recipient list changed: a removed address is marked `removed`; a new address
 * that is not a member gets a pending row and a confirmation mail. A refused send (limit, no
 * dashboard URL) leaves it pending; the operator can send again later.
 */
export async function syncTeamAlertRecipients(input: {
  organizationId: string;
  businessId: string;
  businessName: string;
  before: string[];
  after: string[];
}): Promise<void> {
  const before = new Set(input.before.map(norm));
  const after = [...new Set(input.after.map(norm))];
  const removed = [...before].filter((e) => !after.includes(e));
  if (removed.length)
    await withTenant(input.organizationId, (tx) =>
      tx
        .update(teamAlertRecipients)
        .set({ status: "removed", tokenHash: null, tokenExpiresAt: null, confirmedAt: null })
        .where(
          and(
            eq(teamAlertRecipients.businessId, input.businessId),
            inArray(teamAlertRecipients.email, removed),
          ),
        ),
    );
  const members = await memberSet(input.organizationId, after);
  for (const email of after) {
    if (members.has(email)) continue;
    const [row] = await withTenant(input.organizationId, (tx) =>
      tx
        .select({ status: teamAlertRecipients.status })
        .from(teamAlertRecipients)
        .where(
          and(
            eq(teamAlertRecipients.businessId, input.businessId),
            eq(teamAlertRecipients.email, email),
          ),
        )
        .limit(1),
    );
    // Kept on the list and already known: nothing to do.
    if (before.has(email) && row && row.status !== "removed") continue;
    try {
      await sendConfirmation({ ...input, email });
    } catch (e) {
      if (!(e instanceof TeamAlertRecipientError)) throw e;
      log.warn("team alert confirmation not sent", {
        event: "team_alert_confirmation_not_sent",
        businessId: input.businessId,
        reason: e.code,
      });
    }
  }
}

/** "Send again" on the settings screen. The address must be on the list and pending. */
export async function resendConfirmation(input: {
  organizationId: string;
  businessId: string;
  businessName: string;
  recipients: string[];
  email: string;
}): Promise<void> {
  const email = norm(input.email);
  if (!input.recipients.includes(email))
    throw new TeamAlertRecipientError(
      `We could not send the email. ${email} is not a team alert recipient.`,
      "not_found",
    );
  if (await isTeamAddress(input.organizationId, email))
    throw new TeamAlertRecipientError(
      `We did not send the email. ${email} is a team member and gets alerts without confirmation.`,
      "not_pending",
    );
  const [row] = await withTenant(input.organizationId, (tx) =>
    tx
      .select({ status: teamAlertRecipients.status })
      .from(teamAlertRecipients)
      .where(
        and(
          eq(teamAlertRecipients.businessId, input.businessId),
          eq(teamAlertRecipients.email, email),
        ),
      )
      .limit(1),
  );
  if (row?.status === "confirmed")
    throw new TeamAlertRecipientError(
      `We did not send the email. ${email} is already confirmed.`,
      "not_pending",
    );
  await sendConfirmation({ ...input, email });
}

/**
 * Write a pending row with a new token and mail the link. The old link stops working.
 * Throws `rate_limited` over either limit, and `no_link` when the dashboard URL is not set.
 */
async function sendConfirmation(input: {
  organizationId: string;
  businessId: string;
  businessName: string;
  email: string;
}): Promise<void> {
  const base = config.DASHBOARD_BASE_URL?.replace(/\/$/, "");
  if (!base)
    throw new TeamAlertRecipientError(
      "We could not send the email. The dashboard address of this deployment is not set.",
      "no_link",
    );
  const now = new Date();
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const sums = (await systemDb.execute(sql`
    select coalesce(sum(send_count), 0)::int as n from team_alert_recipients
    where email = ${input.email} and send_window_start > ${dayAgo.toISOString()}::timestamptz`)) as unknown as Array<{
    n: number;
  }>;
  const addressSends = Number(sums[0]?.n ?? 0);
  const token = `tar_${randomBytes(32).toString("base64url")}`;
  const sent = await withTenant(input.organizationId, async (tx) => {
    const [cur] = await tx
      .select()
      .from(teamAlertRecipients)
      .where(
        and(
          eq(teamAlertRecipients.businessId, input.businessId),
          eq(teamAlertRecipients.email, input.email),
        ),
      )
      .limit(1)
      .for("update");
    const windowOpen = cur?.sendWindowStart != null && cur.sendWindowStart > dayAgo;
    const count = windowOpen ? cur!.sendCount : 0;
    const tooSoon =
      cur?.lastSentAt != null && now.getTime() - cur.lastSentAt.getTime() < RESEND_MIN_INTERVAL_MS;
    if (tooSoon || count >= SENDS_PER_DAY_PER_BUSINESS || addressSends >= SENDS_PER_DAY_PER_ADDRESS)
      return false;
    const values = {
      status: "pending",
      tokenHash: hashToken(token),
      tokenExpiresAt: new Date(now.getTime() + CONFIRM_TTL_MS),
      confirmedAt: null,
      lastSentAt: now,
      sendCount: count + 1,
      sendWindowStart: windowOpen ? cur!.sendWindowStart : now,
    };
    if (cur)
      await tx.update(teamAlertRecipients).set(values).where(eq(teamAlertRecipients.id, cur.id));
    else
      await tx.insert(teamAlertRecipients).values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        email: input.email,
        ...values,
      });
    return true;
  });
  if (!sent)
    throw new TeamAlertRecipientError(
      "We could not send the email. We sent too many confirmation emails to this address. Try again later.",
      "rate_limited",
    );
  const link = `${base}/team-alerts/confirm/s/${token}`;
  const subject = `Confirm that you want team alerts from ${input.businessName}`;
  const intro = `Someone added this email address to the team alerts of ${input.businessName}. We do not send alerts to this address until you confirm it. If you do not want these alerts, ignore this email.`;
  await resolveMailer(null).send({
    to: input.email,
    from: config.MAIL_FROM,
    fromName: config.MAIL_FROM_NAME,
    subject,
    html: [
      '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">',
      `<h2 style="font-size:18px;margin:0 0 16px">${escapeHtml(subject)}</h2>`,
      `<p style="font-size:14px;line-height:1.6;margin:0 0 12px">${escapeHtml(intro)}</p>`,
      `<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Confirm email address</a></p>`,
      '<p style="font-size:12px;color:#666;margin:0">The link works one time and expires in 7 days.</p>',
      "</div>",
    ].join(""),
    text: `${intro}\n\nConfirm email address: ${link}\n\nThe link works one time and expires in 7 days.`,
    idempotencyKey: `team_alert_confirm:${hashToken(token)}`,
  });
}

/**
 * The public confirm. Spends the token: works once, before it expires, and only while the
 * address is still pending. Returns nothing about the business or the address.
 */
export async function confirmTeamAlertRecipient(token: string): Promise<boolean> {
  if (!token.startsWith("tar_") || token.length > 200) return false;
  const rows = await systemDb
    .update(teamAlertRecipients)
    .set({ status: "confirmed", confirmedAt: new Date(), tokenHash: null, tokenExpiresAt: null })
    .where(
      and(
        eq(teamAlertRecipients.tokenHash, hashToken(token)),
        eq(teamAlertRecipients.status, "pending"),
        gt(teamAlertRecipients.tokenExpiresAt, new Date()),
      ),
    )
    .returning({ id: teamAlertRecipients.id });
  return rows.length === 1;
}
