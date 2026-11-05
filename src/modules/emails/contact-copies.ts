/**
 * A customer's additional contacts who get a copy of an email, as CC.
 *
 * Read when the message is queued and stored on the row with the To address, so a resend
 * goes to the same people and the log says who received it. Suppressed addresses are
 * dropped again at delivery.
 */
import { and, eq } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { contacts, customers } from "@db/schema";
import { EMAIL_AUDIENCE, EMAIL_DOCUMENT, type EmailType } from "./config";

/** Case-insensitive de-duplication, dropping anything in `exclude`. */
export function uniqueAddresses(list: string[], exclude: string[] = []): string[] {
  const seen = new Set(exclude.map((e) => e.trim().toLowerCase()));
  const out: string[] = [];
  for (const raw of list) {
    const a = raw.trim();
    if (!a || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a);
  }
  return out;
}

export async function contactCopies(
  tx: Tx,
  customerId: string,
  type: EmailType,
  toAddress: string,
): Promise<string[]> {
  const flag =
    EMAIL_AUDIENCE[type] === "billing" ? contacts.sendBillingEmail : contacts.sendAccountEmail;
  const rows = await tx
    .select({ email: contacts.email })
    .from(contacts)
    .where(and(eq(contacts.customerId, customerId), eq(contacts.enabled, true), eq(flag, true)));
  return uniqueAddresses(
    rows.map((r) => r.email),
    [toAddress],
  );
}

/**
 * Everyone copied on one email: the contacts above, plus the customer's own CC and BCC lists
 * (0486) on the emails about an invoice or credit note (invoices, receipts, payment notices).
 * BCC drops anyone already in To or CC.
 */
export async function customerCopies(
  tx: Tx,
  customerId: string,
  type: EmailType,
  toAddress: string,
): Promise<{ cc: string[]; bcc: string[] }> {
  const fromContacts = await contactCopies(tx, customerId, type, toAddress);
  if (!EMAIL_DOCUMENT[type]) return { cc: fromContacts, bcc: [] };
  const [c] = await tx
    .select({ cc: customers.billingCcEmails, bcc: customers.billingBccEmails })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  const cc = uniqueAddresses([...fromContacts, ...(c?.cc ?? [])], [toAddress]);
  return { cc, bcc: uniqueAddresses(c?.bcc ?? [], [toAddress, ...cc]) };
}
