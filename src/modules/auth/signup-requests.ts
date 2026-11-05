/**
 * Access requests while self-serve sign-up is locked (0405).
 *
 * The sign-up page shows a request form instead of a dead end. A request is stored (one open
 * request per address: a repeat updates it) and emailed to the team. Staff answer it from the
 * back-office: send a one-time sign-up link (`sendSignupInvite`) or dismiss it.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { signupRequests } from "@db/schema";
import { config } from "@/platform/config";
import { systemDb } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";
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

/**
 * Store a request, or update the address's open one, then tell the team. A repeat with the same
 * answers changes nothing and tells nobody, so a double submit is one request and one lead.
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
  const [row] = await systemDb
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
  if (!row) {
    log.info("access request repeated unchanged");
    return;
  }
  log.info("access request received", { request: row.publicId });
  await notifyTeam(row);
}

/** Email and chat, side by side. Neither can fail the request: it is stored already. */
async function notifyTeam(r: SignupRequestRow): Promise<void> {
  await Promise.all([emailTeam(r), postToChat(r)]);
}

const VOLUME_LABEL: Record<string, string> = {
  none: "not billing yet",
  under_10k: "under $10K / month",
  "10k_100k": "$10K–$100K / month",
  "100k_500k": "$100K–$500K / month",
  over_500k: "over $500K / month",
};

async function postToChat(r: SignupRequestRow): Promise<void> {
  const url = config.LEAD_CHAT_WEBHOOK_URL ?? config.OPS_ALERT_WEBHOOK_URL;
  if (!url) return;
  const facts = [
    r.company,
    r.country,
    r.billingVolume ? VOLUME_LABEL[r.billingVolume] : null,
    r.gateway,
  ].filter(Boolean);
  const text =
    `*Access request* · ${r.name} <${r.email}>\n${facts.join(" · ")}` +
    (r.message ? `\n> ${r.message.replace(/\n/g, " ")}` : "") +
    "\nSend a sign-up link from the back-office: Sign-up requests.";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok)
      log.warn("chat rejected the access request", {
        event: "signup_request_chat_rejected",
        status: res.status,
        request: r.publicId,
      });
  } catch (e) {
    // Never the URL: it is the credential.
    log.warn("chat post of the access request failed", {
      event: "signup_request_chat_failed",
      error: (e as Error)?.message ?? String(e),
      request: r.publicId,
    });
  }
}

async function emailTeam(r: SignupRequestRow): Promise<void> {
  const to = config.SIGNUP_REQUEST_NOTIFY_TO;
  if (!to) return;
  const rendered = renderSignupRequestNotice(r);
  try {
    await resolveMailer(null).send({
      to,
      from: config.MAIL_FROM,
      fromName: config.MAIL_FROM_NAME,
      replyTo: `${r.name} <${r.email}>`,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  } catch (err) {
    // Stored already, and listed in the back-office: a lost notice loses nothing.
    log.error(err, { event: "signup_request_notice_failed", request: r.publicId });
  }
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
