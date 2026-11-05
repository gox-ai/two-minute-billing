/**
 * The marketing site map. Header, mobile menu, footer and the overview pages all read this,
 * so a page cannot be in the menu and missing from the footer.
 */
export interface SiteLink {
  label: string;
  to: string;
  description?: string;
  icon?: string;
  /** The header menu's one-line description. */
  blurb?: string;
  /** The header menu group it is listed under (MENU_COLUMNS). */
  group?: string;
  /** Opens in a new tab. */
  external?: boolean;
}

export const PRODUCT: SiteLink[] = [
  {
    label: "Subscriptions",
    group: "Bill",
    blurb: "Plans, trials and proration.",
    to: "/product/subscriptions",
    icon: "i-lucide-repeat",
    description: "Plans, add-ons, trials, upgrades and proration, in every currency.",
  },
  {
    label: "Invoicing",
    group: "Bill",
    blurb: "Invoices and credit notes.",
    to: "/product/invoicing",
    icon: "i-lucide-file-text",
    description: "Invoices and credit notes on schedule, with tax and branded PDFs.",
  },
  {
    label: "Payments",
    group: "Collect",
    blurb: "Runs on your own gateway.",
    to: "/product/payments",
    icon: "i-lucide-credit-card",
    description: "Your own gateway accounts. Cards, wallets and bank debits.",
  },
  {
    label: "Recovery",
    group: "Collect",
    blurb: "Win back failed payments.",
    to: "/product/recovery",
    icon: "i-lucide-rotate-ccw",
    description: "Smart retries, a backup card and emails that win payments back.",
  },
  {
    label: "Integrations",
    group: "Collect",
    blurb: "12 gateways, HubSpot and more.",
    to: "/integrations",
    icon: "i-lucide-plug",
    description: "12 payment gateways, HubSpot, FirstPromoter and webhooks to your own tools.",
  },
  {
    label: "Tax",
    group: "Tax and reports",
    blurb: "VAT, GST and US sales tax.",
    to: "/product/tax",
    icon: "i-lucide-landmark",
    description: "VAT, GST and US sales tax on every invoice, with inclusive prices.",
  },
  {
    label: "Checkout and portal",
    group: "Bill",
    blurb: "Hosted checkout, self-service.",
    to: "/product/checkout-portal",
    icon: "i-lucide-shopping-cart",
    description: "Hosted checkout, buy links, a pricing page and a self-serve portal.",
  },
  {
    label: "Reporting",
    group: "Tax and reports",
    blurb: "MRR, churn and cohorts.",
    to: "/product/reporting",
    icon: "i-lucide-chart-line",
    description: "MRR, churn and cohorts. Click a figure to see the records behind it.",
  },
];

export const SOLUTIONS: SiteLink[] = [
  {
    label: "Europe",
    group: "By region",
    blurb: "VAT by country, reverse charge.",
    to: "/solutions/europe",
    icon: "i-lucide-euro",
    description: "VAT by customer country, reverse charge, VIES checks and SEPA Direct Debit.",
  },
  {
    label: "United States",
    group: "By region",
    blurb: "Sales tax by state, in USD.",
    to: "/solutions/us",
    icon: "i-lucide-dollar-sign",
    description: "Sales tax at the rate you set per state, exempt customers, cards and ACH.",
  },
  {
    label: "India",
    group: "By region",
    blurb: "GST, TDS and e-mandates in INR.",
    to: "/solutions/india",
    icon: "i-lucide-indian-rupee",
    description: "GST invoices, TDS, and Razorpay mandates for recurring INR.",
  },
  {
    label: "SaaS",
    group: "By business model",
    blurb: "Seats and self-serve upgrades.",
    to: "/solutions/saas",
    icon: "i-lucide-building-2",
    description: "Seats, plans and add-ons, with upgrades customers make themselves.",
  },
  {
    label: "Usage-based",
    group: "By business model",
    blurb: "Meter usage, bill it in arrears.",
    to: "/solutions/usage",
    icon: "i-lucide-gauge",
    description: "Meter what customers use and bill it in arrears.",
  },
  {
    label: "AI billing",
    group: "By business model",
    blurb: "Model prices, credits and spend limits.",
    to: "/solutions/ai-billing",
    icon: "i-lucide-sparkles",
    description: "Bill AI tokens at list price plus markup, sell prepaid credits and see margin.",
  },
  {
    label: "Ecommerce",
    group: "By business model",
    blurb: "One-time and repeat orders.",
    to: "/solutions/ecommerce",
    icon: "i-lucide-shopping-bag",
    description: "One-time and repeat orders from one checkout, with skips and pauses.",
  },
  {
    label: "Developers",
    group: "By team",
    blurb: "A REST API for every screen.",
    to: "/solutions/developers",
    icon: "i-lucide-code",
    description: "A documented REST API: every dashboard screen is also an endpoint.",
  },
];

