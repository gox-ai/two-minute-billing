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
  // PayU's card_type codes, stored as-is before the adapter mapped them.
  mast: "Mastercard",
  dinr: "Diners Club",
  maes: "Maestro",
  smae: "Maestro",
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
  portal: "in the customer portal",
  checkout: "in checkout",
  webhook: "from a gateway notification",
  mcp: "through an AI agent (MCP)",
  billing_clock: "by the billing clock",
  scheduled_job: "by the billing clock",
  migration: "by a data import",
  system: "by the system",
  hubspot: "by HubSpot",
};

/** Gateway catalogue keys (src/providers/gateway-catalog.ts) as their display names. */
const GATEWAY_NAME: Record<string, string> = {
  tmtest: "TM Test",
  stripe: "Stripe",
  paypal: "PayPal",
  razorpay: "Razorpay",
  gocardless: "GoCardless",
  braintree: "Braintree",
  cashfree: "Cashfree",
  adyen: "Adyen",
  checkoutcom: "Checkout.com",
  authorizenet: "Authorize.net",
  square: "Square",
  mollie: "Mollie",
  payu: "PayU",
  cybersource: "CyberSource",
  // Not a payment gateway: the email provider's delivery notices.
  ses: "Amazon SES",
};

/** `razorpay` → "Razorpay"; null when the key names no known gateway. */
export function gatewayName(key: string | null | undefined): string | null {
  return key && Object.hasOwn(GATEWAY_NAME, key) ? GATEWAY_NAME[key]! : null;
}

/** A webhook's actor is the gateway key: "from Stripe", else "from a gateway notification". */
export function sourcePhrase(source: string, actor?: string | null): string | null {
  if (source === "webhook") {
    const name = gatewayName(actor);
    return name ? `from ${name}` : SOURCE_PHRASE.webhook!;
  }
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

/**
 * An unaudited event's sentence parts: `payment_intent_intent_consumed` on a `payment_intent`
 * record gives noun "Payment intent", verb "consumed." The resource prefix is cut off the type,
 * and a verb that opens by repeating the noun's last word ("intent consumed") drops that word.
 */
export function eventSentence(type: string, resourceType: string): { noun: string; verb: string } {
  const words = type.replace(/\./g, "_").split("_").filter(Boolean);
  const own = resourceType.split("_");
  const hasOwn = own.length < words.length && own.every((w, i) => words[i] === w);
  const nounWords = hasOwn ? own : words.length > 1 ? words.slice(0, 1) : own;
  let verbWords = words.length > nounWords.length ? words.slice(nounWords.length) : words;
  const last = nounWords[nounWords.length - 1];
  if (verbWords.length > 1 && verbWords[0] === last) verbWords = verbWords.slice(1);
  return { noun: sentence(nounWords.join("_")), verb: `${verbWords.join(" ")}.` };
}
