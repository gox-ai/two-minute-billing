import { cache } from "react";
import Link from "next/link";
import {
  Clock,
  CreditCard,
  Download,
  FileText,
  Info,
  LogOut,
  ReceiptText,
  ShoppingBag,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Chip, StatusChip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { money, fmtDate } from "@/lib/format";
import {
  portalMe,
  portalListPaymentMethods,
  portalListGateways,
  portalListInvoices,
  portalListPurchases,
  portalListSubscriptions,
  portalListShippingAddresses,
  portalLinkNotice,
  portalListReceipts,
  portalListRequests,
  portalGetCreditRunway,
  portalGetCredits,
  portalListSpendLimits,
} from "@/lib/portal-api";
import { readPortalBusiness, readStorefrontToken } from "@/lib/storefront-session";
import { SafeHtml } from "@/components/safe-html";
import {
  portalRemoveBackupAction,
  portalSetBackupAction,
  portalSetDefaultAction,
  portalLogoutAction,
} from "./actions";
import { EmailCodeSignIn } from "./email-code-sign-in";
import { RemovePaymentMethod } from "./remove-method";
import { AddCard } from "./add-card";
import { AddMethodDisclosure } from "./add-method-disclosure";
import { PortalSectionLink } from "./section-link";
import { BillingDetails } from "./billing-details";
import { ShippingAddresses } from "./shipping-addresses";
import { PayInvoiceButton } from "./pay-invoice";
import { PayRequestForm } from "./pay-request";
import { PayNowInsteadButton, StopBankRequestButton } from "./pay-now-instead";
import { canCancelAtGateway } from "./gateway-cancel";
import {
  BrandTheme,
  Glyph,
  ProductGlyph,
  NoticeCard,
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
  methodLabel,
  mandateState,
} from "./portal-chrome";
import { PortalPanes } from "./portal-panes";
import { PortalCreditsSection } from "./portal-credits";
import { PortalUsageControlsSection } from "./portal-usage-controls";
import { isPortalTab, type PortalTab } from "./portal-tabs";

/**
 * Mirrors `OPEN_INVOICE_STATUSES` in src/modules/invoicing/status.ts — the statuses
 * where the engine will actually take money. Rendering "Pay now" on anything else
 * offers a control that is refused the moment it is pressed.
 */
const PAYABLE_STATUSES = new Set(["posted", "payment_due", "not_paid"]);
import { getCountries } from "@/lib/api/geo";
import { accountHolderName } from "@/lib/names";
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
 * Shown when there is no session cookie at all — someone opened `/portal` directly, or
 * their cookie expired. Worded identically to the invalid-token card below, because
 * from the buyer's side the two are the same situation and the difference is ours to
 * care about, not theirs.
 *
 * There is deliberately NO self-serve way back in, so the copy says "ask for a new link"
 * and stops there rather than pointing anywhere. `/portal/request` used to be the answer
 * and was deleted on 2026-08-30 — a single-use link a buyer requests by email is spent by
 * the mail scanner before they click it. See `src/modules/customer-portal/README.md`
 * § "Self-serve access". Do not add a link here until something exists to link to.
 */
async function ExpiredCard() {
  // The business comes from the link's own failed exchange or the last session on this
  // browser (`rememberPortalBusiness`); with neither, the default copy stands alone.
  const biz = await readPortalBusiness();
  const notice = biz ? await portalLinkNotice(biz) : null;
  const card = (
    <NoticeCard icon={<Clock />} title="This link is not valid or is expired">
      {notice?.message_html ? (
        <SafeHtml
          html={notice.message_html}
          className="[&_a]:text-primary [&_a]:underline [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:text-foreground [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground [&_ol]:list-inside [&_ol]:list-decimal [&_p]:my-2 [&_ul]:list-inside [&_ul]:list-disc"
        />
      ) : (
        "Billing links are valid for a limited time. Ask for a new link."
      )}
      {biz && notice?.email_code ? <EmailCodeSignIn business={biz} /> : null}
    </NoticeCard>
  );
  if (!notice) return card;
  return (
    <BrandTheme brand={notice.business}>
      <StorefrontHeader brand={notice.business} eyebrow="Billing portal" />
      {card}
    </BrandTheme>
  );
}

/**
 * F-22: what a buyer sees right after pressing "Sign out" — landing on this same route
 * with no cookie left. Reusing `ExpiredCard`'s copy there would tell someone who just
 * chose to leave that their link "expired", which reads as a failure of something that
 * worked exactly as asked. Same empty state underneath (no session, nothing to show),
 * different word for why it's empty. No link back in, same as `ExpiredCard` — there is
 * still no self-serve way back in; the buyer needs a fresh link either way.
 */
async function SignedOutCard() {
  // Phase 4: where the business offers sign-in by code, the way back is on this card.
  const biz = await readPortalBusiness();
  const notice = biz ? await portalLinkNotice(biz) : null;
  const codeOn = !!biz && !!notice?.email_code;
  return (
    <NoticeCard icon={<LogOut />} title="You are signed out">
      {codeOn
        ? "Your billing session ended. To return, sign in with your email."
        : "Your billing session ended. To return, ask for a new link."}
      {codeOn ? <EmailCodeSignIn business={biz!} /> : null}
    </NoticeCard>
  );
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
    return signed_out ? <SignedOutCard /> : <ExpiredCard />;
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
  const payMethods = methods.filter((pm) => !pm.status || pm.status === "valid");
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
    (i) => PAYABLE_STATUSES.has(i.status) && !i.payment_in_flight,
  ).length;

  /**
   * Which section a narrow screen opens on. Only matters below 1000px — above it every
   * section is on screen at once and this is ignored.
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
          : subscriptions.length > 0
            ? "plan"
            : "methods";

  return (
    <BrandTheme brand={brand}>
      {/* Finishes a redirect-mode add (PayPal approval) when the buyer lands back here. */}
      <SetupReturn scope={scope} />

      {meData.return_url ? (
        <a
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
              <div className="hidden sm:block">
                <div className="truncate text-sm font-medium">
                  {holder ?? meData.customer.email}
                </div>
                {/* `accountHolderName` FALLS BACK TO THE EMAIL, so a customer with no
                    name resolves `holder` TO their email and this guard passed on the
                    same string — printing it twice, stacked, in the page's top-right.
                    The second line is only worth its space when it differs. */}
                {holder && meData.customer.email && holder !== meData.customer.email ? (
                  <div className="truncate text-xs text-muted-foreground">
                    {meData.customer.email}
                  </div>
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
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
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
      <PaymentReturn scope={scope} />

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
        balance={<BalanceCard me={meData} invoices={invoices} methods={methods} holder={holder} />}
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
                          <Glyph>
                            <FileText />
                          </Glyph>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">
                              {l.invoice_number ?? l.invoice}
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
              description="Pay an open invoice or download a PDF for your records."
              bodyClassName="p-0"
            >
              {/* The rows are capped and scrolled once there are enough to need it. The list
                  is already BOUNDED server-side — ten, then "Show older invoices" below — so
                  this only limits how much height ONE page of it may claim: with no ceiling
                  the invoice column set the height of the whole portal and pushed the account
                  column off screen. The "show older" link stays OUTSIDE the scroller, so it is
                  reachable without scrolling the list to its end first. */}
              {invoices.length === 0 ? (
                <EmptyState
                  icon={<FileText />}
                  title="No invoices yet"
                  description="Invoices show here when we issue them."
                />
              ) : (
                <div className={invoices.length > 5 ? "max-h-[28rem] overflow-y-auto" : undefined}>
                  <RowList>
                    {invoices.map((inv) => (
                      <Row key={inv.id}>
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <Glyph>
                            <FileText />
                          </Glyph>
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-sm font-medium">
                                {inv.number ?? inv.id}
                              </span>
                              <StatusChip status={inv.status} />
                            </div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {fmtDate(inv.created_at, tz)}
                              {inv.paid_at
                                ? ` · paid ${fmtDate(inv.paid_at, tz)}`
                                : inv.due_date
                                  ? ` · due ${fmtDate(inv.due_date, tz)}`
                                  : ""}
                            </div>
                          </div>
                        </div>
                        {/* Two fixed columns on the right, because the action group's width
                    changes from row to row (a paid invoice has no "Pay now") — left
                    to itself, flex put every row's amount at a different x and the
                    money stopped reading as a column. `min-w` rather than `w` so an
                    unusually long amount grows instead of truncating. */}
                        <div className="flex items-center justify-between gap-4 sm:justify-end">
                          <div className="text-right sm:min-w-28">
                            <div className="text-sm font-medium tabular-nums">
                              {money(inv.total_minor, inv.currency)}
                            </div>
                            {inv.amount_due_minor > 0 ? (
                              <div className="text-xs text-muted-foreground tabular-nums">
                                {money(inv.amount_due_minor, inv.currency)} due
                              </div>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center justify-end gap-2 sm:w-44">
                            {/* Only where there is genuinely money to take. A `paid`, `voided`
                        or zero-balance invoice must not offer a button that would be
                        refused by the engine the moment it was pressed. */}
                            {inv.payment_in_flight && inv.amount_due_minor <= 0 ? (
                              /* ── A SETTLED INVOICE WITH A STRAY IN-FLIGHT DEBIT (2026-08-31) ──
                         The comment above states the rule and the two in-flight branches
                         below did not apply it — only the `Pay now` branch checked
                         `amount_due_minor > 0`. So a `paid` invoice rendered "Waiting for
                         your bank · Approve the request they sent you", in warning colour,
                         in the same row as its own "Paid" chip.
                         Reported from the portal 2026-08-31: four invoices on one
                         subscription showed it, ₹1,43,976.16 of live e-mandate requests
                         against invoices owing ₹0.00, and the prompt is the RBI/NPCI AFA
                         approval — so approving really does move money.
                         Why they are still in flight at all: each invoice was settled by
                         the NEXT plan change's adjustment credit note, and nothing cancels
                         a debit already dispatched to the rail when a CREDIT settles its
                         invoice. That engine gap is filed separately; this branch only stops
                         us asking the buyer to approve it.
                         NEUTRAL, not warning: nothing is required of them. And the abandon
                         control is kept where an AFA request exists, because it is the one
                         genuinely useful action here — `abandonAuthenticationPendingDebit`
                         keys on the invoice's in-progress transaction, not on the invoice's
                         status, so it still works on a settled invoice and is the buyer's way
                         to stop a debit they do not owe. */
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
                              /* Waiting on the BUYER, not on us — the rail paused this debit for
                         their bank's approval (at any amount — the issuer decides) and it
                         expires unapproved. It is the one in-flight state that needs a
                         human, so unlike the quiet "processing" below it gets a filled
                         button.

                         ONE INSTRUCTION AND ONE BUTTON, and the previous version had
                         neither. It read "Waiting for your bank / Approve their request,
                         or:" in semantic orange above an orange fill — a status the buyer
                         cannot act on, an ambiguous "their", a dangling "or:", and the
                         urgency said twice in one narrow column. Now the text is neutral
                         and names the action ("Approve the auto-debit with your bank, or")
                         while the single filled button carries the urgency and completes
                         the sentence.

                         ⚠️ THE ESCAPE HATCH IS OFFERED ONLY WHERE WE CAN KILL THE FIRST
                         ATTEMPT (2026-09-12). Releasing our own hold does not stop the
                         gateway taking the money, so on a gateway that cannot void an
                         in-flight debit "pay another way" is a double-charge button:
                         RazorPay declares `intentVoid: false`, and their Late Authorisation
                         behaviour can authorise a payment sitting in `created`
                         RETROACTIVELY for up to three days while they poll the bank. The
                         dialog's "decline the request if it arrives" is no safeguard there
                         either — under late authorisation no request reaches the buyer to
                         decline. So that branch tells them what to do and what we are
                         doing, and offers nothing they cannot act on.

                         Where we CAN cancel (Stripe, measured), the hatch is real and not a
                         "Resend" that would do nothing: we cannot re-send the BANK's
                         request, but we can release OUR hold, which is what unblocks paying
                         here. Without it the only option was to wait out the window for a
                         payment they may already have decided against. */
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
                              /* Money is already moving on this invoice. Say so instead of
                         offering a button the engine will refuse — a bank transfer or a
                         UPI debit can take a while to confirm, and a buyer told nothing
                         will either pay twice or think we lost it. */
                              <span className="text-xs text-muted-foreground">
                                Payment processing…
                              </span>
                            ) : inv.amount_due_minor > 0 &&
                              PAYABLE_STATUSES.has(inv.status) &&
                              inv.over_card_limit ? (
                              /* Above the business's card limit: the checkout offers cards,
                                 so there is no Pay now. The PDF shows how to pay. */
                              <span className="text-xs text-muted-foreground">
                                We do not accept a card for this amount. The PDF shows how to pay.
                              </span>
                            ) : inv.amount_due_minor > 0 && PAYABLE_STATUSES.has(inv.status) ? (
                              /* No "by card" sub-line here, and its absence is deliberate.
                         It existed to answer "which method will Pay now open?" while the
                         answer was a single rail we chose. It is not any more: the intent
                         is minted with `letBuyerChooseMethod`, so the gateway's own sheet
                         offers whatever the merchant has enabled and the BUYER picks.
                         Naming a rail here would now be a claim the checkout does not
                         honour, which is worse than saying nothing — the sheet itself is
                         the honest answer, and it arrives one click later. */
                              <PayInvoiceButton
                                invoice={inv.id}
                                currency={inv.currency}
                                me={meData}
                                scope={scope}
                                focus={payInvoice === inv.id}
                              />
                            ) : null}
                            <Button asChild variant="outline" size="sm">
                              <Link href={`/portal/invoices/${inv.id}/pdf`} prefetch={false}>
                                <Download className="size-4" /> PDF
                              </Link>
                            </Button>
                          </div>
                        </div>
                      </Row>
                    ))}
                  </RowList>
                </div>
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
                      <Row key={p.invoice}>
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <ProductGlyph src={first?.image_url} fallback={<ShoppingBag />} />
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-sm font-medium">
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
                        <div className="flex items-center justify-between gap-4 sm:justify-end">
                          <div className="text-right text-sm font-medium tabular-nums sm:min-w-28">
                            {money(p.total_minor, p.currency)}
                          </div>
                          <div className="flex shrink-0 items-center justify-end sm:w-44">
                            <Button asChild variant="outline" size="sm">
                              <Link href={`/portal/invoices/${p.invoice}/pdf`} prefetch={false}>
                                <Download className="size-4" /> Receipt
                              </Link>
                            </Button>
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
                <div className={receipts.length > 5 ? "max-h-[28rem] overflow-y-auto" : undefined}>
                  <RowList>
                    {receipts.map((rc) => (
                      <Row key={rc.id}>
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <Glyph>
                            <ReceiptText />
                          </Glyph>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{rc.number}</div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {fmtDate(rc.paid_at, tz)} · {rc.method}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center justify-between gap-4 sm:justify-end">
                          <div className="text-right text-sm font-medium tabular-nums sm:min-w-28">
                            {money(rc.amount_minor, rc.currency)}
                          </div>
                          <div className="flex shrink-0 items-center justify-end sm:w-44">
                            <Button asChild variant="outline" size="sm">
                              <Link href={`/portal/receipts/${rc.id}/pdf`} prefetch={false}>
                                <Download className="size-4" /> PDF
                              </Link>
                            </Button>
                          </div>
                        </div>
                      </Row>
                    ))}
                  </RowList>
                </div>
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
          subscriptions.length > 0 || credits || canAddLimit ? (
            <>
              {subscriptions.length > 0 ? (
                <PlanCard
                  subs={subscriptions}
                  tz={tz}
                  allowCoupons={meData.business.allow_customer_coupons}
                  offeredRails={offeredRails}
                  shippingAddresses={shippingOn ? shippingAddresses : undefined}
                />
              ) : null}
              {credits ? <PortalCreditsSection credits={credits} tz={tz} /> : null}
              {credits ||
              spendLimits?.length ||
              canAddLimit ||
              (runway && runway.runway_days != null) ? (
                <PortalUsageControlsSection
                  runway={runway}
                  limits={spendLimits}
                  currency={runway?.currency ?? spendLimits?.[0]?.currency ?? "USD"}
                  tz={tz}
                />
              ) : null}
            </>
          ) : null
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
              bodyClassName="p-0"
            >
              {methods.length === 0 ? (
                <EmptyState
                  icon={<CreditCard />}
                  title="No payment method saved"
                  /* "Add one below" is only true once the billing address is on file —
                     otherwise what is below is the gate, not the form, and the empty
                     state was pointing at a refusal. */
                  description={
                    meData.customer.billing_details_complete
                      ? "Add one below so that we can collect invoice payments automatically."
                      : "We cannot collect invoice payments automatically until you save a payment method."
                  }
                />
              ) : (
                /* Scrolled, not paginated, and only once there are enough to need it.
                   Unlike invoices this list is BOUNDED — a buyer holds a handful of
                   instruments, not a history — so there is nothing to fetch lazily and a
                   cursor would be machinery for no gain. What it does need is a ceiling:
                   each row carries a mandate-status line, so five instruments ran to
                   1024px and the card towered over everything beside it. Four rows fit,
                   the rest scroll, and no instrument becomes unreachable. */
                <div className={methods.length > 4 ? "max-h-[26rem] overflow-y-auto" : undefined}>
                  <RowList>
                    {methods.map((pm) => {
                      /* What the mandate behind this instrument is doing — see `mandateState`. The
                 chip, the limit line and the well below all read it, so they cannot end up
                 telling the buyer three different stories about one authorization. */
                      const mandate = mandateState(pm);
                      return (
                        <li key={pm.id} className="px-5 py-3.5">
                          <div className="flex flex-col gap-2.5">
                            <div className="flex min-w-0 items-center gap-3">
                              <MethodGlyph pm={pm} />
                              <div className="min-w-0">
                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                  <span className="truncate text-sm font-medium">
                                    {methodLabel(pm)}
                                  </span>
                                  {/* One word for this role across both surfaces (2026-09-14):
                                      the operator dashboard says Primary and so does this. It
                                      pairs with Backup — "default" has no opposite — and it
                                      matches the engine's `role` and `/assign_role`. Read off
                                      `role`, not `is_default`: that field is literally
                                      `role === "primary"`, kept on the API for integrators. */}
                                  {pm.role === "primary" ? <Chip>Primary</Chip> : null}
                                  {/* Every card the engine will fall back to, so a removed one
                              is visibly different. */}
                                  {pm.role === "backup" ? <Chip>Backup</Chip> : null}
                                  {pm.status && pm.status !== "valid" ? (
                                    <StatusChip status={pm.status} />
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
                                    Expires {String(pm.exp_month).padStart(2, "0")}/{pm.exp_year}
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
                              {!pm.is_default ? (
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
                              {/* Backups are tried in turn when the primary declines. Never
                          offered on the primary: it cannot be demoted, only replaced. */}
                              {pm.role === "backup" ? (
                                <ActionForm action={portalRemoveBackupAction}>
                                  <input type="hidden" name="pm" value={pm.id} />
                                  <Button type="submit" variant="outline" size="sm">
                                    Remove backup
                                  </Button>
                                </ActionForm>
                              ) : !pm.is_default ? (
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
                            <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground sm:ml-12">
                              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                              {/* One well, three states. "Auto-debit authorized" was said unconditionally,
                        which is simply untrue while the bank is still confirming (a netbanking
                        e-mandate is `initiated` until T+1) and after the buyer has revoked it —
                        the two moments a buyer is most likely to be reading this row. */}
                              {mandate.kind === "pending" ? (
                                <span>
                                  Auto-debit is not active yet ({pm.mandate.rail}). Your bank is
                                  still confirming this authorization. This can take until the next
                                  working day. We do not automatically collect invoices due before
                                  then. Pay them from{" "}
                                  <PortalSectionLink section="invoices">Invoices</PortalSectionLink>
                                  .
                                </span>
                              ) : mandate.kind === "dead" ? (
                                <span>
                                  This auto-debit authorization is no longer active (
                                  {pm.mandate.rail} · {mandate.status}). We cannot collect from this
                                  account. Add a payment method to give a new authorization.
                                </span>
                              ) : (
                                <span>
                                  Auto-debit authorized ({pm.mandate.rail}). If you remove it here,
                                  we stop charges from this account. To cancel the mandate, revoke
                                  it in your UPI app or bank portal.
                                </span>
                              )}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </RowList>
                </div>
              )}
              {/* A titled block, not a tracked micro-label: this is the one thing on the page
                  the buyer comes here to DO, and an eyebrow the size of a column head made it
                  read as a footnote under the list.

                  Now a DISCLOSURE. Open it is ~740px — about half the Payment methods card —
                  and it was rendered open to everyone, including a buyer with five saved
                  instruments who is not adding a sixth. It opens by itself for the two people
                  who need it: someone with nothing saved, and someone landing back from a
                  provider redirect. See `add-method-disclosure.tsx`. */}
              <div className="border-t px-5 py-4">
                <AddMethodDisclosure
                  defaultOpen={methods.length === 0 || setup === "return" || addCard === "1"}
                >
                  <AddCard
                    scope={scope}
                    me={meData}
                    gateways={gateways}
                    expectedDebitMinor={gws.data?.expected_debit_minor ?? 0}
                    unattendedLimitMinor={gws.data?.unattended_debit_limit_minor ?? null}
                  />
                </AddMethodDisclosure>
              </div>
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
                <ShippingAddresses addresses={shippingAddresses} countries={countries} />
              </StorefrontSection>
            ) : null}
          </>
        }
      />

      <StorefrontFooter business={business} />
    </BrandTheme>
  );
}
