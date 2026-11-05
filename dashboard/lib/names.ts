/**
 * Which name goes where — the dashboard's copy of the engine's rule.
 *
 * ── THE AUTHORITY IS THE BACKEND ────────────────────────────────────────────────
 * `src/modules/customers/names.ts` is the spec: read its header for the reasoning
 * behind the precedence, and change it there first if the rule ever moves. This file
 * only re-expresses it against the SERIALISED wire shape — snake_case
 * `first_name`/`last_name`/`company` plus a nested `address` carrying the billing
 * contact — because that is what a dashboard component holds.
 *
 * ⚠️ WHY A MIRROR AND NOT A SHARED PACKAGE. The two sides do not agree on field names
 * (`billingFirstName` on the row vs `address.first_name` on the wire), so a shared
 * module would need an adapter at every call site — more code than the twenty lines
 * below, and one more layer to read when a name comes out wrong. `dashboard/` also
 * has no path into `src/`: it is a separate tsconfig with its own `@/` root and ships
 * to a different runtime, so importing across the boundary would drag engine imports
 * (drizzle, the db client) into a client bundle. The duplication is deliberate and
 * bounded; the cost of it drifting is a wrong name on a screen, not a wrong invoice.
 *
 * The two chains deliberately disagree — see the backend note. `invoiceContactName`
 * answers "what is printed on the document", `accountHolderName` answers "who is this
 * person". Do not collapse them.
 *
 * ── `name` IS DEPRECATED (2026-08-23) ───────────────────────────────────────────
 * It is out of both chains here, matching the backend. The wire still CARRIES a
 * `name` key, but it is now derived server-side from `first_name`/`last_name`/
 * `company` — so consulting it in a chain would just re-check fields already checked
 * one line above, and re-adding it would silently reintroduce the email as a "name"
 * on any surface that reads it directly. Prefer these helpers over the raw field.
 */

/** The customer fields these helpers read, as `serializeCustomer` puts them on the wire. */
export interface CustomerNameFields {
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  email?: string | null;
  address?: AddressContactFields | null;
}

/**
 * The contact block of an address. Split out because the operator invoice page holds
 * an invoice's SNAPSHOT address, not a customer — the same three fields, no customer
 * around them.
 */
export interface AddressContactFields {
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
}

const clean = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);

const joined = (first: string | null | undefined, last: string | null | undefined): string | null =>
  clean([clean(first), clean(last)].filter(Boolean).join(" "));

/**
 * The name PRINTED on an invoice, credit note or receipt: the billing address's own
 * contact, then the account holder, then the email.
 *
 * Use this wherever a screen shows the buyer what we bill — "Billed to" on the portal,
 * the invoice document header — so the page and the PDF cannot say different things.
 */
export function invoiceContactName(c: CustomerNameFields): string | null {
  return (
    joined(c.address?.first_name, c.address?.last_name) ??
    clean(c.address?.company) ??
    joined(c.first_name, c.last_name) ??
    clean(c.company) ??
    clean(c.email)
  );
}

/**
 * The name a PERSON is known by — the portal greeting, a header aside, a gateway
 * prefill for the human at the keyboard. Never the billing contact: greeting a buyer
 * as "Accounts Payable" because that is who receives their invoices is a worse error
 * than showing no name at all.
 */
export function accountHolderName(c: CustomerNameFields): string | null {
  return joined(c.first_name, c.last_name) ?? clean(c.company) ?? clean(c.email);
}

/**
 * "First Last" / company — whatever an address's own contact block actually carries,
 * with NO fallback to the customer around it. Used where the address is the subject:
 * an invoice's snapshotted `billing_address`, which must print what was stored on the
 * document, not what the customer looks like today.
 *
 * `lib/api/invoices.ts` re-exports this as `addressName`, its original name.
 */
export function addressContactName(a: AddressContactFields | null | undefined): string | null {
  if (!a) return null;
  return joined(a.first_name, a.last_name) ?? clean(a.company);
}
