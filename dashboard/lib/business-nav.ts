import {
  Clock,
  CreditCard,
  Gavel,
  HandCoins,
  Home,
  Package,
  Plug,
  Receipt,
  RotateCcw,
  ScrollText,
  Settings,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { PermissionKey } from "@/lib/permissions.generated";

/**
 * THE BUSINESS-SCOPED NAV, IN ONE PLACE, because it now has two consumers.
 *
 * `BizSideNav` renders it as a sidebar; the ⌘K palette turns the same entries into jump
 * targets. It lived inline in `AppNav.tsx` while the palette kept its own hardcoded list of
 * five ORG destinations — which is exactly how the palette fell three items behind the
 * sidebar and never offered a single business page. A second copy of a nav is a copy that
 * goes stale, and this one had already gone stale twice over.
 *
 * Pure data, no hooks and no `usePathname`, so a server component can call it too.
 */
/**
 * Where an entry sits on the rail, grouped by what the operator is doing: the records they
 * bill against, the money in motion (Logs is mostly payment trails), and what they set up
 * once. `undefined` is the unlabelled top slot — Home and Reports, the business at a glance.
 */
export type BizNavSection = "billing" | "payments" | "setup";
export const BIZ_NAV_SECTION_LABELS: Record<BizNavSection, string> = {
  billing: "Billing",
  payments: "Payments",
  setup: "Setup",
};

export interface BizNavLeaf {
  href: string;
  label: string;
  icon: LucideIcon;
  show: boolean;
  /** exact match required for active (used by the index/Home route) */
  exact?: boolean;
  /**
   * Count of things waiting on a person. Rendered as a badge, and as a dot on the collapsed
   * rail. `undefined` means "not counted" and renders nothing — which is NOT the same as 0, and
   * must not be faked: a badge that saturates at a page size is worse than no badge.
   */
  badge?: number;
  /**
   * `attention` uses the destructive tone; `news` uses the accent. Money with a deadline needs
   * a person, a changelog does not — see the design system on reserving a fill for states
   * needing action.
   */
  badgeTone?: "attention" | "news";
  section?: BizNavSection;
}
export interface BizNavGroup {
  label: string;
  icon: LucideIcon;
  show: boolean;
  section?: BizNavSection;
  children: Array<Omit<BizNavLeaf, "icon" | "section"> & { icon?: LucideIcon }>;
}
export type BizNavEntry = BizNavLeaf | BizNavGroup;
export const isBizNavGroup = (e: BizNavEntry): e is BizNavGroup => "children" in e;

export interface BizNavPerms {
  ops: boolean;
  manager: boolean;
  admin: boolean;
  /** Set for a custom role: entries show by key instead of by level. */
  keys?: readonly string[] | null;
}

/** A fixed role sees an entry by its level (a child by its group); a custom role by its key. */
function sees(
  perms: BizNavPerms,
  key: PermissionKey,
  level?: "ops" | "manager" | "admin",
): boolean {
  if (perms.keys) return perms.keys.includes(key);
  return level ? perms[level] : true;
}

export function businessNavEntries({
  biz,
  perms,
  testMode,
  counts,
}: {
  biz: string;
  perms: BizNavPerms;
  testMode: boolean;
  /**
   * Live counts for the work surfaces. Omit a key to render no badge — the layout soft-fails
   * these, and "we could not count" must not display as zero.
   */
  counts?: { retries?: number };
}): BizNavEntry[] {
  const base = `/businesses/${biz}`;
  return [
    {
      href: base,
      label: "Home",
      icon: Home,
      show: sees(perms, "reports:view", "ops"),
      exact: true,
    },
    // Beside Home, unlabelled: both answer "how is the business doing", and Home already
    // leads with MRR.
    // Reports is three surfaces, not one: boards you arranged, a query builder, and the
    // library of everything placeable. The library was reachable from nothing at all.
    {
      label: "Reports",
      icon: TrendingUp,
      show: sees(perms, "reports:view", "ops"),
      children: [
        {
          href: `${base}/reports/dashboards`,
          label: "Dashboards",
          show: sees(perms, "views:view"),
        },
        { href: `${base}/reports/stats`, label: "Stats", show: true },
        { href: `${base}/reports/explore`, label: "Explore", show: true },
        { href: `${base}/reports/customers`, label: "Customers", show: true },
        { href: `${base}/reports/cancellations`, label: "Cancellations", show: true },
        { href: `${base}/reports/recovery`, label: "Recovery", show: true },
        {
          href: `${base}/reports/usage-margin`,
          label: "Usage margin",
          show: sees(perms, "usage_margin:view", "manager"),
        },
      ],
    },
    {
      href: `${base}/customers`,
      label: "Customers",
      icon: Users,
      show: sees(perms, "customers:view", "manager"),
      section: "billing",
    },
    {
      href: `${base}/subscriptions`,
      label: "Subscriptions",
      icon: CreditCard,
      show: sees(perms, "subscriptions:view", "manager"),
      section: "billing",
    },
    {
      label: "Invoices & Credit Notes",
      icon: Receipt,
      show: sees(perms, "invoices:view", "ops") || sees(perms, "credit_notes:view", "ops"),
      section: "billing",
      children: [
        { href: `${base}/invoices`, label: "Invoices", show: sees(perms, "invoices:view") },
        {
          href: `${base}/credit_notes`,
          label: "Credit Notes",
          show: sees(perms, "credit_notes:view"),
        },
      ],
    },
    /**
     * WORK, NOT HISTORY — moved out of the Logs group (2026-09-09).
     *
     * A dispute is money being clawed back against a deadline; a retry is revenue currently at
     * risk in dunning. Both sat inside a collapsed group called "Logs", beside webhook
     * payloads, and neither is surfaced on the business Home page — so the only way to learn
     * you had a dispute with an evidence deadline was to remember to open a menu named after
     * where the data is stored.
     */
    {
      href: `${base}/retries`,
      label: "Retries",
      icon: RotateCcw,
      show: sees(perms, "invoices:view", "ops"),
      badge: counts?.retries,
      badgeTone: "attention",
      section: "payments",
    },
    {
      href: `${base}/disputes`,
      label: "Disputes",
      icon: Gavel,
      show: sees(perms, "payments:view", "ops"),
      section: "payments",
      // No badge yet, deliberately: the engine's dispute list returns a bare array capped at
      // `min(limit ?? 50, 200)` with no `total`, so any count here would be a page size
      // wearing a number's clothes. Needs the paginated contract first.
    },
    // Requests the business sent for a customer's open invoices: open ones are money to chase.
    {
      href: `${base}/payment_requests`,
      label: "Payment requests",
      icon: HandCoins,
      show: sees(perms, "payments:view", "ops"),
      section: "payments",
    },
    {
      label: "Logs",
      icon: ScrollText,
      show: perms.keys
        ? ["payments:view", "gateways:view", "emails:view", "events:view"].some((k) =>
            perms.keys!.includes(k),
          )
        : perms.ops,
      section: "payments",
      children: [
        { href: `${base}/transactions`, label: "Transactions", show: sees(perms, "payments:view") },
        { href: `${base}/receipts`, label: "Receipts", show: sees(perms, "payments:view") },
        {
          href: `${base}/payment_intents`,
          label: "Payment Intents",
          show: sees(perms, "payments:view"),
        },
        {
          href: `${base}/gateway_webhooks`,
          label: "Gateway Webhooks",
          show: sees(perms, "gateways:view"),
        },
        {
          href: `${base}/gateway_requests`,
          label: "Gateway Requests",
          show: sees(perms, "gateways:view"),
        },
        { href: `${base}/emails`, label: "Emails", show: sees(perms, "emails:view") },
        { href: `${base}/events`, label: "Events", show: sees(perms, "events:view") },
      ],
    },
    {
      label: "Product Catalog",
      icon: Package,
      show: sees(perms, "catalog:view", "manager") || sees(perms, "coupons:view", "manager"),
      section: "setup",
      children: [
        {
          href: `${base}/catalog/product_groups`,
          label: "Product Groups",
          show: sees(perms, "catalog:view"),
        },
        { href: `${base}/catalog/plans`, label: "Plans", show: sees(perms, "catalog:view") },
        { href: `${base}/catalog/addons`, label: "Addons", show: sees(perms, "catalog:view") },
        {
          href: `${base}/catalog/charges`,
          label: "One-time products",
          show: sees(perms, "catalog:view"),
        },
        { href: `${base}/catalog/meters`, label: "Meters", show: sees(perms, "catalog:view") },
        {
          href: `${base}/catalog/payment_links`,
          label: "Payment links",
          show: sees(perms, "payments:view"),
        },
        { href: `${base}/catalog/coupons`, label: "Coupons", show: sees(perms, "coupons:view") },
        {
          href: `${base}/catalog/coupon_sets`,
          label: "Coupon Sets",
          show: sees(perms, "coupons:view"),
        },
        { href: `${base}/catalog/tax`, label: "Taxes", show: sees(perms, "taxes:view") },
      ],
    },
    {
      href: `${base}/integrations`,
      label: "Integrations",
      icon: Plug,
      show: sees(perms, "integrations:view", "admin"),
      section: "setup",
    },
    {
      label: "Settings",
      icon: Settings,
      show: sees(perms, "settings:manage", "admin"),
      section: "setup",
      children: [
        { href: `${base}/settings`, label: "Configure", show: true, exact: true },
        { href: `${base}/settings/billing-rules`, label: "Billing rules", show: true },
        {
          href: `${base}/settings/gateways`,
          label: "Payment Gateways",
          show: sees(perms, "gateways:manage"),
        },
        {
          href: `${base}/settings/emails`,
          label: "Email Notifications",
          show: sees(perms, "emails:view"),
        },
        // Was reachable only from a link inside the old settings page.
        { href: `${base}/settings/custom-fields`, label: "Custom Fields", show: true },
        { href: `${base}/settings/reason-codes`, label: "Reason Codes", show: true },
        {
          href: `${base}/transfer`,
          label: "Transfer & Sample Data",
          show: sees(perms, "transfers:manage"),
        },
        { href: `${base}/audit`, label: "Audit Log", show: sees(perms, "audit_logs:view") },
      ],
    },
    // Time Travel only makes sense on sandbox businesses (backend is test-mode gated).
    {
      href: `${base}/time_travel`,
      label: "Time Travel",
      icon: Clock,
      show: sees(perms, "test_tools:manage", "admin") && testMode,
      section: "setup",
    },
  ];
}

/**
 * Every VISIBLE destination, flattened for the palette: a group contributes its children
 * rather than itself, because a group heading is not somewhere you can go. The group label
 * rides along as `section` so the palette can say "Product Catalog › Plans" and so typing
 * "catalog" finds Plans — which is how people actually remember where a page lives.
 */
export function businessNavTargets(args: {
  biz: string;
  perms: BizNavPerms;
  testMode: boolean;
}): Array<{ href: string; label: string; section?: string; icon?: LucideIcon }> {
  const out: Array<{ href: string; label: string; section?: string; icon?: LucideIcon }> = [];
  for (const e of businessNavEntries(args)) {
    if (!e.show) continue;
    if (isBizNavGroup(e)) {
      for (const c of e.children) {
        if (c.show) out.push({ href: c.href, label: c.label, section: e.label, icon: e.icon });
      }
    } else {
      out.push({ href: e.href, label: e.label, icon: e.icon });
    }
  }
  return out;
}
