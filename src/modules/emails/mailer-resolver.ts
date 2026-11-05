import { createHash } from "node:crypto";
import {
  getMailer,
  getMailerOverride,
  SmtpMailer,
  SesMailer,
  NoTransportMailer,
  type Mailer,
} from "@/providers/mailer";
import { resolveSmtpConfig, isSmtpUsable, readSmtpPassword } from "./smtp-config";
import { resolveSesConfig, isSesUsable, readSesSecret } from "./ses-config";
import { createLogger } from "@/platform/logger";
import { resetDependencies } from "@/platform/circuit-breaker";

const log = createLogger("emails.mailer");

/** The business columns this resolver needs. Kept structural so callers can pass a row. */
export interface MailerBusinessRow {
  id: string;
  smtpConfig?: unknown;
  smtpCredentialsEnc?: string | null;
  sesConfig?: unknown;
  sesCredentialsEnc?: string | null;
}

/** The transports worth pooling. Both own sockets, so both must be closed when superseded. */
type PooledMailer = SmtpMailer | SesMailer;

interface CacheEntry {
  fingerprint: string;
  mailer: PooledMailer;
}

/**
 * One pooled SmtpMailer per business, keyed by a fingerprint of its settings so that
 * saving new credentials takes effect on the next send rather than at the next restart —
 * a merchant who fixes a wrong password and watches the queue keep failing would
 * reasonably conclude the feature is broken.
 *
 * The fingerprint is a hash, not the values: this map is long-lived process state and a
 * plaintext SMTP password sitting in it is one heap dump away from being a credential
 * leak, for no benefit over comparing digests.
 */
const cache = new Map<string, CacheEntry>();

/**
 * The transport kind leads every fingerprint, so switching a business from SMTP to SES (or
 * back) can never collide with the settings it replaced — the digest changes even in the
 * degenerate case where both configurations hash their remaining fields identically.
 */
function fingerprint(kind: "smtp" | "ses", parts: readonly (string | number | null)[]): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, ...parts]))
    .digest("base64url");
}

/**
 * The transport that should carry mail for this business.
 *
 * Precedence, highest first:
 *   1. A test override installed via setMailer() — never bypassed, or a verify run would
 *      open real sockets for any business that happens to have a transport configured.
 *   2. The business's own SES settings, when enabled and complete.
 *   3. The business's own SMTP settings, when enabled and complete.
 *   4. Nothing. A business with neither gets a NoTransportMailer that refuses the send.
 *
 * (2) and (3) are mutually exclusive in the database — `businesses_mail_transport_ck`
 * rejects a row with both enabled — so their relative order is a formality rather than a
 * policy. It is fixed and documented anyway, because a row written before that constraint
 * existed must still resolve to the SAME transport on every tick; a resolver that picked
 * non-deterministically would send a business's mail from two different relays.
 *
 * **There is deliberately no fall-through to the deployment mailer here.** A business brings
 * its own transport or its mail does not go out. Handing customer mail to the PLATFORM's relay
 * would send it from the wrong domain, fail the merchant's SPF/DKIM and spend platform
 * reputation on someone else's mail — and it would do all that while reporting success, which
 * is the failure mode this whole area exists to remove. `getMailer()` still serves
 * `resolveMailer(null)`: platform mail (operator invites, password resets) belongs to no tenant
 * and legitimately rides the deployment transport.
 *
 * A business whose own settings fail to decrypt gets the same refusal, with a warning — never
 * an exception, because `deliverPendingEmails` resolves outside its per-row try/catch and one
 * tenant's stale key must not stall the shared billing clock for everyone else.
 */
