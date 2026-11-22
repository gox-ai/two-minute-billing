import { cache } from "react";
import { mandateRailLabel, mandateRevokeWhere } from "@/lib/mandate-rail";
import Link from "next/link";
import { CreditCard, FileText, Info, Package, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Chip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { money } from "@/lib/format";
import { fmtDate, fmtDateTime } from "@/lib/format-date";
import {
  portalMe,
  portalListPaymentMethods,
  portalListGateways,
  portalListInvoices,
  portalListPurchases,
  portalListSubscriptions,
  portalListShippingAddresses,
  portalListReceipts,
  portalListRequests,
  portalGetCreditRunway,
  portalGetCredits,
  portalListSpendLimits,
} from "@/lib/portal-api";
import { readStorefrontToken } from "@/lib/storefront-session";
import { portalSetBackupAction, portalSetDefaultAction, portalLogoutAction } from "./actions";
import { ExpiredCard, PortalContact, SignedOutCard } from "./portal-dead-ends";
import {
  buyerInvoiceState,
  METHOD_PROBLEM_LABEL,
  methodProblem,
  normalizeMethodWords,
  PAYABLE_STATUSES,
  payableNow,
} from "./portal-state";
import { RemovePaymentMethod } from "./remove-method";
import { AddCard } from "./add-card";
import { AddMethodButton, AddMethodDisclosure } from "./add-method-disclosure";
import { PortalSectionLink } from "./section-link";
import { TruncatedText } from "../../truncated-text";
import { BillingDetails } from "./billing-details";
import { ShippingAddresses } from "./shipping-addresses";
import { PayInvoiceButton } from "./pay-invoice";
import { ArriveRow, ExitRowList, PopOnChange } from "../../storefront-motion";
import { PayRequestForm } from "./pay-request";
import { PayNowInsteadButton, StopBankRequestButton } from "./pay-now-instead";
import { canCancelAtGateway } from "./gateway-cancel";
import {
  BrandTheme,
  ProductGlyph,
  Row,
  RowList,
  StorefrontFooter,
  StorefrontHeader,
  StorefrontSection,
} from "../../chrome";
import {
  BalanceCard,
  MethodGlyph,
  PlanCard,
  SetupCard,
  lastFailure,
  methodLabel,
  mandateState,
  setupNeeds,
} from "./portal-chrome";
import { PortalPanes } from "./portal-panes";
import { PortalCreditsSection } from "./portal-credits";
import { PortalUsageControlsSection } from "./portal-usage-controls";
import { isPortalTab, type PortalTab } from "./portal-tabs";

/** Buyer invoice tones on the chip palette. */
const CHIP_TONE = { success: "green", warning: "tan", error: "red", neutral: "gray" } as const;
import { getCountries } from "@/lib/api/geo";
import { accountHolderName } from "@/lib/names";
import { canChargeMethod } from "@/lib/payment-method-status";
import { SetupReturn } from "./setup-return";
import { PaymentReturn } from "./payment-return";

export const dynamic = "force-dynamic";

/**
 * `generateMetadata` and the render are two passes over the same request, and both
 * need the business. React's `cache` makes the second call free — without it the
 * favicon would cost a whole extra portal round trip on every page load.
 */
const loadMe = cache((token: string) => portalMe(token));

/**
 * The browser tab is part of the brand, and it is the one piece that cannot be set
 * from inside the page. Deduped with the render's own `portalMe` by React `cache`, so
 * the favicon costs no extra round trip. A bad/expired token simply falls through to
 * the storefront default title — metadata must never throw.
 */
export async function generateMetadata() {
  const token = await readStorefrontToken("portal");
  const me = token ? await loadMe(token) : null;
  const biz = me?.ok ? me.data?.business : null;
  return {
    title: biz ? `Billing · ${biz.name}` : "Billing",
    ...(biz?.favicon_url ? { icons: { icon: biz.favicon_url } } : {}),
  };
}

/**
 * Buyer-facing billing portal (P14). Everything on this page is authed by the
 * customer-scoped portal token, which since W1 lives in an HttpOnly cookie set by
 * `/portal/s/<token>` rather than in this page's URL — the org API key is never used
 * (see lib/portal-api.ts).
 *
 * The token is read here, server-side, and never handed to a child component. What the
 * children get instead is the data they render plus `scope`, a non-secret key for
 * per-tab storage. Nothing on this page's client side can reach the credential.
 *
 * Layout: a branded header, then the balance statement, then the invoice the
 * balance refers to, then the instruments. Presentation lives in
 * `portal-chrome.tsx`; this file stays the data + control layer, so every button
 * below still reaches a real endpoint.
 */
export default async function PortalPage({
  searchParams,
}: {
  searchParams: Promise<{
    signed_out?: string;
    /** `expired`: the continue page's link was refused. */
    link?: string;
    /** Narrow-screen section filter — see `portal-panes.tsx`. */
    tab?: string;
    /** Gateway redirect returns. They also decide which section the buyer lands in. */
    setup?: string;
    pay?: string;
    /** How many invoices to render. Grows as the buyer asks for more. */
    invoices?: string;
    /** How many receipts to render. Grows the same way. */
    receipts?: string;
    /** Single-action links (Phase 4b): the task the link opens on. */
    pay_invoice?: string;
    add_card?: string;
  }>;
}) {
  const {
    signed_out,
    link,
    tab,
    setup,
    invoices: invoicesParam,
    receipts: receiptsParam,
    pay_invoice: payInvoice,
    add_card: addCard,
  } = await searchParams;

  /**
   * How many invoices to render. The engine's own default is 10 and it caps the request,
   * so a hand-edited `?invoices=100000` cannot bring back the unbounded read this
   * replaced. Anything unparseable falls back to the default rather than erroring — a bad
   * query string should not cost the buyer their whole portal.
   */
  const askedFor = Number.parseInt(invoicesParam ?? "", 10);
  const invoiceLimit = Number.isFinite(askedFor) && askedFor > 0 ? askedFor : undefined;
  // Same rule for receipts; the engine caps the page at 100.
  const askedReceipts = Number.parseInt(receiptsParam ?? "", 10);
  const receiptLimit =
    Number.isFinite(askedReceipts) && askedReceipts > 0 ? Math.min(askedReceipts, 100) : 10;

  const token = await readStorefrontToken("portal");
  if (!token) {
    // `?signed_out=1` only ever comes from `portalLogoutAction`'s own redirect — an
    // attacker-crafted URL carrying it lands on a session-less page either way, so
    // there is nothing to gain from spoofing it and nothing to check.
    return signed_out ? (
      <SignedOutCard />
    ) : (
      <ExpiredCard reason={link === "expired" ? "link" : "session"} />
    );
  }

  // The buyer's address form needs the same country data the operator forms use.
  const countries = await getCountries();
  // Credits (design G3 § 7): started early, read after; a failure hides the section only.
  const creditsP = portalGetCredits(token).catch(() => null);
  // Usage controls (design G5 § 5): each read degrades on its own.
  const runwayP = portalGetCreditRunway(token).catch(() => null);
  const limitsP = portalListSpendLimits(token).catch(() => null);
  const [me, pms, gws, invs, subs, buys, rcpts, reqs, ships] = await Promise.all([
    loadMe(token),
    portalListPaymentMethods(token),
    portalListGateways(token),
    portalListInvoices(token, invoiceLimit),
    portalListSubscriptions(token),
    portalListPurchases(token),
    portalListReceipts(token, receiptLimit),
    portalListRequests(token),
    portalListShippingAddresses(token),
  ]);

  if (!me.ok || !me.data) return <ExpiredCard />;
  const creditsRes = await creditsP;
  const [runwayRes, limitsRes] = await Promise.all([runwayP, limitsP]);
  const runway = runwayRes?.ok ? (runwayRes.data ?? null) : null;
  const spendLimits = limitsRes?.ok ? (limitsRes.data?.data ?? null) : null;
  // A customer with usage to limit may add its own limit, even with none yet (design D7).
  const canAddLimit = limitsRes?.ok ? limitsRes.data?.can_add === true : false;
  const credits =
    creditsRes?.ok &&
    creditsRes.data &&
    (creditsRes.data.balances.length > 0 ||
      creditsRes.data.grants.length > 0 ||
      creditsRes.data.packs.length > 0)
      ? creditsRes.data
      : null;

  // Hoisted past the `!me.data` guard above: TypeScript loses that narrowing
  // inside the invoices.map() callback below.
  const meData = me.data;
  const brand = meData.business;
  const business = brand.name;
  // Every date on this page renders in the BUSINESS's zone, not the viewer's and not
  // UTC. There is no BusinessTzProvider out here in the storefront tree, so it is
  // threaded by hand — and it must be, because this is the screen where a customer
  // compares an issue date against the invoice PDF.
  const tz = brand.timezone;
  const methods = pms.ok && pms.data ? pms.data.data : [];
  const gateways = gws.ok && gws.data ? gws.data.data : [];
  const invoices = invs.ok && invs.data ? invs.data.data : [];
  /** One-time purchases; the section shows only when there are some. */
  const purchases = buys.ok && buys.data ? buys.data.data : [];
  /** Whether the engine held anything back — see `portalListInvoices`. */
  const moreInvoices = invs.ok && invs.data ? invs.data.has_more : false;
  /** The next step of the same list, carried in the URL so it survives a reload. */
  const nextInvoiceCount = invoices.length + 10;
  /** Empty on a fetch failure: the rest of the portal must still render (same rule as above). */
  const subscriptions = subs.ok && subs.data ? subs.data.data : [];
  /** Numbered receipts, newest first. */
  const receipts = rcpts.ok && rcpts.data ? rcpts.data.data : [];
  const moreReceipts = rcpts.ok && rcpts.data ? rcpts.data.has_more : false;
  /** Open and processing payment requests the business sent this buyer. */
  const requests = reqs.ok && reqs.data ? reqs.data.data : [];
  /** Saved methods a request can charge: a dead instrument would only be refused. */
  const payMethods = methods.filter((pm) => canChargeMethod(pm.status));
  /** Live shipping addresses (0360). */
  const shippingAddresses = ships.ok && ships.data ? ships.data.data : [];
  /** Shipping shows when the business collects it, or this customer already has a book. */
  const shippingOn =
    meData.business.collects_shipping_address === true || shippingAddresses.length > 0;
  /**
   * Every rail this buyer can actually pick, unioned across the business's gateway
   * accounts. Only used to stop copy recommending a rail that is not on the page — see
   * `PlanCard`'s shortfall alert. A gateway that states no restriction reports null
   * `method_types`, which `AddCard` reads as "card only", so it contributes nothing here.
   */
  const offeredRails = [...new Set(gateways.flatMap((g) => g.method_types ?? []))];

  /**
   * Which cards cannot carry the renewal they are attached to, keyed by card id.
   *
   * Derived from the subscriptions ALREADY fetched above — `mandate_shortfall` rides on
   * each one's renewal estimate, which is the whole reason it was declined as its own
   * portal feature (an invoice plan per page load to catch a rare state). So this notice
   * costs nothing extra.
   *
   * Worst case wins when a card backs several subscriptions: the payer needs to authorise
   * once, at a ceiling that covers the largest debit, so showing the smaller gap would
   * send them back a second time.
   */
  const shortfallByPm = new Map<
    string,
    NonNullable<(typeof subscriptions)[number]["mandate_shortfall"]>
  >();
  for (const sub of subscriptions) {
    const sf = sub.mandate_shortfall;
    if (!sf) continue;
    const prev = shortfallByPm.get(sf.payment_method);
    if (!prev || sf.amount_minor > prev.amount_minor) shortfallByPm.set(sf.payment_method, sf);
  }

  const holder = accountHolderName(meData.customer);
  /**
   * Per-tab storage key for a redirect-mode card add (`lib/pending-vault-setup.ts`).
   * The customer's PUBLIC id — deliberately not the session token, which is what this
   * used to be. It is not a credential, it is stable across a hop out to PayPal and
   * back, and it keeps two buyers who share a browser from reading each other's
   * half-finished setup.
   */
  const scope = meData.customer.id;

  /**
   * Open invoices, badged on the narrow-screen "Invoices" control. Same statuses the
   * Pay now button is gated on, so the count can never promise a payable invoice the
   * list then refuses to offer.
   */
  // Invoices the buyer can act on: a payment already in progress is not one of them.
  const dueCount = invoices.filter(
    (i) => PAYABLE_STATUSES.has(i.status) && !i.payment_in_flight && !i.collection_scheduled_at,
  ).length;

  /** Invoices "Pay" can open a checkout for: owed, open, not moving, under the card limit. */
  const payable = invoices.filter(payableNow);
  /** The balance card carries the filled "Pay $X" when exactly one invoice is payable. */
  const balancePay = payable.length === 1 ? payable[0] : null;
  const setupShown = setupNeeds({ me: meData, methods, invoices, subs: subscriptions, tz }) != null;
  /** A failed charge or a broken primary: open the add form on the methods pane. */
  const methodTrouble =
    lastFailure(invoices, methods) != null ||
    methods.some((m) => m.is_default && methodProblem(m, tz) != null);

  /**
   * Which section the page opens on. Below 1000px it is the one section on screen; above
   * it, the pane under the plan (the plan itself is always shown there).
   *
   * A gateway redirect wins over everything: a buyer coming back from approving a card
   * at PayPal (`?setup=return`) must land on Payment methods, or the card they just
   * added is on a screen they are not looking at and the whole trip reads as a failure.
   * An explicit `?tab=` is next (a reload, a back button, a shared link). Otherwise
   * Invoices, which is what the payment email brought them here for.
   */
  const initialTab: PortalTab =
    setup === "return"
      ? "methods"
      : isPortalTab(tab)
        ? tab
        : /* Invoices is what a payment email brings a buyer here for — but only once
             there ARE any. With none it is the emptiest section on the page, and
             landing there put a full-height "No invoices yet" under the filter as the
             first thing a new customer saw. `PortalPanes` clamps to a section that
             actually rendered, so these are preferences, not guarantees. */
          invoices.length > 0
          ? "invoices"
          : "plan";

  return (
    <BrandTheme brand={brand}>
      {/* Finishes a redirect-mode add (PayPal approval) when the buyer lands back here. */}
      <SetupReturn scope={scope} me={meData} />

      {meData.return_url ? (
        <a
          data-document-link
          href={meData.return_url}
          rel="noopener"
          className="mb-2 inline-flex text-sm text-primary hover:underline"
        >
          ← Back to {brand.name}
        </a>
      ) : null}
      <StorefrontHeader
        brand={brand}
        eyebrow="Billing portal"
        aside={
          /* Who is signed in — the ACCOUNT HOLDER, not the billing contact. The two
             differ for exactly the customers where it matters most: a buyer whose
             invoices go to their finance team should not be told they are "Accounts
             Payable" on their own portal. */
          (holder ?? meData.customer.email) ? (
            <div className="flex flex-col items-end gap-1">
              {/* The identity is what a phone gives up, not the control. It is the one
                  thing here the page repeats elsewhere ("Billed to", Billing details),
                  whereas Sign out exists nowhere else — so on a narrow screen the
                  button stays and the name goes. */}
              {/* The name stays on a phone too (truncated): it is the only place that says
                  who is signed in. The email is the part a phone gives up. */}
              <div className="max-w-full min-w-0 text-right">
                <TruncatedText
                  value={holder ?? meData.customer.email ?? ""}
                  className="text-sm font-medium"
                />
                {/* `accountHolderName` FALLS BACK TO THE EMAIL, so a customer with no
                    name resolves `holder` TO their email and this guard passed on the
                    same string — printing it twice, stacked, in the page's top-right.
                    The second line is only worth its space when it differs. */}
                {holder && meData.customer.email && holder !== meData.customer.email ? (
                  <TruncatedText
                    value={meData.customer.email}
                    className="hidden text-xs text-muted-foreground sm:block"
                  />
                ) : null}
              </div>
              {/* Beside the identity it ends (F-22) — the obvious home for it, and the
                  only place on the page that says who is signed in. Ending a session
                  is not destructive (nothing is deleted, nothing is charged), so it
                  reads as a plain, quiet control rather than a warning — the design
                  system reserves semantic colour for things that actually need one. */}
              <form action={portalLogoutAction}>
                <button
                  type="submit"
                  className="flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground hover:text-foreground hover:underline"
                >
                  <LogOut className="size-3" aria-hidden />
                  Sign out
                </button>
              </form>
            </div>
          ) : null
        }
      />

      {/* Its money-side twin: finishes a redirect-mode "Pay now" (a PayPal order, a bank
          auth link), then shows that payment until it settles. */}
      <PaymentReturn scope={scope} me={meData} invoices={invoices} />

      <PortalPanes
        initialTab={initialTab}
        dueCount={dueCount}
        setup={
          <SetupCard
            me={meData}
            methods={methods}
            invoices={invoices}
            subs={subscriptions}
            tz={tz}
          />
        }
        balance={
          <BalanceCard
            me={meData}
            invoices={invoices}
            methods={methods}
            holder={holder}
            tz={tz}
            hideWhenClear={setupShown}
            payNow={
              balancePay ? (
                <PayInvoiceButton
                  invoice={balancePay.id}
                  currency={balancePay.currency}
                  amountMinor={balancePay.amount_due_minor}
                  me={meData}
                  scope={scope}
                  size="default"
                  // The balance card leads with adding a method when this one is dead.
                  variant={lastFailure(invoices, methods)?.newMethodNeeded ? "outline" : "default"}
                />
              ) : null
            }
          />
        }
        invoices={
          <>
            {requests.map((r) => {
              const open = r.lines
                .filter((l) => l.state === "open")
                .sort((a, b) => a.position - b.position);
              const firstPm =
                payMethods.find((pm) => pm.id === r.payment_method) ??
                payMethods.find((pm) => pm.role === "primary") ??
                payMethods[0];
              return (
                <StorefrontSection
                  key={r.id}
                  title="Payment request"
                  description={`${business} asks you to pay ${open.length === 1 ? "this invoice" : `these ${open.length} invoices`} together.`}
                  bodyClassName="p-0"
                >
                  <RowList>
                    {open.map((l) => (
                      <Row key={l.invoice}>
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium wrap-break-word">
                              {l.invoice_number ?? "Invoice"}
                            </div>
                            {l.due_date ? (
                              <div className="mt-0.5 text-xs text-muted-foreground">
                                Due {fmtDate(l.due_date, tz)}
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <div className="text-right text-sm font-medium tabular-nums sm:min-w-28">
                          {money(l.amount_due_minor, r.currency)}
                        </div>
                      </Row>
                    ))}
                  </RowList>
                  <div className="flex flex-col gap-3 border-t px-5 py-4">
                    {r.last_payment_error && r.status === "open" ? (
                      <Alert tone="error">
                        The last payment was not successful.
                        {r.last_payment_error.message ? ` ${r.last_payment_error.message}` : ""}
                      </Alert>
                    ) : null}
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="text-sm">
                        <span className="text-muted-foreground">Total due: </span>
                        <span className="font-semibold tabular-nums">
                          {money(r.amount_minor, r.currency)}
                        </span>
                      </div>
                      {r.status === "processing" ? (
                        <span className="text-xs text-muted-foreground">Payment processing…</span>
                      ) : firstPm && r.amount_minor > 0 ? (
                        <PayRequestForm
                          preq={r.id}
                          label={`Pay ${money(r.amount_minor, r.currency)}`}
                          methods={payMethods.map((pm) => ({
                            value: pm.id,
                            label: methodLabel(pm),
                          }))}
                          defaultMethod={firstPm.id}
                        />
                      ) : null}
                    </div>
                    <p className="m-0 text-xs text-muted-foreground">
                      {firstPm
                        ? "We charge your saved payment method. You can also pay each invoice on its own in the list below."
                        : "You have no saved payment method. Pay each invoice on its own in the list below."}
                    </p>
                  </div>
                </StorefrontSection>
              );
            })}
            <StorefrontSection
              title="Invoices"
              hideTitle
              description="Pay an open invoice or download a PDF for your records."
              bodyClassName="p-0"
            >
              {/* One paging method: "Show older invoices" below. No inner scroll box. */}
              {invoices.length === 0 ? (
                <EmptyState
                  compact
                  icon={<FileText />}
                  title="No invoices yet"
                  description="Invoices show here when we issue them."
                />
              ) : (
                <RowList>
                  {invoices.map((inv) => {
                    const state = buyerInvoiceState(inv);
                    const issued = fmtDate(inv.created_at, tz);
                    // A second date only when it says something the first does not.
                    const paidOn = inv.paid_at ? fmtDate(inv.paid_at, tz) : null;
                    const dueOn =
                      !inv.paid_at && inv.amount_due_minor > 0 && inv.due_date
                        ? fmtDate(inv.due_date, tz)
                        : null;
                    // A held invoice has no Pay button: it finalizes by itself, then we charge it.
                    const second =
                      inv.status === "pending" && inv.usage_closes_at
                        ? `Finalizes on ${fmtDateTime(inv.usage_closes_at, tz)}`
                        : paidOn && paidOn !== issued
                          ? `paid ${paidOn}`
                          : dueOn && dueOn !== issued
                            ? `due ${dueOn}`
                            : null;
                    return (
                      <Row key={inv.id} className="flex-row flex-wrap items-center gap-x-4 gap-y-2">
                        <div className="flex min-w-0 flex-1 basis-52 items-center gap-3">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="text-sm font-medium wrap-break-word">
                                {inv.number ?? "Invoice"}
                              </span>
                              <PopOnChange value={state.label}>
                                <Chip tone={CHIP_TONE[state.tone]}>{state.label}</Chip>
                              </PopOnChange>
                            </div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {issued}
                              {second ? ` · ${second}` : ""}
                            </div>
                          </div>
                        </div>
                        {/* Amount on the right edge, so the money reads as one column whatever
                            actions a row has. */}
                        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-2">
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            {inv.payment_in_flight && inv.amount_due_minor <= 0 ? (
                              /* A settled invoice with a stray in-flight debit: nothing is required
                                 of the buyer. The abandon control stays where an AFA request exists,
                                 because it is their way to stop a debit they do not owe. */
                              <span className="text-right text-xs leading-tight text-muted-foreground">
                                No payment needed
                                <span className="block">This invoice is already settled</span>
                                {inv.awaiting_authentication ? (
                                  <StopBankRequestButton
                                    invoice={inv.id}
                                    gateway={inv.in_flight_gateway}
                                  />
                                ) : null}
                              </span>
                            ) : inv.payment_in_flight && inv.awaiting_authentication ? (
                              /* Waiting on the BUYER's bank approval. The escape hatch only where
                                 the gateway can void the first attempt: elsewhere "pay another
                                 way" could charge twice. */
                              <div className="flex flex-col items-end gap-1.5 text-right text-xs leading-tight">
                                {canCancelAtGateway(inv.in_flight_gateway) ? (
                                  <>
                                    <span className="text-muted-foreground">
                                      Approve the auto-debit with your bank, or
                                    </span>
                                    <PayNowInsteadButton
                                      invoice={inv.id}
                                      gateway={inv.in_flight_gateway}
                                    />
                                  </>
                                ) : (
                                  <>
                                    <span className="text-muted-foreground">
                                      Approve the auto-debit with your bank.
                                    </span>
                                    <span className="text-muted-foreground/80">
                                      We cannot take a separate payment until this one finishes.
                                    </span>
                                  </>
                                )}
                              </div>
                            ) : inv.payment_in_flight ? (
                              /* Money is moving: say so instead of a button the engine refuses. */
                              <span className="text-xs text-muted-foreground">
                                Payment processing…
                              </span>
                            ) : inv.collection_scheduled_at && inv.amount_due_minor > 0 ? (
                              /* The bank has the notice: a second payment would only race it. */
                              <span className="max-w-56 text-right text-xs leading-tight text-muted-foreground">
                                Payment scheduled
                                <span className="block">
                                  We take it on {fmtDateTime(inv.collection_scheduled_at, tz)}. Do
                                  not pay again.
                                </span>
                              </span>
                            ) : inv.amount_due_minor > 0 &&
                              PAYABLE_STATUSES.has(inv.status) &&
                              inv.over_card_limit ? (
                              /* Above the business's card limit: there is no checkout to open. */
                              <span className="max-w-56 text-right text-xs text-muted-foreground">
                                We do not accept a card for this amount. The PDF shows how to pay.
                              </span>
                            ) : inv.amount_due_minor > 0 && PAYABLE_STATUSES.has(inv.status) ? (
                              /* No rail is named: the buyer picks it in the provider's own form. */
                              <PayInvoiceButton
                                invoice={inv.id}
                                currency={inv.currency}
                                amountMinor={inv.amount_due_minor}
                                me={meData}
                                scope={scope}
                                focus={payInvoice === inv.id}
                                variant={balancePay?.id === inv.id ? "outline" : "default"}
                                refusalSlot={`pay-refusal-${inv.id}`}
                              />
                            ) : null}
                            {/* A quiet text link: one filled action per screen (decided 2026-11-17). */}
                            <Link
                              href={`/portal/invoices/${inv.id}/pdf`}
                              prefetch={false}
                              className="text-sm font-medium text-primary hover:underline"
                            >
                              PDF
                            </Link>
                          </div>
                          <div className="min-w-20 text-right">
                            <div className="text-sm font-medium tabular-nums">
                              {money(inv.total_minor, inv.currency)}
                            </div>
                            {/* A held invoice is not final: usage is added when it finalizes. */}
                            {inv.status === "pending" && inv.usage_closes_at ? (
                              <div className="text-xs text-muted-foreground">so far</div>
                            ) : null}
                            {/* Only when part is already paid: a second copy of the total says nothing. */}
                            {inv.status !== "pending" &&
                            inv.amount_due_minor > 0 &&
                            inv.amount_due_minor !== inv.total_minor ? (
                              <div className="text-xs text-muted-foreground tabular-nums">
                                {money(inv.amount_due_minor, inv.currency)} due
                              </div>
                            ) : null}
                          </div>
                        </div>
                        {/* A Pay now refusal, on its own line under the row (see PayInvoiceButton). */}
                        <div id={`pay-refusal-${inv.id}`} className="basis-full empty:hidden" />
                      </Row>
                    );
                  })}
                </RowList>
              )}
              {/* A LINK, not a button: this is the same page with more of the same list, so
                  it survives a reload and a share, needs no client state, and works before
                  hydration. `scroll={false}` because the buyer is at the bottom of the list
                  and jumping them back to the balance card is the opposite of what they
                  asked for. Rendered only when the engine says it held rows back. */}
              {moreInvoices ? (
                <div className="border-t px-5 py-3 text-center">
                  <Link
                    href={`/portal?invoices=${nextInvoiceCount}${receiptsParam ? `&receipts=${receiptLimit}` : ""}${tab ? `&tab=${tab}` : ""}`}
                    scroll={false}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    Show older invoices
                  </Link>
                </div>
              ) : null}
            </StorefrontSection>
            {purchases.length > 0 ? (
              <StorefrontSection
                title="Purchases"
                description="One-time products that you bought. Download a receipt for each."
                bodyClassName="p-0"
              >
                <RowList>
                  {purchases.map((p) => {
                    const first = p.items[0];
                    const more = p.items.length - 1;
                    const refund =
                      p.refunded_minor <= 0
                        ? null
                        : p.refunded_minor >= p.total_minor
                          ? "Refunded"
                          : `${money(p.refunded_minor, p.currency)} refunded`;
                    return (
                      <Row
                        key={p.invoice}
                        className="flex-row flex-wrap items-center gap-x-4 gap-y-2"
                      >
                        <div className="flex min-w-0 flex-1 basis-52 items-center gap-3">
                          <ProductGlyph src={first?.image_url} />
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="text-sm font-medium wrap-break-word">
                                {first
                                  ? `${first.description}${first.quantity > 1 ? ` × ${first.quantity}` : ""}`
                                  : (p.number ?? p.invoice)}
                                {more > 0 ? ` and ${more} more` : ""}
                              </span>
                              {refund ? <Chip>{refund}</Chip> : null}
                            </div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {fmtDate(p.paid_at ?? p.created_at, tz)}
                              {p.number ? ` · ${p.number}` : ""}
                            </div>
                          </div>
                        </div>
                        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-2">
                          <Link
                            href={`/portal/invoices/${p.invoice}/pdf`}
                            prefetch={false}
                            className="text-sm font-medium text-primary hover:underline"
                          >
                            Receipt
                          </Link>
                          <div className="min-w-20 text-right text-sm font-medium tabular-nums">
                            {money(p.total_minor, p.currency)}
                          </div>
                        </div>
                      </Row>
                    );
                  })}
                </RowList>
              </StorefrontSection>
            ) : null}
            {receipts.length > 0 ? (
              <StorefrontSection
                title="Receipts"
                description="A receipt for each payment that you made. Download a PDF for your records."
                bodyClassName="p-0"
              >
                <RowList>
                  {receipts.map((rc) => (
                    <Row key={rc.id} className="flex-row flex-wrap items-center gap-x-4 gap-y-2">
                      <div className="flex min-w-0 flex-1 basis-52 items-center gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium wrap-break-word">{rc.number}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {fmtDate(rc.paid_at, tz)} · {normalizeMethodWords(rc.method)}
                          </div>
                        </div>
                      </div>
                      <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-2">
                        {/* A quiet text link: one filled action per screen (decided 2026-11-17). */}
                        <Link
                          href={`/portal/receipts/${rc.id}/pdf`}
                          prefetch={false}
                          className="text-sm font-medium text-primary hover:underline"
                        >
                          PDF
                        </Link>
                        <div className="min-w-20 text-right text-sm font-medium tabular-nums">
                          {money(rc.amount_minor, rc.currency)}
                        </div>
                      </div>
                    </Row>
                  ))}
                </RowList>
                {moreReceipts ? (
                  <div className="border-t px-5 py-3 text-center">
                    <Link
                      href={`/portal?receipts=${receipts.length + 10}${invoiceLimit ? `&invoices=${invoiceLimit}` : ""}${tab ? `&tab=${tab}` : ""}`}
                      scroll={false}
                      className="text-sm font-medium text-primary hover:underline"
                    >
                      Show older receipts
                    </Link>
                  </div>
                ) : null}
              </StorefrontSection>
            ) : null}
          </>
        }
        plan={
          <>
            {subscriptions.length > 0 ? (
              <PlanCard
                subs={subscriptions}
                tz={tz}
                allowCoupons={meData.business.allow_customer_coupons}
                offeredRails={offeredRails}
                shippingAddresses={shippingOn ? shippingAddresses : undefined}
                canCharge={payMethods.length > 0}
              />
            ) : (
              /* No subscription: say so, and give a way forward. */
              <Card className="gap-0 py-0">
                <h2 className="sr-only">Your plan</h2>
                <EmptyState
                  compact
                  icon={<Package />}
                  title="You have no subscription"
                  description={
                    brand.has_pricing_page && brand.id
                      ? `To subscribe, select a plan from ${business}.`
                      : `To subscribe, contact ${business}.`
                  }
                  action={
                    brand.has_pricing_page && brand.id ? (
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/pricing/${brand.id}`} prefetch={false}>
                          View plans
                        </Link>
                      </Button>
                    ) : (
                      <PortalContact
                        name={business}
                        supportEmail={brand.support_email}
                        website={brand.website}
                        className="mt-0"
                      />
                    )
                  }
                />
              </Card>
            )}
            {credits ? <PortalCreditsSection credits={credits} tz={tz} /> : null}
            {/* Shown when there is a limit, a limit the buyer may add, or a runway to state. */}
            {spendLimits?.length || canAddLimit || (runway && runway.runway_days != null) ? (
              <PortalUsageControlsSection
                runway={runway}
                limits={spendLimits}
                canAdd={canAddLimit}
                business={business}
                currency={runway?.currency ?? spendLimits?.[0]?.currency ?? "USD"}
                tz={tz}
              />
            ) : null}
          </>
        }
        methods={
          <>
            {/* One section, not two: the list and the way to extend it are the same
          subject, and a separate "Add a payment method" card repeated the heading
          for no gain. The add flow keeps the card surface (not a recessed well)
          because it can expand into a full billing-address form. */}
            <StorefrontSection
              title="Payment methods"
              hideTitle
              description="Cards and mandates this business may charge for your subscription."
              action={<AddMethodButton />}
              bodyClassName="p-0"
            >
              {methods.length === 0 ? (
                <EmptyState
                  compact
                  icon={<CreditCard />}
                  title="No payment method saved"
                  description="Add one so that we can collect invoice payments automatically."
                />
              ) : (
                /* Scrolled, not paginated, and only once there are enough to need it.
                   Unlike invoices this list is BOUNDED — a buyer holds a handful of
                   instruments, not a history — so there is nothing to fetch lazily and a
                   cursor would be machinery for no gain. What it does need is a ceiling:
                   each row carries a mandate-status line, so five instruments ran to
                   1024px and the card towered over everything beside it. Four rows fit,
                   the rest scroll, and no instrument becomes unreachable. */
                <div>
                  <ExitRowList>
                    {methods.map((pm) => {
                      /* What the mandate behind this instrument is doing — see `mandateState`. The
                 chip, the limit line and the well below all read it, so they cannot end up
                 telling the buyer three different stories about one authorization. */
                      const mandate = mandateState(pm);
                      const problem = methodProblem(pm, tz);
                      return (
                        <ArriveRow key={pm.id} rowId={pm.id} className="px-5 py-3.5">
                          <div className="flex flex-col gap-2.5">
                            <div className="flex min-w-0 items-center gap-3">
                              <MethodGlyph pm={pm} />
                              <div className="min-w-0">
                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                  <span className="text-sm font-medium wrap-break-word">
                                    {methodLabel(pm)}
                                  </span>
                                  {/* One word for this role across both surfaces (2026-09-14):
                                      the operator dashboard says Primary and so does this. It
                                      pairs with Backup — "default" has no opposite — and it
                                      matches the engine's `role` and `/assign_role`. Read off
                                      `role`, not `is_default`: that field is literally
                                      `role === "primary"`, kept on the API for integrators. */}
                                  <PopOnChange value={pm.role ?? ""}>
                                    {pm.role === "primary" ? <Chip>Primary</Chip> : null}
                                  </PopOnChange>
                                  {/* Every card the engine will fall back to, so a removed one
                              is visibly different. */}
                                  {pm.role === "backup" ? <Chip>Backup</Chip> : null}
                                  {problem ? (
                                    <Chip tone={problem === "pending" ? "gray" : "red"}>
                                      {METHOD_PROBLEM_LABEL[problem]}
                                    </Chip>
                                  ) : pm.status === "expiring" ? (
                                    <Chip tone="tan">Expires soon</Chip>
                                  ) : null}
                                  {/* A mandate the bank has not confirmed yet. The instrument's own
                            status is still `valid` here — nothing is wrong with it — so
                            without this the row looks ready and silently is not. Not shown
                            for a dead mandate: that already flips the instrument to
                            `invalid`, and the chip beside this one says so. */}
                                  {mandate.kind === "pending" ? (
                                    <Chip>Awaiting bank confirmation</Chip>
                                  ) : null}
                                </div>
                                {pm.exp_month && pm.exp_year ? (
                                  <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                                    {problem === "expired" ? "Expired" : "Expires"}{" "}
                                    {String(pm.exp_month).padStart(2, "0")}/{pm.exp_year}
                                  </div>
                                ) : null}
                                {/* Why it cannot be charged, and the fix. A dead mandate has its
                                    own well below. */}
                                {problem && !(problem === "invalid" && mandate.kind === "dead") ? (
                                  <div className="mt-1 text-xs text-destructive">
                                    {problem === "invalid"
                                      ? "We cannot charge this payment method. Add a new one."
                                      : problem === "expired"
                                        ? "We cannot charge an expired card. Add a new payment method."
                                        : "We cannot charge it until it is verified."}
                                  </div>
                                ) : null}
                                {/* The mandate's per-debit CEILING, as the PROVIDER registered and
                          enforces it (`payment_methods.mandate_max_amount_minor`). It sits
                          beside the expiry because it is the same kind of fact — a hard
                          limit on what this instrument can do — and it is the number that
                          decides whether a renewal is collectable at all: a debit above it
                          is refused before the gateway is even called (`mandateRefusal`).
                          The buyer is also the only person who can raise it, by authorizing
                          again, so they are the right audience for it.

                          Rendered only when the provider reported the amount AND its
                          currency. A null amount means UNKNOWN, not unlimited (the charge
                          pre-flight skips its check then), and a bare number under a guessed
                          currency would claim something we do not know. Saying nothing
                          claims nothing. */}
                                {pm.mandate?.max_amount_minor != null && pm.mandate.currency ? (
                                  <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                                    Up to {money(pm.mandate.max_amount_minor, pm.mandate.currency)}{" "}
                                    per charge
                                  </div>
                                ) : null}
                                {/* THE CEILING IS TOO SMALL FOR WHAT THIS CARD MUST COLLECT.
                                    Rendered here rather than on the plan pane because this is
                                    where the number it contradicts is shown, and because the
                                    payer is the only person who can raise it — a mandate's
                                    ceiling cannot be changed in place, only replaced by a fresh
                                    authorisation. States the amount it must reach so
                                    re-authorising is a decision rather than an act of faith,
                                    and says when the card rail alone will not be enough. */}
                                {(() => {
                                  const sf = shortfallByPm.get(pm.id);
                                  if (!sf) return null;
                                  return (
                                    <div className="mt-1.5 text-xs text-warning">
                                      This card is authorised for{" "}
                                      {money(sf.ceiling_minor, sf.currency)} per charge, but your
                                      next payment is {money(sf.amount_minor, sf.currency)}. We
                                      cannot collect it automatically. Add this card again to
                                      authorise up to{" "}
                                      {money(sf.reauthorized_ceiling_minor, sf.currency)}
                                      {sf.needs_authentication_even_if_raised
                                        ? ". With a card, your bank still asks you to approve each charge of this size. A netbanking mandate can collect it automatically, but a card cannot."
                                        : "."}
                                    </div>
                                  );
                                })()}
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 sm:ml-12">
                              {!pm.is_default && !problem ? (
                                <ActionForm action={portalSetDefaultAction}>
                                  <input type="hidden" name="pm" value={pm.id} />
                                  {/* OUTLINE, deliberately — do not "promote" this to the default
                                      variant to give the row a primary action. On the operator
                                      dashboard `variant="default"` is near-black ink, but this is
                                      a HOSTED page: `brandCss` rewrites `--solid` to the
                                      merchant's raw brand colour (`lib/brand.ts`), so a filled
                                      button here renders full-strength brand — a solid orange
                                      "Make primary" for an orange merchant. That reads as the
                                      loudest thing on the page for what is a reversible
                                      preference change, and it was rejected on sight.

                                      The row's hierarchy comes from ORDER and from `Remove`
                                      being quieter (ghost), not from a fill. The section's own
                                      tab pill is the only filled element in this column, and it
                                      uses ink (`--foreground`) precisely so it does not become
                                      a second brand-coloured surface. */}
                                  <Button type="submit" variant="outline" size="sm">
                                    Make primary
                                  </Button>
                                </ActionForm>
                              ) : null}
                              {/* Every method that is not primary is a backup, tried in turn
                          when the primary declines: no "Remove backup". "Make backup" is
                          only for an older method saved with no role. */}
                              {pm.role !== "backup" && !pm.is_default && !problem ? (
                                <ActionForm action={portalSetBackupAction}>
                                  <input type="hidden" name="pm" value={pm.id} />
                                  <Button type="submit" variant="outline" size="sm">
                                    Make backup
                                  </Button>
                                </ActionForm>
                              ) : null}
                              {/* Confirmed, not one-click: it deletes the instrument here AND at
                        the gateway, and it sits a keystroke from "Make primary". */}
                              <RemovePaymentMethod
                                pm={pm.id}
                                label={methodLabel(pm)}
                                isPrimary={pm.role === "primary"}
                                mandateRail={pm.mandate?.rail}
                                askReason={
                                  methods.length === 1 && meData.business.ask_delete_reason === true
                                }
                              />
                            </div>
                          </div>
                          {/* An instrument on a MANDATE rail is an authorization the buyer
                    gave their BANK, not just a stored card. "Remove" takes it off
                    this account and stops us charging it — but the mandate itself
                    survives at the bank, and we cannot revoke it: RazorPay refuses
                    to delete an active recurring token and exposes no cancel route
                    (operator ask 5). Only the payer can, from their UPI app or
                    bank portal. Saying so here is the difference between an honest
                    control and one that implies the autopay has been cancelled. */}
                          {pm.mandate?.rail ? (
                            <div className="mt-2.5 flex items-start gap-2 rounded-xl bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground sm:ml-12">
                              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                              {/* One well, three states. "Auto-debit authorized" was said unconditionally,
                        which is simply untrue while the bank is still confirming (a netbanking
                        e-mandate is `initiated` until T+1) and after the buyer has revoked it —
                        the two moments a buyer is most likely to be reading this row. */}
                              {mandate.kind === "pending" ? (
                                <span>
                                  Auto-debit is not active yet ({mandateRailLabel(pm.mandate.rail)}
                                  ). Your bank is still confirming this authorization. This can take
                                  until the next working day. We do not automatically collect
                                  invoices due before then. Pay them from{" "}
                                  <PortalSectionLink section="invoices">Invoices</PortalSectionLink>
                                  .
                                </span>
                              ) : mandate.kind === "dead" ? (
                                <span>
                                  This auto-debit authorization is no longer active (
                                  {mandateRailLabel(pm.mandate.rail)} · {mandate.status}). We cannot
                                  collect from this account. Add a payment method to give a new
                                  authorization.
                                </span>
                              ) : (
                                <span>
                                  Auto-debit authorized ({mandateRailLabel(pm.mandate.rail)}). If
                                  you delete it here, we stop charges from this account. To cancel
                                  the mandate, revoke it {mandateRevokeWhere(pm.mandate.rail)}.
                                </span>
                              )}
                            </div>
                          ) : null}
                        </ArriveRow>
                      );
                    })}
                  </ExitRowList>
                </div>
              )}
              {/* A popup (option C), opened by "Add a payment method" at the top right of this card or
                  by any link that asks for it. See `add-method-disclosure.tsx`. */}

              <AddMethodDisclosure
                // A popup now: it opens by itself only when the buyer came to add a method
                // (an email's link, a setup coming back), never on every visit.
                defaultOpen={setup === "return" || addCard === "1"}
              >
                <AddCard
                  currency={subscriptions[0]?.currency ?? invoices[0]?.currency ?? null}
                  scope={scope}
                  me={meData}
                  countries={countries}
                  gateways={gateways}
                  routes={gws.data?.method_routes ?? null}
                  expectedDebitMinor={gws.data?.expected_debit_minor ?? 0}
                  unattendedLimitMinor={gws.data?.unattended_debit_limit_minor ?? null}
                />
              </AddMethodDisclosure>
            </StorefrontSection>
          </>
        }
        details={
          <>
            {/* Above payment methods on purpose: it is the prerequisite for adding one
          (card networks require a billing address, and `AddCard` refuses to start a
          setup without it), and it is what every invoice on this page is addressed
          to. The buyer is also the only person who knows when it changes. */}
            <StorefrontSection
              title="Billing details"
              hideTitle
              description="The name and address that we print on your invoices. They also set the tax on your invoices."
            >
              <BillingDetails me={meData} countries={countries} />
            </StorefrontSection>
            {shippingOn ? (
              <StorefrontSection
                title="Shipping addresses"
                description="Where we send your orders. Each subscription ships to your default address unless you select a different one."
                bodyClassName="p-0"
              >
                <ShippingAddresses
                  addresses={shippingAddresses}
                  countries={countries}
                  billing={{
                    ...meData.customer.address,
                    first_name:
                      meData.customer.address.first_name ??
                      (meData.customer.address.last_name ? null : meData.customer.first_name),
                    last_name:
                      meData.customer.address.last_name ??
                      (meData.customer.address.first_name ? null : meData.customer.last_name),
                  }}
                />
              </StorefrontSection>
            ) : null}
          </>
        }
      />

      <StorefrontFooter
        business={business}
        supportEmail={brand.support_email}
        website={brand.website}
      />
    </BrandTheme>
  );
}
