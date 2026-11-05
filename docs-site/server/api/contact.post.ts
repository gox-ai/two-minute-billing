/**
 * The contact form. Emails our team through Amazon SES's HTTPS API when NUXT_CONTACT_SES_* are
 * set (our docs host blocks the SMTP ports), else over SMTP (NUXT_CONTACT_SMTP_URL), and posts
 * to Google Chat when NUXT_CONTACT_CHAT_WEBHOOK_URL is set. Sent when either channel takes it.
 * Every setting comes from the docs host's env, never from the repository. Limited to five
 * messages an hour per address, behind Turnstile when it is configured.
 */
import nodemailer from "nodemailer";
import { sendWithSes } from "../lib/ses";

const WINDOW_MS = 3_600_000;
const LIMIT = 5;
const sent = new Map<string, number[]>();

const TOPICS = ["Cloud plans", "Enterprise", "Self-hosted support", "Something else"];

/** The SMTP URL as connection options, with short timeouts so a blocked port fails in seconds. */
function smtpOptions(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || (u.protocol === "smtps:" ? 465 : 587),
    secure: u.protocol === "smtps:",
    auth: u.username
      ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) }
      : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}

function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export default defineEventHandler(async (event) => {
  const cfg = useRuntimeConfig(event);
  // The contact form is part of the Cloud site; a self-hosted docs build has no such page.
  if (cfg.public.edition !== "cloud") throw createError({ statusCode: 404 });
  const ses =
    cfg.contactSesRegion && cfg.contactSesKeyId && cfg.contactSesSecret
      ? { region: cfg.contactSesRegion, keyId: cfg.contactSesKeyId, secret: cfg.contactSesSecret }
      : null;
  const canMail = !!(ses || cfg.contactSmtpUrl) && !!cfg.contactTo;
  const chatUrl = cfg.contactChatWebhookUrl as string;
  if (!canMail && !chatUrl) {
    throw createError({
      statusCode: 503,
      statusMessage: "The contact form is not set up on this site.",
    });
  }
  const body = await readBody<Record<string, unknown>>(event);
  const name = clean(body.name, 200);
  const email = clean(body.email, 254);
  const company = clean(body.company, 200);
  const topic = clean(body.topic, 50);
  const message = clean(body.message, 5000);
  if (
    !name ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !TOPICS.includes(topic) ||
    message.length < 10
  ) {
    throw createError({ statusCode: 400, statusMessage: "Correct the highlighted fields." });
  }

  const ip = getRequestIP(event, { xForwardedFor: true }) ?? "unknown";
  const now = Date.now();
  const recent = (sent.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) {
    throw createError({
      statusCode: 429,
      statusMessage: "Too many messages. Try again in an hour.",
    });
  }

  if (cfg.turnstileSecret) {
    const verdict = await $fetch<{ success: boolean }>(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: new URLSearchParams({
          secret: cfg.turnstileSecret,
          response: clean(body.turnstile_token, 4096),
          remoteip: ip,
        }),
      },
    ).catch(() => ({ success: false }));
    if (!verdict.success) {
      throw createError({
        statusCode: 400,
        statusMessage: "We could not check that you are a person. Try again.",
      });
    }
  }

  const mail = {
    from: cfg.contactFrom || cfg.contactTo,
    to: cfg.contactTo,
    replyTo: `${name} <${email}>`,
    subject: `[${topic}] ${name}${company ? ` · ${company}` : ""}`,
    text: `${message}\n\n— ${name} <${email}>${company ? `, ${company}` : ""}`,
  };
  const sendMail = async (): Promise<boolean> => {
    if (!canMail) return false;
    try {
      if (ses) await sendWithSes({ ...ses, ...mail });
      else await nodemailer.createTransport(smtpOptions(cfg.contactSmtpUrl)).sendMail(mail);
      return true;
    } catch (err) {
      // The reason only: never the SMTP URL, which carries the password.
      const e = err as { code?: string; message?: string };
      console.error(
        `[contact] send failed (${ses ? "ses" : "smtp"}): ${e.code ?? ""} ${e.message ?? err}`,
      );
      return false;
    }
  };
  const postChat = async (): Promise<boolean> => {
    if (!chatUrl) return false;
    const text =
      `*Contact form · ${topic}* · ${name} <${email}>${company ? ` · ${company}` : ""}\n` + message;
    try {
      await $fetch(chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json; charset=UTF-8" },
        body: { text },
        timeout: 10_000,
      });
      return true;
    } catch (err) {
      // Status only: ofetch's message carries the URL, and the URL is the credential.
      const status = (err as { statusCode?: number }).statusCode;
      console.error(`[contact] chat post failed: ${status ?? "no response"}`);
      return false;
    }
  };
  const [mailed, posted] = await Promise.all([sendMail(), postChat()]);
  if (!mailed && !posted) {
    throw createError({
      statusCode: 502,
      statusMessage: "We could not send your message. Try again later.",
    });
  }
  sent.set(ip, [...recent, now]);
  return { ok: true };
});
