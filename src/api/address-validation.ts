/**
 * Cross-field address validation, shared by every surface that accepts one:
 * operator customers, the buyer portal, hosted checkout and the business profile.
 *
 * WHY IT IS A REFINEMENT AND NOT PER-FIELD RULES. Every rule here depends on the
 * country — a postal code is only valid *for a country*, a state code is only
 * closed *for a country*, a national phone number only resolves *given a country*.
 * Zod validates fields independently, so the checks have to run once the whole
 * object is in hand.
 *
 * This closes a real hole rather than adding polish. Before migration 0177 the
 * dashboard rendered a strict country picker and an inline postal check in front of
 * an API whose entire address contract was `z.string().length(2)` on the country and
 * a length cap on everything else — so a direct caller could store `country: 'XX'`
 * with a `postal_code` of `hello`, and the browser check was advisory anyway (it
 * rendered an error and still submitted). A strict picker in front of a permissive
 * API is a lie the API eventually gets told.
 *
 * The messages name the country and the expected shape, because a 400 that only
 * says "invalid" makes the caller guess which of twelve fields is wrong.
 */
import { z } from "zod";
import {
  countryFor,
  isStrictSubdivisionCountry,
  isValidPhone,
  isValidPostal,
  isValidStateCode,
  normalizeStateCode,
  splitE164,
  subdivisionsFor,
  withoutTrunkZero,
} from "@/platform/geo";

/** The subset of an address body the refinement reads. All optional/nullable. */
export interface AddressLike {
  city?: string | null;
  state?: string | null;
  state_code?: string | null;
  postal_code?: string | null;
  zip?: string | null;
  country?: string | null;
  phone?: string | null;
}

const MAX_LISTED = 12;

/**
 * Apply to any address object: `addressBody.superRefine(addressRefinement)`.
 *
 * Note it must be applied AFTER any `.extend()` — `superRefine` returns a
 * ZodEffects, which has no `.extend`.
 */
export function addressRefinement(a: AddressLike, ctx: z.RefinementCtx): void {
  const raw = (a.country ?? "").trim();

  // Country first: every other rule is meaningless without it, and reporting a bad
  // postal code for a country that does not exist would send the caller the wrong way.
  const country = raw ? countryFor(raw) : null;
  if (raw && !country) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["country"],
      message: `"${raw}" is not a valid ISO 3166-1 alpha-2 country code`,
    });
    return;
  }

  // ── Subdivision ────────────────────────────────────────────────────────────
  const stateCode = (a.state_code ?? "").trim();
  if (stateCode && country && !isValidStateCode(country.code, stateCode)) {
    const subs = subdivisionsFor(country.code) ?? [];
    // The full list is 239 entries for some countries; naming a dozen is a useful
    // error, dumping all of them is not.
    const sample = subs
      .slice(0, MAX_LISTED)
      .map((s) => s.value)
      .join(", ");
    const more = subs.length > MAX_LISTED ? `, … (${subs.length} total)` : "";
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["state_code"],
      message: `"${stateCode}" is not a valid ${country.regionLabel.toLowerCase()} code for ${country.name}${sample ? `. Use one of: ${sample}${more}` : ""}`,
    });
  }

  /**
   * A state_code that is really a NAME is the specific bug this catches: "California"
   * matches no rate component, so tax silently resolves to zero. Only flagged where
   * the set is closed — elsewhere free text in `state_code` is legitimate.
   */
  if (stateCode && country && isStrictSubdivisionCountry(country.code) && stateCode.length > 6) {
    const named = (subdivisionsFor(country.code) ?? []).find(
      (s) => s.label.toLowerCase() === stateCode.toLowerCase(),
    );
    if (named) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state_code"],
        message: `state_code takes the code, not the name. Use "${named.value}" for ${named.label}`,
      });
    }
  }

  // `state` (the printed name) and `state_code` must not contradict each other:
  // invoices print one and tax reads the other.
  const stateName = (a.state ?? "").trim();
  if (stateName && stateCode && country && isStrictSubdivisionCountry(country.code)) {
    const canonical = normalizeStateCode(country.code, stateCode);
    const match = (subdivisionsFor(country.code) ?? []).find((s) => s.value === canonical);
    if (match && match.label.toLowerCase() !== stateName.toLowerCase()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: `"${stateName}" does not match ${canonical} (${match.label}). The printed name and the code must agree`,
      });
    }
  }

  // ── Postal code ────────────────────────────────────────────────────────────
  // `zip` is an accepted alias, folded into postal_code downstream; validate
  // whichever one the caller sent.
  const postal = (a.postal_code ?? a.zip ?? "").trim();
  if (postal && country) {
    if (!country.hasPostalCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [a.postal_code != null ? "postal_code" : "zip"],
        message: `${country.name} does not use a postal code`,
      });
    } else if (!isValidPostal(country.code, postal)) {
      const hint = country.postalHint ? `. Expected format: ${country.postalHint}` : "";
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [a.postal_code != null ? "postal_code" : "zip"],
        message: `"${postal}" is not a valid ${country.postalLabel.toLowerCase()} for ${country.name}${hint}`,
      });
    }
  }

  // ── Phone ──────────────────────────────────────────────────────────────────
  // A bare national number is read against this address's country; an E.164 value
  // carries its own and is checked against that country instead.
  const phone = (a.phone ?? "").trim();
  if (phone && !isValidPhone(phone, country?.code ?? null)) {
    // The commonest miss: a number written the domestic way, trunk 0 included.
    const fixed = withoutTrunkZero(phone, country?.code ?? null);
    const dial = fixed?.startsWith("+") ? splitE164(fixed)?.dial : null;
    const zeroHint = fixed
      ? dial
        ? `. Remove the 0 after +${dial}`
        : ". Remove the leading 0"
      : null;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["phone"],
      message: country
        ? `"${phone}" is not a valid phone number for ${country.name}${zeroHint ?? `. For an international number, include the country code +${country.dialCode ?? ""}`}`
        : `"${phone}" is not a valid phone number${zeroHint ?? ". Start the number with + and the country code"}`,
    });
  }
}

/**
 * Missing required fields (`addressRequirementIssues`, 0334) as a zod error, so the 400 has
 * the same `details` shape as a format failure.
 */
export function requirementIssuesError(
  issues: ReadonlyArray<{ field: string; message: string }>,
  root = "address",
): z.ZodError {
  return new z.ZodError(
    issues.map((i) => ({
      code: "custom" as const,
      path: [root, i.field],
      message: i.message,
      input: undefined,
    })),
  );
}
