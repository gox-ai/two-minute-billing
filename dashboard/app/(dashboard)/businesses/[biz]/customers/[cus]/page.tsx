import { billingRules } from "@/lib/billing-rules";
import * as React from "react";
import { RecordVisit } from "@/components/record-visit";
import { CustomerUsageCard } from "@/components/customers/customer-usage-card";
import { CustomerUsageKeysCard } from "@/components/customers/customer-usage-keys-card";
import { CustomerCreditsCard } from "@/components/credits/customer-credits-card";
import { CustomerUsageControlsCard } from "@/components/usage-controls/customer-usage-controls-card";
import Link from "next/link";
import {
  listBusinesses,
  getCustomer,
  listContacts,
  listShippingAddresses,
  listSubscriptions,
  listInvoices,
  listPaymentMethods,
  listPrices,
  listProducts,
  listProductGroups,
  getRenewalEstimate,
  listCreditNotes,
  listUnbilledCharges,
  money,
  fmtDate,
  listCustomerExcessPayments,
  type ExcessPayment,
} from "@/lib/api";
import type { RenewalEstimate, UnbilledCharge } from "@/lib/api";
import { accountHolderName } from "@/lib/names";
import { billingDateModeLabel } from "@/lib/billing-date-mode";
import { listTransactions } from "@/lib/api/payments";
import { getDunningPolicy } from "@/lib/api/dunning-policies";
import { listReceipts } from "@/lib/api/receipts";
import { listPaymentRequests } from "@/lib/api/payment-requests";
import { ReceiptsCard } from "@/components/receipts/receipts-card";
import { PaymentRequestsCard } from "@/components/payment-requests/payment-requests-card";
import { RequestPaymentRailButton } from "@/components/payment-requests/request-payment-dialog";
import { listEmails } from "@/lib/api/emails";
import { listCustomFieldDefinitions } from "@/lib/api/custom-fields";
import { getCountries } from "@/lib/api/geo";
import { loadInvoiceTimelines, unpaidInvoices } from "@/components/invoices/invoice-timeline";
import { createContactAction, deleteContactAction, updateContactAction } from "@/app/actions";
import { ActionButton } from "@/components/action-button";
import { requirePermission, allows } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { StatusChip, IdChip, Chip } from "@/components/patterns/chip";
import { CopyButton } from "@/components/patterns/copy-button";
import { RailLink } from "@/components/patterns/action-rail";
import {
  Facts,
  FoldedCard,
  RecordCard,
  RecordCrumbs,
  RecordHeader,
  Row,
  Zone,
  initials,
  type FoldedSection,
} from "@/components/patterns/record-page";
import { MoreMenu, MoreSection } from "@/components/patterns/more-menu";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  CustomerActions,
  ValidateVatButton,
  EditBillingAddressButton,
} from "@/components/customers/customer-actions";
import {
  ChangeBillingDateButton,
  CollectPaymentRailButton,
  PromoCreditRailButton,
  ExcessPaymentRailButton,
  RecordOfflinePaymentRailButton,
  ClearPersonalDataButton,
  FormDialogButton,
} from "@/components/customers/customer-page-buttons";
import { CustomerHistory } from "@/components/customers/customer-history";
import { cursorSource, HISTORY_PAGE } from "@/lib/cursor-source";
import { Paged, PagedFooter, PagedItems } from "@/components/patterns/pager";
import { listEventsForBusiness } from "@/lib/api/developer";
import {
  CustomerRefreshProvider,
  CustomerRefreshButton,
  CustomerAttention,
  CustomerDueChip,
  CustomerFigures,
  CustomerBalancesCard,
  CustomerPaymentMethodsCard,
  CustomerSubscriptionsCard,
} from "./customer-volatile";
import { ActivityLogCard } from "@/components/activity-log-card";
import {
  ShippingAddressButton,
  ShippingAddressList,
} from "@/components/customers/shipping-addresses";
import { CommentsCard } from "@/components/comments/comments-card";
import { ErrorState } from "@/components/states";
import { CheckboxField } from "@/components/ui/checkbox";
import { Alert } from "@/components/ui/alert";

export const dynamic = "force-dynamic";

// Customer detail, record-page layout: header card (rare actions under More), a
// needs-attention card, four figures, then zones laid out row by row — Billing,
// Records, folded Account details, Danger zone.
/**
 * A custom field's label, with what the field actually is.
 *
 * The read view showed only the label — and for this business the labels ARE the
 * api_names (`hashed_eid`, `signup_source_v2`), so an operator got an identifier
 * and no type, no api name, no PII marking. The edit form has carried all three
 * the whole time.
 */
function CustomFieldLabel({
  def,
}: {
  def: { label: string; cf_name: string; data_type: string; archived?: boolean; is_pii?: boolean };
}) {
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span className="min-w-0 wrap-break-word">{def.label}</span>
      <span className="font-normal text-muted-foreground">{def.data_type}</span>
      {def.is_pii ? <Chip tone="tan">PII</Chip> : null}
      {def.archived ? <Chip tone="gray">archived</Chip> : null}
    </span>
  );
}

