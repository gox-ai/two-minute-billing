import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
// The MIME builder only. nodemailer is already this file's sibling dependency (SmtpMailer),
// and its composer is the same one that produces the bytes for every SMTP send here — so the
// two transports put identical messages on the wire rather than two dialects of MIME.
import MailComposer from "nodemailer/lib/mail-composer";
import { MailerSendError, type Mailer, type OutboundEmail, type SendResult } from "./types";

/**
 * Amazon SES via the SESv2 API.
 *
 * Note this is the API transport, not SES's SMTP endpoint. SES can already be driven
 * through `SmtpMailer` today (`email-smtp.<region>.amazonaws.com:587`, STARTTLS, SES SMTP
 * credentials) and that remains a supported way to use it. This adapter exists because the
 * API gives two things the SMTP endpoint cannot:
 *
 *   1. **IAM instead of a long-lived password.** SES SMTP credentials are a derived
 *      secret that must be generated and stored; an IAM key scoped to sending alone
 *      is narrower and rotates with the rest of the account's credentials.
 *   2. **A typed error taxonomy.** SMTP hands back a reply code and a sentence; SESv2
 *      throws `MailFromDomainNotVerifiedException` vs `AccountSuspendedException` vs
 *      `MessageRejected`. `classifySesError` below turns that into the one bit the outbox
 *      needs, and gets it right far more often than a numeric code allows.
 *
 * It also works where outbound :587 is blocked, which is common on locked-down egress.
 *
 * ⚠️ **The IAM action depends on the CONTENT TYPE, which is not obvious from the API.**
 * `SendEmail` is one call, but AWS authorises `Content.Simple` against `ses:SendEmail` and
 * `Content.Raw` against **`ses:SendRawEmail`**. This adapter sends Raw (see `attempt`), so
 * `ses:SendRawEmail` is the permission to grant — which is also what a key provisioned for
 * nodemailer already has. Measured against real AWS, 2026-08-29: Simple content was denied
 * on every identity while Raw sent first time under an unchanged policy.
 */
export interface SesTransportOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Optional SES configuration set — the hook for open/click tracking and, more usefully,
   * for routing bounce and complaint notifications to SNS. Left null the mail still sends;
   * you just have no asynchronous feedback channel. See the note in `classifySesError`
   * about why that channel is where real bounces live.
   */
  configurationSet?: string | null;
  /**
   * Per-request ceiling, load-bearing for the same reason as the SMTP one:
   * `deliverPendingEmails` awaits each send inside a wall-clock tick budget
   * (TICK_PASS_BUDGET_MS), so an unreachable endpoint must cost one slow row rather than
   * the whole tick.
   */
  timeoutMs?: number;
  /**
   * Override the SES endpoint. Two real uses: a VPC or FIPS endpoint in a locked-down
   * account, and `verify:ses-transport`, which points this at a local server that speaks the
   * SESv2 wire protocol — so the suite proves this adapter really does speak SESv2, rather
   * than proving that a mock returns what the mock was told to return.
   */
  endpoint?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Is this failure worth retrying — and, separately, is it the RECIPIENT's fault?
 *
 * Those are not the same question, and conflating them is the trap here. `permanent: true`
 * does not merely mean "stop retrying": `deliverPendingEmails` turns it into
 * `status: 'bounced'`, which this system defines as *the far side refused this address —
 * the merchant's data problem*, as distinct from `failed` (*we ran out of attempts; usually
 * OUR problem*). So `permanent` is an accusation against the customer's mailbox, and must
 * only be raised when that is genuinely what happened.
 *
 * Two facts about SES make almost every synchronous error NOT that:
 *
 * - **SESv2 `SendEmail` has no per-recipient structure.** The SMTP adapter can key off
 *   nodemailer's `rejected[]` array to tell "this mailbox is bad" from "the relay objected
 *   to the message"; there is no equivalent here. One call, one exception, no indication of
 *   which recipient — if any — was at fault.
 * - **Real SES bounces are asynchronous.** A hard bounce arrives later over SNS from the
 *   configuration set's event destination, not in the `SendEmail` response. A synchronous
 *   throw is therefore nearly always about the ACCOUNT (suspended, paused, sandboxed) or
 *   the IDENTITY (unverified From domain) — our configuration, which a merchant will fix
 *   and which must find the mail still queued when they do.
 *
 * So the default is transient, deliberately, and matches the SMTP adapter's stated
 * trade-off: retrying a permanent failure wastes six attempts, but giving up on a transient
 * one loses the mail. The one exception is the account-level suppression list, below.
 */
