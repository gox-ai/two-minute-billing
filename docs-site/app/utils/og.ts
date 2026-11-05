/**
 * Open Graph images for the pages Nitro does NOT prerender (/pricing, /contact, /blog).
 *
 * The OG module runs in zero-runtime mode: it renders images only while prerendering.
 * A server-rendered page would point at a `/_og/d/…` URL that the server cannot answer,
 * so these pages name a static `/_og/s/…` image instead, and nuxt.config adds the same
 * path to the prerender list so the image exists. Pure module: nuxt.config imports it.
 *
 * The segment follows the module's own URL grammar (`c_<component>,<prop>_<value>,p_<page>`),
 * restricted to letters, digits, spaces, hyphens and full stops so it never needs escaping.
 */
export interface StaticOg {
  headline: string;
  title: string;
  description: string;
}

export const STATIC_OG: Record<string, StaticOg> = {
  "/pricing": {
    headline: "Pricing",
    title: "Flat monthly plans. No revenue share.",
    // OG text allows only letters, digits, hyphens and full stops, so no "$1,000" here.
    description: "Every feature on every plan. Free until your billing grows.",
  },
  "/blog": {
    headline: "Blog",
    title: "Subscription billing explained with real numbers",
    description: "Sales tax and VAT. Failed payments. Proration and revenue metrics.",
  },
  "/contact": {
    headline: "Contact",
    title: "Talk to the Two Minute Billing team",
    description: "Enterprise plans. Self-hosted support. Security reviews.",
  },
};

const SAFE = /^[A-Za-z0-9 .-]+$/;

function encodeValue(value: string): string {
  if (!SAFE.test(value))
    throw new Error(`OG text must be plain letters, digits, hyphens and full stops: ${value}`);
  return value.replace(/ /g, "+");
}

/** `/_og/s/c_Marketing,headline_…,title_…,description_…,p_….png` for one page. */
export function staticOgPath(pagePath: string): string | undefined {
  const og = STATIC_OG[pagePath];
  if (!og) return undefined;
  const page = btoa(JSON.stringify(pagePath))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "~");
  const parts = [
    "c_Marketing",
    `headline_${encodeValue(og.headline)}`,
    `title_${encodeValue(og.title)}`,
    `description_${encodeValue(og.description)}`,
    `p_${page}`,
  ];
  return `/_og/s/${parts.join(",")}.png`;
}
