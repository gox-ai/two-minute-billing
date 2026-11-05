/**
 * Currency exponent handling.
 *
 * The platform stores money as integer MINOR units + a 3-letter currency code
 * (see the money invariant in CLAUDE.md). Converting minor→decimal for a gateway
 * that wants a decimal string (PayPal) — or interpreting a gateway's decimal
 * amount back into minor units — needs the currency's exponent, which is NOT
 * always 2. Zero-decimal currencies (JPY, KRW, …) have no fractional unit;
 * three-decimal currencies (BHD, KWD, …) have three.
 *
 * The lists mirror ISO 4217 / the set Stripe documents for zero- and
 * three-decimal amounts. Anything not listed defaults to 2.
 */

// ⚠ There is a SECOND exponent table in `dashboard/lib/money.ts`, because the
// dashboard cannot import from `src/`. `test/unit/currency-exponent.test.ts` compares
// the two and fails on any divergence — if you add a code here, add it there too.
// Both follow ISO 4217: the exponent DEFINES our stored minor units, so emails, PDFs and
// gateway conversion must all read the same one. A processor that differs (Stripe takes
// MGA in whole units) converts in its own adapter.

// ISO 4217 currencies with no minor unit (amount minor === amount major).
const ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "UYI",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
// ISO 4217 currencies with three minor digits.
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

// Funds/index units quoted to four places. Rare, but `minorScale` handles any
// exponent, so omitting them just made them silently wrong by 100×.
const FOUR_DECIMAL = new Set(["CLF", "UYW"]);

const ISO_CODES = new Set(Intl.supportedValuesOf("currency"));

/** True for an active ISO 4217 code (case-insensitive). `XXX` and made-up codes are false. */
export function isIsoCurrency(code: string): boolean {
  return ISO_CODES.has(code.toUpperCase());
}

/** Number of minor-unit digits for a currency code (default 2). */
export function currencyExponent(code: string): number {
  const c = code.toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  if (FOUR_DECIMAL.has(c)) return 4;
  return 2;
}

/**
 * Integer minor units → a human-facing money string: `249900` INR → `₹2,499.00`,
 * `1000` JPY → `¥1,000`.
 *
 * Mirrors the dashboard's `money()` deliberately, because the two are read side by
 * side: this renders the hosted checkout's line items while the dashboard renders the
 * portal, and the same plan showing as `INR 2499.00` on one and `₹2,499.00` on the
 * other reads as two different products rather than two views of one.
 *
 * Not for gateway payloads — those want `minorToDecimalString`, which emits a bare
 * machine-readable decimal with no symbol, grouping or locale.
 *
 * Two things worth knowing about the output. The separator between a currency CODE and
 * the amount is a NON-BREAKING space (Intl's, so the pair cannot wrap) — compare with
 * `\u00A0`, not ' '. And the locale is pinned to 'en' rather than the host's, because
 * `toLocaleString(undefined, …)` made the rendered string depend on the SERVER's
 * locale: the same page grouped as `5,61,180` or `561,180` depending on where it ran.
 * Pinned also means it matches the dashboard, which pins 'en' too.
 */
export function formatMoney(amountMinor: bigint | number, code: string): string {
  const exp = currencyExponent(code);
  const major = Number(amountMinor) / 10 ** exp;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code }).format(major);
  } catch {
    // Unknown/malformed code → Intl throws. Fall back to the currency's own exponent
    // rather than a blanket 2, so a zero-decimal amount does not grow fake decimals.
    return `${major.toFixed(exp)} ${code}`;
  }
}

/** 10 ** exponent, as a bigint, for a currency code. */
export function minorScale(code: string): bigint {
  return 10n ** BigInt(currencyExponent(code));
}

/**
 * Render integer minor units as the decimal string a gateway expects
 * (e.g. 1050 USD → "10.50", 1050 JPY → "1050", 1050 BHD → "1.050").
 */
export function minorToDecimalString(amountMinor: bigint, code: string): string {
  const exp = currencyExponent(code);
  const neg = amountMinor < 0n;
  const abs = neg ? -amountMinor : amountMinor;
  const sign = neg ? "-" : "";
  if (exp === 0) return `${sign}${abs}`;
  const scale = 10n ** BigInt(exp);
  const major = abs / scale;
  const minor = abs % scale;
  return `${sign}${major}.${minor.toString().padStart(exp, "0")}`;
}

/**
 * Convert a gateway's decimal amount (string or number) back into integer
 * minor units for the given currency. Uses string math to avoid float drift.
 */
export function decimalToMinor(amount: string | number, code: string): bigint {
  const exp = currencyExponent(code);
  const s = typeof amount === "number" ? amount.toString() : amount.trim();
  const neg = s.startsWith("-");
  const [intPart, fracPart = ""] = (neg ? s.slice(1) : s).split(".");
  const frac = (fracPart + "0".repeat(exp)).slice(0, exp);
  const combined = `${intPart}${frac}` || "0";
  const val = BigInt(combined);
  return neg ? -val : val;
}
