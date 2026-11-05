/**
 * Document-number composition, for the live preview on the numbering settings screens.
 *
 * ⚠️ **MIRROR of `src/modules/invoicing/customization.ts`** (`dynamicPrefixValue` /
 * `composeDocumentNumber`), which is the source of truth — it is what actually stamps a
 * number onto an invoice. The dashboard is a separate workspace package with no path to
 * `src/`, so this is copied rather than imported; mirroring with a pointer is the house
 * pattern here (see `brandSchema`'s "Mirrors the engine's own check").
 *
 * If you change the format, change BOTH, and update the expectation table in
 * `scripts/verify-invoice-pdf.ts` which pins the engine's output strings.
 *
 * The preview exists because a merchant editing a prefix is choosing an identifier that
 * will appear on tax documents for years. Showing them the actual next number beats
 * describing the rule.
 */

export type DynamicPrefix =
  | "none"
  | "yyyy"
  | "fy"
  | "mmyyyy"
  | "mm-yyyy"
  | "yyyymm"
  | "yyyy-mm"
  | "ddmmyyyy"
  | "dd-mm-yyyy"
  | "yyyymmdd"
  | "yyyy-mm-dd"
  | "mmddyyyy"
  | "mm-dd-yyyy";

export type NumberSeparator = "none" | "hyphen";

/** Label + value for the dropdown. */
export const DYNAMIC_PREFIX_OPTIONS: Array<{ value: DynamicPrefix; label: string }> = [
  { value: "none", label: "None" },
  { value: "yyyy", label: "YYYY" },
  { value: "fy", label: "FY (fiscal year)" },
  { value: "mmyyyy", label: "MMYYYY" },
  { value: "mm-yyyy", label: "MM-YYYY" },
  { value: "yyyymm", label: "YYYYMM" },
  { value: "yyyy-mm", label: "YYYY-MM" },
  { value: "ddmmyyyy", label: "DDMMYYYY" },
  { value: "dd-mm-yyyy", label: "DD-MM-YYYY" },
  { value: "yyyymmdd", label: "YYYYMMDD" },
  { value: "yyyy-mm-dd", label: "YYYY-MM-DD" },
  { value: "mmddyyyy", label: "MMDDYYYY" },
  { value: "mm-dd-yyyy", label: "MM-DD-YYYY" },
];

export const SEPARATOR_OPTIONS: Array<{ value: NumberSeparator; label: string }> = [
  { value: "hyphen", label: "Hyphen ( - )" },
  { value: "none", label: "None" },
];

export const MONTH_OPTIONS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
].map((label, i) => ({ value: String(i + 1), label }));

const SEP: Record<NumberSeparator, string> = { none: "", hyphen: "-" };

/**
 * Y/M/D as they read in `timezone` — `Intl`, not the `Date` getters, because those answer
 * in the browser's zone and the number is stamped in the BUSINESS's. `en-CA` gives
 * ISO-ordered parts so the split is positional.
 */
function partsInTz(at: Date, timezone: string): { y: number; m: number; d: number } {
  let iso: string;
  try {
    iso = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    iso = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  }
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

/** `202627` for a year starting in April 2026 with `startMonth` 4. */
function fiscalYearLabel(y: number, m: number, startMonth: number): string {
  const start = m >= startMonth ? y : y - 1;
  return `${start}${String(start + 1).slice(2)}`;
}

export function dynamicPrefixValue(
  kind: DynamicPrefix,
  at: Date,
  timezone: string,
  fiscalYearStartMonth = 1,
): string {
  if (kind === "none") return "";
  const { y, m, d } = partsInTz(at, timezone);
  const MM = String(m).padStart(2, "0");
  const DD = String(d).padStart(2, "0");
  switch (kind) {
    case "yyyy":
      return String(y);
    case "fy":
      return fiscalYearLabel(y, m, fiscalYearStartMonth);
    case "mmyyyy":
      return `${MM}${y}`;
    case "mm-yyyy":
      return `${MM}-${y}`;
    case "yyyymm":
      return `${y}${MM}`;
    case "yyyy-mm":
      return `${y}-${MM}`;
    case "ddmmyyyy":
      return `${DD}${MM}${y}`;
    case "dd-mm-yyyy":
      return `${DD}-${MM}-${y}`;
    case "yyyymmdd":
      return `${y}${MM}${DD}`;
    case "yyyy-mm-dd":
      return `${y}-${MM}-${DD}`;
    case "mmddyyyy":
      return `${MM}${DD}${y}`;
    case "mm-dd-yyyy":
      return `${MM}-${DD}-${y}`;
  }
}

export function composeDocumentNumber(input: {
  prefix: string;
  counter: number | bigint;
  dynamicPrefix: DynamicPrefix;
  separator1: NumberSeparator;
  separator2: NumberSeparator;
  fiscalYearStartMonth?: number;
  at: Date;
  timezone: string;
}): string {
  const stamp = dynamicPrefixValue(
    input.dynamicPrefix,
    input.at,
    input.timezone,
    input.fiscalYearStartMonth ?? 1,
  );
  // With no stamp there is only ONE joint, and it takes separator1 — which is why the
  // default `hyphen` reproduces the historical `INV-42`.
  return stamp
    ? `${input.prefix}${SEP[input.separator1]}${stamp}${SEP[input.separator2]}${input.counter}`
    : `${input.prefix}${SEP[input.separator1]}${input.counter}`;
}
