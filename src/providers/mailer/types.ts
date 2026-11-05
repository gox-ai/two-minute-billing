/**
 * Mailer adapter boundary — the engine never talks to an email transport
 * directly, only through this interface (same rule as payment providers in
 * `src/providers/types.ts`). Swapping console → SMTP → a hosted ESP is a config
 * change, not an engine change.
 */

export interface OutboundEmail {
  to: string;
  from: string;
  fromName?: string | null;
  replyTo?: string | null;
  /**
   * Copy recipients. `cc` is visible to the customer; `bcc` is not. A transport that
   * cannot express them must drop them rather than fold them into `to`, which would
   * disclose an internal archive address to the customer.
   */
  cc?: string[] | null;
  bcc?: string[] | null;
  subject: string;
  html: string;
  text: string;
  /** Correlates the send with the email_messages row (for provider lookups). */
  idempotencyKey?: string;
  /**
   * Files to attach — in practice the invoice or credit-note PDF that billing
   * notifications carry.
   *
   * A transport that cannot express attachments must FAIL rather than silently send the
   * message without them: an invoice email whose invoice is missing is worse than one that
   * did not arrive, because nothing tells the merchant it went out incomplete.
   */
  attachments?: MailAttachment[];
}

export interface MailAttachment {
  /** As the recipient sees it, e.g. `invoice-INV-0001.pdf`. */
  filename: string;
  content: Buffer;
  /** MIME type; defaults to application/pdf at the only call site that exists today. */
  contentType?: string;
}

export interface SendResult {
  /** Provider-side message id, when the transport returns one. */
  providerMessageId: string | null;
  status: "sent";
}

/**
 * A send that failed, with the one thing the outbox cannot work out for itself: whether
 * retrying could ever help.
 *
 * It lives at the adapter boundary because classifying the failure needs transport
 * knowledge — an SMTP 5xx, an ESP's `Permanent` bounce type — and the engine is not allowed
 * to know about either (same rule as payment providers). An adapter that throws a plain
 * `Error` is treated as transient, which is the safe default: retrying a permanent failure
 * wastes six attempts, but giving up on a transient one loses the mail.
 */
export class MailerSendError extends Error {
  constructor(
    message: string,
    /** True when the relay refused in a way that cannot change on a retry. */
    readonly permanent: boolean,
    /** The transport's own code, for the log — an SMTP reply code, or an ESP error id. */
    readonly code?: number | string,
    /**
     * WHOSE fault — the host's, or this message's.
     *
     * `permanent` answers "can a retry help?", which is a question about the MESSAGE.
     * This answers a different and orthogonal one, and the two are independent: a connect
     * timeout is `permanent: false` AND `fault: "transport"`; a 550 to a dead mailbox is
     * `permanent: true` AND `fault: "message"`; an over-quota 452 is transient and the
     * message's problem.
     *
     * ── WHY THE SECOND AXIS EXISTS ──────────────────────────────────────────────────
     * Without it, "this server is unreachable" and "this server did not like this email"
     * arrive as the same shape, so nothing downstream can react differently — and the
     * only sane reaction to a dead host is to STOP CALLING IT. Measured 2026-09-01: one
     * business's SMTP host was unreachable, every attempt paid the full 10s connect
     * timeout, and at ~2,900 messages/day x 6 attempts that demanded ~174,000s of clock
     * time per day against the 86,400s a day contains. Per-message backoff cannot fix a
     * fault that belongs to the relay; a circuit breaker can, and this is the signal it
     * needs. See `platform/circuit-breaker.ts`.
     *
     * Defaults to `"message"`, which is the conservative direction: an adapter that has
     * not been taught the distinction never trips a breaker, so it behaves exactly as it
     * did before rather than silently suppressing sends.
     */
    readonly fault: MailerFault = "message",
  ) {
    super(message);
    this.name = "MailerSendError";
  }
}

/**
 * `transport` — the host did not give us a usable answer: refused, timed out, DNS failed,
 * TLS failed, or rejected our credentials. Retrying THIS message changes nothing, and so
 * does retrying any other message to the same host, until something about the host or the
 * configuration changes.
 *
 * `message` — the host answered and objected to this particular mail (or its recipient).
 * Other messages to the same host may well succeed.
 *
 * EAUTH is deliberately `transport`: it is per-credential, not per-message, so hammering a
 * relay with the wrong password is exactly as pointless as hammering a dead one — and it
 * gets the operator the same "your mail settings are broken" signal either way.
 */
export type MailerFault = "transport" | "message";

export interface Mailer {
  /**
   * `unconfigured` is a real, recorded outcome, not a placeholder: it means a business had no
   * usable transport of its own and the send was refused rather than quietly handed to the
   * platform relay. It is written to `email_messages.transport` so a failed row says so.
   */
  readonly kind: "console" | "smtp" | "esp" | "ses" | "unconfigured";
  /**
   * WHICH remote this instance talks to — `smtp.resend.com:465`, an SES region — or null
   * for a transport that reaches no network at all.
   *
   * Exists so the circuit breaker can key on the dependency INSTANCE rather than on the
   * transport kind. Two businesses on two different relays must fail independently: keying
   * on `kind` alone would let one merchant's dead host silence every SMTP sender on the
   * deployment, which is a worse outage than the one the breaker exists to prevent.
   *
   * **Null means "never breakered", and that is the correct answer for the console sink and
   * the unconfigured refusal** — neither can suffer a transport fault, because neither makes
   * a call. Anything that opens a socket must name what it opened it to.
   */
  readonly target: string | null;
  /**
   * Deliver one message. Throws on a transport failure so the outbox can retry — and
   * should throw {@link MailerSendError} so the outbox can tell "try again in an hour"
   * from "this mailbox does not exist".
   */
  send(msg: OutboundEmail): Promise<SendResult>;
}
