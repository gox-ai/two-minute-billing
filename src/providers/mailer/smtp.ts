import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { MailerSendError, type Mailer, type OutboundEmail, type SendResult } from "./types";

/**
 * How the connection is protected. Three named modes rather than a `secure` boolean,
 * because the boolean conflates two different things and the third case has no encoding
 * in it at all:
 *   tls      — implicit TLS, encrypted from the first byte. Conventionally port 465.
 *   starttls — connect in the clear, then REQUIRE an upgrade. Conventionally port 587.
 *              `requireTLS` is what makes it a requirement; without it nodemailer will
 *              happily continue unencrypted when the server omits STARTTLS, which is a
 *              silent downgrade and the whole reason this is not the default-by-omission.
 *   none     — no encryption at all. Only for a local sink (mailpit, MailHog). Customer
 *              billing mail carries names, amounts and invoice links; this is never the
 *              right answer against a real relay, and the dashboard says so.
 */
export type SmtpEncryption = "tls" | "starttls" | "none";

export interface SmtpTransportOptions {
  host: string;
  port: number;
  encryption: SmtpEncryption;
  username?: string | null;
  password?: string | null;
  /**
   * Per-stage ceilings. These are load-bearing, not hygiene: `deliverPendingEmails`
   * awaits each send inside a wall-clock tick budget (TICK_PASS_BUDGET_MS), and an
   * unreachable relay that blocks on connect for the OS default would spend the whole
   * tick on one message and starve every other business's queue. Bounded here so a dead
   * relay costs one slow row, fails, and goes to backoff like any other error.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Is this failure worth retrying?
 *
 * RFC 5321 makes the answer readable: a **5yz** reply is a permanent negative completion
 * ("no such mailbox", "sender not authorised"), a **4yz** is transient ("try later"). Six
 * retries over six hours against a 550 achieves nothing and buries the real reason under
 * "gave up after 6 attempts".
 *
 * Two nodemailer specifics matter:
 * - `responseCode` carries the numeric reply and is the reliable signal; `err.code` is
 *   nodemailer's own string (`EENVELOPE`, `EAUTH`, `ECONNECTION`, `ETIMEDOUT`) and describes
 *   the STAGE, not the permanence — `EENVELOPE` covers both a refused sender (permanent)
 *   and a greylisted one (transient), so keying off it alone would misclassify both ways.
 * - **`EAUTH` is deliberately treated as TRANSIENT** even though it is usually a 535. Bad
 *   credentials are a misconfiguration the merchant will fix, and the mail should still be
 *   in the queue when they do; marking it permanently bounced would silently discard every
 *   invoice sent during a password typo.
 * - **A 5xx that rejected NO RECIPIENT is not a bounce**, and gets the same treatment for
 *   the same reason. The clearest case is an unverified From domain — Resend answers
 *   `550 This API key is not authorized to send emails from <domain>` at the DATA stage
 *   (`code: EMESSAGE`, `command: DATA`, `rejected` empty; measured, not assumed). Calling
 *   that permanent was wrong twice over: it marks the CUSTOMER's address bounced when the
 *   customer is fine, and it discards the queue the instant a merchant saves a From
 *   address their relay has not verified — the failure that produces real bounces.
 *
 *   The discriminator is structural rather than a text match on the relay's wording:
 *   nodemailer populates `rejected` when the refusal was about a recipient. No rejected
 *   recipient means the relay objected to the MESSAGE or its SENDER, which is our
 *   configuration to fix, not the buyer's mailbox.
 */
/**
 * Failures where the HOST never gave us a usable answer.
 *
 * Node's socket/DNS errors plus nodemailer's own stage codes for connect, greeting and
 * socket timeouts. Retrying this message is pointless, and so is retrying any other message
 * to the same host — which is exactly what makes them breaker-worthy and everything else
 * not. `EENVELOPE` and `EMESSAGE` are deliberately absent: the relay answered, it just
 * objected to what we sent.
 */
const TRANSPORT_FAULT_CODES = new Set([
  "ETIMEDOUT", // connect/greeting/socket timeout — the 10s ceiling in this file
  "ESOCKET", // socket error, including TLS handshake failures
  "ECONNECTION", // nodemailer's own connect-stage failure
  "ECONNREFUSED", // nothing listening on that port (a mistyped port looks exactly like this)
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND", // DNS did not resolve the host
  "EAI_AGAIN", // DNS temporarily failed
  "EDNS",
  "EPROTO",
]);

export function classifySmtpError(e: unknown): MailerSendError {
  const err = e as {
    responseCode?: unknown;
    code?: unknown;
    message?: unknown;
    response?: unknown;
  };
  const codeNum = typeof err?.responseCode === "number" ? err.responseCode : undefined;
  const codeStr = typeof err?.code === "string" ? err.code : undefined;
  const message = String(
    err?.message ?? err?.response ?? "We could not send the email through SMTP",
  );

  // The host itself is unusable. `permanent` stays FALSE — the mail must survive until the
  // relay comes back — but the fault is the transport's, so a breaker can stop paying the
  // full connect timeout for every queued message in the meantime.
  if (codeStr && TRANSPORT_FAULT_CODES.has(codeStr))
    return new MailerSendError(message, false, codeNum ?? codeStr, "transport");

  // EAUTH keeps its transient verdict, for the reason in the note above — the merchant will
  // fix the password and the queue must still be there. What changes is the FAULT: bad
  // credentials are per-relay, not per-message, so hammering it once per message is as
  // useless as hammering a dead host, and the breaker should stop it.
  if (codeStr === "EAUTH")
    return new MailerSendError(message, false, codeNum ?? codeStr, "transport");

  // Did the relay actually refuse a RECIPIENT? nodemailer lists them here when it did.
  const rejected = Array.isArray((err as { rejected?: unknown[] }).rejected)
    ? (err as { rejected: unknown[] }).rejected
    : [];
  const is5xx = codeNum !== undefined && codeNum >= 500 && codeNum < 600;
  // A 5xx about the message or the sender: retriable, because the fix is a setting the
  // merchant changes, and the buyer's address is not at fault. See the note above.
  //
  // NOT a transport fault, deliberately. The relay answered, and it answered about THIS
  // message — an unverified From domain refuses the message while the connection is
  // perfectly healthy. Breaking the circuit there would suppress every other business
  // sharing the relay over one merchant's misconfiguration.
  if (is5xx && rejected.length === 0)
    return new MailerSendError(message, false, codeNum ?? codeStr);

  return new MailerSendError(message, is5xx, codeNum ?? codeStr);
}

/**
 * Real SMTP delivery via nodemailer. The engine never imports nodemailer itself — this
 * file is the only place it appears, behind the same `Mailer` boundary the console sink
 * implements (mirrors the payment-provider rule in src/providers/types.ts).
 *
 * One instance owns one pooled connection, so it is worth caching per business rather
 * than constructing per message; `resolveMailer` in src/modules/emails/mailer-resolver.ts
 * does that. Call `close()` when discarding one.
 */
export class SmtpMailer implements Mailer {
  readonly kind = "smtp" as const;
  /** The relay this instance dials — the breaker's dependency identity. */
  readonly target: string;
  private readonly transporter: Transporter;

