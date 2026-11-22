/**
 * Fill a billing address's empty state and city from its postal code, where it is saved.
 *
 * A business may hide City or State on a buyer form, so the form cannot fill them; the save
 * does. Never overwrites a value that is set. The state fills only for a country that has
 * subdivisions; the city only when exactly one place matches. No postal data, or no match,
 * leaves the address as it is.
 */
import { countryFor, GeoNotLoadedError, subdivisionsFor } from "@/platform/geo";
import { lookupPostal } from "@/platform/postal-lookup";

interface FillableAddress {
  city?: string | null;
  state?: string | null;
  stateCode?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

const blank = (v: string | null | undefined) => !(v ?? "").trim();

export async function fillAddressFromPostal<T extends FillableAddress>(
  address: T | null | undefined,
): Promise<T | null | undefined> {
  if (!address || blank(address.postalCode) || blank(address.country)) return address;
  // Best effort: a process without the geo reference loaded saves the address as given.
  let country: ReturnType<typeof countryFor>;
  let hasSubdivisions: boolean;
  try {
    country = countryFor(address.country!.trim());
    if (!country) return address;
    hasSubdivisions = (subdivisionsFor(country.code) ?? []).length > 0;
  } catch (e) {
    if (e instanceof GeoNotLoadedError) return address;
    throw e;
  }
  const needState = hasSubdivisions && blank(address.stateCode) && blank(address.state);
  const needCity = blank(address.city);
  if (!needState && !needCity) return address;
  const hit = await lookupPostal(country.code, address.postalCode!).catch(() => null);
  if (!hit) return address;
  const out = { ...address };
  if (needState && hit.stateCode) {
    out.stateCode = hit.stateCode;
    if (hit.stateName) out.state = hit.stateName;
  }
  const only = hit.cities.length === 1 ? hit.cities[0] : undefined;
  if (needCity && only) out.city = only;
  return out;
}