export function classifySesError(e: unknown): MailerSendError {
  const err = e as {
    name?: unknown;
    message?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  const name = typeof err?.name === "string" ? err.name : undefined;
  const message = String(err?.message ?? "We could not send the email through SES");
  const status = err?.$metadata?.httpStatusCode;
  const code = name ?? status;

  switch (name) {
    /**
     * Every one of these is a configuration fact about the sending account, not a verdict
     * on the customer's address:
     *   AccountSuspended / SendingPaused — sending is switched off account-wide.
     *   MailFromDomainNotVerified       — the From identity is not verified in this region.
     *                                     The exact analogue of the unverified-domain 550
     *                                     the SMTP classifier already refuses to call a
     *                                     bounce; calling it one here would mark a blameless
     *                                     customer bounced AND discard the queue the moment
     *                                     a merchant saves a From address SES has not
     *                                     verified — the very failure that produces bounces.
     *   NotFound                        — a ConfigurationSetName that does not exist.
     * All stay queued so they resume the moment the setting is corrected.
     */
    case "AccountSuspendedException":
    case "SendingPausedException":
    case "MailFromDomainNotVerifiedException":
    case "NotFoundException":
      return new MailerSendError(message, false, code);

    // Rate and quota. Transient by definition — this is SES asking us to slow down, and the
    // outbox's backoff ladder is exactly the right response.
    case "TooManyRequestsException":
    case "LimitExceededException":
      return new MailerSendError(message, false, code);

    /**
     * Our own malformed request. Retrying identical bytes cannot help — but `permanent`
     * would blame the customer's mailbox for an engine bug, which is worse than six wasted
     * attempts. Left transient so it exhausts its retries and lands as `failed`, which this
     * system already defines as "usually OUR problem" — the correct label for it.
     */
    case "BadRequestException":
      return new MailerSendError(message, false, code);

    /**
     * The only synchronous SES failure that IS about the address.
     *
     * `MessageRejected` is overloaded — it covers invalid content, a sandbox account mailing
     * an unverified recipient, and an address on the account's suppression list (which SES
     * populates from earlier hard bounces and complaints). Only the last is a recipient
     * verdict, and it is the one case where continuing to mail the address is actively
     * harmful to sending reputation.
     *
     * Matched on wording rather than structure, which the SMTP classifier deliberately
     * avoids — but there it had `rejected[]` to key off and here there is nothing else in
     * the response to discriminate on. The trade-off is stated rather than hidden: a
     * reworded AWS message degrades this to "transient", which merely costs retries, and
     * never the other way. The durable fix is SNS bounce/complaint notifications via a
     * configuration set, which is where SES actually reports this; until that exists, this
     * is the only signal we get.
     */
    case "MessageRejected":
      return new MailerSendError(message, /blacklist|suppress/i.test(message), code);
  }

  /**
   * Anything unrecognised — a new SES exception, a network error, a 5xx — is transient.
   *
   * There is deliberately no throttling/5xx branch here: it would return exactly this, and a
   * branch whose arms agree reads as a decision that was made when none was. The single bit
   * this function exists to produce is "did SES refuse this ADDRESS", and for everything
   * outside the cases above the honest answer is no.
   *
   * FAULT, on the other hand, does split here — because a request that never reached SES is
   * a different animal from one SES answered. An SDK network error has no `name` we
   * recognise and no HTTP status at all (`$metadata.httpStatusCode` is undefined), and a 5xx
   * is AWS itself being unavailable. Both mean "stop calling for a moment"; a 4xx with a
   * recognised exception name means SES is up and talking to us.
   */
  const reachedSes = typeof status === "number" && status < 500;
  return new MailerSendError(message, false, code, reachedSes ? "message" : "transport");
}

/**
 * Format an RFC 5322 `From` with a display name.
 *
 * nodemailer did this for the SMTP path; SESv2 takes `FromEmailAddress` as one pre-formatted
 * string, so it has to be done here. Two cases the naive `${name} <${addr}>` gets wrong:
 * a name containing a comma, quote or angle bracket (which must be a quoted-string, or the
 * header parses as several addresses), and a non-ASCII name — SES requires 7-bit ASCII in
 * headers, so it needs an RFC 2047 encoded-word.
 */
export function formatFromAddress(address: string, name?: string | null): string {
  const display = name?.trim();
  if (!display) return address;
  if (/[^\x20-\x7E]/.test(display)) {
    return `=?UTF-8?B?${Buffer.from(display, "utf8").toString("base64")}?= <${address}>`;
  }
  if (/[(),.:;<>@[\]\\"]/.test(display)) {
    return `"${display.replace(/([\\"])/g, "\\$1")}" <${address}>`;
  }
  return `${display} <${address}>`;
}

/**
 * Real SES delivery. The engine never imports the AWS SDK itself — this file is the only
 * place it appears, behind the same `Mailer` boundary the console sink and `SmtpMailer`
 * implement (mirrors the payment-provider rule in src/providers/types.ts).
 *
 * One instance owns one HTTP client with a connection pool, so it is worth caching per
 * business rather than constructing per message; `resolveMailer` in
 * src/modules/emails/mailer-resolver.ts does that. Call `close()` when discarding one.
 */
export class SesMailer implements Mailer {
  readonly kind = "ses" as const;
  /** The SES region this instance sends through — the breaker's dependency identity. */
  readonly target: string;
  private readonly client: SESv2Client;
  private readonly configurationSet: string | null;

  constructor(opts: SesTransportOptions) {
    const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // The endpoint when one is overridden (VPC/FIPS, or the verify suite's local
    // server), else the region — whichever names the thing that can actually be down.
    this.target = opts.endpoint?.trim() || `ses:${opts.region}`;
    this.configurationSet = opts.configurationSet?.trim() || null;
    this.client = new SESv2Client({
      region: opts.region,
      // Passed explicitly rather than left to the default provider chain: a multi-tenant
      // engine must never fall back to the host's ambient instance role and silently send a
      // merchant's mail from the platform's SES account.
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      /**
       * ONE attempt. The SDK retries internally by default (3, with its own backoff), which
       * would be a second, invisible retry ladder nested inside the outbox's — burning the
       * tick's wall-clock budget on one row and making `attempts` in email_messages a lie
       * about how many times we actually hit SES. Retry policy belongs to the outbox.
       */
      maxAttempts: 1,
      requestHandler: { connectionTimeout: timeout, requestTimeout: timeout },
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    });
  }

  async send(msg: OutboundEmail): Promise<SendResult> {
    try {
      return await this.attempt(msg);
    } catch (e) {
      throw classifySesError(e);
    }
  }

  /**
   * Build the RFC 5322 message, then hand SES the bytes.
   *
   * Raw rather than `Content.Simple`, matching what nodemailer's own SES transport does and
   * what tmr_data_service therefore already sends. Simple was fine for a subject and two
   * bodies, but it cannot carry **attachments** — and billing notifications carry the invoice
   * PDF. A transport that quietly dropped the attachment would send an invoice email with no
   * invoice in it, which is worse than not sending at all.
   *
   * MIME is composed by nodemailer's `MailComposer` rather than by hand: boundaries,
   * quoted-printable, base64 line wrapping and header encoding are all places where a
   * hand-rolled builder is wrong in ways that only show up in one mail client.
   *
   * ⚠️ **BCC is passed to SES, never to the composer.** `MailComposer` writes a `Bcc:`
   * header for any `bcc` it is given (see its header list), which would disclose an internal
   * archive address to the customer — the exact leak the SMTP suite asserts against. SES's
   * `Destination.BccAddresses` delivers to them without putting them in the message.
   */
  private async attempt(msg: OutboundEmail): Promise<SendResult> {
    const raw = await this.buildMime(msg);

    const out = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: formatFromAddress(msg.from, msg.fromName),
        Destination: {
          ToAddresses: [msg.to],
          // Empty arrays omitted rather than sent: `Cc: ` is not the same header as no
          // header, and the SMTP path takes the same care.
          ...(msg.cc?.length ? { CcAddresses: msg.cc } : {}),
          // The ONLY place BCC appears. Deliberately not in the MIME above.
          ...(msg.bcc?.length ? { BccAddresses: msg.bcc } : {}),
        },
        ...(this.configurationSet ? { ConfigurationSetName: this.configurationSet } : {}),
        Content: { Raw: { Data: raw } },
      }),
    );
    return { providerMessageId: out.MessageId ?? null, status: "sent" };
  }

  /** The message bytes. Reply-To and our dedupe header ride the MIME, not the API call. */
  private async buildMime(msg: OutboundEmail): Promise<Uint8Array> {
    const composer = new MailComposer({
      from: formatFromAddress(msg.from, msg.fromName),
      to: msg.to,
      ...(msg.cc?.length ? { cc: msg.cc } : {}),
      // NO `bcc` — see the note on attempt().
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      // Our own public id, echoed as a header several ESPs honour for dedupe — the same one
      // the SMTP path sends, so a retry after an ambiguous failure carries the same key.
      ...(msg.idempotencyKey ? { headers: { "X-Entity-Ref-ID": msg.idempotencyKey } } : {}),
      ...(msg.attachments?.length
        ? {
            attachments: msg.attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              contentType: a.contentType ?? "application/pdf",
            })),
          }
        : {}),
    });
    return await composer.compile().build();
  }

  /**
   * There is deliberately NO `verify()` here, and its absence is a decision.
   *
   * It used to call `GetAccount`, which reports sandbox status and quota — genuinely useful,
   * and the one thing this transport could do that SMTP cannot. But `ses:GetAccount` is a
   * SEPARATE IAM permission from `ses:SendRawEmail`, and a key scoped to sending alone —
   * the least-privilege setup, and the one this product asks for — does not carry it.
   *
   * Without that call there is no way to check SES credentials without actually sending, so
   * a "test connection" here could only ever report that it could not test. The test SEND is
   * the honest check, and it is the one the dashboard offers.
   */

  close(): void {
    this.client.destroy();
  }
}
