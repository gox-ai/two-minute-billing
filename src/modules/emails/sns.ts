/**
 * Amazon SNS message verification and SES event parsing.
 *
 * This endpoint is PUBLIC and unauthenticated — AWS posts to it with no shared secret, the
 * same shape as the gateway webhooks. Authenticity therefore comes entirely from the
 * signature, and the stakes are concrete: a forged "bounce" would mark a real customer's
 * address permanently undeliverable and suppress every future invoice to them. Silently, and
 * from anyone on the internet who knows the URL.
 *
 * Kept free of database and network I/O except the one certificate fetch, so the whole
 * verification path is unit-testable against hand-built messages.
 */
import { createVerify, createPublicKey, type KeyObject } from "node:crypto";
import { createLogger } from "@/platform/logger";

const log = createLogger("emails.sns");

/** SNS message types we may receive on a topic subscription. */
export type SnsMessageType =
  | "SubscriptionConfirmation"
  | "Notification"
  | "UnsubscribeConfirmation";

export interface SnsEnvelope {
  Type: SnsMessageType;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL?: string;
  SigningCertUrl?: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
}

export class SnsVerificationError extends Error {}

/**
 * The fields that are signed, IN ORDER, per message type.
 *
 * Order and membership are part of the signature, not a convenience: SNS builds the string
 * as `Key\nValue\n` for exactly these keys in exactly this sequence. Getting either wrong
 * produces a verification failure that looks like a forged message, which is the confusing
 * direction to fail in.
 */
const SIGNED_FIELDS: Record<SnsMessageType, readonly string[]> = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: [
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ],
  UnsubscribeConfirmation: [
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ],
};

/** `Key\nValue\n` for each signed field that is PRESENT. Absent optional fields are skipped. */
export function canonicalStringToSign(msg: SnsEnvelope): string {
  const fields = SIGNED_FIELDS[msg.Type];
  if (!fields) throw new SnsVerificationError(`Unknown SNS message type: ${msg.Type}`);
  let out = "";
  for (const key of fields) {
    const value = (msg as unknown as Record<string, unknown>)[key];
    // `Subject` is genuinely optional on a Notification and is omitted from the string when
    // absent — including it as an empty value would break every unsubjected message.
    if (value === undefined || value === null) continue;
    out += `${key}\n${String(value)}\n`;
  }
  return out;
}

/**
 * Is this a certificate URL AWS could actually have served?
 *
 * THE critical check, and the reason this is a function with its own tests. The envelope
 * names its own signing certificate, so an attacker who could point that at a host they
 * control would simply sign their forgery with their own key and we would happily verify it.
 * The signature is only worth as much as the constraint on where the key came from.
 *
 * Requires HTTPS and an `sns.<region>.amazonaws.com` host — anchored at both ends, because
 * `sns.us-east-1.amazonaws.com.evil.test` and `evilsns.us-east-1.amazonaws.com` both contain
 * the pattern. The `.com.cn` suffix covers the China partitions, which are legitimate AWS.
 */
export function isTrustedSigningCertUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(url.hostname);
}

/**
 * Fetch and cache a signing certificate.
 *
 * Cached because AWS rotates these rarely and a bounce storm would otherwise fetch the same
 * PEM thousands of times. Keyed by the full URL, so a rotation (a new filename) is a cache
 * miss rather than a stale key — there is no expiry to get wrong.
 */
const certCache = new Map<string, KeyObject>();

async function publicKeyFor(certUrl: string): Promise<KeyObject> {
  const hit = certCache.get(certUrl);
  if (hit) return hit;
  const res = await fetch(certUrl);
  if (!res.ok) throw new SnsVerificationError(`Could not fetch SNS signing cert (${res.status})`);
  const pem = await res.text();
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch (e) {
    throw new SnsVerificationError(
      `SNS signing cert is not a usable certificate: ${(e as Error).message}`,
    );
  }
  certCache.set(certUrl, key);
  return key;
}

/** Exported for tests: drop the cached certs. */
export function __clearSnsCertCache(): void {
  certCache.clear();
}

/**
 * Verify an SNS envelope, or throw.
 *
 * `SignatureVersion` selects the digest — 1 is SHA1, 2 is SHA256. Both are accepted because
 * AWS still emits 1 on long-lived topics, but an unrecognised version is REFUSED rather than
 * defaulted: silently treating an unknown version as SHA1 is how a downgrade gets accepted.
 */
