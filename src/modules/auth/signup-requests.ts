/**
 * Access requests while self-serve sign-up is locked (0405).
 *
 * The sign-up page shows a request form instead of a dead end. A request is stored (one open
 * request per address: a repeat updates it) and the team is told by email and chat. Staff answer
 * it from the back-office: send a one-time sign-up link (`sendSignupInvite`) or dismiss it.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { signupRequests } from "@db/schema";
import { config } from "@/platform/config";
import { systemDb } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";
import { postTeamChat } from "@/platform/team-chat";
import { stampTracePayload } from "@/platform/trace";
import { resolveMailer } from "@/modules/emails/mailer-resolver";
import { renderSignupRequestNotice } from "@/modules/emails/templates";
import { sendSignupInvite } from "./signup";

const log = createLogger("auth.signup-requests");

export type SignupRequestRow = typeof signupRequests.$inferSelect;
export type SignupRequestStatus = "pending" | "invited" | "dismissed";

export class SignupRequestError extends Error {}

export interface SignupRequestInput {
  email: string;
  name: string;
  company: string;
  country?: string | null;
  billingVolume?: string | null;
  gateway?: string | null;
  message?: string | null;
  ip?: string | null;
}

export const ACCESS_REQUEST_NOTICE_TASK = "access_request_notice_send";
const NOTICE_MAX_ATTEMPTS = 10;

export type AccessRequestNoticeChannel = "chat" | "email";

export interface AccessRequestNoticeJob {
  /** The request's public id (`sreq_…`). */
  request: string;
  channel: AccessRequestNoticeChannel;
}

export const accessRequestNoticeJobKey = (
  channel: AccessRequestNoticeChannel,
  request: string,
): string => `access_request_notice:${channel}:${request}`;

/**
 * Store a request, or update the address's open one, and queue the team's notices in the same
 * transaction: one `access_request_notice_send` job per channel, sent by the engine worker. A
 * repeat with the same answers changes nothing and queues nothing, so a double submit is one
 * request and one lead.
 */
export async function submitSignupRequest(input: SignupRequestInput): Promise<void> {
  const email = input.email.toLowerCase().trim();
  const fields = {
    name: input.name,
    company: input.company,
    country: input.country ?? null,
    billingVolume: input.billingVolume ?? null,
    gateway: input.gateway ?? null,
    message: input.message || null,
    requestedIp: input.ip ?? null,
  };
  const row = await systemDb.transaction(async (tx) => {
    const [r] = await tx
      .insert(signupRequests)
      .values({ publicId: publicId("sreq"), email, ...fields })
      .onConflictDoUpdate({
        target: signupRequests.email,
        targetWhere: sql`status = 'pending'`,
        set: { ...fields, updatedAt: new Date() },
        // The IP is not an answer: the same request from a new address is still a duplicate.
        setWhere: sql`(${signupRequests.name}, ${signupRequests.company}, ${signupRequests.country},
          ${signupRequests.billingVolume}, ${signupRequests.gateway}, ${signupRequests.message})
          IS DISTINCT FROM (excluded.name, excluded.company, excluded.country,
          excluded.billing_volume, excluded.gateway, excluded.message)`,
      })
      .returning();
    if (!r) return null;
    for (const channel of ["chat", "email"] as const) {
      const job: AccessRequestNoticeJob = { request: r.publicId, channel };
      // A change while its notice waits replaces that job: one notice, with the latest answers.
      await tx.execute(sql`select graphile_worker.add_job(
        ${ACCESS_REQUEST_NOTICE_TASK},
        ${JSON.stringify(stampTracePayload(job))}::json,
        max_attempts => ${NOTICE_MAX_ATTEMPTS},
        job_key => ${accessRequestNoticeJobKey(channel, r.publicId)})`);
    }
    return r;
  });
  if (!row) {
    log.info("access request repeated unchanged");
    return;
  }
  log.info("access request received", { request: row.publicId });
}

const VOLUME_LABEL: Record<string, string> = {
  none: "not billing yet",
  under_10k: "under $10K / month",
  "10k_100k": "$10K–$100K / month",
  "100k_500k": "$100K–$500K / month",
  over_500k: "over $500K / month",
};

/** LEAD_CHAT_WEBHOOK_URL is the deprecated name, read until production renames it. */
const accessChatUrl = (): string | undefined =>
  config.SUPPORT_CHAT_WEBHOOK_URL ?? config.LEAD_CHAT_WEBHOOK_URL ?? config.OPS_ALERT_WEBHOOK_URL;

