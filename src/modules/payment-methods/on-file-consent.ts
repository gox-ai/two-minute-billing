/**
 * The payer's consent to keep a payment method for later charges, given while they pay
 * (portal Pay now, "Save this card for future payments"). Card networks, PayPal and RBI's
 * card-on-file rules want the payer told when the method is charged, how the amount is set
 * and how to stop it. Stored like the ACH authorization: the exact text shown, its version,
 * when and from where (`payment_method_authorizations`). A change to the words is a new
 * VERSION.
 */
import type { AchAuthorizationEvidence } from "./ach-authorization";

/** Bump on every change to the words below. */
export const ON_FILE_CONSENT_TEXT_VERSION = "on-file-2026-11-19";

/** The text a payer reads under the box, in ASD-STE100. */
export function onFileConsentText(businessName: string): string {
  const biz = businessName.trim() || "The business";
  return (
    `${biz} keeps this payment method for your future invoices. ` +
    `${biz} charges it on or after the date of each invoice, for the amount due on the invoice. ` +
    "You can delete it in your billing portal at any time."
  );
}

/** What the portal sends back: the version it showed, accepted. */
export interface OnFileConsentAcceptance {
  textVersion: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export class OnFileConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnFileConsentError";
  }
}

/** Render the accepted version for this business, or refuse a version we no longer show. */
export function onFileConsentEvidence(
  acceptance: OnFileConsentAcceptance,
  parties: { businessName: string; payerName: string | null; payerEmail: string | null },
  now: Date = new Date(),
): AchAuthorizationEvidence {
  if (acceptance.textVersion !== ON_FILE_CONSENT_TEXT_VERSION)
    throw new OnFileConsentError(
      "The text about saving your payment method changed. Read it again, then pay.",
    );
  return {
    textVersion: ON_FILE_CONSENT_TEXT_VERSION,
    text: onFileConsentText(parties.businessName),
    acceptedAt: now,
    ipAddress: acceptance.ipAddress,
    userAgent: acceptance.userAgent?.slice(0, 500) ?? null,
    payerName: parties.payerName?.trim() || null,
    payerEmail: parties.payerEmail?.trim() || null,
  };
}

/** `payment_intents.save_consent` holds the evidence as JSON; dates as ISO strings. */
export function consentFromJson(raw: unknown): AchAuthorizationEvidence | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.textVersion !== "string" || typeof r.text !== "string") return null;
  return {
    textVersion: r.textVersion,
    text: r.text,
    acceptedAt: new Date(String(r.acceptedAt)),
    ipAddress: typeof r.ipAddress === "string" ? r.ipAddress : null,
    userAgent: typeof r.userAgent === "string" ? r.userAgent : null,
    payerName: typeof r.payerName === "string" ? r.payerName : null,
    payerEmail: typeof r.payerEmail === "string" ? r.payerEmail : null,
  };
}