export default async function CustomerDetail({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string; cus: string }>;
  searchParams: Promise<{ error?: string; msg?: string }>;
}) {
  const { biz, cus } = await params;
  const { error, msg } = await searchParams;
  const me = await requirePermission("customers:view", "manager");

  let businesses, customer, subs, invoices, pms, contacts, prices, products, groups;
  try {
    customer = await getCustomer(biz, cus);
    [businesses, subs, invoices, pms, contacts, prices, products, groups] = await Promise.all([
      listBusinesses(),
      // The whole list: the card pages it, and the figures sum it.
      listSubscriptions(biz, cus, { limit: 1000 }),
      listInvoices(biz, cus),
      listPaymentMethods(biz, cus),
      // The legacy `getWallet` call is gone: it was fetched WITH the resolved
      // currency, so `wallet.currency` only ever echoed that back (or the business
      // default when there was nothing to derive) — already the next link in the
      // txnCurrency chain. Balances come from `customer.balances`, per bucket.
      listContacts(biz, cus),
      // Catalog lookups (small business-wide lists) — resolve each subscription
      // item's price → product → product group, and give plan/addon links.
      listPrices(biz, { includeArchived: true }).catch(() => ({ data: [] })),
      listProducts(biz, { includeArchived: true }).catch(() => ({ data: [] })),
      listProductGroups(biz, { includeArchived: true }).catch(() => ({ data: [] })),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader
          title="Customer"
          breadcrumbs={[
            { label: "Businesses", href: "/" },
            { label: biz, href: `/businesses/${biz}` },
            { label: "Customer" },
          ]}
        />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  // History panel data — non-critical: failures degrade to empty tabs rather
  // than error the whole page.
  const [
    historyInvoices,
    transactions,
    creditNotesAll,
    emailsPage,
    events,
    cfDefsRes,
    countries,
    excessPayments,
    receiptsPage,
    requestsPage,
    shippingBook,
  ] = await Promise.all([
    // History's first page per tab; the tab pages on from there.
    listInvoices(biz, cus, { limit: HISTORY_PAGE }).catch(() => null),
    listTransactions(biz, { customer: cus, limit: HISTORY_PAGE }).catch(() => null),
    // Scoped to this customer server-side — reading the whole business's credit
    // notes and filtering here silently lost rows once the list became paginated.
    listCreditNotes(biz, undefined, { customer: cus, limit: HISTORY_PAGE }).catch(() => null),
    // Email Logs tab in History; the route already filters by customer.
    listEmails(biz, { customer: cus, limit: HISTORY_PAGE }).catch(() => null),
    // `customer=` is the whole footprint, not just the customer row: the engine
    // resolves it to every resource id this customer owns (`ownedByCustomer`), so
    // the tab carries the subscription, invoice and payment events of its life.
    listEventsForBusiness(biz, { customer: cus, limit: HISTORY_PAGE }).catch(() => null),
    // Definitions give each stored `cf_*` value its admin-set label and type —
    // without them the section would show raw api_names.
    listCustomFieldDefinitions(biz, { entityType: "customer", includeArchived: true }).catch(
      () => ({ data: [] }),
    ),
    // Country reference data for the "Update Billing Info" drawer's address form.
    getCountries(),
    // Payments behind the excess credit — each refundable from the Balances card.
    listCustomerExcessPayments(biz, cus).catch(() => ({ data: [] as ExcessPayment[] })),
    // The latest few; each card links to the full list scoped to this customer.
    listReceipts(biz, { limit: 5, scope: { customer: cus } }).catch(() => null),
    listPaymentRequests(biz, { limit: 5, scope: { customer: cus } }).catch(() => null),
    // null = the read failed; the card says so rather than "no addresses".
    listShippingAddresses(biz, cus, { includeArchived: true }).catch(() => null),
  ]);
  const cfDefs = cfDefsRes.data;
  // Non-critical: on a failed read the row shows the policy id.
  const dunningPolicy = customer.dunning_policy
    ? await getDunningPolicy(biz, customer.dunning_policy).catch(() => null)
    : null;
  /**
   * Next-billing amounts come from the ENGINE's own renewal plan
   * (`estimateRenewal` → `planSubscriptionPeriodInvoice`), so they include tax,
   * coupons and rounding exactly as the billing clock will invoice them.
   *
   * Do NOT go back to summing `unit_price_minor × quantity`: that is the pre-tax
   * subtotal, and it understated every renewal on a taxed business by the whole tax
   * amount (₹10,799 shown where the customer will actually be charged ₹12,742.82).
   * It also made "Plan Amount" and "Next Billing Amount" render the same number,
   * when they should differ by the tax.
   *
   * Best-effort per subscription: an estimate that fails degrades that row to "—"
   * rather than erroring the page, and is null by design for a subscription with no
   * next term (cancelling / non-renewing / cycle cap reached).
   */
  const renewalEstimates = new Map<string, RenewalEstimate>();
  await Promise.all(
    subs.data
      .filter((s) => ["active", "in_trial"].includes(s.status))
      .map(async (s) => {
        const r = await getRenewalEstimate(biz, s.id).catch(() => null);
        if (r?.estimate) renewalEstimates.set(s.id, r.estimate);
      }),
  );

  /**
   * Customer-level Unbilled Charges — the engine only exposes them per subscription
   * (`/v1/businesses/:biz/subscriptions/:sub/unbilled_charges`), so the BFF fans
   * out over this customer's subscriptions and merges. That is the same shape as
   * the renewal-estimate fan-out above (one small request per subscription, all in
   * parallel, each failure degrading that subscription to no rows rather than
   * erroring the page) — no new backend route needed.
   *
   * Every subscription is queried, not just the live ones: a charge deferred before
   * a cancel can still be sitting there, and hiding it is exactly the money a
   * customer-level rollup exists to surface.
   */
  const unbilledRows: (UnbilledCharge & { subscription: string })[] = (
    await Promise.all(
      subs.data.map(async (s) => {
        const r = await listUnbilledCharges(biz, s.id).catch(() => ({
          data: [] as UnbilledCharge[],
        }));
        return r.data.map((c) => ({ ...c, subscription: s.id }));
      }),
    )
  ).flat();
  // Only PENDING rows are money still owed — `billed` ones are already on an
  // invoice and `voided` ones never will be, so the headline counts pending alone
  // (same rule the subscription page's cancel dialog uses).
  const pendingUnbilledByCurrency = new Map<string, number>();
  for (const c of unbilledRows) {
    if (c.status !== "pending") continue;
    pendingUnbilledByCurrency.set(
      c.currency,
      (pendingUnbilledByCurrency.get(c.currency) ?? 0) + c.amount_minor,
    );
  }

  // price id → product id → product group name, for the subscription card.
  const priceToProduct = new Map(prices.data.map((p) => [p.id, p.product]));
  const groupName = new Map(groups.data.map((g) => [g.id, g.name]));
  const productInfo = new Map(
    products.data.map((p) => [
      p.id,
      { name: p.name, group: p.product_group ? (groupName.get(p.product_group) ?? null) : null },
    ]),
  );

  const business = businesses.data.find((b) => b.id === biz);
  // Dates render in the business timezone, not UTC — the engine's term
  // boundaries are midnight in this zone (see components/business-tz).
  const tz = businesses.data.find((b) => b.id === biz)?.timezone ?? null;
  const name = business?.name ?? "Business";
  const bizCurrencies = business?.currencies ?? null;
  const addr = customer.address;
  const addrLine = addr
    ? [addr.line1, addr.line2, addr.city, addr.state, addr.postal_code, addr.country]
        .filter(Boolean)
        .join(", ")
    : null;
  /**
   * The BILLING CONTACT — the address's own person, who on this record is deliberately
   * a different fact from the account holder below (`billing_address.first_name` vs
   * `customer.first_name`), and the one that prints on an invoice. Kept as the bare
   * first+last join rather than `addressContactName` because the company renders on its
   * own line just below; folding it in would print it twice.
   */
  const billingContact = addr ? [addr.first_name, addr.last_name].filter(Boolean).join(" ") : "";
  /** The ACCOUNT HOLDER — this record's own identity, never the address contact. */
  const fullName = accountHolderName(customer);
  /**
   * Titled with the COMPANY — the entity being billed — keeping the person as a
   * secondary line. Titling it with the person made two contacts at the same company
   * read as two unrelated records. Falls back to the person, then the email, for a
   * customer with no company.
   */
  const pageTitle = customer.company || fullName || customer.email || "Customer";

  // Unpaid invoices' payments and dunning, as the subscription page shows it (1–2 only).
  const invoiceTracks = await loadInvoiceTimelines(biz, unpaidInvoices(invoices.data));
  /** No company and no name: the email IS the title, so the fact line must not repeat it. */
  const titleIsEmail = !customer.company && !fullName && !!customer.email;
  /** The person, shown under the title only when the company is the title. */
  const personSubtitle =
    customer.company && fullName && fullName !== customer.company ? fullName : null;

  /**
   * The one currency this page transacts in. `effective_currency` is derived
   * server-side (explicit preference → live subscriptions' currency); the business's
   * default is the last resort for a customer with nothing to derive from.
   *
   * Do NOT reintroduce `customer.currency ?? wallet.currency`: `currency` is null
   * for most customers, so that fell through to the BUSINESS default and showed an
   * INR-only customer `$0.00` credits — and, because the same value keys the
   * `balances` lookup, it read the wrong bucket and reported 0 for a customer who
   * genuinely held INR credits. It also preselected USD in the add-charge /
   * manage-credits / excess-payment dialogs, which mints balances that the
   * customer's own invoices can never consume.
   */
  const txnCurrency =
    customer.effective_currency ?? customer.currency ?? business?.default_currency ?? "USD";
  /** True when nothing but the business default was available — see txnCurrency. */
  const currencyIsDerived = !customer.currency && !!customer.effective_currency;

  const billable = subs.data
    .filter((s) => ["active", "in_trial"].includes(s.status) && !s.cancel_at_period_end)
    // `next_billing_at`, NOT `current_period_end`. The filter above deliberately includes
    // `in_trial`, and a trialling subscription reports no term — so this sorted on
    // `new Date(null).getTime()`, which is NaN. A comparator returning NaN does not throw:
    // it silently scrambles the order, so "the next payment" could be any of the customer's
    // subscriptions. `next_billing_at` is the field that answers this across every status
    // (trial end while in_trial, term end while active) and the rest of this page already
    // uses it. Null sorts last — no upcoming payment is not the soonest one.
    .sort(
      (a, b) =>
        (a.next_billing_at ? Date.parse(a.next_billing_at) : Infinity) -
        (b.next_billing_at ? Date.parse(b.next_billing_at) : Infinity),
    );
  const nextSub = billable[0];

  const summary = [
    {
      label: "ID",
      value: <span className="font-mono text-xs">{customer.id}</span>,
      copy: customer.id,
    },
    { label: "Email", value: customer.email ?? "—", copy: customer.email ?? undefined },
    { label: "First name", value: customer.first_name || "—" },
    { label: "Last name", value: customer.last_name || "—" },
    { label: "Company", value: customer.company || "—" },
    { label: "Phone", value: customer.phone || "—" },
    // JSON Metadata moved out to its own railed section — it is the one
    // summary value an operator can EDIT, and a one-line blob in a two-column grid
    // could neither be read nor offered an Edit affordance.
    // Custom fields get their own railed section below (they are admin-defined and
    // there can be a dozen) — a single summary row rendered them as a cramped stack
    // of raw `cf_` api_names with no labels.
    { label: "Created", value: fmtDate(customer.created_at, tz) },
  ];

  // The role rows used to print the raw `pm_…` token, which names the same card the
  // Payment Methods section below shows as "Visa ending 0123" — unreadable, and not
  // matchable against that section by eye. Resolve it; keep the id when the card is
  // gone from the list (detached but still referenced), since then it is all we have.
  const pmLabel = (id: string | null | undefined) => {
    if (!id) return "—";
    const pm = pms.data.find((p) => p.id === id);
    if (!pm) return <span className="font-mono text-xs">{id}</span>;
    return (
      <span>
        <span className="capitalize">{pm.brand ?? pm.type}</span>
        {pm.last4 ? ` ending ${pm.last4}` : ""}
      </span>
    );
  };

  const config = [
    {
      // We never persist a preferred currency, so say which one is in force: an
      // unset preference still bills in the subscriptions' currency, and showing "—"
      // while every invoice is INR read as "no currency decided".
      label: "Preferred currency",
      value: customer.currency ? (
        customer.currency
      ) : currencyIsDerived ? (
        <span>
          {txnCurrency} <span className="text-xs text-muted-foreground">(from subscriptions)</span>
        </span>
      ) : (
        "—"
      ),
    },
    { label: "Language", value: customer.locale || "—" },
    {
      label: "Auto collection",
      value: customer.auto_collection === "off" ? "Off (send invoice)" : "On",
    },
    {
      label: "Email notifications",
      value: customer.email_notifications === false ? "Off" : "On",
    },
    { label: "Dunning", value: customer.dunning_excluded ? "Excluded" : "Included" },
    { label: "Reports", value: customer.exclude_from_reporting ? "Excluded" : "Included" },
    {
      // Exclusion wins over any policy, so the policy is only "in use" while included.
      label: "Dunning policy",
      value: dunningPolicy ? (
        <span>
          <Link
            href={`/businesses/${biz}/settings/dunning/policies/${dunningPolicy.id}`}
            className="text-primary hover:underline"
          >
            {dunningPolicy.name}
          </Link>
          {customer.dunning_excluded ? (
            <span className="text-xs text-muted-foreground"> (not in use: excluded)</span>
          ) : null}
        </span>
      ) : customer.dunning_policy ? (
        <span className="font-mono text-xs">{customer.dunning_policy}</span>
      ) : (
        <Link href={`/businesses/${biz}/settings/dunning`} className="text-primary hover:underline">
          Business settings
        </Link>
      ),
    },
    { label: "Net term days", value: customer.net_term_days ? `${customer.net_term_days}` : "0" },
    { label: "Billing date", value: customer.billing_date ? `Day ${customer.billing_date}` : "—" },
    { label: "Billing date mode", value: billingDateModeLabel(customer.billing_date_mode) },
    { label: "Next billing on", value: nextSub ? fmtDate(nextSub.next_billing_at, tz) : "—" },
    {
      label: "MRR",
      value:
        customer.mrr && Object.keys(customer.mrr).length
          ? Object.entries(customer.mrr)
              .map(([c, v]) => money(v, c))
              .join(", ")
          : "—",
    },
    { label: "Primary payment method", value: pmLabel(customer.primary_payment_source_id) },
    {
      label: "Backup payment methods",
      value: (() => {
        const backups = pms.data.filter((p) => p.role === "backup");
        if (backups.length === 0) return "—";
        return (
          <span className="flex flex-col">
            {backups.map((p) => (
              <span key={p.id}>{pmLabel(p.id)}</span>
            ))}
          </span>
        );
      })(),
    },
  ];

  const tax = [
    { label: "Exempt from tax", value: customer.tax_exempt ? "Yes" : "No" },
    {
      label: "VAT number",
      value: customer.vat_number ? (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono text-xs">{customer.vat_number}</span>
          {customer.vat_number_status ? (
            <Badge
              variant={customer.vat_number_status === "valid" ? "default" : "secondary"}
              className="text-xs"
            >
              {customer.vat_number_status}
            </Badge>
          ) : null}
          <ValidateVatButton biz={biz} cus={cus} />
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
    {
      label: "VAT validated at",
      value: customer.vat_validated_at ? fmtDate(customer.vat_validated_at, tz) : "—",
    },
    {
      label: "Withholding (TDS)",
      value: customer.withholding_rate_bps
        ? `${(customer.withholding_rate_bps / 100).toFixed(2)}%`
        : "—",
    },
  ];

  const hasMetadata = !!customer.metadata && Object.keys(customer.metadata).length > 0;

  const shipping = (shippingBook?.data ?? []).filter((a) => !a.archived);
  const shipDefault = shipping.find((a) => a.is_default) ?? null;

  /**
   * Custom fields to display: every ACTIVE definition (so a defined-but-unset field
   * still shows as "—", which is how an operator learns the field exists), plus any
   * stored value whose definition was archived — those keep reading even though they
   * can no longer be written, so silently dropping them would hide real data.
   */
  const cfValues = (customer.custom_fields ?? {}) as Record<string, unknown>;
  const cfRows = [
    ...cfDefs.filter((d) => !d.archived),
    ...cfDefs.filter((d) => d.archived && cfValues[d.api_name] !== undefined),
  ]
    .sort((a, b) => a.position - b.position || a.label.localeCompare(b.label))
    .map((d) => ({ def: d, value: cfValues[d.api_name] }));
  // A value with no definition at all (e.g. a definition hard-deleted out of band).
  const cfOrphans = Object.entries(cfValues).filter(([k]) => !cfDefs.some((d) => d.api_name === k));
  /** Set vs unset, because the card renders them differently — see the note there. */
  const isSet = (v: unknown) => v !== undefined && v !== null && v !== "";
  const cfSet = cfRows.filter(({ value }) => isSet(value));
  const cfUnset = cfRows.filter(({ value }) => !isSet(value));

  const contactForm = (c?: (typeof contacts.data)[number]) => (
    <form action={c ? updateContactAction : createContactAction} className="flex flex-col gap-4">
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="cus" value={cus} />
      {c ? <input type="hidden" name="con" value={c.id} /> : null}
      <Input
        name="email"
        type="email"
        placeholder="email@company.com"
        defaultValue={c?.email}
        required
      />
      <div className="flex gap-2">
        <Input name="first_name" placeholder="First" defaultValue={c?.first_name ?? ""} />
        <Input name="last_name" placeholder="Last" defaultValue={c?.last_name ?? ""} />
      </div>
      <Input name="label" placeholder="Label (e.g. Billing)" defaultValue={c?.label ?? ""} />
      <CheckboxField
        name="send_billing_email"
        label="Send billing email"
        hint="Invoices, payments, refunds, credit notes and card updates."
        defaultChecked={c?.send_billing_email}
      />
      <CheckboxField
        name="send_account_email"
        label="Send account email"
        hint="Subscription and trial changes, renewal and cancellation reminders."
        defaultChecked={c?.send_account_email}
      />
      <Button type="submit" className="self-end">
        {c ? "Save contact" : "Add contact"}
      </Button>
    </form>
  );
  const addContact = (variant: "rail" | "ghost") => (
    <FormDialogButton
      label="Add contact"
      triggerVariant={variant}
      title="Add contact"
      description="Add a team member to receive copies of this customer's emails."
    >
      {contactForm()}
    </FormDialogButton>
  );

  const addressBlock = (a: NonNullable<typeof addr>, contact: string) => (
    <address className="text-sm leading-relaxed not-italic">
      {contact ? <div className="font-medium">{contact}</div> : null}
      {a.company ? <div>{a.company}</div> : null}
      {[a.line1, a.line2, a.line3].filter(Boolean).map((l, i) => (
        <div key={i}>{l}</div>
      ))}
      <div>{[a.city, a.state_code || a.state, a.postal_code].filter(Boolean).join(", ")}</div>
      {a.country ? <div>{a.country}</div> : null}
      {a.phone ? <div className="mt-1 text-muted-foreground">{a.phone}</div> : null}
    </address>
  );

  // One-line summaries for the folded Account details rows.
  const accountSections: FoldedSection[] = [
    {
      id: "summary",
      title: "Profile",
      summary: [
        fullName,
        customer.company,
        customer.phone,
        `since ${fmtDate(customer.created_at, tz)}`,
      ]
        .filter(Boolean)
        .join(" · "),
      children: (
        <Facts
          rows={summary.map((r) => ({
            label: r.label,
            value: r.copy ? (
              <span className="inline-flex items-center gap-1">
                {r.value}
                <CopyButton value={r.copy} />
              </span>
            ) : (
              r.value
            ),
          }))}
        />
      ),
    },
    {
      id: "config",
      title: "Customer configurations",
      summary: [
        customer.auto_collection === "off" ? "Auto collection off" : "Auto collection on",
        `net ${customer.net_term_days ?? 0} days`,
        billingDateModeLabel(customer.billing_date_mode),
        customer.locale,
      ]
        .filter(Boolean)
        .join(" · "),
      children: (
        <div className="flex flex-col gap-3">
          <Facts
            rows={config.map((r) =>
              // These three repeat cards above the fold, so they link there.
              r.label === "MRR"
                ? {
                    label: r.label,
                    value: (
                      <a href="#subscriptions" className="figure-link">
                        {r.value}
                      </a>
                    ),
                  }
                : r.label === "Primary payment method" || r.label === "Backup payment methods"
                  ? {
                      label: r.label,
                      value: (
                        <a href="#payment-methods" className="text-primary hover:underline">
                          {r.value}
                        </a>
                      ),
                    }
                  : { label: r.label, value: r.value },
            )}
          />
          <div>
            <ChangeBillingDateButton
              biz={biz}
              cus={cus}
              currentDate={customer.billing_date}
              currentMode={customer.billing_date_mode}
            />
          </div>
        </div>
      ),
    },
    {
      id: "tax",
      title: "Tax details",
      summary: [
        customer.tax_exempt ? "Exempt" : "Taxable",
        customer.vat_number
          ? `VAT ${customer.vat_number}${customer.vat_number_status ? ` ${customer.vat_number_status}` : ""}`
          : "no VAT number",
        customer.withholding_rate_bps
          ? `withholding ${(customer.withholding_rate_bps / 100).toFixed(2)}%`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      children: <Facts rows={tax} />,
    },
    {
      id: "billing-address",
      title: "Billing address",
      summary: [
        addr && addrLine
          ? `Billing: ${[addr.city, addr.state_code || addr.state, addr.country].filter(Boolean).join(", ")}`
          : "No billing address",
        shipping.length
          ? `${shipping.length} shipping ${shipping.length === 1 ? "address" : "addresses"}`
          : "no shipping address",
      ].join(" · "),
      children: (
        <div>
          <div className="mb-1.5 flex items-center text-xs font-semibold text-muted-foreground">
            <span className="flex-1">Billing address</span>
            <EditBillingAddressButton biz={biz} customer={customer} countries={countries} />
          </div>
          {addr && addrLine ? (
            addressBlock(addr, billingContact)
          ) : (
            <p className="text-sm text-muted-foreground">
              No billing address yet. Use Edit to add one.
            </p>
          )}
          <p className="mt-3 text-sm text-muted-foreground">
            Shipping addresses are in the{" "}
            <a href="#shipping-addresses" className="text-primary hover:underline">
              Shipping addresses
            </a>{" "}
            card.
          </p>
        </div>
      ),
    },
    {
      id: "contacts",
      title: "Additional contacts",
      summary: contacts.data.length
        ? `${contacts.data.length} · ${contacts.data.map((c) => c.email).join(", ")}`
        : "None",
      children: (
        <div className="flex flex-col gap-3">
          <div>{addContact("ghost")}</div>
          {contacts.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No additional contacts. Add team members to receive invoice, payment and subscription
              emails.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Billing email</TableHead>
                  <TableHead>Account email</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {contacts.data.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      {[c.first_name, c.last_name].filter(Boolean).join(" ") || "—"}
                    </TableCell>
                    <TableCell>{c.email}</TableCell>
                    <TableCell>{c.label || "—"}</TableCell>
                    <TableCell>{c.send_billing_email ? "Yes" : "No"}</TableCell>
                    <TableCell>{c.send_account_email ? "Yes" : "No"}</TableCell>
                    <TableCell className="text-right">
                      <FormDialogButton
                        label="Edit"
                        triggerVariant="ghost"
                        title="Edit contact"
                        description={c.email}
                      >
                        {contactForm(c)}
                      </FormDialogButton>
                      <ActionButton
                        action={deleteContactAction}
                        fields={{ biz, cus, con: c.id }}
                        label="Remove"
                        variant="ghost"
                        size="sm"
                        confirm={{
                          title: "Remove contact?",
                          description: `Remove ${c.email}?`,
                          confirmLabel: "Remove",
                          destructive: true,
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      ),
    },
    ...(cfRows.length || cfOrphans.length
      ? [
          {
            id: "custom-fields",
            title: "Custom fields",
            summary: `${cfSet.length + cfOrphans.length} set${cfUnset.length ? ` · ${cfUnset.length} defined and not set` : ""}`,
            children: (
              <div className="flex flex-col gap-3">
                {cfSet.length || cfOrphans.length ? (
                  <Facts
                    rows={[
                      ...cfSet.map(({ def, value }) => ({
                        label: <CustomFieldLabel def={def} />,
                        value:
                          def.data_type === "boolean"
                            ? value
                              ? "Yes"
                              : "No"
                            : def.data_type === "date"
                              ? fmtDate(String(value), tz)
                              : String(value),
                      })),
                      // A value with no definition is real stored data the edit form
                      // cannot reach, so it is surfaced rather than hidden.
                      ...cfOrphans.map(([k, v]) => ({
                        label: (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-xs">cf_{k}</span>
                            <Chip tone="tan">no definition</Chip>
                          </span>
                        ),
                        value: v === null || v === "" ? "—" : String(v),
                      })),
                    ]}
                  />
                ) : null}
                {cfUnset.length ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    <span className="font-medium">
                      {cfUnset.length} field{cfUnset.length === 1 ? "" : "s"} defined and not set
                    </span>
                    {": "}
                    {cfUnset.map(({ def }, i) => (
                      <React.Fragment key={def.id}>
                        {i > 0 ? ", " : ""}
                        <span className="font-mono">{def.label}</span>
                      </React.Fragment>
                    ))}
                  </p>
                ) : null}
                {cfDefs.some((d) => !d.archived) ? null : (
                  <p className="text-xs text-muted-foreground">
                    No active definitions. Create fields in Settings → Custom Fields.
                  </p>
                )}
              </div>
            ),
          },
        ]
      : []),
    {
      // What will ACTUALLY print: the invoice builder falls back to the business default
      // note when this one is empty, so an empty note is not "no note".
      id: "invoice-note",
      title: "Invoice note",
      summary: customer.invoice_notes
        ? customer.invoice_notes
        : business?.default_invoice_notes
          ? `Business default: “${business.default_invoice_notes}”`
          : "None",
      children: customer.invoice_notes ? (
        <p className="text-sm whitespace-pre-wrap">{customer.invoice_notes}</p>
      ) : business?.default_invoice_notes ? (
        <div className="space-y-1.5">
          <p className="text-sm whitespace-pre-wrap">{business.default_invoice_notes}</p>
          <p className="text-xs text-muted-foreground">
            This customer has no note. We print the business default note above instead.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No note. We print no note on this customer’s invoices.
        </p>
      ),
    },
    {
      id: "metadata",
      title: "JSON metadata",
      summary: hasMetadata
        ? `${Object.keys(customer.metadata!).length} key${Object.keys(customer.metadata!).length === 1 ? "" : "s"}`
        : "None",
      children: hasMetadata ? (
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
          {JSON.stringify(customer.metadata, null, 2)}
        </pre>
      ) : (
        <p className="text-sm text-muted-foreground">
          No metadata. Metadata holds your own key-value pairs for this customer. We store them and
          do not use them.
        </p>
      ),
    },
  ];

  return (
    <CustomerRefreshProvider
      biz={biz}
      cus={cus}
      initial={{
        customer,
        subs: subs.data,
        invoices: invoices.data,
        pms: pms.data,
        renewalEstimates: Object.fromEntries(renewalEstimates),
        excessPayments: excessPayments.data,
      }}
    >
      <div className="flex flex-col gap-4">
        <RecordVisit
          biz={biz}
          kind="customer"
          id={customer.id}
          label={accountHolderName(customer) ?? customer.email ?? customer.id}
          detail={[customer.email, customer.company].filter(Boolean).join(" · ")}
        />
        <RecordCrumbs
          items={[
            { label: name, href: `/businesses/${biz}` },
            { label: "Customers", href: `/businesses/${biz}/customers` },
            { label: pageTitle },
          ]}
          right={<CustomerRefreshButton />}
        />

        <RecordHeader
          avatar={initials(pageTitle)}
          title={
            titleIsEmail ? (
              <span className="inline-flex items-center gap-1.5">
                {pageTitle}
                <CopyButton value={customer.email!} />
              </span>
            ) : (
              pageTitle
            )
          }
          chips={
            <>
              {customer.active === false ? <StatusChip status="archived" /> : null}
              <CustomerDueChip />
            </>
          }
          facts={[
            // The person, when the company is the title — the contact is never lost.
            personSubtitle,
            customer.email && !titleIsEmail ? (
              <span key="email" className="inline-flex items-center gap-1">
                {customer.email}
                <CopyButton value={customer.email} />
              </span>
            ) : null,
            customer.currency ?? customer.effective_currency,
            <IdChip key="id" label="Customer ID" id={customer.id} />,
          ]}
          actions={
            <>
              <Button asChild>
                <Link href={`/businesses/${biz}/customers/${cus}/edit`}>Edit customer</Link>
              </Button>
              <MoreMenu>
                <MoreSection heading="Subscription">
                  <RailLink href={`/businesses/${biz}/subscriptions/new?customer=${cus}`}>
                    Create subscription
                  </RailLink>
                </MoreSection>
                <MoreSection heading="Billing">
                  <CollectPaymentRailButton
                    biz={biz}
                    cus={cus}
                    invoices={invoices.data}
                    pms={pms.data}
                  />
                  <RequestPaymentRailButton
                    biz={biz}
                    cus={cus}
                    invoices={invoices.data}
                    pms={pms.data}
                    customerEmail={customer.email ?? null}
                  />
                  {/* Add charge picks a catalog charge; Create quick charge takes an ad-hoc
                      amount. Two different flows. */}
                  <RailLink href={`/businesses/${biz}/customers/${cus}/add_charge_price`}>
                    Add charge
                  </RailLink>
                  <RailLink href={`/businesses/${biz}/customers/${cus}/add_charge`}>
                    Create quick charge
                  </RailLink>
                  <RecordOfflinePaymentRailButton biz={biz} cus={cus} invoices={invoices.data} />
                  <PromoCreditRailButton
                    biz={biz}
                    cus={cus}
                    defaultCurrency={txnCurrency}
                    bizCurrencies={bizCurrencies}
                    balances={customer.balances}
                  />
                  <ExcessPaymentRailButton
                    biz={biz}
                    cus={cus}
                    defaultCurrency={txnCurrency}
                    bizCurrencies={bizCurrencies}
                    balances={customer.balances}
                    hasPaymentMethod={pms.data.length > 0}
                  />
                </MoreSection>
                <MoreSection heading="Customer">
                  <EditBillingAddressButton
                    biz={biz}
                    customer={customer}
                    countries={countries}
                    rail
                    label="Edit billing info"
                  />
                  {addContact("rail")}
                  <CustomerActions biz={biz} customer={customer} showEdit={false} />
                </MoreSection>
                {allows(me, "api_logs:view", "developer") ? (
                  <MoreSection heading="Developers">
                    <RailLink
                      href={`/developer/logs?customer=${encodeURIComponent(cus)}&business=${biz}`}
                    >
                      API requests
                    </RailLink>
                  </MoreSection>
                ) : null}
              </MoreMenu>
            </>
          }
        />

        {error ? <ErrorState description={error} /> : null}
        {msg ? <Alert tone="info">{msg}</Alert> : null}

        {/* Volatile: the portal moves dues, cards and credit without the operator, so
            these re-read on the header's Refresh. */}
        <CustomerAttention biz={biz} tz={tz} tracks={invoiceTracks} />
        <CustomerFigures
          biz={biz}
          tz={tz}
          txnCurrencyFallback={business?.default_currency ?? "USD"}
        />

        <Zone title="Billing">
          <Row span="8/4">
            <CustomerSubscriptionsCard
              biz={biz}
              cus={cus}
              tz={tz}
              priceToProduct={Object.fromEntries(priceToProduct)}
              productInfo={Object.fromEntries(productInfo)}
            />
            <CustomerPaymentMethodsCard biz={biz} cus={cus} tz={tz} />
          </Row>
          <Row span="6/6">
            {/* A customer-level rollup of each subscription's unbilled charges — what will
                be billed that is not on an invoice yet. */}
            <RecordCard
              id="unbilled"
              title="Unbilled charges"
              meta={
                pendingUnbilledByCurrency.size
                  ? `${[...pendingUnbilledByCurrency.entries()].map(([c, v]) => money(v, c)).join(" · ")} pending · goes on the next invoice`
                  : undefined
              }
              flush={unbilledRows.length > 0}
            >
              {unbilledRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No unbilled charges. Everything charged to this customer is already on an invoice.
                </p>
              ) : (
                <Paged
                  size={10}
                  items={unbilledRows.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="pl-5 wrap-anywhere whitespace-normal">
                        {c.description}
                        <div className="font-mono text-xs text-muted-foreground">{c.id}</div>
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/businesses/${biz}/subscriptions/${c.subscription}?from=customer#unbilled`}
                          className="font-mono text-xs wrap-anywhere text-primary hover:underline"
                        >
                          {c.subscription}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <StatusChip status={c.status} />
                      </TableCell>
                      <TableCell className="pr-5 text-right tabular-nums">
                        {money(c.amount_minor, c.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                >
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-5">Description</TableHead>
                        <TableHead>Subscription</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="pr-5 text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <PagedItems />
                    </TableBody>
                  </Table>
                  <PagedFooter />
                </Paged>
              )}
            </RecordCard>
            <CustomerBalancesCard
              biz={biz}
              txnCurrencyFallback={business?.default_currency ?? "USD"}
              refundReasonRequired={billingRules(business).required_reasons.refund}
            />
          </Row>
          {/* Streams in after the page; renders nothing without a metered subscription. */}
          <React.Suspense fallback={null}>
            <CustomerUsageCard biz={biz} cus={cus} tz={tz} />
          </React.Suspense>
          {allows(me, "credits:view", "manager") ? (
            <React.Suspense fallback={null}>
              <CustomerCreditsCard biz={biz} cus={cus} />
            </React.Suspense>
          ) : null}
          {allows(me, "usage_controls:view", "manager") ? (
            <React.Suspense fallback={null}>
              <CustomerUsageControlsCard biz={biz} cus={cus} />
            </React.Suspense>
          ) : null}
          <React.Suspense fallback={null}>
            <CustomerUsageKeysCard
              biz={biz}
              cus={cus}
              tz={tz}
              canManage={allows(me, "customers:manage", "ops")}
            />
          </React.Suspense>
          <Row span="6/6">
            <PaymentRequestsCard
              biz={biz}
              cus={cus}
              requests={requestsPage?.data ?? null}
              total={requestsPage?.total ?? null}
              tz={tz}
            />
            <ReceiptsCard
              biz={biz}
              receipts={receiptsPage?.data ?? null}
              total={receiptsPage?.total ?? null}
              viewAllHref={`/businesses/${biz}/receipts?customer=${cus}`}
              tz={tz}
              emptyText="No receipts yet. We create one for each successful payment."
            />
          </Row>
          <Row span="12">
            <RecordCard
              id="shipping-addresses"
              title="Shipping addresses"
              meta={
                shipDefault
                  ? `Default: ${shipDefault.label || [shipDefault.city, shipDefault.country].filter(Boolean).join(", ")}`
                  : undefined
              }
              actions={
                shippingBook ? (
                  <ShippingAddressButton
                    biz={biz}
                    cus={cus}
                    countries={countries}
                    first={!shipDefault}
                  />
                ) : null
              }
            >
              {shippingBook ? (
                <ShippingAddressList
                  biz={biz}
                  cus={cus}
                  countries={countries}
                  addresses={shippingBook.data}
                />
              ) : (
                <Alert tone="error">
                  We could not load the shipping addresses. Reload the page.
                </Alert>
              )}
            </RecordCard>
          </Row>
        </Zone>

        <Zone title="Records">
          <Row span="12">
            <RecordCard id="history" title="History">
              {/* The Events tab is the RAW stream; the Activity log tells the same history
                  as sentences with an actor. Both cover the customer's whole footprint. */}
              <CustomerHistory
                biz={biz}
                invoices={cursorSource(historyInvoices, "invoices", { customer: cus })}
                transactions={cursorSource(transactions, "transactions", { customer: cus })}
                creditNotes={cursorSource(creditNotesAll, "credit_notes", { customer: cus })}
                emails={cursorSource(emailsPage, "emails", { customer: cus })}
                events={cursorSource(events, "events", { customer: cus })}
              />
            </RecordCard>
          </Row>
          <Row span="8/4">
            {/* `scope="customer"` widens both streams to everything the customer owns. */}
            <ActivityLogCard
              biz={biz}
              resourceType="customer"
              resourceId={cus}
              tz={tz}
              scope="customer"
              layout="card"
              previewRows={5}
            />
            <CommentsCard
              biz={biz}
              resourceType="customer"
              resourceId={cus}
              backPath={`/businesses/${biz}/customers/${cus}`}
              layout="card"
            />
          </Row>
        </Zone>

        <div className="mt-4">
          <FoldedCard
            title="Account details"
            sections={accountSections}
            actions={
              <Link
                href={`/businesses/${biz}/customers/${cus}/edit`}
                className="text-primary hover:underline"
              >
                Edit
              </Link>
            }
          />
        </div>

        <section
          id="danger"
          className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-card px-5 py-4 sm:flex-row sm:items-center"
        >
          <div className="flex-1">
            <p className="text-sm font-semibold text-destructive">
              Danger zone · Clear personal data (GDPR)
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              This deletes all PII from this record. It also deletes saved payment methods at the
              gateway. We keep subscriptions and invoices for accounting. You cannot undo this.
            </p>
            {customer.pii_cleared ? (
              <p className="mt-1 text-xs font-medium text-destructive">
                PII already cleared for this customer.
              </p>
            ) : null}
          </div>
          <ClearPersonalDataButton biz={biz} cus={cus} disabled={customer.pii_cleared ?? false} />
        </section>
      </div>
    </CustomerRefreshProvider>
  );
}
