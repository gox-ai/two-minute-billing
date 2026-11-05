/** The EU member states. */
export const EU_COUNTRIES = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
];

/** Where analytics cookies need consent first: the EEA (EU + IS, LI, NO), the UK and Switzerland. */
export const CONSENT_COUNTRIES = [...EU_COUNTRIES, "IS", "LI", "NO", "GB", "CH"];
