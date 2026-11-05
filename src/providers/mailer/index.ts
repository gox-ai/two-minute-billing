import { config } from "@/platform/config";
import type { Mailer } from "./types";
import { ConsoleMailer } from "./console";
import { SmtpMailer } from "./smtp";
import { SesMailer } from "./ses";

export type { Mailer, OutboundEmail, SendResult, MailAttachment } from "./types";
export { MailerSendError } from "./types";
import { MailerSendError } from "./types";
export {
  SmtpMailer,
  classifySmtpError,
  type SmtpEncryption,
  type SmtpTransportOptions,
} from "./smtp";
export { SesMailer, classifySesError, formatFromAddress, type SesTransportOptions } from "./ses";

/**
 * Not-yet-wired transports. They exist so `MAILER_PROVIDER` can name them and the
 * failure is an explicit, actionable config error rather than a silent no-send.
 * Implement `send` against a hosted ESP SDK when the operator wires one; the rest of the
 * pipeline is transport-agnostic. (`smtp` is implemented — see ./smtp.ts.)
 */
class UnconfiguredMailer implements Mailer {
  constructor(
    readonly kind: "smtp" | "esp" | "ses",
    private readonly why: string,
  ) {}
  /** Refuses before opening a socket, so there is no remote to hold responsible. */
  readonly target = null;
  async send(): Promise<never> {
    throw new Error(this.why);
  }
}

/**
 * A business with no usable transport of its own.
 *
 * This is what `resolveMailer` returns instead of the deployment mailer, and the distinction is
 * the whole point: customer mail sent through the PLATFORM's relay would carry the wrong sending
 * domain, fail the merchant's SPF/DKIM, and spend the platform's sending reputation on someone
 * else's mail. Silently succeeding that way is worse than not sending.
 *
 * It refuses at `send()` rather than at resolve time on purpose. `deliverPendingEmails` resolves
 * the transport OUTSIDE its per-row try/catch, so throwing during resolution would abort the whole
 * pass and stall every other tenant's queue — the exact failure the decrypt-fallback path was
 * written to avoid. Refusing inside `send()` makes it one ordinary failed row.
 *
 * The refusal is TRANSIENT (`permanent: false`), which matters: `permanent` becomes `bounced`,
 * meaning "the far side refused this address". The customer's mailbox is blameless here — this is
 * our configuration — so the mail stays queued and goes out once a transport is set up.
 */
export class NoTransportMailer implements Mailer {
  readonly kind = "unconfigured" as const;
  /** Refuses before opening a socket, so there is no remote to hold responsible. */
  readonly target = null;
  constructor(private readonly why: string) {}
  async send(): Promise<never> {
    throw new MailerSendError(this.why, false, "no_transport");
  }
}

let cached: Mailer | null = null;
let override: Mailer | null = null;

/**
 * The test override, if one is installed. Exposed so the per-business resolver
 * (src/modules/emails/mailer-resolver.ts) can honour it: without this, a business with
 * its own SMTP settings would build a real SmtpMailer and try to open a socket in the
 * middle of a verify run, silently escaping the capturing fake.
 */
export function getMailerOverride(): Mailer | null {
  return override;
}

/** The deployment-wide mailer (singleton). Selected by MAILER_PROVIDER (default console). */
export function getMailer(): Mailer {
  if (override) return override;
  if (cached) return cached;
  switch (config.MAILER_PROVIDER) {
    case "smtp":
      // Selected but unusable is a config error, not a silent fallback to the dev sink:
      // falling back would be indistinguishable from working, which is the exact failure
      // this whole change exists to remove.
      cached = config.SMTP_HOST
        ? new SmtpMailer({
            host: config.SMTP_HOST,
            port: config.SMTP_PORT,
            encryption: config.SMTP_ENCRYPTION,
            username: config.SMTP_USERNAME ?? null,
            password: config.SMTP_PASSWORD ?? null,
          })
        : new UnconfiguredMailer(
            "smtp",
            "MAILER_PROVIDER='smtp' is selected but SMTP_HOST is not set. Set SMTP_HOST/SMTP_PORT/" +
              "SMTP_USERNAME/SMTP_PASSWORD, or set MAILER_PROVIDER=console for local/dev.",
          );
      break;
    case "ses":
      // Same rule as `smtp` above: selected but unusable is a config error, never a silent
      // fallback to the dev sink. Both keys are required together — a key id with no secret
      // is a half-pasted credential, and the SDK would fail at first send with a signing
      // error that says nothing about which half is missing.
      cached =
        config.AWS_EMAIL_KEY && config.AWS_EMAIL_SECRET
          ? new SesMailer({
              region: config.AWS_EMAIL_REGION,
              accessKeyId: config.AWS_EMAIL_KEY,
              secretAccessKey: config.AWS_EMAIL_SECRET,
              configurationSet: config.AWS_EMAIL_CONFIGURATION_SET ?? null,
            })
          : new UnconfiguredMailer(
              "ses",
              "MAILER_PROVIDER='ses' is selected but AWS_EMAIL_KEY / AWS_EMAIL_SECRET are not both set. " +
                "Set them (plus AWS_EMAIL_REGION), or set MAILER_PROVIDER=console for local/dev.",
            );
      break;
    case "esp":
      cached = new UnconfiguredMailer(
        "esp",
        "MAILER_PROVIDER='esp' is selected but that transport is not wired yet. " +
          "Set MAILER_PROVIDER=ses (with AWS_EMAIL_KEY/AWS_EMAIL_SECRET), =smtp (with SMTP_HOST) " +
          "or =console, or implement src/providers/mailer/esp.ts for a different provider.",
      );
      break;
    case "console":
    default:
      cached = new ConsoleMailer();
  }
  return cached;
}

/**
 * Test seam: override the mailer (e.g. a capturing fake in verify:emails). Takes
 * precedence over BOTH the MAILER_PROVIDER singleton and any per-business SMTP settings,
 * so a test never opens a real socket. Pass null to restore normal resolution.
 */
export function setMailer(m: Mailer | null): void {
  override = m;
  // Drop the memoised singleton too, so restoring (null) re-reads MAILER_PROVIDER rather
  // than handing back an instance built before the test changed config.
  if (!m) cached = null;
}
