import type { customers } from "@db/schema";
import { billingContact } from "@/modules/customers/names";

type CustomerRow = typeof customers.$inferSelect;

/**
 * The customer's CURRENT address, in the same shape the invoice snapshot uses.
 * Billing lives in flat columns on `customers`, shipping in a jsonb blob, so this
 * is also what normalises the two into one shape for the API.
 */
export function customerBillingAddress(c: CustomerRow) {
  // ⚠️ The three name fields are the BILLING ADDRESS's own contact, not the account
  // holder — this used to read `c.firstName`/`c.lastName`/`c.company`, so an invoice's
  // `billing_address` reported the person who signed up rather than whoever the address
  // is addressed to, on every API response and therefore on the dashboard invoice page.
  // `billingContact` falls back to the account holder when the address has no contact of
  // its own, so the shape never regresses to nulls where it previously had a name.
  //
  // ⚠️ This makes `invoice.billing_address` FALLBACK-APPLIED while `customer.billing_address`
  // (`customers/serialize.ts`) stays RAW. The asymmetry is deliberate — do not "fix" it into
  // consistency. Raw on the customer is what stops the operator edit form prefilling an
  // invented contact and then PERSISTING it on save, because `applyAddress` replaces the whole
  // address rather than patching it (the trap documented at length in `customers/serialize.ts`).
  // Fallback-applied on the invoice is what gets a name onto a printed document that has
  // already been issued and can no longer be corrected.
  const contact = billingContact(c);
  return {
    first_name: contact.first_name,
    last_name: contact.last_name,
    email: c.email ?? null,
    // Phone prefers the ADDRESS's phone: `customers/serialize.ts` already maps
    // `billing_phone` to `address.phone`, so the same key in the same shape must mean the
    // same column or the two reads contradict each other. Falls back to the primary phone
    // so a customer with only that one keeps a phone here.
    //
    // ⚠️ NOT the order the provider path uses. `payment-methods/service.ts` sends
    // `phone ?? billingPhone` because RazorPay's recurring-mandate contact must be the
    // primary number; this is a printed/displayed address, not a gateway contact.
    phone: c.billingPhone ?? c.phone ?? null,
    company: contact.company,
    line1: c.addressLine1 ?? null,
    line2: c.addressLine2 ?? null,
    line3: c.addressLine3 ?? null,
    city: c.city ?? null,
    state: c.state ?? null,
    // The ISO 3166-2 code — what decides place of supply, so it travels with the address.
    state_code: c.stateCode ?? null,
    postal_code: c.postalCode ?? null,
    country: c.country ?? null,
  };
}

/** The buyer registration an invoice prints: GSTIN first, else the EU VAT id. */
export function customerTaxIdOf(c: CustomerRow | null | undefined): string | null {
  return c?.taxRegistrationNumber ?? c?.vatNumber ?? null;
}

/** For a snapshot column: `''` records "none at issue", which NULL ("not recorded") cannot. */
export const frozen = (v: string | null | undefined): string => v?.trim() ?? "";

/** A frozen value back to what readers print: `''` → null, NULL → the live fallback. */
export function fromFrozen<T>(snap: string | null | undefined, live: () => T): string | T | null {
  return snap == null ? live() : snap || null;
}

/** The notes an invoice prints: the customer's own, else the business default. */
export function invoiceNotesOf(
  cus: { invoiceNotes: string | null } | null | undefined,
  biz: { defaultInvoiceNotes: string | null } | null | undefined,
): string | null {
  return cus?.invoiceNotes?.trim() || biz?.defaultInvoiceNotes?.trim() || null;
}
