/**
 * The text a storefront action shows for a refused engine call. Pure, so the root unit
 * suite pins it.
 *
 * Never an HTTP status line ("Bad Gateway") and never the engine's 500 text: for those it
 * returns undefined, and each action's own "We could not …" sentence applies.
 */

/** The engine's error envelope, as far as a storefront reads it. */
export interface StorefrontErrorBody {
  error?: { message?: string; details?: Record<string, string[] | undefined> };
}

/** Labels for the request fields a buyer form sends, as the form names them. */
const FIELD_LABELS: Record<string, string> = {
  email: "Email",
  name: "Name",
  first_name: "First name",
  last_name: "Last name",
  company: "Company",
  phone: "Phone",
  address: "Billing address",
  billing_address: "Billing address",
  shipping_address: "Shipping address",
  tax_registration_number: "Tax ID",
  po_number: "PO number",
  postal_code: "Postal code",
  state: "State",
  state_code: "State",
  city: "City",
  country: "Country",
  line1: "Address line 1",
  line2: "Address line 2",
  line3: "Address line 3",
};

/** The label a buyer reads for a request field: the form's name, else the key in words. */
export function fieldLabel(key: string): string {
  const known = FIELD_LABELS[key];
  if (known) return known;
  const words = key.split(/[._]/).filter(Boolean).join(" ");
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

/**
 * `labels`: name each field reason (checkout, where a reason may not name its field), or
 * show the reasons alone (portal, where each reason names its field).
 */
export function storefrontErrorText(
  status: number,
  body: unknown,
  labels: boolean,
): string | undefined {
  if (status >= 500) return undefined;
  const payload = (body as StorefrontErrorBody | undefined)?.error;
  const reasons = Object.entries(payload?.details ?? {}).flatMap(([field, msgs]) =>
    (msgs ?? []).map((m) => (labels ? `${fieldLabel(field)}: ${m}` : m)),
  );
  if (reasons.length) return reasons.join("; ");
  const message = payload?.message?.trim();
  return message || undefined;
}
