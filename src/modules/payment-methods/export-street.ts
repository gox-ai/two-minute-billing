/** Pure: what line 1 a gateway gets when the business fills it. No imports, so tests can load it. */

interface AddressColumns {
  country: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}

/**
 * Line 1 for the gateway when the business fills it (`storefront_config.fill_export_street`): the
 * buyer is outside `fillHome` and gave no street, so their city and state stand in (the postal
 * code fills both), else the postal code. Undefined = send what the buyer typed. Our own record
 * always keeps what the buyer typed.
 */
export function filledLine1(customer: AddressColumns, fillHome: string | null): string | undefined {
  const country = (customer.country ?? "").toUpperCase();
  if (!fillHome || !country || country === fillHome.toUpperCase()) return undefined;
  if ((customer.addressLine1 ?? "").trim()) return undefined;
  const parts = [customer.city, customer.state].map((v) => (v ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : (customer.postalCode ?? "").trim() || undefined;
}
