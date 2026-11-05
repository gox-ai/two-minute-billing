/**
 * Every navigable page the sidebars do not already list, for the ⌘K palette.
 *
 * The sidebars (`businessNavTargets`, the org rail in the dashboard layout) cover the
 * top-level destinations; this covers what is otherwise reachable only by clicking
 * through a page — the settings sub-pages above all. `pnpm verify:palette-coverage`
 * fails when a `page.tsx` route is in neither place, so a new page cannot be
 * forgotten here.
 *
 * Labels match the page's own header (or the settings row that links to it), so what
 * the operator types is what they will see on arrival. No imports on purpose: the
 * coverage gate loads this file from `scripts/`.
 */

export interface PalettePage {
  /** `biz`: `path` is under `/businesses/<biz>`. `org`: `path` is absolute. */
  scope: "biz" | "org";
  /** May carry a `#section` anchor; the gate compares the part before it. */
  path: string;
  label: string;
  section: string;
  keywords?: string[];
}

/** Pages that create a record, shown in the palette's Create group. Paths under the business. */
export const CREATE_PAGES: Array<{ label: string; path: string; section: string; idle: boolean }> =
  [
    { label: "Create customer", path: "customers/new", section: "Customers", idle: true },
    {
      label: "Create subscription",
      path: "subscriptions/new",
      section: "Subscriptions",
      idle: true,
    },
    { label: "Create plan", path: "catalog/plans/new", section: "Product Catalog", idle: true },
    { label: "Create coupon", path: "catalog/coupons/new", section: "Product Catalog", idle: true },
    { label: "Create addon", path: "catalog/addons/new", section: "Product Catalog", idle: false },
    {
      label: "Create charge",
      path: "catalog/charges/new",
      section: "Product Catalog",
      idle: false,
    },
    { label: "Create meter", path: "catalog/meters/new", section: "Product Catalog", idle: false },
    {
      label: "Create credit note",
      path: "credit_notes/new",
      section: "Invoices & Credit Notes",
      idle: false,
    },
  ];

const SETTINGS = "Settings";
const RULES = "Billing rules";
const EMAIL = "Email notifications";

