import type { SesSettings, SmtpSettings } from "@/lib/api/emails";

/**
 * The one reading of "what carries this business's mail", shared by the delivery hub and the
 * three pages under it.
 *
 * It exists because the answer is derived from two independent resources (`smtp_config` and
 * `ses_config`) and four screens now ask it. When the hub owned the whole form it could
 * compute this inline; split across routes, four separate derivations would be four chances
 * to disagree about which relay is live — the exact drift the engine's
 * `describeTransport()` was added to prevent on its own side.
 */

export type TransportId = "smtp" | "ses";

/**
 * Which transport this business has selected, or null when it has selected none.
 *
 * Null is NOT "the platform relay". There is no such setting for a business: customer mail
 * on the platform's own domain would fail the merchant's SPF/DKIM and spend the platform's
 * sending reputation, so a business with neither is an unfinished setup and every screen
 * says so rather than naming a fallback that is not a choice anyone made.
 */
export function activeTransport(smtp: SmtpSettings, ses: SesSettings): TransportId | null {
  return ses.enabled ? "ses" : smtp.enabled ? "smtp" : null;
}

export const TRANSPORT_LABEL: Record<TransportId, string> = {
  smtp: "SMTP server",
  ses: "Amazon SES",
};

/** The identifying detail, or null when the transport has never been filled in. */
export function transportDetail(id: TransportId, smtp: SmtpSettings, ses: SesSettings) {
  if (id === "ses") return ses.region;
  return smtp.host ? (smtp.port ? `${smtp.host}:${smtp.port}` : smtp.host) : null;
}

/**
 * Whether the credentials for a transport are complete enough for the engine to accept an
 * activation. Mirrors the checks in `saveSmtpSettings` / `saveSesSettings` — the engine
 * validates again and is the authority, so this only ever decides what a screen SAYS, never
 * whether a save is allowed.
 */
export function transportReady(id: TransportId, smtp: SmtpSettings, ses: SesSettings) {
  return id === "ses"
    ? Boolean(ses.region && ses.access_key_id && ses.secret_configured)
    : Boolean(smtp.host && smtp.port && smtp.password_configured);
}

export function deliveryCrumbs(biz: string) {
  return [
    { label: "Settings", href: `/businesses/${biz}/settings` },
    { label: "Email notifications", href: `/businesses/${biz}/settings/emails` },
    { label: "Delivery", href: `/businesses/${biz}/settings/emails/delivery` },
  ];
}
