import { config } from "@/platform/config";

/**
 * What will actually carry a business's mail right now, described WITHOUT constructing a
 * transport — this runs on a settings page render, and opening a pooled SMTP connection or
 * an SES client just to describe one would be an odd side effect of looking at a form.
 *
 * `unconfigured` means a transport is selected that will throw on first send.
 */
export type EffectiveTransport = "smtp" | "ses" | "esp" | "console" | "unconfigured";

export interface TransportView {
  effective_transport: EffectiveTransport;
  /**
   * Whether mail actually reaches a relay. False for the console sink — which still marks
   * rows `sent`. A settings screen that shows "sending: on" without this is inviting a
   * merchant to believe their customers are being emailed when nothing is leaving.
   */
  delivers: boolean;
}

/**
 * Shared by every transport settings view, so that the SMTP screen and the SES screen can
 * never give a business two different answers to "what is carrying my mail".
 *
 * This mirrors the precedence in `resolveMailer`, and the two must agree — the whole reason
 * this field exists is that a screen which *guessed* the engine's fallback guessed wrong. It
 * is one function rather than one per screen because the previous shape (a private helper
 * inside smtp-service) was already a copy of the resolver's ladder, and a second copy for
 * SES would have made three places to keep in step.
 */
export function describeTransport(usable: { smtp: boolean; ses: boolean }): TransportView {
  // Business-level transports first, in the resolver's own order.
  if (usable.ses) return { effective_transport: "ses", delivers: true };
  if (usable.smtp) return { effective_transport: "smtp", delivers: true };

  switch (config.MAILER_PROVIDER) {
    case "smtp":
      return config.SMTP_HOST
        ? { effective_transport: "smtp", delivers: true }
        : { effective_transport: "unconfigured", delivers: false };
    case "ses":
      // Both halves of the key, matching the guard in getMailer(): a key id with no secret
      // builds an UnconfiguredMailer that throws, which delivers nothing.
      return config.AWS_EMAIL_KEY && config.AWS_EMAIL_SECRET
        ? { effective_transport: "ses", delivers: true }
        : { effective_transport: "unconfigured", delivers: false };
    case "esp":
      // Still a stub that throws, so it delivers nothing despite being selected.
      return { effective_transport: "unconfigured", delivers: false };
    default:
      return { effective_transport: "console", delivers: false };
  }
}
