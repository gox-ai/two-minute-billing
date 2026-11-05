/**
 * Which name goes where — the ONE place that answers it.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────
 * A customer row carries three overlapping names and we used to resolve them
 * differently in five places: `invoicing/document.ts`, `credit-notes/document.ts`,
 * `emails/adhoc-service.ts`, `invoicing/serialize.ts` and the dashboard's own
 * `addressName`. Divergent copies of a precedence rule are how an invoice prints
 * one name, the email about that invoice greets another, and the vault holds a
 * third. The columns:
 *
 *   name                                  — ⚠️ DEPRECATED 2026-08-23. Nothing in this
 *                                           file reads it any more; see "THE
 *                                           DEPRECATION" below.
 *   first_name / last_name / company       — the ACCOUNT HOLDER
 *   billing_first_name / …_last_name /     — the BILLING CONTACT, i.e. the address's
 *   …_company / …_phone                      own contact
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────
 * A customer with `first_name: Priya, last_name: Raghunathan, company: Kavi Analytics`
 * and `billing_address: {first_name: Accounts, last_name: Payable, company: Kavi
 * Analytics Pvt Ltd}` produces an invoice PDF reading:
 *
 *     BILLED TO
 *     Accounts Payable
 *     Kavi Analytics Pvt Ltd
 *     4 Anna Salai
 *
 * "Priya Raghunathan" appears nowhere on the document: the BILLING ADDRESS CONTACT is
 * the invoice identity and the customer-level name is the account holder (lists,
 * emails, portal greeting). Two further rules shape the fallbacks below: the customer
 * name is never copied into the address (an address saved with no contact stays
 * contact-less), and there is no `customer.name` at all — posting one is silently
 * dropped.
 *
 * ── THE DEPRECATION (2026-08-23) ────────────────────────────────────────────────
 * `customers.name` is gone from every chain below. It was already last in both, never
 * asked for on any form, and measuring the local DB settled the argument: of 4,007
 * customers, 464 had it set, 450 of those had NO structured name at all (i.e. it was
 * populated by our own seeds and test scripts, which reached for it because it was the
 * shortest path through `POST /v1/customers`), it duplicated the derived holder in
 * ZERO rows, and the only 7 rows where it disagreed were one fixture repeated. It
 * carried no operator intent anywhere.
 *
 * A customer is named by `first_name`/`last_name`/`company` — full stop. The column
 * still exists (dropping it is a separate, reversible-only-by-restore decision) and
 * `GET /v1/customers` still emits `name`, but as a READ-ONLY echo of `holderName`
 * below; sending it to a write route is a 400. Do not reintroduce it into a chain.
 *
 * ⚠️ Do not "simplify" these two functions into one. They deliberately disagree:
 * for the customer above, `invoiceContactName` is "Accounts Payable" and
 * `accountHolderName` is "Priya Raghunathan", and each is correct for its surface.
 */

/**
 * The subset of a customer row these helpers read. Deliberately structural rather
 * than `typeof customers.$inferSelect`: the email/outbox paths select a handful of
 * columns, and requiring the whole row would push them into fetching it.
 */
export interface NameFields {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  email?: string | null;
  billingFirstName?: string | null;
  billingLastName?: string | null;
  billingCompany?: string | null;
}

const clean = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);

const joined = (first: string | null | undefined, last: string | null | undefined): string | null =>
  clean([clean(first), clean(last)].filter(Boolean).join(" "));

/**
 * The ACCOUNT HOLDER's structured name, with no email fallback: `first last` →
 * `company` → null.
 *
 * Extracted because three things must agree on exactly this chain and used to state it
 * three times: `accountHolderName` (which adds the email fallback), the `name` echo in
 * `customers/serialize.ts`, and `accountHolderNameSql` — the Postgres mirror that
 * makes the list FILTER match the rendered column. Keep them in step: the SQL one
 * cannot import this, so a change here is a two-file change.
 */
export function holderName(c: NameFields): string | null {
  return joined(c.firstName, c.lastName) ?? clean(c.company);
}

/**
 * The name to PRINT on an invoice, credit note, or receipt — and to hand a gateway
 * as the billing name, since that is the name on the document the payment settles.
 *
 * Billing contact first, then the account holder, then the email.
 * Returns null only for a row with no name and no email at all, which the caller
 * renders as the public id.
 */
export function invoiceContactName(c: NameFields): string | null {
  return (
    joined(c.billingFirstName, c.billingLastName) ??
    clean(c.billingCompany) ??
    holderName(c) ??
    clean(c.email)
  );
}

/**
 * The name a HUMAN OPERATOR recognises this customer by — customer tables, detail
 * headers, search results, the portal greeting, the subject line of mail we send
 * them. Never the billing contact: greeting a buyer as "Accounts Payable" because
 * that is who receives their invoices is a worse error than showing no name.
 */
export function accountHolderName(c: NameFields): string | null {
  return holderName(c) ?? clean(c.email);
}

/**
 * The billing address's own contact block, with the same fallback `invoiceContactName`
 * applies — so a customer who never filled in the address contact still gets their
 * name and company onto the printed document and into the invoice's `billing_address`
 * snapshot, instead of an address with a bare street line.
 *
 * `phone` has no fallback chain here: `billingPhone`/`phone` are read together by the
 * provider path (`payment-methods/service.ts`), which needs the primary phone FIRST
 * for RazorPay's recurring contact requirement — the opposite order. Kept out
 * rather than encoded wrongly.
 */
export function billingContact(c: NameFields): {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
} {
  const hasOwn = Boolean(
    clean(c.billingFirstName) || clean(c.billingLastName) || clean(c.billingCompany),
  );
  if (hasOwn) {
    return {
      first_name: clean(c.billingFirstName),
      last_name: clean(c.billingLastName),
      company: clean(c.billingCompany),
    };
  }
  return {
    first_name: clean(c.firstName),
    last_name: clean(c.lastName),
    company: clean(c.company),
  };
}

/**
 * Does this customer have ANY usable billing name? The buyer-facing gates
 * (`billing_details_complete` on the portal and checkout) used to test
 * `customer.name` specifically, which made our own invented column a hard
 * requirement for card setup — a buyer who filled in First/Last was told their
 * billing details were incomplete.
 */
export function hasBillingName(c: NameFields): boolean {
  return Boolean(
    joined(c.billingFirstName, c.billingLastName) ?? clean(c.billingCompany) ?? holderName(c),
  );
}