export async function verifySnsMessage(
  msg: SnsEnvelope,
  opts: { fetchKey?: (url: string) => Promise<KeyObject> } = {},
): Promise<void> {
  const certUrl = msg.SigningCertURL ?? msg.SigningCertUrl;
  if (!isTrustedSigningCertUrl(certUrl)) {
    throw new SnsVerificationError(`Untrusted SNS signing certificate URL: ${certUrl ?? "(none)"}`);
  }
  const algorithm =
    msg.SignatureVersion === "1" ? "RSA-SHA1" : msg.SignatureVersion === "2" ? "RSA-SHA256" : null;
  if (!algorithm) {
    throw new SnsVerificationError(`Unsupported SNS SignatureVersion: ${msg.SignatureVersion}`);
  }
  if (!msg.Signature) throw new SnsVerificationError("SNS message carries no signature");

  const key = await (opts.fetchKey ?? publicKeyFor)(certUrl!);
  const verifier = createVerify(algorithm);
  verifier.update(canonicalStringToSign(msg), "utf8");
  if (!verifier.verify(key, msg.Signature, "base64")) {
    throw new SnsVerificationError("SNS signature does not match");
  }
}

// ── SES event payloads ────────────────────────────────────────────────────────

/** What we do with one SES notification, once parsed. */
export interface SesFeedback {
  kind: "bounce" | "complaint" | "delivery";
  /** SES's own id for the message — matches `email_messages.provider_message_id`. */
  providerMessageId: string | null;
  /** The addresses this feedback is ABOUT (a message may have several recipients). */
  recipients: string[];
  /**
   * Whether the address should be suppressed. Only a PERMANENT bounce and a complaint
   * qualify: a transient bounce is a full mailbox or a greylist, and suppressing on one
   * would stop mailing a working address for ever over a temporary condition.
   */
  suppress: boolean;
  /** `permanent` | `transient` | `undetermined` | `complaint`, for email_messages.bounce_type. */
  bounceType: "permanent" | "transient" | "undetermined" | "complaint" | null;
  /** The provider's own words, kept verbatim for the operator. */
  detail: string | null;
}

/**
 * Parse the SES payload carried inside `SnsEnvelope.Message`.
 *
 * Handles BOTH shapes AWS emits, which is not defensive coding but a fact about the service:
 * an SNS destination configured directly on an identity sends `notificationType`, while a
 * configuration-set event destination sends `eventType`. The same account routinely produces
 * both, and a parser that knew only one would silently ignore half the feedback.
 *
 * Returns null for anything that is not feedback about delivery (opens, clicks, sends).
 */
export function parseSesFeedback(raw: string): SesFeedback | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    log.warn("SES notification body was not JSON");
    return null;
  }
  const type = String(payload.notificationType ?? payload.eventType ?? "").toLowerCase();
  const mail = payload.mail as { messageId?: string } | undefined;
  const providerMessageId = typeof mail?.messageId === "string" ? mail.messageId : null;

  if (type === "bounce") {
    const bounce = payload.bounce as
      | {
          bounceType?: string;
          bounceSubType?: string;
          bouncedRecipients?: { emailAddress?: string }[];
        }
      | undefined;
    const severity = String(bounce?.bounceType ?? "").toLowerCase();
    const bounceType =
      severity === "permanent"
        ? "permanent"
        : severity === "transient"
          ? "transient"
          : "undetermined";
    return {
      kind: "bounce",
      providerMessageId,
      recipients: (bounce?.bouncedRecipients ?? [])
        .map((r) => r.emailAddress)
        .filter((a): a is string => typeof a === "string" && a.length > 0),
      // ONLY permanent. See SesFeedback.suppress.
      suppress: bounceType === "permanent",
      bounceType,
      detail: bounce?.bounceSubType
        ? `${bounce.bounceType}/${bounce.bounceSubType}`
        : (bounce?.bounceType ?? null),
    };
  }

  if (type === "complaint") {
    const complaint = payload.complaint as
      | { complainedRecipients?: { emailAddress?: string }[]; complaintFeedbackType?: string }
      | undefined;
    return {
      kind: "complaint",
      providerMessageId,
      recipients: (complaint?.complainedRecipients ?? [])
        .map((r) => r.emailAddress)
        .filter((a): a is string => typeof a === "string" && a.length > 0),
      // A complaint always suppresses: the address works, the person does not want the mail,
      // and continuing is what gets a sending domain blocklisted.
      suppress: true,
      bounceType: "complaint",
      detail: complaint?.complaintFeedbackType ?? "complaint",
    };
  }

  if (type === "delivery") {
    return {
      kind: "delivery",
      providerMessageId,
      recipients: [],
      suppress: false,
      bounceType: null,
      detail: null,
    };
  }

  return null;
}