  constructor(opts: SmtpTransportOptions) {
    const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // host:port, not host alone — a mistyped PORT is a distinct dependency from the
    // correct one on the same host, and it is exactly the failure this identity has to
    // separate (measured 2026-09-01: `smtp.resend.com:4650`, where 465 was meant).
    this.target = `${opts.host}:${opts.port}`;
    this.transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.encryption === "tls",
      requireTLS: opts.encryption === "starttls",
      ignoreTLS: opts.encryption === "none",
      // Anonymous relays (a local sink, or an IP-allowlisted gateway) legitimately have
      // no credentials. Passing `auth` with empty strings makes nodemailer attempt AUTH
      // and fail against exactly those servers, so omit the key entirely instead.
      auth: opts.username ? { user: opts.username, pass: opts.password ?? "" } : undefined,
      pool: true,
      maxConnections: 3,
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    });
  }

  async send(msg: OutboundEmail): Promise<SendResult> {
    try {
      return await this.attempt(msg);
    } catch (e) {
      throw classifySmtpError(e);
    }
  }

  private async attempt(msg: OutboundEmail): Promise<SendResult> {
    // Throws on any transport failure, which is the contract deliverPendingEmails
    // depends on: a thrown error becomes an attempt + backoff, a return marks the row
    // sent. Swallowing anything here would relabel a bounce as a delivery.
    const info = await this.transporter.sendMail({
      to: msg.to,
      from: msg.fromName ? { name: msg.fromName, address: msg.from } : msg.from,
      replyTo: msg.replyTo ?? undefined,
      // Empty arrays must become undefined: nodemailer renders `Cc: ` for `[]`, and an
      // empty header is not the same as no header to every relay.
      cc: msg.cc?.length ? msg.cc : undefined,
      bcc: msg.bcc?.length ? msg.bcc : undefined,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      // Our own public id, echoed as a header several ESPs honour for dedupe. A retry
      // after an ambiguous failure (sent, then the ack was lost) carries the same key,
      // giving the far side a chance to collapse the duplicate we cannot detect.
      headers: msg.idempotencyKey ? { "X-Entity-Ref-ID": msg.idempotencyKey } : undefined,
      // Straight through — nodemailer builds the same MIME the SES transport composes by
      // hand, so an invoice PDF looks identical whichever relay carries it.
      attachments: msg.attachments?.length
        ? msg.attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
            contentType: a.contentType ?? "application/pdf",
          }))
        : undefined,
    });
    return { providerMessageId: info.messageId ?? null, status: "sent" };
  }

  /**
   * Handshake and authenticate without sending anything — backs "Test connection" in the
   * dashboard. Separate from a test SEND because the two fail differently and a merchant
   * needs to know which: `verify` failing is credentials or reachability, a test send
   * failing after `verify` passed is the From address being refused.
   */
  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  close(): void {
    this.transporter.close();
  }
}
