/**
 * The "<product> alternative" pages: one entry per page, rendered by pages/compare/[slug].vue,
 * and the hub table on pages/compare/index.vue.
 *
 * This file and pages/compare/** are the only site files allowed to name another billing
 * product (user decision 2026-10-22; the publish guard allowlists them by path).
 * Every statement about another product has a row, with its source URL, in
 * docs/references/COMPARISON_SOURCES.md, and the page links the same URL next to it.
 * Change COMPARE_CHECKED only after re-checking every row. Never say a product lacks
 * something: say which of its pages does not list it.
 */
import type { FaqItem } from "../composables/useMarketingSeo";
import type { SiteLink } from "./site";

/** The day every competitor fact below was last checked against the vendor's own pages. */
export const COMPARE_CHECKED = "2026-10-29";
export const COMPARE_CHECKED_LABEL = "October 29, 2026";
/** The day the page copy last changed. Shown as "Last updated". */
export const COMPARE_UPDATED = "2026-10-29";
export const COMPARE_UPDATED_LABEL = "October 29, 2026";

/** Where each matrix row's topic is explained on our own site. */
export const COMPARE_ROW_LINKS: Record<string, string> = {
  Price: "/pricing",
  "Fee on your revenue": "/pricing",
  "Other costs": "/pricing",
  "Getting started": "/pricing",
  "Who is the seller": "/product/payments",
  "Payment gateways": "/integrations",
  "Sales tax and VAT": "/product/tax",
  "India GST": "/solutions/india",
  "Self-hosting and open source": "/open-source",
  "Subscription analytics": "/product/reporting",
};

/** A short row for the hero card. `label` "Price", "Self-hosting" and "Gateway" feed the header menu. */
export interface CompareRow {
  label: string;
  us: string;
  them: string;
}

/** One matrix row. `sources` are the vendor pages the `them` cell comes from. */
export interface CompareFact extends CompareRow {
  sources: string[];
}

/** One cost line for the other product, with the page it comes from. */
export interface CostItem {
  text: string;
  source: string;
}

export interface Comparison {
  slug: string;
  /** The product as its owner names it. */
  name: string;
  /** The search query this page targets (US). Internal: docs/references/SEO_KEYWORD_MAP.md. */
  keyword: string;
  /** The page part of the title, at most 39 characters: the template adds " | Two Minute Billing". */
  title: string;
  h1: string;
  eyebrow: string;
  /** Meta description, 140–155 characters. */
  description: string;
  /** The honest summary above the fold: what both do, the difference, when they are better. */
  intro: string;
  /** Short card text for the footer and the sitemap. */
  summary: string;
  /** The key difference, one or two sentences, for the /compare hub. */
  difference: string;
  og: { headline: string; title: string; description: string };
  glance: CompareRow[];
  rows: CompareFact[];
  /** Everything this product costs, hidden costs included. */
  costs: CostItem[];
  /** When we fit, and when this product is the better fit. */
  fit: { us: string[]; them: string[] };
  /** Our weak points against this product, said plainly. */
  cons: string[];
  /** What moving from this product involves. No import claims: we offer no import tool. */
  moving: string;
  /** Short cells for the /compare matrix. */
  hub: { price: string; fee: string; seller: string; gateways: string; source: string };
  /** The closing recommendation, one or two sentences. */
  verdict: string;
  faq: FaqItem[];
  /** The trademark note, one sentence. */
  trademark: string;
}

// The vendor pages every fact comes from, read on COMPARE_CHECKED.
const SRC = {
  cbPricing: "https://www.chargebee.com/pricing/",
  cbSalesTax: "https://www.chargebee.com/docs/billing/2.0/taxes/us-sales-tax",
  cbVat: "https://www.chargebee.com/docs/billing/2.0/taxes/eu-vat",
  cbGst: "https://www.chargebee.com/docs/billing/2.0/taxes/indian-gst",
  sbPricing: "https://stripe.com/billing/pricing",
  sbAnalytics: "https://docs.stripe.com/billing/subscriptions/analytics",
  stTax: "https://docs.stripe.com/tax",
  stTaxIndia: "https://docs.stripe.com/tax/supported-countries/asia-pacific/india",
  stTaxPricing: "https://stripe.com/tax/pricing",
  pdPricing: "https://www.paddle.com/pricing",
  rcPricing: "https://recurly.com/pricing/",
  rcTax: "https://docs.recurly.com/recurly-subscriptions/docs/tax",
  rcVat: "https://docs.recurly.com/recurly-subscriptions/docs/vat-gst-support",
  mxPricing: "https://www.maxio.com/pricing",
  mxHome: "https://www.maxio.com/",
  mxTax: "https://docs.maxio.com/billing/taxes/overview/understand-tax-options",
  mxMerger:
    "https://www.kmworld.com/Articles/News/News/SaaSOptics-and-Chargify-merge-relaunch-as-Maxio-152442.aspx",
  zuPricing: "https://www.zuora.com/pricing/",
  zuGateways:
    "https://docs.zuora.com/en/zuora-payments/overview/zuora-payments-overview/supported-payment-gateways",
  zuTax:
    "https://docs.zuora.com/en/zuora-billing/set-up-zuora-billing/apply-taxes/overview-of-zuora-tax",
  zuReporting:
    "https://docs.zuora.com/en/zuora-platform/data/reporting/reporting-quick-reference/reporting-overview",
  lsPricing: "https://www.lemonsqueezy.com/pricing",
  lsFees: "https://docs.lemonsqueezy.com/help/getting-started/fees",
  lsUpdate: "https://www.lemonsqueezy.com/blog/2026-update",
};

