/**
 * The payer's ACH debit authorization, for gateways that leave it to the merchant
 * (`achAuthorization: "ours"`, Authorize.net eCheck). The storefront shows the text the
 * engine renders here; the payer accepts it with a checkbox; the engine renders the same
 * version again and stores it with the payment method (`payment_method_authorizations`).
 *
 * A change to the words is a new VERSION: stored rows keep the text they were shown.
 */
import { paymentMethodAuthorizations } from "@db/schema";
import { publicId } from "@/platform/ids";
import type { Tx } from "@/platform/db";

/** Bump on every change to the words below. */
// 2026-10-29: with no business email, the cancel sentence names the portal only.
export const ACH_AUTHORIZATION_TEXT_VERSION = "ach-debit-2026-10-29";

/** Days of notice before a debit whose amount differs from the last one (Reg E 1005.10(d)). */
export const ACH_VARYING_AMOUNT_NOTICE_DAYS = 10;

/** Business days before the next debit that a cancellation must reach the business. */
export const ACH_REVOCATION_LEAD_BUSINESS_DAYS = 3;

export interface AchAuthorizationParties {
  businessName: string;
  /** Where the payer contacts the business to cancel. */
  businessEmail?: string | null;
  payerName: string;
  payerEmail?: string | null;
}

export interface AchAuthorizationText {
  version: string;
  title: string;
  paragraphs: string[];
  /** The checkbox label. */
  agreement: string;
}

/** The text a payer reads, in ASD-STE100. */
export function achAuthorizationText(p: AchAuthorizationParties): AchAuthorizationText {
  const biz = p.businessName.trim() || "The business";
  const notice = p.payerEmail?.trim()
    ? `${biz} sends a notice to ${p.payerEmail.trim()}`
    : `${biz} sends a notice to my email address`;
  // Without an email, "I tell <business>" gives the payer no way to do it.
  const cancel = p.businessEmail?.trim()
    ? `To cancel it, I tell ${biz} at ${p.businessEmail.trim()}, or I remove this bank account in my billing portal.`
    : "To cancel it, I remove this bank account in my billing portal.";
  return {
    version: ACH_AUTHORIZATION_TEXT_VERSION,
    title: "Bank account debit authorization",
    paragraphs: [
      `I authorize ${biz} to debit the bank account that I enter in the next step. ${biz} makes an ACH debit for each invoice of my subscription, on or after the date of the invoice.`,
      `Each debit is the amount due on the invoice. This amount can change from one invoice to the next. If a debit is different from the last debit, ${notice} at least ${ACH_VARYING_AMOUNT_NOTICE_DAYS} days before the debit. The notice gives the amount and the date.`,
      `If my bank returns a debit unpaid, ${biz} can try the debit again.`,
      `This authorization stays in effect until I cancel it. ${cancel} I must do this at least ${ACH_REVOCATION_LEAD_BUSINESS_DAYS} business days before the next debit.`,
      "I am an owner of this bank account, or I have the right to authorize debits from it.",
    ],
    agreement: `I, ${p.payerName.trim() || "the account holder"}, agree to this debit authorization.`,
  };
}

/** The stored form: title, paragraphs and agreement, one per line block. */
export function achAuthorizationFullText(t: AchAuthorizationText): string {
  return [t.title, ...t.paragraphs, t.agreement].join("\n\n");
}

/** What the storefront sends back: the version it showed, accepted. */
export interface AchAuthorizationAcceptance {
  textVersion: string;
  /** From the payer's request: never the Next server's. */
  ipAddress: string | null;
  userAgent: string | null;
  acceptedAt?: Date;
}

/** The evidence `persistVaultedPaymentMethod` writes, rendered by the caller. */
export interface AchAuthorizationEvidence {
  textVersion: string;
  text: string;
  acceptedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  payerName: string | null;
  payerEmail: string | null;
}

export class AchAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AchAuthorizationError";
  }
}

/** Render the accepted version for these parties, or refuse a version we no longer show. */
export function achAuthorizationEvidence(
  acceptance: AchAuthorizationAcceptance,
  parties: AchAuthorizationParties,
): AchAuthorizationEvidence {
  if (acceptance.textVersion !== ACH_AUTHORIZATION_TEXT_VERSION)
    throw new AchAuthorizationError(
      "The bank debit authorization changed. Read the new authorization and accept it again.",
    );
  return {
    textVersion: ACH_AUTHORIZATION_TEXT_VERSION,
    text: achAuthorizationFullText(achAuthorizationText(parties)),
    acceptedAt: acceptance.acceptedAt ?? new Date(),
    ipAddress: acceptance.ipAddress,
    userAgent: acceptance.userAgent?.slice(0, 500) ?? null,
    payerName: parties.payerName.trim() || null,
    payerEmail: parties.payerEmail?.trim() || null,
  };
}

/** Append one evidence row. Called inside the transaction that writes the payment method. */
export async function insertAchAuthorization(
  tx: Tx,
  row: {
    organizationId: string;
    businessId: string;
    customerId: string;
    paymentMethodId: string;
    paymentMethodPublicId: string;
    gatewayKey: string;
    methodType: string;
    evidence: AchAuthorizationEvidence;
  },
): Promise<string> {
  const id = publicId("pma");
  const e = row.evidence;
  await tx.insert(paymentMethodAuthorizations).values({
    organizationId: row.organizationId,
    businessId: row.businessId,
    publicId: id,
    paymentMethodId: row.paymentMethodId,
    paymentMethodPublicId: row.paymentMethodPublicId,
    customerId: row.customerId,
    gatewayKey: row.gatewayKey,
    methodType: row.methodType,
    textVersion: e.textVersion,
    text: e.text,
    acceptedAt: e.acceptedAt,
    ipAddress: e.ipAddress,
    userAgent: e.userAgent,
    payerName: e.payerName,
    payerEmail: e.payerEmail,
  });
  return id;
}
