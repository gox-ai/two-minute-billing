/**
 * Tell our team about a member's support message (Cloud): a chat line, and an email to
 * SUPPORT_EMAIL with the whole request.
 *
 * Queued by `queueSupportNotice` in the transaction that stores the message (0513): one
 * `support_notice_send` job per channel, keyed `support_notice:<channel>:<message>`. The worker
 * sends it within seconds, a rollback sends nothing, and a failed channel is retried by the
 * queue on its own (10 attempts), so the other channel is never sent twice.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { config } from "@/platform/config";
import { isCloud } from "@/platform/edition";
import { createLogger } from "@/platform/logger";
import { postTeamChat } from "@/platform/team-chat";
import { supportMessages } from "@db/schema";
import { resolveMailer } from "@/modules/emails/mailer-resolver";
import { accountBrand } from "@/modules/emails/account-brand";
import { renderSupportStaffNotice } from "@/modules/emails/templates";
import { getForStaff } from "./support";
import { supportReference, type SupportItem } from "./support-context";
import { ASSISTANT_NAME } from "./name";

const log = createLogger("assistant.support-notify");

export const SUPPORT_NOTICE_TASK = "support_notice_send";

export type SupportNoticeChannel = "chat" | "email";

/** The job payload, built by `public.app_queue_support_notice`. */
export interface SupportNoticeJob {
  /** The member message's public id (`srm_…`). */
  message: string;
  channel: SupportNoticeChannel;
}

export const supportNoticeJobKey = (channel: SupportNoticeChannel, message: string): string =>
  `support_notice:${channel}:${message}`;

/** Chat: our support channel, else the ops channel. */
export const supportChatUrl = (): string | undefined =>
  config.SUPPORT_CHAT_WEBHOOK_URL ?? config.OPS_ALERT_WEBHOOK_URL;

/** The request in the back-office; null when its address is not set. */
export const supportRequestLink = (id: string): string | null => {
  const base = config.BACKOFFICE_PUBLIC_URL?.replace(/\/+$/, "");
  return base ? `${base}/support/${id}` : null;
};

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g;

/**
 * The chat line. A chat room is not our support desk: organization, subject and the link only.
 * Never the description, a reply, the member or anything they attached.
 */
export function supportChatText(v: {
  kind: "new" | "reply";
  reference: string;
  organization: string;
  subject: string;
  link: string | null;
}): string {
  const head =
    v.kind === "new" ? `🆘 New support request ${v.reference}` : `💬 Reply on ${v.reference}`;
  const subject = v.subject.replace(EMAIL, "[email]").replace(/\s+/g, " ").slice(0, 160);
  return [`${head} · ${v.organization}`, subject, v.link].filter(Boolean).join("\n");
}

/** The thumbs-down chat line: organization, the question and the comment. Never the answer or ids. */
export function feedbackDownText(v: {
  organizationName: string;
  question: string | null;
  comment: string | null;
}): string {
  const flat = (s: string) => s.replace(EMAIL, "[email]").replace(/\s+/g, " ").trim();
  const question = flat(v.question ?? "").slice(0, 160) || "(no question)";
  const comment = flat(v.comment ?? "").slice(0, 500) || "(no comment)";
  return `👎 ${ASSISTANT_NAME} answer rated not helpful · ${v.organizationName}\n${question}\n${comment}`;
}

/** Cloud: one chat line when a member rates an answer not helpful. Skipped when no chat is set. */
export async function notifyFeedbackDown(v: {
  organizationName: string;
  question: string | null;
  comment: string | null;
}): Promise<"sent" | "skipped"> {
  const url = supportChatUrl();
  if (!isCloud() || !url) return "skipped";
  const r = await postTeamChat(url, feedbackDownText(v));
  if (!r.ok) throw new Error(`The chat did not take the feedback alert: ${r.error}`);
  return "sent";
}

/** The message's request, and whether it is the request's first member message. */
async function messageForNotice(
  message: string,
): Promise<{ id: string; request: string; first: boolean } | null> {
  const rows = (await systemDb.execute(sql`
    select m.id, r.public_id as request,
      not exists (select 1 from support_messages x
        where x.request_id = m.request_id and x.author_kind = 'member'
          and x.created_at < m.created_at) as first
    from support_messages m
    join support_requests r on r.id = m.request_id
    where m.public_id = ${message} and m.author_kind = 'member'`)) as unknown as Array<{
    id: string;
    request: string;
    first: boolean;
  }>;
  return rows[0] ?? null;
}

/**
 * Send one channel of a notice. Throws when the channel did not take it, so the queue retries;
 * the last attempt logs an error. Skipped on self-hosted, or when the channel is not set.
 */
export async function sendSupportNotice(
  job: SupportNoticeJob,
  attempt: { attempts: number; maxAttempts: number } = { attempts: 1, maxAttempts: 1 },
): Promise<"sent" | "skipped"> {
  if (!isCloud()) return "skipped";
  const chatUrl = supportChatUrl();
  const to = config.SUPPORT_EMAIL;
  if (job.channel === "chat" ? !chatUrl : !to) return "skipped";
  const m = await messageForNotice(job.message);
  const d = m ? await getForStaff(m.request) : null;
  if (!m || !d) return "skipped";
  const kind = m.first ? "new" : "reply";
  const reference = supportReference(d.request.number);
  const link = supportRequestLink(d.request.publicId);
  try {
    if (job.channel === "chat") {
      const r = await postTeamChat(
        chatUrl!,
        supportChatText({
          kind,
          reference,
          organization: d.organization.name,
          subject: d.request.subject,
          link,
        }),
      );
      if (!r.ok) throw new Error(`The chat did not take the support notice: ${r.error}`);
    } else {
      const msg = d.messages.find((x) => x.publicId === job.message);
      const mail = renderSupportStaffNotice({
        kind,
        reference,
        organization: d.organization,
        business: d.business,
        member: d.member,
        subject: d.request.subject,
        body: msg?.body ?? "",
        screenshots: ((msg?.attachments as Array<{ name: string }> | null) ?? []).map(
          (s) => s.name,
        ),
        items: (d.request.context as SupportItem[]) ?? [],
        link,
      });
      await resolveMailer(null).send({
        to: to!,
        from: config.MAIL_FROM,
        fromName: accountBrand().name,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });
    }
  } catch (e) {
    const facts = { channel: job.channel, message: job.message, attempts: attempt.attempts };
    if (attempt.attempts >= attempt.maxAttempts)
      log.error(e as Error, { event: "support_notice_failed", ...facts });
    else
      log.warn("a support notice will be retried", {
        event: "support_notice_retry",
        reason: (e as Error)?.message,
        ...facts,
      });
    throw e;
  }
  // When staff were first told; the job key, not this column, keeps a channel from sending twice.
  await systemDb
    .update(supportMessages)
    .set({ notifiedAt: new Date() })
    .where(and(eq(supportMessages.id, m.id), isNull(supportMessages.notifiedAt)));
  log.info("support notice sent", {
    event: "support_notice_sent",
    channel: job.channel,
    request: d.request.publicId,
  });
  return "sent";
}