export function resolveMailer(biz: MailerBusinessRow | null | undefined): Mailer {
  const override = getMailerOverride();
  if (override) return override;
  if (!biz) return getMailer();

  const ses = resolveSesConfig(biz);
  if (isSesUsable(ses, biz.sesCredentialsEnc)) {
    return pooled(biz.id, () => {
      const secret = readSesSecret(biz.sesCredentialsEnc);
      // Decryptable but empty — an access key id with no secret cannot sign a request.
      // Treated exactly like a failed decrypt rather than passed on, because the SDK would
      // otherwise fail at first send with a signing error naming neither the business nor
      // the missing half.
      if (!secret) return null;
      const accessKeyId = ses.accessKeyId as string;
      return {
        fingerprint: fingerprint("ses", [ses.region, ses.configurationSet, accessKeyId, secret]),
        build: () =>
          new SesMailer({
            region: ses.region as string,
            accessKeyId,
            secretAccessKey: secret,
            configurationSet: ses.configurationSet,
          }),
      };
    });
  }

  const cfg = resolveSmtpConfig(biz);
  if (isSmtpUsable(cfg, biz.smtpCredentialsEnc)) {
    return pooled(biz.id, () => {
      const password = readSmtpPassword(biz.smtpCredentialsEnc);
      const host = cfg.host as string;
      const port = cfg.port as number;
      return {
        fingerprint: fingerprint("smtp", [host, port, cfg.encryption, cfg.username, password]),
        build: () =>
          new SmtpMailer({
            host,
            port,
            encryption: cfg.encryption,
            username: cfg.username,
            password,
          }),
      };
    });
  }

  return new NoTransportMailer(
    "No delivery method is configured for this business. Configure SMTP or Amazon SES in " +
      "Settings → Email notifications → Delivery. Until then, emails stay in the queue.",
  );
}

/**
 * Shared cache discipline for both per-business transports: reuse the pooled instance while
 * its settings are unchanged, close the superseded one when they change, and refuse the send
 * if the credentials cannot be read.
 *
 * Factored out so SES and SMTP cannot drift apart on the two details that actually bite —
 * closing the old pool (this runs on every clock tick, so a leak compounds) and turning a
 * decrypt failure into a refused row rather than an exception on the billing clock.
 */
function pooled(
  businessId: string,
  prepare: () => { fingerprint: string; build: () => PooledMailer } | null,
): Mailer {
  let plan: { fingerprint: string; build: () => PooledMailer } | null;
  try {
    plan = prepare();
  } catch (err) {
    log.warn("transport credentials could not be decrypted — refusing to send", {
      businessId,
      error: err instanceof Error ? err.message : String(err),
    });
    return new NoTransportMailer(
      "We could not decrypt the email credentials of this business, so we cannot use the " +
        "configured transport. Enter them again in Settings → Email notifications → Delivery.",
    );
  }
  if (!plan) {
    log.warn("transport credentials are incomplete — refusing to send", { businessId });
    return new NoTransportMailer(
      "The email credentials of this business are incomplete, so we cannot use the configured " +
        "transport. Enter them again in Settings → Email notifications → Delivery.",
    );
  }

  const hit = cache.get(businessId);
  if (hit && hit.fingerprint === plan.fingerprint) return hit.mailer;
  if (hit) hit.mailer.close();

  const mailer = plan.build();
  cache.set(businessId, { fingerprint: plan.fingerprint, mailer });
  return mailer;
}

/**
 * Drop a business's cached transport (call after saving settings, and in tests).
 *
 * Also clears any circuit-breaker verdict against that business's dependencies, and the two
 * belong together for the same reason: the settings just changed, so everything this system
 * believed about the old host is now about a host we are no longer using. A merchant fixing
 * a mistyped port must not then wait out a cooldown to find out whether they got it right —
 * that would present a fixed configuration as still broken, which is the worst possible
 * moment to be wrong.
 *
 * Fire-and-forget on purpose: the caller is a settings save, and a failed cache eviction
 * must not fail the save. The cost of the delete not landing is one cooldown of delay, which
 * is exactly what the behaviour was before this existed.
 */
export function invalidateMailer(businessId: string): void {
  void resetDependencies(businessId).catch(() => {});
  const hit = cache.get(businessId);
  if (!hit) return;
  hit.mailer.close();
  cache.delete(businessId);
}

/** Close every pooled connection. For clean shutdown and between verify suites. */
export function closeAllMailers(): void {
  for (const entry of cache.values()) entry.mailer.close();
  cache.clear();
}
