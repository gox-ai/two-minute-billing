/**
 * The blog's fixed vocabulary: categories, post types and the byline. Pure module: the content
 * config, the server routes and the pages all import it.
 */

export const BLOG_CATEGORIES = [
  { label: "Tax", slug: "tax", tone: "billing" },
  { label: "Failed payments", slug: "failed-payments", tone: "growth" },
  { label: "Pricing and proration", slug: "pricing-and-proration", tone: "neutral" },
  { label: "Revenue metrics", slug: "revenue-metrics", tone: "growth" },
  { label: "Engineering", slug: "engineering", tone: "neutral" },
  { label: "Product news", slug: "product-news", tone: "neutral" },
] as const;

export type BlogCategory = (typeof BLOG_CATEGORIES)[number]["label"];
export type BlogTone = "billing" | "growth" | "neutral";

export const BLOG_CATEGORY_LABELS = BLOG_CATEGORIES.map((c) => c.label) as [
  BlogCategory,
  ...BlogCategory[],
];
export const BLOG_TYPES = ["Guide", "Explainer", "Engineering", "News", "Opinion"] as const;
export const BLOG_TONES = ["billing", "growth", "neutral"] as const;

export const BLOG_AUTHOR = "Two Minute Billing team";

/** A post still waiting for its `publishAt`. Only `nuxt dev` and the Studio build show one. */
export const isScheduledPost = (p: { publishAt?: string | null }) =>
  !!p.publishAt && Date.parse(p.publishAt) > Date.now();
export const BLOG_TITLE = "Two Minute Billing blog";
export const BLOG_DESCRIPTION =
  "Guides, product news and engineering notes on subscription billing.";

export interface BlogCta {
  title: string;
  description: string;
  shot?: string;
}

/** The closing call to action: the blog's own, or a category's where one fits better. */
export const BLOG_CTA: BlogCta = {
  title: "Bill subscriptions on your own payment gateway",
  description: "A flat monthly price, not a share of your revenue. No credit card required.",
};
const CATEGORY_CTA: Partial<Record<BlogCategory, BlogCta>> = {
  Tax: {
    title: "Raise a sales tax invoice in test mode",
    description:
      "Add your state rates, bill a test customer in another state, and read the invoice. No credit card required.",
    shot: "/product/tax",
  },
};
export const blogCta = (category: string): BlogCta =>
  CATEGORY_CTA[category as BlogCategory] ?? BLOG_CTA;

export function blogCategory(label: string) {
  return BLOG_CATEGORIES.find((c) => c.label === label);
}

export function blogCategoryBySlug(slug: unknown) {
  return typeof slug === "string" ? BLOG_CATEGORIES.find((c) => c.slug === slug) : undefined;
}

/** The meaning class (marketing.css) a tone paints with. */
export function blogToneClass(tone: string | undefined): "mk-billing" | "mk-growth" | "mk-plain" {
  return tone === "billing" ? "mk-billing" : tone === "growth" ? "mk-growth" : "mk-plain";
}

/** `2026-11-02` → `November 2, 2026`. Dates are calendar days, so UTC. */
export function blogDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Words per minute for the read time: a considered pace for prose with tables and figures. */
export const BLOG_WPM = 220;

/** Minutes to read a Markdown body: words outside code fences and frontmatter. */
export function blogReadingTime(markdown: string): number {
  const text = markdown
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`|[\]()-]/g, " ");
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / BLOG_WPM));
}