export const DEVELOPERS: SiteLink[] = [
  {
    label: "Quickstart",
    group: "Get started",
    blurb: "Your first subscription.",
    to: "/help/developers/getting-started/quickstart",
    icon: "i-lucide-zap",
    description: "From sign-up to a first subscription.",
  },
  {
    label: "Documentation",
    group: "Get started",
    blurb: "Guides and recipes.",
    to: "/help",
    icon: "i-lucide-book-open",
    description: "Guides for everyone who runs billing.",
  },
  {
    label: "API reference",
    group: "Reference",
    blurb: "Every endpoint and field.",
    to: "/help/developers/api-reference",
    icon: "i-lucide-braces",
    description: "Every endpoint, with a request and a response.",
  },
  {
    label: "Changelog",
    group: "Reference",
    blurb: "What shipped, newest first.",
    to: "/changelog",
    icon: "i-lucide-sparkles",
    description: "What shipped, newest first.",
  },
];

export const COMPANY: SiteLink[] = [
  { label: "Pricing", to: "/pricing" },
  { label: "Security", to: "/security" },
  { label: "Self-hosted", to: "/open-source" },
  { label: "Blog", to: "/blog" },
  { label: "Contact", to: "/contact" },
];

/* ---------------------------------------------------------------------------
   Header menus. Items come from the lists above by their `group`; MENU_COLUMNS
   sets the group order and which groups share a column.
--------------------------------------------------------------------------- */

export type MenuKey = "product" | "solutions" | "developers";

export interface MenuGroup {
  label: string;
  items: SiteLink[];
}

// The triggers are buttons, not links, so Enter and Space open them; each menu links its overview.
export interface HeaderMenu {
  value: MenuKey;
  label: string;
  /** Desktop columns; a column may stack two groups. */
  columns: MenuGroup[][];
  /** The row under the columns, and the last link on phones. */
  footer?: SiteLink;
  /** The side panel's words. Its picture is the panel component's, by `value`. */
  aside: { label: string; title: string; text?: string; link: SiteLink };
  /** The side panel on phones: one plain link, as its own group. */
  phone?: MenuGroup;
}

export const MENU_COLUMNS: Record<MenuKey, string[][]> = {
  product: [["Bill"], ["Collect"], ["Tax and reports"]],
  solutions: [["By business model"], ["By region", "By team"]],
  developers: [["Get started"], ["Reference"], ["Open source"]],
};

function columns(key: MenuKey, links: SiteLink[]): MenuGroup[][] {
  return MENU_COLUMNS[key].map((col) =>
    col.map((label) => ({ label, items: links.filter((l) => l.group === label) })),
  );
}

const SELF_HOSTED: SiteLink = {
  label: "Self-hosted",
  to: "/open-source",
  group: "Open source",
  blurb: "Run it on your own servers.",
};

/** The three header menus. GitHub is listed only when the repository URL is configured. */
export function headerMenus(repo?: string): HeaderMenu[] {
  const github: SiteLink[] = repo
    ? [
        {
          label: "GitHub",
          to: repo,
          group: "Open source",
          blurb: "Engine, dashboard and docs.",
          external: true,
        },
      ]
    : [];
  return [
    {
      value: "product",
      label: "Product",
      columns: columns("product", PRODUCT),
      footer: { label: "All features", to: "/product" },
      aside: {
        label: "From the dashboard",
        title: "A failed renewal, paid on the first retry.",
        link: { label: "See how recovery works", to: "/product/recovery" },
      },
    },
    {
      value: "solutions",
      label: "Solutions",
      columns: columns("solutions", SOLUTIONS),
      aside: {
        label: "Switching billing tools",
        title: "Compare billing tools",
        text: "See how we differ, point by point.",
        link: { label: "View comparisons", to: "/compare" },
      },
      phone: {
        label: "Switching billing tools",
        items: [{ label: "Compare", to: "/compare", blurb: "See how we differ, point by point." }],
      },
    },
    {
      value: "developers",
      label: "Developers",
      columns: columns("developers", [...DEVELOPERS, SELF_HOSTED, ...github]),
      footer: { label: "All developer docs", to: "/help/developers" },
      aside: {
        label: "Your stack",
        title: "Payments in through your gateways, events out to your tools.",
        link: { label: "View integrations", to: "/integrations" },
      },
    },
  ];
}

/** The public repository: app.config `github.url`, the same source as the docs header's icon. */
export function useRepoUrl(): string | undefined {
  const github = useAppConfig().github;
  return (github && github.url) || undefined;
}

/** The dashboard's sign-in and sign-up, from runtime config. */
export function useAppLinks() {
  const app = useRuntimeConfig().public.appUrl.replace(/\/+$/, "");
  return { signIn: `${app}/login`, signUp: `${app}/signup` };
}