// Our side of every matrix, said once. Checked against the code: COMPARISON_SOURCES.md.
const US = {
  price:
    "Free plan while you bill less than {freeBand} a month. Then a flat monthly price by billing volume.",
  fee: "0%. No percentage of revenue and no fee per transaction to us.",
  other:
    "Your payment gateway's own processing fees. Self-hosting is free: you pay for your servers.",
  seller: "You. Payments go to your own payment gateway account.",
  gateways:
    "12 gateways on your own accounts: Stripe, PayPal, Braintree, Square, Adyen, Checkout.com, Authorize.net, Mollie, GoCardless, Razorpay, Cashfree and PayU.",
  tax: "US sales tax by state, VAT with reverse charge and VIES checks, and GST. You enter the rates. We do not look them up or file.",
  gst: "GST by place of supply (CGST and SGST, or IGST), GSTIN and HSN or SAC codes on invoices, and TDS recorded on the invoice.",
  hosting: "Open source under the AGPL-3.0. Self-host every feature, or use our Cloud.",
  analytics:
    "MRR, ARR, churn, net and gross revenue retention, quick ratio, lifetime value and cohorts, per currency.",
  start: "Sign up free, with no credit card. Every business has a test mode.",
};

/** Our side of the cost section. Paid prices come from the catalogue on /pricing. */
export const COMPARE_OUR_COSTS: string[] = [
  "Free plan while you bill less than {freeBand} a month, in live mode, with every feature.",
  "Then a flat monthly price by billing volume.",
  "0% of your revenue. No fee per transaction to us.",
  "Your payment gateway charges its own processing fees, as it does today.",
  "Bill more than your plan covers and billing carries on. We ask you to change to a larger plan.",
  "The self-hosted edition is free, with every feature. You pay for your own servers.",
];

const FAQ_GATEWAY: FaqItem = {
  label: "Is Two Minute Billing a payment gateway?",
  content:
    "No. Your payment gateway charges the card and holds the money, in your own account. We decide what to charge and when, raise the invoices, retry failed payments and keep the records.",
};

const FAQ_SELF_HOST: FaqItem = {
  label: "Can I self-host Two Minute Billing?",
  content:
    "Yes. The engine is open source under the AGPL-3.0. The self-hosted edition has every feature and costs nothing. You run the servers and apply new releases.",
};

const gatewaysFaq = (name: string, more: string): FaqItem => ({
  label: "Which payment gateways can I use?",
  content: `Stripe, PayPal, Braintree, Square, Adyen, Checkout.com, Authorize.net, Mollie, GoCardless, Razorpay, Cashfree and PayU, on your own accounts. ${name} lists ${more}, so check that your gateway is on our list before you switch.`,
});

const movingNoImport = (name: string) =>
  `We have no self-serve import from ${name}. You set up your plans and customers with us, and your past invoices stay in ${name}. Talk to us before you plan a move.`;

// Lines that hold against every product on these pages.
const CON_GATEWAYS = "12 gateways. We cannot charge through a gateway that is not one of them.";
const CON_RATES = "You enter tax rates yourself. We do not look them up or file returns.";
const CON_MOR_TAX =
  "You register for sales tax and VAT and file the returns. We work out the tax on each invoice.";
const CON_MOR_GATEWAY = "You open your own payment gateway account and pay its processing fees.";
const FIT_FLAT = "Your billing fee grows with your revenue, and you want a flat monthly price.";
const FIT_OPEN = "You want to self-host the billing engine or read its code.";
const FIT_FREE = "You want to start on a Free plan while you bill less than {freeBand} a month.";
const HOSTED = (page: string) =>
  `Hosted service. Its ${page} lists no self-hosted or open-source edition.`;

