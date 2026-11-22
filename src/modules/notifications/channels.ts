/**
 * The four ways a notification leaves: Web Push, member email, Google Chat, outside email.
 * One send each, classified so the drain and the test sends settle a row the same way.
 * Transports are injectable for the verify suite (`setNotificationTransports`).
 */
import webpush from "web-push";
import { config } from "@/platform/config";
import { resolveMailer } from "@/modules/emails/mailer-resolver";
import { MailerSendError } from "@/providers/mailer/types";
import { isChatWebhookUrl } from "./service";

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The JSON the service worker reads (`dashboard/public/sw.js`). */
export interface PushBody {
  title: string;
  body: string;
  url: string | null;
  tag?: string;
  renotify?: boolean;
  badge_count?: number;
}

export interface MailBody {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}

export interface Transports {
  /** Resolves with the push service's status; rejects with `{ statusCode }` on a refusal. */
  push(
    target: PushTarget,
    payload: string,
    urgency: "high" | "normal",
  ): Promise<{ statusCode: number }>;
  chat(url: string, body: unknown): Promise<{ status: number; text: string }>;
  email(mail: MailBody): Promise<void>;
}

const MAX_PUSH_BYTES = 4000;

const defaults: Transports = {
  async push(target, payload, urgency) {
    const v = vapid();
    if (!v) throw Object.assign(new Error("push is not configured"), { statusCode: 0 });
    const r = await webpush.sendNotification(target, payload, {
      vapidDetails: v,
      TTL: 24 * 3600,
      urgency,
      timeout: 10_000,
    });
    return { statusCode: r.statusCode };
  },
  async chat(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, text: (await res.text().catch(() => "")).slice(0, 300) };
  },
  async email(mail) {
    await resolveMailer(null).send({
      to: mail.to,
      from: config.MAIL_FROM,
      fromName: config.MAIL_FROM_NAME,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      idempotencyKey: mail.idempotencyKey,
    });
  },
};

let current: Transports = defaults;

/** Verify suites only: replace one or more transports. `null` restores the real ones. */
export function setNotificationTransports(t: Partial<Transports> | null): void {
  current = t ? { ...defaults, ...t } : defaults;
}

export function vapid(): { subject: string; publicKey: string; privateKey: string } | null {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = config;
  if (!publicKey || !privateKey) return null;
  const subject =
    config.VAPID_SUBJECT ||
    (config.DASHBOARD_BASE_URL?.startsWith("https://") ? config.DASHBOARD_BASE_URL : null) ||
    `mailto:${config.MAIL_FROM}`;
  return { subject, publicKey, privateKey };
}

/** Push is on when the deployment has VAPID keys, or a verify suite replaced the transport. */
export const pushConfigured = () => current.push !== defaults.push || vapid() !== null;

export type SendOutcome =
  | { kind: "sent" }
  /** Will not succeed on a retry; settle as skipped. */
  | { kind: "skipped"; reason: string; gone?: boolean }
  | { kind: "permanent"; error: string }
  | { kind: "retry"; error: string };

/** Fit the push into the 4 KB the push services accept: shorten the body first. */
export function pushPayload(body: PushBody): string {
  let json = JSON.stringify(body);
  if (Buffer.byteLength(json) <= MAX_PUSH_BYTES) return json;
  const over = Buffer.byteLength(json) - MAX_PUSH_BYTES;
  const b = { ...body, body: `${body.body.slice(0, Math.max(0, body.body.length - over - 2))}…` };
  json = JSON.stringify(b);
  return Buffer.byteLength(json) <= MAX_PUSH_BYTES ? json : JSON.stringify({ ...b, body: "" });
}

export async function sendPush(
  target: PushTarget,
  body: PushBody,
  urgency: "high" | "normal" = "normal",
): Promise<SendOutcome> {
  if (!pushConfigured()) return { kind: "skipped", reason: "push_not_configured" };
  try {
    const r = await current.push(target, pushPayload(body), urgency);
    if (r.statusCode >= 200 && r.statusCode < 300) return { kind: "sent" };
    return classifyPushStatus(r.statusCode, `HTTP ${r.statusCode}`);
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    return classifyPushStatus(code ?? 0, (e as Error)?.message ?? String(e));
  }
}

function classifyPushStatus(status: number, error: string): SendOutcome {
  // 404/410: the browser dropped the subscription. Delete it.
  if (status === 404 || status === 410)
    return { kind: "skipped", reason: "subscription_gone", gone: true };
  // 400/401/403/413: the request or our keys are wrong; a retry sends the same thing.
  if (status >= 400 && status < 500 && status !== 429) return { kind: "permanent", error };
  return { kind: "retry", error };
}

/** Google answers `{"error":{"message":…}}`; keep its sentence, not the JSON. */
function chatErrorMessage(text: string): string {
  try {
    const m = (JSON.parse(text) as { error?: { message?: unknown } })?.error?.message;
    if (typeof m === "string" && m.trim()) return m.trim().slice(0, 200);
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 200);
}

export async function sendChat(url: string, body: unknown): Promise<SendOutcome> {
  if (!isChatWebhookUrl(url)) return { kind: "permanent", error: "not a Google Chat webhook URL" };
  try {
    const r = await current.chat(url, body);
    if (r.status >= 200 && r.status < 300) return { kind: "sent" };
    const error = `HTTP ${r.status}${r.text ? `: ${chatErrorMessage(r.text)}` : ""}`;
    return r.status === 429 || r.status >= 500
      ? { kind: "retry", error }
      : { kind: "permanent", error };
  } catch (e) {
    return { kind: "retry", error: (e as Error)?.message ?? String(e) };
  }
}

export async function sendMail(mail: MailBody): Promise<SendOutcome> {
  try {
    await current.email(mail);
    return { kind: "sent" };
  } catch (e) {
    const error = (e as Error)?.message ?? String(e);
    if (e instanceof MailerSendError && e.permanent) return { kind: "permanent", error };
    return { kind: "retry", error };
  }
}