export const PALETTE_PAGES: PalettePage[] = [
  // ── business settings (the hub at /settings) ──
  {
    scope: "biz",
    path: "/settings/business-profile",
    label: "Business profile",
    section: SETTINGS,
    keywords: ["address", "time zone", "timezone", "contact"],
  },
  {
    scope: "biz",
    path: "/settings/brand",
    label: "Brand styles",
    section: SETTINGS,
    keywords: ["logo", "colour", "color", "favicon", "branding"],
  },
  {
    scope: "biz",
    path: "/settings/billing-frequencies",
    label: "Billing frequencies",
    section: SETTINGS,
    keywords: ["product catalog", "intervals", "periods"],
  },
  {
    scope: "biz",
    path: "/settings/currencies",
    label: "Currencies",
    section: SETTINGS,
    keywords: ["exchange rates", "fx", "multi-currency"],
  },
  {
    scope: "biz",
    path: "/settings/gateways/new",
    label: "Add a gateway",
    section: SETTINGS,
    keywords: [
      "payment gateway",
      "connect",
      "stripe",
      "razorpay",
      "paypal",
      "braintree",
      "adyen",
      "checkout.com",
      "authorize.net",
      "square",
      "mollie",
      "payu",
      "cybersource",
    ],
  },
  {
    scope: "biz",
    path: "/settings/hosted-pages",
    label: "Hosted pages",
    section: SETTINGS,
    keywords: ["checkout", "portal", "self-serve", "coupon codes"],
  },
  {
    scope: "biz",
    path: "/settings/checkout-fields",
    label: "Checkout and portal fields",
    section: SETTINGS,
    keywords: ["avs", "zip", "postal code", "address verification", "portal", "billing address"],
  },
  {
    scope: "biz",
    path: "/settings/invoices",
    label: "Invoices",
    section: SETTINGS,
    keywords: ["invoice settings", "numbering", "prefix", "invoice note"],
  },
  {
    scope: "biz",
    path: "/settings/credit-notes",
    label: "Credit notes",
    section: SETTINGS,
    keywords: ["credit note settings", "numbering", "prefix"],
  },
  {
    scope: "biz",
    path: "/settings/metadata-rules",
    label: "Metadata rules",
    section: SETTINGS,
    keywords: ["metadata", "validation", "schema", "strict", "json", "keys"],
  },
  {
    scope: "biz",
    path: "/settings/documents",
    label: "Documents",
    section: SETTINGS,
    keywords: ["signature", "seller address", "invoice fields"],
  },
  {
    scope: "biz",
    path: "/settings/payment-instructions",
    label: "Payment instructions",
    section: SETTINGS,
    keywords: ["offline payments", "bank transfer", "wire"],
  },
  {
    scope: "biz",
    path: "/settings/dunning",
    label: "Dunning for failed payments",
    section: SETTINGS,
    keywords: [
      "dunning",
      "retries",
      "retry schedule",
      "failed payments",
      "recovery",
      "involuntary churn",
    ],
  },
  {
    scope: "biz",
    path: "/settings/dunning/policies",
    label: "Dunning policies",
    section: SETTINGS,
    keywords: ["dunning policy", "customer dunning", "retry schedule"],
  },
  {
    scope: "biz",
    path: "/settings/dunning/policies/new",
    label: "Create dunning policy",
    section: SETTINGS,
    keywords: ["dunning policy"],
  },
  {
    scope: "biz",
    path: "/settings/credits",
    label: "Credits",
    section: SETTINGS,
    keywords: ["prepaid credit", "blocking", "overdraft", "holds", "credit packs", "top-up limits"],
  },
  {
    scope: "biz",
    path: "/settings/credit-units",
    label: "Credit units",
    section: SETTINGS,
    keywords: ["custom units", "tokens", "credit rate"],
  },
  {
    scope: "biz",
    path: "/settings/usage-controls",
    label: "Usage controls",
    section: SETTINGS,
    keywords: ["spend limits", "limit tiers", "usage alerts", "usage widget", "allowed origins"],
  },
  {
    scope: "biz",
    path: "/settings/credit-units/new",
    label: "Create credit unit",
    section: SETTINGS,
    keywords: ["custom units", "tokens"],
  },
  {
    scope: "biz",
    path: "/settings/receipts",
    label: "Receipts",
    section: SETTINGS,
    keywords: ["receipt numbering", "receipt prefix"],
  },
  {
    scope: "biz",
    path: "/settings/decline-rules",
    label: "Error handling",
    section: SETTINGS,
    keywords: ["decline rules", "decline codes", "gateway errors"],
  },

  // ── billing rules (the hub at /settings/billing-rules) ──
  {
    scope: "biz",
    path: "/settings/billing-rules/subscription-cancellation",
    label: "Subscription cancellation",
    section: RULES,
    keywords: ["cancel"],
  },
  {
    scope: "biz",
    path: "/settings/billing-rules/update-subscription",
    label: "Update subscription",
    section: RULES,
    keywords: ["proration", "change plan", "upgrade", "downgrade"],
  },
  {
    scope: "biz",
    path: "/settings/billing-rules/pause-resume",
    label: "Pause and resume",
    section: RULES,
    keywords: ["pause"],
  },
  { scope: "biz", path: "/settings/billing-rules/backdating", label: "Backdating", section: RULES },
  {
    scope: "biz",
    path: "/settings/billing-rules/billing-mode",
    label: "Billing mode",
    section: RULES,
    keywords: ["calendar billing", "anniversary"],
  },
  {
    scope: "biz",
    path: "/settings/billing-rules/round-off",
    label: "Round-off invoice amount",
    section: RULES,
    keywords: ["rounding"],
  },
  {
    scope: "biz",
    path: "/settings/billing-rules/credits-flexibility",
    label: "Credits flexibility",
    section: RULES,
    keywords: ["promotional credits", "credits"],
  },
  {
    scope: "biz",
    path: "/settings/billing-rules/unbilled-charges",
    label: "Unbilled charges",
    section: RULES,
  },
  {
    scope: "biz",
    path: "/settings/billing-rules/usage-close",
    label: "Usage close",
    section: RULES,
    keywords: ["metered usage", "late usage", "invoice delay"],
  },
  {
    scope: "biz",
    path: "/settings/billing-rules/payment-terms",
    label: "Payment terms",
    section: RULES,
    keywords: ["net 30", "due date"],
  },
  {
    scope: "biz",
    path: "/settings/billing-rules/chargebacks",
    label: "Chargeback management",
    section: RULES,
    keywords: ["disputes", "chargebacks"],
  },
  {
    scope: "biz",
    path: "/settings/billing-rules/subscription-reactivation",
    label: "Subscription reactivation",
    section: RULES,
    keywords: ["reactivate"],
  },

  // ── email notifications (the hub at /settings/emails) ──
  {
    scope: "biz",
    path: "/settings/emails/sender",
    label: "Sender",
    section: EMAIL,
    keywords: ["email", "from address", "reply-to", "footer"],
  },
  {
    scope: "biz",
    path: "/settings/emails/delivery",
    label: "Delivery",
    section: EMAIL,
    keywords: ["email", "mail transport", "smtp", "ses"],
  },
  {
    scope: "biz",
    path: "/settings/emails/delivery/smtp",
    label: "SMTP server",
    section: EMAIL,
    keywords: ["email"],
  },
  {
    scope: "biz",
    path: "/settings/emails/delivery/ses",
    label: "Amazon SES",
    section: EMAIL,
    keywords: ["email"],
  },
  {
    scope: "biz",
    path: "/settings/emails/delivery/test",
    label: "Test delivery",
    section: EMAIL,
    keywords: ["email", "send test email"],
  },
  {
    scope: "biz",
    path: "/settings/emails/suppressions",
    label: "Suppressed addresses",
    section: EMAIL,
    keywords: ["email", "bounces", "unsubscribes", "suppressions"],
  },

  // ── other business pages ──
  {
    scope: "biz",
    path: "/integrations/hubspot",
    label: "HubSpot",
    section: "Integrations",
    keywords: ["crm", "sync"],
  },

  // ── organization ──
  {
    scope: "org",
    path: "/settings/model-prices",
    label: "Model prices",
    section: "Settings",
    keywords: ["ai", "llm", "tokens", "your cost", "price list"],
  },
  {
    scope: "org",
    path: "/account",
    label: "Your account",
    section: "Account",
    keywords: ["profile", "name", "photo", "avatar"],
  },
  {
    scope: "org",
    path: "/account#appearance",
    label: "Appearance",
    section: "Your account",
    keywords: ["theme", "dark mode", "light mode"],
  },
  {
    scope: "org",
    path: "/account#password",
    label: "Password",
    section: "Your account",
    keywords: ["change password"],
  },
  {
    scope: "org",
    path: "/account#two-factor",
    label: "Two-factor authentication",
    section: "Your account",
    keywords: ["2fa", "mfa", "authenticator", "recovery codes", "passkey"],
  },
  {
    scope: "org",
    path: "/account#sessions",
    label: "Active sessions",
    section: "Your account",
    keywords: ["sign out", "browsers", "devices"],
  },
  {
    scope: "org",
    path: "/account#trusted-browsers",
    label: "Trusted browsers",
    section: "Your account",
    keywords: ["remembered", "forget browser"],
  },
  {
    scope: "org",
    path: "/settings#security",
    label: "Security",
    section: SETTINGS,
    keywords: ["require two-factor", "2fa policy", "mfa"],
  },
  {
    scope: "org",
    path: "/developer#api-keys",
    label: "API keys",
    section: "Developers",
    keywords: ["keys", "tokens"],
  },
  {
    scope: "org",
    path: "/developer#webhook-endpoints",
    label: "Webhooks",
    section: "Developers",
    keywords: ["endpoints", "events"],
  },
  { scope: "org", path: "/developer#recent-events", label: "Recent events", section: "Developers" },
];
