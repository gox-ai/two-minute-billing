import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import type { TeamAlertsConfig } from "@/lib/api";
import { composeDocumentNumber } from "@/lib/document-numbering";
import { resolveCreditConfig, type CreditConfigInput } from "@/lib/credits";
import { businessTz } from "@/lib/business-tz-server";
import { listGatewayAccounts, getGatewayCatalogOrEmpty } from "@/lib/api/gateways";
import { gatewayDisplayName } from "@/components/gateways/gateway-meta";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { SettingsLinkRow, SettingsPage } from "@/components/settings/settings-layout";
import { SettingsGroup, SettingsHub } from "@/components/patterns/settings-hub";
import {
  resolveEmailSummary,
  dunningSummary,
  currencySummary,
  frequencySummary,
  brandSummary,
} from "./summaries";

export const dynamic = "force-dynamic";

// The settings hub for a business: two-column groups (name and blurb left, a card of
// linked rows right), one row per page. Everything business-scoped lives here; the org-scoped pages (API keys, team, webhooks) hang off the
// Account group at the bottom rather than a second settings surface the
// operator has to know about.
//
// Every row's `value` is read off a real field. Rows with nothing meaningful to
// summarize pass no hint rather than a placeholder (Rule 0).
export default async function BusinessSettingsHub({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");

  let b;
  try {
    b = await getBusiness(biz);
  } catch (e) {
    return (
      <>
        <PageHeader title="Settings" breadcrumbs={[{ label: "Settings" }]} />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  if (!b) {
    return (
      <>
        <PageHeader title="Settings" breadcrumbs={[{ label: "Settings" }]} />
        <ErrorState title="Not found" description={`We could not find the business ${biz}.`} />
      </>
    );
  }

  // Same composition as Settings → Invoices / Credit notes, so the hub never shows a
  // number those pages would not.
  const tz = await businessTz(biz);
  const biz0 = b;
  const nextDoc = (kind: "invoice" | "credit_note") => {
    const n = biz0.invoice_customization?.[kind]?.numbering ?? null;
    return composeDocumentNumber({
      prefix:
        (kind === "invoice" ? biz0.invoice_prefix : biz0.credit_note_prefix) ??
        (kind === "invoice" ? "INV" : "CN"),
      counter: (kind === "invoice" ? biz0.invoice_next_number : biz0.credit_note_next_number) ?? 1,
      dynamicPrefix: n?.dynamic_prefix ?? "none",
      separator1: n?.separator1 ?? "hyphen",
      separator2: n?.separator2 ?? "hyphen",
      fiscalYearStartMonth: n?.fiscal_year_start_month ?? 1,
      at: new Date(),
      timezone: tz,
    });
  };

  const rn = b.invoice_customization?.receipt?.numbering ?? null;
  const nextReceipt = composeDocumentNumber({
    prefix: b.receipt_prefix ?? "RCPT",
    counter: b.receipt_next_number ?? 1,
    dynamicPrefix: rn?.dynamic_prefix ?? "none",
    separator1: rn?.separator1 ?? "hyphen",
    separator2: rn?.separator2 ?? "hyphen",
    fiscalYearStartMonth: rn?.fiscal_year_start_month ?? 1,
    at: new Date(),
    timezone: tz,
  });

  // Gateway hint reads "Razorpay, +2 more". Non-fatal: a gateway
  // fetch failure must not take down the whole settings index.
  let gatewayHint: string | undefined;
  try {
    const [{ data }, catalog] = await Promise.all([
      listGatewayAccounts(biz, false),
      getGatewayCatalogOrEmpty(),
    ]);
    if (data.length > 0) {
      const first = gatewayDisplayName(data[0]!.gateway_key, catalog);
      gatewayHint = data.length === 1 ? first : `${first}, +${data.length - 1} more`;
    } else {
      gatewayHint = "Not connected";
    }
  } catch {
    gatewayHint = undefined;
  }

  const base = `/businesses/${biz}/settings`;

  return (
    <SettingsPage
      title="Settings"
      description="Configure how you manage subscriptions, customers, billing, and more. Each row shows its current value."
      crumbs={[{ label: b.name, href: `/businesses/${biz}` }, { label: "Settings" }]}
    >
      <SettingsHub>
        <SettingsGroup
          title="Billing"
          description="Billing essentials: rules, payment gateways, currencies and tax"
        >
          <SettingsLinkRow
            title="Business profile"
            description="Business address, contact details, and time zone."
            value={b.timezone ?? "No time zone set"}
            href={`${base}/business-profile`}
          />
          <SettingsLinkRow
            title="Brand styles"
            description="Logo, icon, favicon and brand color. Your customers see them on the portal, checkout, invoices and billing email."
            value={brandSummary(b)}
            href={`${base}/brand`}
          />
          <SettingsLinkRow
            title="Billing frequencies"
            description="The billing frequencies that plans and add-ons in your product catalog can use."
            value={frequencySummary(b.billing_frequencies)}
            href={`${base}/billing-frequencies`}
          />
          <SettingsLinkRow
            title="Billing rules"
            description="Configure how billing works with changes to subscriptions, pricing, invoicing, and more."
            href={`${base}/billing-rules`}
          />
          <SettingsLinkRow
            title="Payment gateways"
            description="Connect and configure Stripe, RazorPay and more."
            value={gatewayHint}
            href={`${base}/gateways`}
          />
          <SettingsLinkRow
            title="Currencies"
            description="The currencies this business transacts in, and reporting exchange rates."
            value={currencySummary(b.default_currency, b.currencies)}
            href={`${base}/currencies`}
          />
          <SettingsLinkRow
            title="Tax calculation"
            description="The price type of each currency, how we round tax, and your tax ID for each country."
            value={
              b.tax_rounding === "per_line" ? "Round on each line" : "Round on the invoice total"
            }
            href={`${base}/tax`}
          />
          <SettingsLinkRow
            title="Tax rates"
            description="The tax rates we apply to invoices, by country and state. They are part of the product catalog."
            href={`/businesses/${biz}/catalog/tax`}
            external
          />
        </SettingsGroup>

        <SettingsGroup
          title="Customer-facing essentials"
          description="Emails, invoices, and what your customers see"
        >
          <SettingsLinkRow
            title="Hosted pages"
            description="What customers can do on your hosted checkout and self-serve portal, including whether they may enter a coupon code."
            value={b.allow_customer_coupons ? "Coupon codes accepted" : "No coupon entry"}
            href={`${base}/hosted-pages`}
          />
          {/* 0245. Also the AVS control: requiring the postal code is what turns on ZIP
            verification, since AVS is checked gateway-side. A merchant looking for
            "address verification" has to be able to find it, hence the mention. */}
          <SettingsLinkRow
            title="Checkout and portal fields"
            description="Which details your hosted checkout and portal collect from a buyer, and which are required. This includes the ZIP/postal-code (AVS) control."
            href={`${base}/checkout-fields`}
          />
          <SettingsLinkRow
            title="Email notifications"
            description="Select which billing emails go to your customers, and who they come from."
            value={resolveEmailSummary(b.email_config)}
            href={`${base}/emails`}
          />
          <SettingsLinkRow
            title="Subscription reminders"
            description="How many days before a trial end, a renewal or a scheduled cancellation we send a reminder."
            value={`Renewal: ${(b.reminder_config?.renewal ?? [5]).join(", ")} days before`}
            href={`${base}/reminders`}
          />
          <SettingsLinkRow
            title="Invoices"
            description="Invoice title, numbering, the fields shown, and the default note."
            value={`Next: ${nextDoc("invoice")}`}
            href={`${base}/invoices`}
          />
          <SettingsLinkRow
            title="Credit notes"
            description="Credit-note title, numbering, the fields shown, and the default note."
            value={`Next: ${nextDoc("credit_note")}`}
            href={`${base}/credit-notes`}
          />
          <SettingsLinkRow
            title="Receipts"
            description="Numbering of the receipt that we create for each successful payment."
            value={`Next: ${nextReceipt}`}
            href={`${base}/receipts`}
          />
          {/* The fields that apply to BOTH documents. Its own row rather than a section
            on Invoices, so editing invoices cannot silently change credit notes. */}
          <SettingsLinkRow
            title="Documents"
            description="Fields shown on both invoices and credit notes, the seller address format, and the signature."
            href={`${base}/documents`}
          />
          <SettingsLinkRow
            title="Payment instructions"
            description="How we tell offline payers where to send the money. Invoices show this."
            href={`${base}/payment-instructions`}
          />
        </SettingsGroup>

        <SettingsGroup title="Credits" description="Prepaid credit, credit units and holds">
          <SettingsLinkRow
            title="Credits"
            description="Whether usage stops when credit is used up, hold time, and limits on credit purchases."
            value={
              resolveCreditConfig((b as { credit_config?: CreditConfigInput }).credit_config)
                .blocking_enabled
                ? "Blocking on"
                : "Blocking off"
            }
            href={`${base}/credits`}
          />
          <SettingsLinkRow
            title="Credit units"
            description="Your own units of credit, for example 1 credit = USD 0.01."
            href={`${base}/credit-units`}
          />
          <SettingsLinkRow
            title="Usage controls"
            description="Limit tiers, alerts for every subscription to a plan, and the usage widget for your app."
            href={`${base}/usage-controls`}
          />
        </SettingsGroup>

        <SettingsGroup
          title="Revenue recovery"
          description="Recover failed payments and reduce involuntary churn"
        >
          <SettingsLinkRow
            title="Dunning for failed payments"
            description="The retry schedule after a failed charge, and what happens when all retries fail."
            value={dunningSummary(b.dunning_config, b.dunning_retry_days)}
            href={`${base}/dunning`}
          />
        </SettingsGroup>

        <SettingsGroup
          title="Advanced"
          description="Team alerts, custom data, reason codes, data import and the audit log"
        >
          <SettingsLinkRow
            title="Team alerts"
            description="Email your team about large overdue invoices and failed webhooks, and send a daily summary."
            value={teamAlertsSummary(b.team_alerts_config)}
            href={`${base}/team-alerts`}
          />
          <SettingsLinkRow
            title="Custom fields"
            description="Define typed fields on customers and subscriptions."
            href={`${base}/custom-fields`}
          />
          <SettingsLinkRow
            title="Metadata rules"
            description="Check the types of keys and nested paths in customer and subscription metadata."
            href={`${base}/metadata-rules`}
          />
          <SettingsLinkRow
            title="Reason codes"
            description="Create and manage the reasons you can select when you cancel subscriptions and issue refunds."
            href={`${base}/reason-codes`}
          />
          <SettingsLinkRow
            title="Import and export data"
            description="Import or export your data, and manage sample records."
            href={`/businesses/${biz}/transfer`}
            external
          />
          <SettingsLinkRow
            title="Audit log"
            description="Every configuration and data change made in this business, with who made it."
            href={`/businesses/${biz}/audit`}
            external
          />
          {/* The time-travel backend is test-mode gated, so the row appears only for
            a sandbox business rather than linking somewhere that would refuse. */}
          {b.livemode === "test" ? (
            <SettingsLinkRow
              title="Time travel"
              description="Simulate how your billing configuration works over time, on this sandbox business."
              href={`/businesses/${biz}/time_travel`}
              external
            />
          ) : null}
        </SettingsGroup>

        <SettingsGroup
          title="Account"
          description="Organization-wide. These apply to every business, not only this one."
        >
          <SettingsLinkRow
            title="API keys"
            description="Keys that authenticate API requests for this organization."
            href="/developer"
            external
          />
          <SettingsLinkRow
            title="Webhooks"
            description="Where we deliver outbound events, and which events each endpoint receives."
            href="/developer/webhooks"
            external
          />
          <SettingsLinkRow
            title="Team members"
            description="Who can sign in, and what each role may do."
            href="/team"
            external
          />
          {/* SAML SSO is omitted: there is no SAML connection model yet. */}
          <SettingsLinkRow
            title="Security"
            description="Make two-factor authentication necessary for all members of your organization."
            href="/settings/security"
            external
          />
          <SettingsLinkRow
            title="Your account"
            description="Your profile, password, two-factor authentication and signed-in browsers."
            href="/account"
            external
          />
        </SettingsGroup>
      </SettingsHub>
    </SettingsPage>
  );
}

/** How many team alerts are on, read off the resolved `team_alerts_config`. */
function teamAlertsSummary(c: TeamAlertsConfig | undefined): string {
  if (!c || c.recipients.length === 0) return "Off";
  const on = [c.overdue.enabled, c.webhook_failures.enabled, c.daily_digest.enabled].filter(
    Boolean,
  ).length;
  return on === 0 ? "Off" : `${on} of 3 on`;
}
