// Pure helpers for the hosted pages. Relative imports only: test/unit imports this file.
import { money, toMinor } from "../../lib/format";

/** What the buyer enters now, as the footer and the gateway dialogs name it. */
export type Instrument = "card" | "bank" | "other";

const WHAT: Record<Instrument, string> = {
  card: "Your card details",
  bank: "Your bank account details",
  other: "Your payment details",
};

/**
 * The one sentence about who never sees the instrument, used by the footer and every
 * gateway dialog. No possessive: a business name can end in "s".
 */
export function privacyText(business: string, instrument: Instrument = "card"): string {
  return `${WHAT[instrument]} go directly to the payment provider. ${business || "The business"} never sees them.`;
}

/** A gateway SDK's decimal amount (`"29.00"`, `"USD"`) in the page's money format (`$29.00`). */
export function sdkAmountLabel(amount: unknown, currency: unknown): string | null {
  if (typeof amount !== "string" || typeof currency !== "string" || !amount || !currency)
    return null;
  const major = Number(amount);
  if (!Number.isFinite(major)) return null;
  return money(toMinor(major, currency.toUpperCase()), currency.toUpperCase());
}

/**
 * A business website as a link: `https:` is assumed when no scheme is given, and anything
 * that is not http(s) is dropped (a `javascript:` URL would run on our origin).
 */
export function websiteLink(
  raw: string | null | undefined,
): { href: string; label: string } | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return { href: url.href, label: `${url.hostname.replace(/^www\./, "")}${path}` };
  } catch {
    return null;
  }
}

/** An email address worth a `mailto:` link, or null. */
export function supportEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

/** Rails that settle only in one currency, whatever the gateway says it can do. */
const RAIL_CURRENCY: Record<string, string> = { upi: "INR" };

/**
 * The rails a buyer paying in `currency` can use. UPI moves only Indian rupees, so a buyer
 * paying in another currency is never offered it. With no currency nothing is dropped.
 */
export function railsForCurrency<T extends string>(
  allowed: readonly T[],
  currency: string | null | undefined,
): T[] {
  const want = currency?.trim().toUpperCase();
  if (!want) return [...allowed];
  return allowed.filter((m) => (RAIL_CURRENCY[m] ?? want) === want);
}

/** Two-letter codes `Intl` names as regions but that are not ISO 3166 countries. */
const NOT_COUNTRIES = new Set([
  "EU",
  "EZ",
  "UN",
  "QO",
  "XA",
  "XB",
  "ZZ",
  "AC",
  "CP",
  "CQ",
  "DG",
  "EA",
  "IC",
  "TA",
]);

/** Every country the runtime can name, as `{ value: "US", label: "United States" }`, by name. */
export function countryOptions(): Array<{ value: string; label: string }> {
  const names = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const out: Array<{ value: string; label: string }> = [];
  const A = 65;
  for (let i = 0; i < 26; i++)
    for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(A + i, A + j);
      if (NOT_COUNTRIES.has(code)) continue;
      let label: string | undefined;
      try {
        label = names.of(code);
      } catch {
        label = undefined;
      }
      if (label && label !== code) out.push({ value: code, label });
    }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** The card networks the card row names. RuPay is an Indian network, named only for rupees. */
export function cardNetworksHint(currency: string | null | undefined): string {
  return currency?.trim().toUpperCase() === "INR"
    ? "Visa, Mastercard, RuPay"
    : "Visa, Mastercard and other major cards";
}
