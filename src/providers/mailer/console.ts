import { setTimeout as sleep } from "node:timers/promises";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";
import type { Mailer, OutboundEmail, SendResult } from "./types";

const log = createLogger("mailer.console");

/**
 * Dev sink: logs the message and succeeds. The email_messages row is the record
 * of truth (rendered subject/body persisted at enqueue), so tests and the
 * dashboard read the DB, not the transport. No network, no dependency.
 *
 * NOTHING IS DELIVERED HERE. The row still ends up `status: 'sent'`, because from the
 * outbox's point of view the transport accepted it and there is nothing to retry — which
 * is precisely why `email_messages.transport` exists to record that it was this sink and
 * not a relay. Read the two columns together; `sent` alone does not mean a customer got
 * anything. The log line below is worded to match.
 */
export class ConsoleMailer implements Mailer {
  readonly kind = "console" as const;
  /** Reaches no network, so it can never suffer a transport fault. Never breakered. */
  readonly target = null;

  async send(msg: OutboundEmail): Promise<SendResult> {
    // Stand-in for a relay's response time in load tests (scripts/loadtest); 0 by default.
    if (config.MAILER_CONSOLE_DELAY_MS > 0) await sleep(config.MAILER_CONSOLE_DELAY_MS);
    log.log("[mailer:console] email written to dev sink — NOT delivered", {
      to: msg.to,
      from: msg.from,
      // Logged so a merchant testing CC/BCC against the dev sink can see they were
      // resolved. Omitted when empty rather than logged as [] — an empty key reads as
      // "we tried and got nothing" instead of "not configured".
      ...(msg.cc?.length ? { cc: msg.cc } : {}),
      ...(msg.bcc?.length ? { bcc: msg.bcc } : {}),
      subject: msg.subject,
      chars: msg.html.length,
      // A local stack has no inbox: show the body so its links can be followed.
      ...(config.MAILER_CONSOLE_BODY === "TRUE" ? { text: msg.text } : {}),
    });
    return { providerMessageId: null, status: "sent" };
  }
}
