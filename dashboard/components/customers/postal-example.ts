// Pure: test/unit imports this file by relative path.

/** Real, public postcodes for the countries people most often type, where a made-up one reads wrong. */
const KNOWN: Record<string, string> = {
  US: "95814",
  CA: "K1A 0B1",
  GB: "SW1A 1AA",
  IN: "560001",
  AU: "2000",
  DE: "10115",
  FR: "75001",
  NL: "1011 AB",
  JP: "100-0001",
  BR: "01310-100",
  IE: "D02 X285",
  SH: "STHL 1ZZ",
  PN: "PCRN 1ZZ",
  IO: "BBND 1ZZ",
  // A letter prefix that is part of the code, not a placeholder.
  LT: "LT-01001",
  LU: "L-1009",
  LV: "LV-1050",
  // Territories whose codes sit in one numeric range.
  GF: "97300",
  GP: "97100",
  MH: "96960",
  MP: "96950",
  PF: "98714",
  PM: "97500",
  PR: "00901",
  RE: "97400",
  VI: "00802",
  WF: "98600",
};

/**
 * An example postcode for a country, from its format mask (`NNNNN-NNNN`, `LNL NLN`): `N` is a
 * digit, `L` a letter, everything else is kept. A mask with no `N` or `L` is itself the code
 * (`GX11 1AA`). Null when there is no mask.
 */
export function postalExample(country: string | null | undefined, mask: string | null | undefined) {
  const known = country ? KNOWN[country.toUpperCase()] : undefined;
  if (known) return known;
  if (!mask) return null;
  let d = 0;
  let l = 0;
  return mask.replace(/[NL]/g, (c) =>
    c === "N" ? String((d++ % 9) + 1) : String.fromCharCode(65 + (l++ % 26)),
  );
}

/** The postal label inside a sentence: "ZIP code" and "PIN code" keep their capitals. */
export function postalNoun(label: string): string {
  return /^[A-Z]{2}/.test(label) || label === "Eircode"
    ? label
    : label.charAt(0).toLowerCase() + label.slice(1);
}
