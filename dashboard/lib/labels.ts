/** Plain words for stored codes. A code stays in a `title` or a tooltip, never as the label. */

const sentence = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** `payment` → "Payment", `partial_refund` → "Partial refund". */
export function enumLabel(value: string | null | undefined): string {
  return value ? sentence(value) : "—";
}

/** Card brand: `visa` → "Visa", `american_express` → "American Express". */
const BRAND: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  american_express: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  rupay: "RuPay",
  maestro: "Maestro",
};
export function brandLabel(brand: string | null | undefined): string {
  if (!brand) return "—";
  const k = brand.toLowerCase();
  return BRAND[k] ?? sentence(brand).replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Who or what caused a change, as a short phrase: "by the billing clock". */
const SOURCE_PHRASE: Record<string, string> = {
  api: "through the API",
  dashboard: "in the dashboard",
  billing_clock: "by the billing clock",
  scheduled_job: "by the billing clock",
  migration: "by a data import",
  system: "by the system",
  hubspot: "by HubSpot",
};
export function sourcePhrase(source: string): string | null {
  return SOURCE_PHRASE[source] ?? null;
}

/** "1 region", "2 regions". Pass `many` for an irregular plural. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "1000000" + "calls/mo" → "1,000,000 calls a month". A non-number keeps its text. */
export function quantityLabel(value: string | number, unit?: string | null): string {
  const n =
    typeof value === "number" ? value : /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
  const v = n == null ? String(value) : n.toLocaleString("en-US");
  if (!unit) return v;
  const u = unit
    .replace(/\/mo\b/, " a month")
    .replace(/\/yr\b/, " a year")
    .replace(/\/day\b/, " a day");
  return `${v} ${u}`;
}

/** An event type as a title: `invoice.paid` → "Invoice paid", `subscription_changed` → "Subscription changed". */
export function eventTitle(type: string): string {
  return sentence(type.replace(/\./g, " "));
}

/** "Gross Volume" → "Gross volume". Lowers a capital that follows a space; acronyms (MRR, LTV) stay. */
export function sentenceCase(t: string): string {
  return t.replace(/ ([A-Z][a-z])/g, (_, w: string) => ` ${w.toLowerCase()}`);
}
