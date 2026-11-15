import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/states";
import { RecordCrumbs } from "@/components/patterns/record-page";
import type { Crumb } from "@/components/page-header";

/** What a missing record is called and where its list lives, by route segment. */
const BUSINESS_SECTIONS: Record<string, { thing: string; list: string; href: string }> = {
  customers: { thing: "customer", list: "View customers", href: "customers" },
  subscriptions: { thing: "subscription", list: "View subscriptions", href: "subscriptions" },
  invoices: { thing: "invoice", list: "View invoices", href: "invoices" },
  credit_notes: { thing: "credit note", list: "View credit notes", href: "credit_notes" },
  transactions: { thing: "transaction", list: "View transactions", href: "transactions" },
  disputes: { thing: "dispute", list: "View disputes", href: "disputes" },
  payment_requests: {
    thing: "payment request",
    list: "View payment requests",
    href: "payment_requests",
  },
  payment_intents: {
    thing: "payment intent",
    list: "View payment intents",
    href: "payment_intents",
  },
  events: { thing: "event", list: "View events", href: "events" },
  emails: { thing: "email", list: "View emails", href: "emails" },
  retries: { thing: "retry", list: "View retries", href: "retries" },
  receipts: { thing: "receipt", list: "View receipts", href: "receipts" },
  audit: { thing: "audit entry", list: "View audit log", href: "audit" },
  "catalog/products": { thing: "product", list: "View products", href: "catalog/products" },
  "catalog/plans": { thing: "plan", list: "View plans", href: "catalog/plans" },
  "catalog/addons": { thing: "add-on", list: "View add-ons", href: "catalog/addons" },
  "catalog/charges": { thing: "charge", list: "View charges", href: "catalog/charges" },
  "catalog/prices": { thing: "price", list: "View prices", href: "catalog/prices" },
  "catalog/coupons": { thing: "coupon", list: "View coupons", href: "catalog/coupons" },
  "catalog/coupon_sets": {
    thing: "coupon set",
    list: "View coupon sets",
    href: "catalog/coupon_sets",
  },
  "catalog/meters": { thing: "meter", list: "View meters", href: "catalog/meters" },
  "catalog/product_groups": {
    thing: "product group",
    list: "View product groups",
    href: "catalog/product_groups",
  },
  "catalog/tax": { thing: "tax region", list: "View taxes", href: "catalog/tax" },
  "catalog/payment_links": {
    thing: "payment link",
    list: "View payment links",
    href: "catalog/payment_links",
  },
  "settings/gateways": { thing: "gateway", list: "View gateways", href: "settings/gateways" },
  "settings/credit-units": {
    thing: "credit unit",
    list: "View credit units",
    href: "settings/credit-units",
  },
  "settings/dunning": {
    thing: "dunning policy",
    list: "View dunning settings",
    href: "settings/dunning",
  },
  settings: { thing: "setting", list: "View settings", href: "settings" },
  catalog: { thing: "catalog page", list: "View plans", href: "catalog/plans" },
};

const ORG_SECTIONS: Record<string, { thing: string; list: string; href: string }> = {
  "developer/webhooks": {
    thing: "webhook endpoint",
    list: "View webhooks",
    href: "/developer/webhooks",
  },
  "developer/logs": { thing: "request", list: "View request logs", href: "/developer/logs" },
  developer: { thing: "developer page", list: "View developers", href: "/developer" },
  team: { thing: "member", list: "View team", href: "/team" },
  settings: { thing: "setting", list: "View settings", href: "/settings" },
  audit: { thing: "audit entry", list: "View audit log", href: "/audit" },
  reports: { thing: "report", list: "View metrics", href: "/metrics" },
};

/** "View customers" → "Customers", for the crumb. */
const crumbLabel = (list: string) => {
  const rest = list.replace(/^View /, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
};

/** Longest matching section for the segments after the scope: `catalog/plans` before `catalog`. */
function section<T>(table: Record<string, T>, segments: string[]): T | null {
  for (let n = Math.min(segments.length, 2); n > 0; n--) {
    const hit = table[segments.slice(0, n).join("/")];
    if (hit) return hit;
  }
  return null;
}

/**
 * The branded not-found page, inside the shell: crumbs to the nearest list, then one
 * `EmptyState` with ONE way out. The business variant names the business, never its id.
 */
export function NotFoundPage({
  path,
  business,
}: {
  /** The requested path (from `x-tmb-path`); decides the nearest list. */
  path: string;
  /** Set inside `/businesses/[biz]`: the id and its resolved name. */
  business?: { id: string; name: string };
}) {
  const segments = path.split("/").filter(Boolean);
  if (business) {
    const rest = segments.slice(2);
    const hit = section(BUSINESS_SECTIONS, rest);
    const home = `/businesses/${business.id}`;
    // Starts at the business, like every other business page.
    const crumbs: Crumb[] = [
      { label: business.name, href: home },
      ...(hit ? [{ label: crumbLabel(hit.list), href: `${home}/${hit.href}` }] : []),
    ];
    return (
      <NotFoundBody
        crumbs={crumbs}
        thing={hit?.thing ?? "page"}
        where={business.name}
        action={{ label: hit?.list ?? "View home", href: hit ? `${home}/${hit.href}` : home }}
      />
    );
  }
  const hit = section(ORG_SECTIONS, segments);
  return (
    <NotFoundBody
      crumbs={[
        { label: "Overview", href: "/" },
        ...(hit ? [{ label: crumbLabel(hit.list), href: hit.href }] : []),
      ]}
      thing={hit?.thing ?? "page"}
      action={hit ? { label: hit.list, href: hit.href } : { label: "View overview", href: "/" }}
    />
  );
}

function NotFoundBody({
  crumbs,
  thing,
  where,
  action,
}: {
  crumbs: Crumb[];
  thing: string;
  where?: string;
  action: { label: string; href: string };
}) {
  const isPage = thing === "page" || thing.endsWith(" page");
  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs items={crumbs} />
      <div className="rounded-xl border bg-card">
        <EmptyState
          icon={<SearchX />}
          title={`We could not find this ${thing}.`}
          description={
            isPage
              ? where
                ? `This address does not exist in ${where}. Check the link, or go back to the list.`
                : "This address does not exist. Check the link, or go back to the overview."
              : where
                ? `It is not in ${where}, or it was deleted. Check the link, or go back to the list.`
                : "It does not exist, or it was deleted. Check the link, or go back to the list."
          }
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={action.href}>{action.label}</Link>
            </Button>
          }
        />
      </div>
    </div>
  );
}