export function accessRequestChatText(r: SignupRequestRow): string {
  const facts = [
    r.company,
    r.country,
    r.billingVolume ? VOLUME_LABEL[r.billingVolume] : null,
    r.gateway,
  ].filter(Boolean);
  return (
    `*Access request* · ${r.name} <${r.email}>\n${facts.join(" · ")}` +
    (r.message ? `\n> ${r.message.replace(/\n/g, " ")}` : "") +
    "\nSend a sign-up link from the back-office: Sign-up requests."
  );
}

/**
 * Send one channel of the notice for the request as it is now. Throws when the channel did not
 * take it, so the queue retries; the last attempt logs an error. Skipped when the channel is unset.
 */
export async function sendAccessRequestNotice(
  job: AccessRequestNoticeJob,
  attempt: { attempts: number; maxAttempts: number } = { attempts: 1, maxAttempts: 1 },
): Promise<"sent" | "skipped"> {
  const url = accessChatUrl();
  const to = config.SIGNUP_REQUEST_NOTIFY_TO;
  if (job.channel === "chat" ? !url : !to) return "skipped";
  const [r] = await systemDb
    .select()
    .from(signupRequests)
    .where(eq(signupRequests.publicId, job.request))
    .limit(1);
  if (!r) return "skipped";
  try {
    if (job.channel === "chat") {
      const res = await postTeamChat(url!, accessRequestChatText(r));
      if (!res.ok) throw new Error(`The chat did not take the access request: ${res.error}`);
    } else {
      const rendered = renderSignupRequestNotice(r);
      await resolveMailer(null).send({
        to: to!,
        from: config.MAIL_FROM,
        fromName: config.MAIL_FROM_NAME,
        replyTo: `${r.name} <${r.email}>`,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
    }
  } catch (e) {
    // Stored already and listed in the back-office: a lost notice loses no request.
    const facts = { channel: job.channel, request: r.publicId, attempts: attempt.attempts };
    if (attempt.attempts >= attempt.maxAttempts)
      log.error(e as Error, { event: "signup_request_notice_failed", ...facts });
    else
      log.warn("an access request notice will be retried", {
        event: "signup_request_notice_retry",
        reason: (e as Error)?.message,
        ...facts,
      });
    throw e;
  }
  return "sent";
}

export async function listSignupRequests(
  status?: SignupRequestStatus,
): Promise<SignupRequestRow[]> {
  return systemDb
    .select()
    .from(signupRequests)
    .where(status ? eq(signupRequests.status, status) : undefined)
    .orderBy(desc(signupRequests.createdAt))
    .limit(500);
}

async function byPublicId(id: string): Promise<SignupRequestRow> {
  const [r] = await systemDb
    .select()
    .from(signupRequests)
    .where(eq(signupRequests.publicId, id))
    .limit(1);
  if (!r) throw new SignupRequestError("No such request.");
  return r;
}

/** Email the person a sign-up link. Allowed again on an invited request (a new link). */
export async function inviteSignupRequest(id: string, staff: string): Promise<SignupRequestRow> {
  const r = await byPublicId(id);
  if (r.status === "dismissed") throw new SignupRequestError("This request is dismissed.");
  await sendSignupInvite(
    {
      email: r.email,
      name: r.name,
      company: r.company,
      country: r.country,
      billingVolume: r.billingVolume,
      gateway: r.gateway,
    },
    config.DASHBOARD_BASE_URL,
  );
  const [u] = await systemDb
    .update(signupRequests)
    .set({ status: "invited", invitedAt: new Date(), invitedBy: staff, updatedAt: new Date() })
    .where(eq(signupRequests.id, r.id))
    .returning();
  log.info("sign-up link sent", { request: r.publicId, staff });
  return u!;
}

export async function dismissSignupRequest(id: string, staff: string): Promise<SignupRequestRow> {
  const r = await byPublicId(id);
  const [u] = await systemDb
    .update(signupRequests)
    .set({
      status: "dismissed",
      dismissedAt: new Date(),
      dismissedBy: staff,
      updatedAt: new Date(),
    })
    .where(and(eq(signupRequests.id, r.id), eq(signupRequests.status, "pending")))
    .returning();
  if (!u) throw new SignupRequestError("Only an open request can be dismissed.");
  log.info("access request dismissed", { request: r.publicId, staff });
  return u;
}
