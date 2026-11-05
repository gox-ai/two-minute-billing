/**
 * Shipping address display, in a plain module so both the server `PlanCard` and the client
 * components can call it.
 */
import type { Country } from "@/lib/api/geo";
import type { PortalShippingAddress } from "@/lib/portal-api";

type AddressLike = Pick<
  PortalShippingAddress,
  | "line1"
  | "line2"
  | "line3"
  | "city"
  | "state"
  | "state_code"
  | "postal_code"
  | "country"
  | "first_name"
  | "last_name"
  | "company"
>;

const s = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/** Recipient, street lines, "city, region, postal", country name. Empties dropped. */
export function shippingLines(a: AddressLike, countries: Country[] = []): string[] {
  const recipient = [s(a.first_name), s(a.last_name)].filter(Boolean).join(" ");
  const region = s(a.state) ?? s(a.state_code);
  const cityLine = [s(a.city), region, s(a.postal_code)].filter(Boolean).join(", ");
  const code = s(a.country);
  const country = code
    ? (countries.find((c) => c.code === code.toUpperCase())?.name ?? code)
    : null;
  return [
    recipient || null,
    s(a.company),
    s(a.line1),
    s(a.line2),
    s(a.line3),
    cityLine || null,
    country,
  ].filter((l): l is string => Boolean(l));
}

/** One line for a picker or a summary: "12 Main St, Springfield, US". */
export function shippingSummary(a: AddressLike): string {
  return [s(a.line1), s(a.city), s(a.postal_code), s(a.country)].filter(Boolean).join(", ");
}