export const COMPARISONS: Comparison[] = [
  {
    slug: "chargebee-alternative",
    name: "Chargebee",
    keyword: "chargebee alternative",
    title: "Chargebee alternative: no revenue share",
    h1: "A Chargebee alternative with a flat monthly price",
    eyebrow: "Chargebee alternative",
    description:
      "Compare Chargebee with Two Minute Billing: a flat monthly price and 0% of revenue, open source and self-hostable, on your own payment gateway.",
    intro:
      "Chargebee and Two Minute Billing both bill subscriptions through your own payment gateway. Chargebee's Billing plans take a percentage of invoicing volume and connect to more gateways. We charge a flat monthly price with 0% of revenue, and you can self-host the open-source engine.",
    summary: "A flat monthly price instead of a percentage of invoicing volume.",
    difference:
      "Chargebee charges a percentage of monthly invoicing volume and lists 40+ gateways. We charge a flat monthly price, and you can self-host.",
    og: {
      headline: "Chargebee alternative",
      title: "A flat price. 0% of revenue.",
      description: "Open source, on your own payment gateway.",
    },
    glance: [
      { label: "Price", us: "Flat monthly plan", them: "Percentage of invoicing volume" },
      { label: "Self-hosting", us: "Free, every feature", them: "Hosted service" },
      { label: "Gateway", us: "Your own account", them: "Your own account" },
    ],
    rows: [
      {
        label: "Price",
        us: US.price,
        them: "Billing plans priced on monthly invoicing volume. The pricing page shows $0 + 0.80% and $99 + 0.65%. Enterprise: schedule a demo.",
        sources: [SRC.cbPricing],
      },
      {
        label: "Fee on your revenue",
        us: US.fee,
        them: "Yes. A percentage of monthly invoicing volume.",
        sources: [SRC.cbPricing],
      },
      {
        label: "Other costs",
        us: US.other,
        them: "Enterprise has no listed price. Quoting (CPQ) and revenue recognition are priced on their own.",
        sources: [SRC.cbPricing],
      },
      {
        label: "Who is the seller",
        us: US.seller,
        them: "You, through one of its connected gateways.",
        sources: [SRC.cbPricing],
      },
      {
        label: "Payment gateways",
        us: US.gateways,
        them: "40+ gateway integrations.",
        sources: [SRC.cbPricing],
      },
      {
        label: "Sales tax and VAT",
        us: US.tax,
        them: "US sales tax from rates you enter or upload, or from Avalara or TaxJar. EU VAT with reverse charge and VIES checks.",
        sources: [SRC.cbSalesTax, SRC.cbVat],
      },
      {
        label: "India GST",
        us: US.gst,
        them: "Supported: CGST and SGST in your own region, IGST otherwise, and a GSTIN in the customer's billing info.",
        sources: [SRC.cbGst],
      },
      {
        label: "Self-hosting and open source",
        us: US.hosting,
        them: HOSTED("pricing page"),
        sources: [SRC.cbPricing],
      },
      {
        label: "Subscription analytics",
        us: US.analytics,
        them: "RevenueStory analytics, usage analytics and a basic report builder.",
        sources: [SRC.cbPricing],
      },
    ],
    costs: [
      {
        text: "A percentage of monthly invoicing volume. The pricing page shows $0 + 0.80% and $99 + 0.65%, with a $66K breakeven between the two.",
        source: SRC.cbPricing,
      },
      { text: "Enterprise has no listed price. You schedule a demo.", source: SRC.cbPricing },
      {
        text: "Quoting (CPQ) and revenue recognition are separate products, each with its own price.",
        source: SRC.cbPricing,
      },
    ],
    fit: {
      us: [FIT_FLAT, FIT_OPEN, "One of our 12 gateways already collects your payments."],
      them: [
        "Your gateway is not one of our 12. Chargebee lists 40+ gateway integrations.",
        "You want Avalara or TaxJar to find your US sales tax rates.",
        "You want quoting (CPQ) and revenue recognition from the same vendor.",
      ],
    },
    cons: [CON_GATEWAYS, CON_RATES],
    moving: movingNoImport("Chargebee"),
    hub: {
      price: "Percentage of invoicing volume",
      fee: "Yes",
      seller: "You",
      gateways: "40+",
      source: SRC.cbPricing,
    },
    verdict:
      "Select Two Minute Billing for a flat price and an engine you can run yourself. Stay with Chargebee if your gateway is not on our list.",
    faq: [
      {
        label: "How does the price compare with Chargebee?",
        content:
          "Chargebee's Billing plans charge a percentage of monthly invoicing volume. Its pricing page shows $0 + 0.80% and $99 + 0.65%. Our Cloud plans are a flat monthly price by billing volume, with 0% of revenue. The self-hosted edition is free.",
      },
      FAQ_GATEWAY,
      gatewaysFaq("Chargebee", "40+ gateway integrations"),
      FAQ_SELF_HOST,
    ],
    trademark: "Chargebee is a trademark of its owner and is named here only to compare.",
  },
  {
    slug: "stripe-billing-alternative",
    name: "Stripe Billing",
    keyword: "stripe billing alternative",
    title: "Stripe Billing alternative: keep Stripe",
    h1: "A Stripe Billing alternative that keeps your Stripe account",
    eyebrow: "Stripe Billing alternative",
    description:
      "Keep your Stripe account and drop the 0.7% Billing fee. Two Minute Billing is a flat monthly price with 0% of revenue, and adds 10 more payment gateways.",
    intro:
      "Stripe Billing charges 0.7% of Billing volume on top of payment fees. Two Minute Billing bills through the same Stripe account for a flat monthly price with 0% of revenue, and can add 10 more gateways. Stripe Billing is the simpler choice if you want billing, payments and tax from one company.",
    summary: "Keep your Stripe account, without a percentage of billing volume.",
    difference:
      "Stripe Billing charges 0.7% of Billing volume. We bill through the same Stripe account for a flat monthly price, and add 10 more gateways.",
    og: {
      headline: "Stripe Billing alternative",
      title: "Keep Stripe. Change the billing.",
      description: "A flat monthly price. 0% of revenue.",
    },
    glance: [
      { label: "Price", us: "Flat monthly plan", them: "0.7% of Billing volume" },
      { label: "Gateways", us: "Stripe and 10 more", them: "Stripe" },
      { label: "Self-hosting", us: "Free, every feature", them: "Hosted, part of Stripe" },
    ],
    rows: [
      {
        label: "Price",
        us: US.price,
        them: "0.7% of Billing volume, pay as you go. Large-volume businesses can ask sales for custom pricing.",
        sources: [SRC.sbPricing],
      },
      {
        label: "Fee on your revenue",
        us: US.fee,
        them: "Yes. 0.7% of Billing volume, including volume processed off Stripe. One-off invoices are excluded.",
        sources: [SRC.sbPricing],
      },
      {
        label: "Other costs",
        us: US.other,
        them: "Card processing is priced separately. Stripe Tax adds 0.5% per transaction (no-code) or US$0.50 per transaction (API) where you are registered.",
        sources: [SRC.sbPricing, SRC.stTaxPricing],
      },
      {
        label: "Who is the seller",
        us: US.seller,
        them: "You, on your Stripe account.",
        sources: [SRC.sbPricing],
      },
      {
        label: "Payment gateways",
        us: US.gateways,
        them: "Stripe payments, priced on the same page.",
        sources: [SRC.sbPricing],
      },
      {
        label: "Sales tax and VAT",
        us: US.tax,
        them: "Stripe Tax calculates sales tax, VAT and GST, and helps you manage registrations and filings. It has its own fee.",
        sources: [SRC.stTax, SRC.stTaxPricing],
      },
      {
        label: "India GST",
        us: US.gst,
        them: "Stripe Tax collects only IGST in India, on digital products, and only for remote sellers with no presence there.",
        sources: [SRC.stTaxIndia],
      },
      {
        label: "Self-hosting and open source",
        us: US.hosting,
        them: "Hosted, as part of Stripe.",
        sources: [SRC.sbPricing],
      },
      {
        label: "Subscription analytics",
        us: US.analytics,
        them: "MRR, ARPU, lifetime value, trial conversion, churn and retention by cohort.",
        sources: [SRC.sbAnalytics],
      },
    ],
    costs: [
      {
        text: "0.7% of Billing volume, pay as you go. It counts volume processed off Stripe too, and excludes one-off invoices.",
        source: SRC.sbPricing,
      },
      { text: "Card processing is priced separately, on the same page.", source: SRC.sbPricing },
      {
        text: "Stripe Tax: 0.5% per transaction (no-code) or US$0.50 per transaction (API), where you are registered.",
        source: SRC.stTaxPricing,
      },
      { text: "Large-volume businesses can ask sales for custom pricing.", source: SRC.sbPricing },
    ],
    fit: {
      us: [
        FIT_FLAT,
        "You want a second gateway beside Stripe, such as Adyen or PayPal, for the currencies you select.",
        FIT_OPEN,
      ],
      them: [
        "You want Stripe Tax to find your rates and help you register and file.",
        "You want billing, payments and tax from one company, in one dashboard.",
        "You do not want a second system beside your Stripe account.",
      ],
    },
    cons: [
      "You enter tax rates yourself. Stripe Tax finds them for you.",
      "A second system to run beside your Stripe account.",
    ],
    moving:
      "Your Stripe account stays connected, and Stripe still charges the cards. We have no self-serve import of Stripe Billing subscriptions, and invoices start a new number series with us. Talk to us before you plan a move.",
    hub: {
      price: "0.7% of Billing volume",
      fee: "Yes, 0.7%",
      seller: "You",
      gateways: "Stripe",
      source: SRC.sbPricing,
    },
    verdict:
      "Select Two Minute Billing to keep Stripe and drop the percentage. Stay with Stripe Billing if you want Stripe Tax to handle tax for you.",
    faq: [
      {
        label: "Can I keep using Stripe?",
        content:
          "Yes. Stripe still charges the cards and pays you out, at Stripe's own fees. We replace the billing layer: plans, invoices, tax, retries and reports.",
      },
      {
        label: "Is there a fee on top of Stripe's?",
        content:
          "Not a percentage. Cloud is a flat monthly price by billing volume, and the self-hosted edition is free. Stripe's payment fees stay as they are.",
      },
      {
        label: "Who works out the sales tax?",
        content:
          "We do, on every invoice line, from the rates you enter for each state or country. Stripe Tax finds the rates for you and helps you file, for its own fee per transaction.",
      },
      {
        label: "Can I bill for usage?",
        content:
          "Yes. Record usage as it happens and bill it in arrears with the subscription fee. A late record still bills in the period it happened.",
      },
    ],
    trademark:
      "Stripe and Stripe Billing are trademarks of their owner and are named here only to compare.",
  },
  {
    slug: "paddle-alternative",
    name: "Paddle",
    keyword: "paddle alternative",
    title: "Paddle alternative on your own gateway",
    h1: "A Paddle alternative where you stay the seller",
    eyebrow: "Paddle alternative",
    description:
      "Paddle charges 5% + 50¢ per sale as merchant of record. Two Minute Billing keeps you the seller on your own payment gateway, for a flat monthly price.",
    intro:
      "Paddle is a merchant of record: it sells to your customers, handles the tax and charges 5% + 50¢ per checkout transaction. Two Minute Billing keeps you the seller on your own payment gateway, for a flat monthly price with 0% of revenue. Paddle is the better fit if you want someone else to file your sales tax and VAT.",
    summary: "Be the seller on your own gateway, without a fee on every sale.",
    difference:
      "Paddle is the merchant of record and charges 5% + 50¢ per sale. With us you are the seller, on your own gateway, for a flat price.",
    og: {
      headline: "Paddle alternative",
      title: "Your gateway. Your customers.",
      description: "A flat monthly price. No fee per sale to us.",
    },
    glance: [
      { label: "Price", us: "Flat monthly plan", them: "5% + 50¢ per transaction" },
      { label: "Seller", us: "You", them: "Paddle, as merchant of record" },
      { label: "Tax filing", us: "You, from our figures", them: "Paddle" },
    ],
    rows: [
      {
        label: "Price",
        us: US.price,
        them: "5% + 50¢ per checkout transaction. No monthly fee. Custom pricing for high volume.",
        sources: [SRC.pdPricing],
      },
      {
        label: "Fee on your revenue",
        us: US.fee,
        them: "Yes. 5% of each checkout transaction, plus 50¢.",
        sources: [SRC.pdPricing],
      },
      {
        label: "Other costs",
        us: US.other,
        them: "Its pricing page lists no monthly fees, migration fees or extras. The fee covers payments, tax, fraud protection and chargebacks.",
        sources: [SRC.pdPricing],
      },
      {
        label: "Who is the seller",
        us: US.seller,
        them: "Paddle, as merchant of record.",
        sources: [SRC.pdPricing],
      },
      {
        label: "Payment gateways",
        us: US.gateways,
        them: "Payments run through Paddle, as the seller.",
        sources: [SRC.pdPricing],
      },
      {
        label: "Sales tax and VAT",
        us: US.tax,
        them: "Paddle collects the tax, tracks the filing deadlines and files the returns.",
        sources: [SRC.pdPricing],
      },
      {
        label: "India GST",
        us: US.gst,
        them: "Paddle sells to your customer as merchant of record and handles the tax itself.",
        sources: [SRC.pdPricing],
      },
      {
        label: "Self-hosting and open source",
        us: US.hosting,
        them: HOSTED("pricing page"),
        sources: [SRC.pdPricing],
      },
      {
        label: "Subscription analytics",
        us: US.analytics,
        them: "Payment and revenue analytics, and a free subscription analytics product.",
        sources: [SRC.pdPricing],
      },
    ],
    costs: [
      { text: "5% + 50¢ per checkout transaction.", source: SRC.pdPricing },
      {
        text: "No monthly fees, migration fees or extras, per its pricing page.",
        source: SRC.pdPricing,
      },
      {
        text: "The fee covers payments, tax compliance, fraud protection, chargebacks and buyer support.",
        source: SRC.pdPricing,
      },
      { text: "Custom pricing for high-volume businesses.", source: SRC.pdPricing },
    ],
    fit: {
      us: [
        "You want to be the seller, with the customer and the payment account in your name.",
        "You want 0% of each sale to go to your billing tool.",
        "You can register for sales tax and VAT where you sell, or have an adviser who does.",
      ],
      them: [
        "You want a merchant of record to collect and file sales tax and VAT for you.",
        "You do not want a payment gateway account of your own.",
        "You want one fee that covers payments, tax, fraud protection and chargebacks.",
      ],
    },
    cons: [CON_MOR_TAX, CON_MOR_GATEWAY],
    moving:
      "We have no self-serve import from Paddle. You open your own payment gateway account first, and your past invoices stay in Paddle. Talk to us before you plan a move.",
    hub: {
      price: "5% + 50¢ per transaction",
      fee: "Yes, 5% + 50¢",
      seller: "Paddle",
      gateways: "Through Paddle",
      source: SRC.pdPricing,
    },
    verdict:
      "Select Two Minute Billing to be the seller and pay a flat price. Stay with Paddle if you want someone else to file your sales tax and VAT.",
    faq: [
      {
        label: "How is a merchant of record different from Two Minute Billing?",
        content:
          "A merchant of record sells your product to your customer and handles the payment and the tax. With us you stay the seller: payments go to your own gateway account, and we work out the tax on each invoice for you to file.",
      },
      {
        label: "Who files my sales tax and VAT?",
        content:
          "You do, as the seller. We work out US sales tax, VAT and GST on every invoice line and report what you charged, so your filing starts from the right figures.",
      },
      {
        label: "How do the costs compare?",
        content:
          "Paddle charges 5% + 50¢ per checkout transaction, which covers payments and tax. With us you pay a flat monthly price, your gateway's processing fees, and any tax adviser or service you use. Compare the three at your own volume.",
      },
    ],
    trademark: "Paddle is a trademark of its owner and is named here only to compare.",
  },
  {
    slug: "recurly-alternative",
    name: "Recurly",
    keyword: "recurly alternative",
    title: "Recurly alternative: flat monthly price",
    h1: "A Recurly alternative with a flat monthly price",
    eyebrow: "Recurly alternative",
    description:
      "Compare Recurly with Two Minute Billing: a flat monthly price and 0% of revenue instead of $249 + 0.9%, open source, on your own payment gateway.",
    intro:
      "Recurly and Two Minute Billing both bill through your own payment gateway. Recurly's Starter plan is $249 a month plus 0.9% of billing volume above $40K. We charge a flat monthly price with 0% of revenue, and the engine is open source. Recurly has built-in US sales tax rates and more gateways.",
    summary: "A flat monthly price instead of a fee plus a percentage of billing.",
    difference:
      "Recurly charges a monthly fee plus a percentage of billing volume. We charge a flat monthly price, and the engine is open source.",
    og: {
      headline: "Recurly alternative",
      title: "A flat price. 0% of revenue.",
      description: "Open source, on your own payment gateway.",
    },
    glance: [
      { label: "Price", us: "Flat monthly plan", them: "$249 a month + 0.9%" },
      { label: "Self-hosting", us: "Free, every feature", them: "Hosted service" },
      { label: "Gateway", us: "Your own account", them: "Your own account" },
    ],
    rows: [
      {
        label: "Price",
        us: US.price,
        them: "Starter: $249 a month + 0.9% of billing volume, with the first $40K each month included. All-Access: as low as under 1%, billed annually.",
        sources: [SRC.rcPricing],
      },
      {
        label: "Fee on your revenue",
        us: US.fee,
        them: "Yes. A percentage of billing volume on both plans.",
        sources: [SRC.rcPricing],
      },
      {
        label: "Other costs",
        us: US.other,
        them: "All-Access has a $1M billing volume minimum. Custom reporting and more analytics are on All-Access.",
        sources: [SRC.rcPricing],
      },
      {
        label: "Who is the seller",
        us: US.seller,
        them: "You, through one of its gateways.",
        sources: [SRC.rcPricing],
      },
      {
        label: "Payment gateways",
        us: US.gateways,
        them: "20+ payment gateways on Starter.",
        sources: [SRC.rcPricing],
      },
      {
        label: "Sales tax and VAT",
        us: US.tax,
        them: "Built-in US sales tax, powered by Avalara, on all plans. UK and EU VAT. Your own Avalara or Vertex account for more.",
        sources: [SRC.rcTax, SRC.rcVat],
      },
      {
        label: "India GST",
        us: US.gst,
        them: "Its VAT and GST page names several countries. India is not one of them.",
        sources: [SRC.rcVat],
      },
      {
        label: "Self-hosting and open source",
        us: US.hosting,
        them: HOSTED("pricing page"),
        sources: [SRC.rcPricing],
      },
      {
        label: "Subscription analytics",
        us: US.analytics,
        them: "Custom reporting, more analytics and automated exports on All-Access.",
        sources: [SRC.rcPricing],
      },
    ],
    costs: [
      {
        text: "Starter: $249 a month + 0.9% of billing volume. The first $40K of billings each month is included.",
        source: SRC.rcPricing,
      },
      {
        text: "All-Access: as low as under 1% of billing volume, billed annually, with a $1M billing volume minimum.",
        source: SRC.rcPricing,
      },
      {
        text: "Custom reporting, more analytics and automated exports are on All-Access.",
        source: SRC.rcPricing,
      },
    ],
    fit: {
      us: [
        FIT_FLAT,
        FIT_OPEN,
        "You want every metric, including cohorts and net revenue retention, on every plan.",
      ],
      them: [
        "Your gateway is not one of our 12. Recurly lists 20+.",
        "You want US sales tax rates found for you. Recurly's built-in tax does that on all plans.",
        "You bill more than $1M and want an annual contract at a rate under 1%.",
      ],
    },
    cons: [CON_GATEWAYS, CON_RATES],
    moving: movingNoImport("Recurly"),
    hub: {
      price: "$249 a month + 0.9%",
      fee: "Yes",
      seller: "You",
      gateways: "20+",
      source: SRC.rcPricing,
    },
    verdict:
      "Select Two Minute Billing for a flat price and an engine you can run yourself. Stay with Recurly if your gateway is not on our list or you want tax rates found for you.",
    faq: [
      {
        label: "How does the price compare with Recurly?",
        content:
          "Recurly's Starter plan is $249 a month plus 0.9% of billing volume above the first $40K each month. Our Cloud plans are a flat monthly price by billing volume, with 0% of revenue. The self-hosted edition is free.",
      },
      FAQ_GATEWAY,
      gatewaysFaq("Recurly", "20+ payment gateways"),
    ],
    trademark: "Recurly is a trademark of its owner and is named here only to compare.",
  },
  {
    slug: "chargify-alternative",
    name: "Chargify (Maxio)",
    keyword: "chargify alternative",
    title: "Chargify and Maxio alternative, no demo",
    h1: "A Chargify and Maxio alternative you can start today",
    eyebrow: "Chargify (Maxio) alternative",
    description:
      "Maxio, formerly Chargify, starts with a demo and $599 a month. Two Minute Billing has a Free plan, a flat monthly price and an open-source engine.",
    intro:
      "Chargify is now part of Maxio. Maxio's Grow plan is $599 a month for up to $100K in monthly billings, and you start with a demo. Two Minute Billing has a Free plan while you bill less than {freeBand} a month, then a flat monthly price, and you can sign up today. Maxio connects to more gateways and tax services.",
    summary: "Start free without a demo, or self-host the open-source engine.",
    difference:
      "Maxio starts with a demo and $599 a month. You can sign up for our Free plan today, or self-host the engine.",
    og: {
      headline: "Chargify and Maxio alternative",
      title: "Start today. No demo.",
      description: "A Free plan, then a flat monthly price.",
    },
    glance: [
      { label: "Getting started", us: "Sign up free", them: "Book a demo" },
      { label: "Price", us: "Flat monthly plan", them: "$599 a month, up to $100K" },
      { label: "Self-hosting", us: "Free, every feature", them: "Hosted service" },
    ],
    rows: [
      {
        label: "Getting started",
        us: US.start,
        them: "Book a demo or get a demo. Its homepage shows no self-serve sign-up.",
        sources: [SRC.mxHome],
      },
      {
        label: "Price",
        us: US.price,
        them: "Grow: $599 a month, up to $100K in monthly billings. Scale: get a quote, over $100K.",
        sources: [SRC.mxPricing],
      },
      {
        label: "Fee on your revenue",
        us: US.fee,
        them: "No percentage fee on its pricing page.",
        sources: [SRC.mxPricing],
      },
      {
        label: "Other costs",
        us: US.other,
        them: "Above $100K in monthly billings, the price is by quote.",
        sources: [SRC.mxPricing],
      },
      {
        label: "Payment gateways",
        us: US.gateways,
        them: "20+ payment gateways.",
        sources: [SRC.mxPricing],
      },
      {
        label: "Sales tax and VAT",
        us: US.tax,
        them: "Tax rules you define yourself, or a connected service such as TaxJar or your own Avalara AvaTax account. Its Managed Sales Tax ends on November 20, 2026.",
        sources: [SRC.mxTax],
      },
      {
        label: "India GST",
        us: US.gst,
        them: "Tax rules you define yourself, or a connected tax service.",
        sources: [SRC.mxTax],
      },
      {
        label: "Self-hosting and open source",
        us: US.hosting,
        them: "Hosted service. Its homepage and pricing page list no self-hosted or open-source edition.",
        sources: [SRC.mxHome, SRC.mxPricing],
      },
      {
        label: "Subscription analytics",
        us: US.analytics,
        them: "Subscription momentum, cohorts and renewal rate, with churn, retention and lifetime value.",
        sources: [SRC.mxPricing],
      },
    ],
    costs: [
      { text: "Grow: $599 a month, up to $100K in monthly billings.", source: SRC.mxPricing },
      { text: "Scale: get a quote, over $100K in monthly billings.", source: SRC.mxPricing },
      { text: "No percentage fee is listed on its pricing page.", source: SRC.mxPricing },
    ],
    fit: {
      us: ["You want to start today, without a demo or a sales call.", FIT_FREE, FIT_OPEN],
      them: [
        "Your gateway is not one of our 12. Maxio lists 20+.",
        "You want a connected tax service such as TaxJar or Avalara AvaTax to find the rates.",
        "You want its subscription momentum report and cohort reporting.",
      ],
    },
    cons: [CON_GATEWAYS, CON_RATES],
    moving: movingNoImport("Maxio"),
    hub: {
      price: "$599 a month, up to $100K",
      fee: "None listed",
      seller: "You",
      gateways: "20+",
      source: SRC.mxPricing,
    },
    verdict:
      "Select Two Minute Billing to start today on a Free plan, or to self-host. Stay with Maxio if you need a gateway or tax service we do not connect to.",
    faq: [
      {
        label: "Is Chargify the same as Maxio?",
        content:
          "Chargify and SaaSOptics merged in April 2022 and relaunched as Maxio. This page compares Two Minute Billing with Maxio's billing as it is sold today.",
      },
      FAQ_GATEWAY,
      gatewaysFaq("Maxio", "20+ payment gateways"),
    ],
    trademark:
      "Chargify and Maxio are trademarks of their owner and are named here only to compare.",
  },
  {
    slug: "zuora-alternative",
    name: "Zuora",
    keyword: "zuora alternative",
    title: "Zuora alternative with published prices",
    h1: "A Zuora alternative with prices you can read",
    eyebrow: "Zuora alternative",
    description:
      "Zuora publishes no list prices. Two Minute Billing shows its prices, has a Free plan, and bills through your own payment gateway, on our Cloud or yours.",
    intro:
      "Zuora publishes no list prices: you speak to an expert first. Two Minute Billing shows its prices, has a Free plan while you bill less than {freeBand} a month, and bills through your own payment gateway. Zuora lists many more gateways and tax engine connectors.",
    summary: "Published prices, and a free start without a sales call.",
    difference:
      "Zuora publishes no list prices and starts with an expert call. Our prices are on our pricing page, and you can start free today.",
    og: {
      headline: "Zuora alternative",
      title: "Prices you can read.",
      description: "Start free today. No sales call.",
    },
    glance: [
      { label: "Prices", us: "Published", them: "By quote" },
      { label: "Getting started", us: "Sign up free", them: "Speak to an expert" },
      { label: "Self-hosting", us: "Free, every feature", them: "Hosted service" },
    ],
    rows: [
      {
        label: "Getting started",
        us: US.start,
        them: "Speak to an expert, or watch a demo.",
        sources: [SRC.zuPricing],
      },
      {
        label: "Price",
        us: US.price,
        them: "Not publicly available. Its pricing page shows no list prices.",
        sources: [SRC.zuPricing],
      },
      {
        label: "Fee on your revenue",
        us: US.fee,
        them: "Not publicly available.",
        sources: [SRC.zuPricing],
      },
      {
        label: "Other costs",
        us: US.other,
        them: "Gateway connectors not in its list are built on request, at extra cost.",
        sources: [SRC.zuGateways],
      },
      {
        label: "Payment gateways",
        us: US.gateways,
        them: "54 gateways in its docs, Stripe and PayPal among them.",
        sources: [SRC.zuGateways],
      },
      {
        label: "Sales tax and VAT",
        us: US.tax,
        them: "Zuora Tax applies rates you load from CSV files, matched by address. Or a tax engine such as Avalara.",
        sources: [SRC.zuTax],
      },
      {
        label: "India GST",
        us: US.gst,
        them: "Not named on the tax pages we checked.",
        sources: [SRC.zuTax],
      },
      {
        label: "Self-hosting and open source",
        us: US.hosting,
        them: HOSTED("pricing page"),
        sources: [SRC.zuPricing],
      },
      {
        label: "Subscription analytics",
        us: US.analytics,
        them: "Zuora Reporting: reports for MRR, churn, usage and deferred revenue, at no extra cost.",
        sources: [SRC.zuReporting],
      },
    ],
    costs: [
      { text: "No list prices. You speak to an expert for a price.", source: SRC.zuPricing },
      {
        text: "Gateway connectors not in its list are built on request, at extra cost.",
        source: SRC.zuGateways,
      },
      { text: "Zuora Reporting is included at no extra cost.", source: SRC.zuReporting },
    ],
    fit: {
      us: ["You want published prices and a start without a sales call.", FIT_FREE, FIT_OPEN],
      them: [
        "Your gateway is not one of our 12. Zuora's docs list 54.",
        "You use a tax engine such as Avalara through Zuora's connectors.",
        "You want standard reports for deferred revenue beside MRR and churn.",
      ],
    },
    cons: [CON_GATEWAYS, CON_RATES],
    moving: movingNoImport("Zuora"),
    hub: {
      price: "By quote",
      fee: "Not published",
      seller: "You",
      gateways: "54 in its docs",
      source: SRC.zuPricing,
    },
    verdict:
      "Select Two Minute Billing for published prices and a start without a sales call. Stay with Zuora if you depend on a gateway or tax engine we do not connect to.",
    faq: [
      FAQ_GATEWAY,
      {
        label: "Can one account run several businesses?",
        content:
          "Yes. An organization holds many businesses, each with its own catalog, currency, tax settings and payment gateway, and its own test mode.",
      },
      gatewaysFaq("Zuora", "54 gateways in its docs"),
    ],
    trademark: "Zuora is a trademark of its owner and is named here only to compare.",
  },
  {
    slug: "lemon-squeezy-alternative",
    name: "Lemon Squeezy",
    keyword: "lemon squeezy alternative",
    title: "Lemon Squeezy alternative: own gateway",
    h1: "A Lemon Squeezy alternative on your own payment gateway",
    eyebrow: "Lemon Squeezy alternative",
    description:
      "Lemon Squeezy charges 5% + 50¢ plus surcharges per sale. Two Minute Billing keeps you the seller on your own gateway, for a flat price and 0% of revenue.",
    intro:
      "Lemon Squeezy is a merchant of record. It charges 5% + 50¢ per transaction, plus surcharges for subscriptions, PayPal and sales outside the US. Two Minute Billing keeps you the seller on your own payment gateway, for a flat monthly price with 0% of revenue. Lemon Squeezy is the better fit if you want it to take on sales tax and VAT.",
    summary: "Your own gateway and a flat price, instead of a fee on every sale.",
    difference:
      "Lemon Squeezy is the merchant of record and charges 5% + 50¢ plus surcharges per sale. With us you are the seller, on your own gateway.",
    og: {
      headline: "Lemon Squeezy alternative",
      title: "Your gateway. Your customers.",
      description: "A flat monthly price. No fee per sale to us.",
    },
    glance: [
      { label: "Price", us: "Flat monthly plan", them: "5% + 50¢, plus surcharges" },
      { label: "Seller", us: "You", them: "Lemon Squeezy" },
      { label: "Self-hosting", us: "Free, every feature", them: "Hosted service" },
    ],
    rows: [
      {
        label: "Price",
        us: US.price,
        them: "5% + 50¢ per transaction. No monthly fee for its ecommerce features.",
        sources: [SRC.lsPricing],
      },
      {
        label: "Fee on your revenue",
        us: US.fee,
        them: "Yes. 5% + 50¢, plus 0.5% on subscription payments, 1.5% outside the US and 1.5% on PayPal.",
        sources: [SRC.lsFees],
      },
      {
        label: "Other costs",
        us: US.other,
        them: "5% on payments recovered by abandoned-cart emails. 1% per payout to a bank account outside the US.",
        sources: [SRC.lsFees],
      },
      {
        label: "Who is the seller",
        us: US.seller,
        them: "Lemon Squeezy, as merchant of record.",
        sources: [SRC.lsPricing],
      },
      {
        label: "Payment gateways",
        us: US.gateways,
        them: "Payments run through Lemon Squeezy, as the seller.",
        sources: [SRC.lsPricing],
      },
      {
        label: "Sales tax and VAT",
        us: US.tax,
        them: "It takes on tax calculation and collection liability in all jurisdictions.",
        sources: [SRC.lsPricing],
      },
      {
        label: "India GST",
        us: US.gst,
        them: "As merchant of record, it takes on tax calculation and collection liability in all jurisdictions.",
        sources: [SRC.lsPricing],
      },
      {
        label: "Self-hosting and open source",
        us: US.hosting,
        them: HOSTED("pricing page"),
        sources: [SRC.lsPricing],
      },
      {
        label: "Subscription analytics",
        us: US.analytics,
        them: "Revenue insights such as MRR, refunds and average order value.",
        sources: [SRC.lsPricing],
      },
    ],
    costs: [
      { text: "5% + 50¢ per transaction.", source: SRC.lsPricing },
      { text: "Plus 0.5% on subscription payments.", source: SRC.lsFees },
      {
        text: "Plus 1.5% on transactions outside the US, and 1.5% on PayPal transactions.",
        source: SRC.lsFees,
      },
      { text: "Plus 5% on payments recovered by abandoned-cart emails.", source: SRC.lsFees },
      {
        text: "Payouts are free to US bank accounts and 1% each to bank accounts outside the US.",
        source: SRC.lsFees,
      },
    ],
    fit: {
      us: [
        "You want to be the seller, on your own payment gateway account.",
        "You want 0% of each sale to go to your billing tool.",
        FIT_OPEN,
      ],
      them: [
        "You want a merchant of record to take on tax calculation and collection.",
        "You do not want a payment gateway account of your own.",
        "You plan to follow its path to Stripe Managed Payments.",
      ],
    },
    cons: [CON_MOR_TAX, CON_MOR_GATEWAY],
    moving:
      "We have no self-serve import from Lemon Squeezy. You open your own payment gateway account first, and your past orders stay in Lemon Squeezy. Talk to us before you plan a move.",
    hub: {
      price: "5% + 50¢, plus surcharges",
      fee: "Yes, 5% + 50¢ and more",
      seller: "Lemon Squeezy",
      gateways: "Through Lemon Squeezy",
      source: SRC.lsFees,
    },
    verdict:
      "Select Two Minute Billing to be the seller on your own gateway, for a flat price. Stay with Lemon Squeezy if you want a merchant of record to handle tax for you.",
    faq: [
      {
        label: "How is a merchant of record different from Two Minute Billing?",
        content:
          "A merchant of record sells your product to your customer and handles the payment and the tax. With us you stay the seller: payments go to your own gateway account, and we work out the tax on each invoice for you to file.",
      },
      {
        label: "Who files my sales tax and VAT?",
        content:
          "You do, as the seller. We work out US sales tax, VAT and GST on every invoice line and report what you charged, so your filing starts from the right figures.",
      },
      {
        label: "What is Lemon Squeezy's plan with Stripe?",
        content:
          "Stripe acquired Lemon Squeezy in 2024. In January 2026 Lemon Squeezy wrote that its goal is an easy way for its users to move to Stripe Managed Payments, Stripe's merchant of record product. The post gives no date.",
      },
    ],
    trademark:
      "Lemon Squeezy and Stripe are trademarks of their owners and are named here only to compare.",
  },
];

/** The /compare hub's methodology and the pages' footer use the same words. */
export const COMPARE_METHOD =
  "We read each product's public pricing pages and docs, and note the date we checked them. We do not test their products or use review scores.";

export function findComparison(slug: string): Comparison | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}

/** The comparison pages as site links: the footer and the sitemap read these. */
export const COMPARE: SiteLink[] = COMPARISONS.map((c) => ({
  label: `${c.name} alternative`,
  to: `/compare/${c.slug}`,
  description: c.summary,
}));
