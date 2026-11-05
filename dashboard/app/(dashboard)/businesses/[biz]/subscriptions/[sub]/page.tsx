import { billingRules, resetRules } from "@/lib/billing-rules";
import type { PriceGrantsCredit } from "@/lib/credits";
import { RemoveScheduledCancellationButton } from "@/components/subscriptions/remove-scheduled-cancellation";
import * as React from "react";
import { RecordVisit } from "@/components/record-visit";
import Link from "next/link";
import {
  listBusinesses,
  listInvoices,
  listSubscriptionOneTimeCharges,
  listPrices,
  listProducts,
  listCoupons,
  listScheduledChanges,
  listUnbilledCharges,
  listEntitlements,
  getCustomer,
  listPaymentMethods,
  listShippingAddresses,
  listCreditNotes,
  money,
  fmtDate,
  fmtDateTime,
  getRenewalEstimate,
  type RenewalEstimate,
} from "@/lib/api";
import { couponDurationLabel } from "@/lib/format";
import type { CouponDetail } from "@/lib/api/coupons";
import { accountHolderName, invoiceContactName } from "@/lib/names";
import { listTransactions } from "@/lib/api/payments";
import { listEventsForBusiness } from "@/lib/api/developer";
import { listEmails } from "@/lib/api/emails";
import { CustomerHistory } from "@/components/customers/customer-history";
import { cursorSource, HISTORY_PAGE } from "@/lib/cursor-source";
import { Paged, PagedFooter, PagedItems } from "@/components/patterns/pager";
import { loadInvoiceTimelines, unpaidInvoices } from "@/components/invoices/invoice-timeline";
import { removeDiscountAction, deleteSubscriptionAction } from "@/app/actions";
import { requirePermission, allows } from "@/lib/session";
import { currencyFlag } from "@/lib/countries";
import { PageHeader } from "@/components/page-header";
import { PaymentMethodRow } from "@/components/payments/payment-method-row";
import { StatusChip, Chip, IdChip } from "@/components/patterns/chip";
import { RailLink } from "@/components/patterns/action-rail";
import {
  Facts,
  FoldedCard,
  RecordCard,
  RecordCrumbs,
  RecordHeader,
  Row,
  Stack,
  Zone,
  type FoldedSection,
} from "@/components/patterns/record-page";
import { MoreMenu, MoreSection } from "@/components/patterns/more-menu";
import { CommentsCard } from "@/components/comments/comments-card";
import { ActivityLogCard } from "@/components/activity-log-card";
import { SubscriptionItems } from "@/components/subscriptions/subscription-items";
import { BillingCyclesInline } from "@/components/subscriptions/billing-cycles-inline";
import { CreditUsageInline } from "@/components/subscriptions/credit-usage-inline";
import { AutoCollectionInline } from "@/components/subscriptions/auto-collection-inline";
import { ShipToInline } from "@/components/subscriptions/ship-to-inline";
import {
  CancelSubscriptionDialog,
  PauseSubscriptionDialog,
  ResumeSubscriptionDialog,
  ChangeTermEndDialog,
  EditTrialEndDialog,
  AddManualDiscountDialog,
} from "@/components/subscriptions/lifecycle-dialogs";
import { listOfferedReasons } from "@/lib/api/reason-codes";
import { TriggerChargeCard } from "@/components/subscriptions/trigger-charge-card";
import type { TriggerChargeRow } from "@/components/subscriptions/trigger-charge-card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/action-button";
import { EmptyState, ErrorState } from "@/components/states";
import { RequestUpdateButton } from "@/components/customers/request-update-button";
import { Gift } from "lucide-react";
import {
  getSubscriptionCommitment,
  getSubscriptionDetail,
  listPlanAddonRules,
  listRenewalSkips,
  listUpcomingRenewals,
  type RenewalSkip,
  type SubscriptionCommitment,
  type UpcomingRenewal,
} from "@/lib/api/subscriptions";
import { CommitmentInline } from "@/components/subscriptions/commitment-inline";
import {
  SkipRenewalDialog,
  SkippedRenewals,
  type RenewalOption,
} from "@/components/subscriptions/skip-renewal";
import { resolveResumeDefaults } from "@/lib/api/business-settings";
import { getTimeTravel } from "@/lib/api/time-travel";
import type { PlanAddonRule } from "@/lib/api/subscriptions";
import { attachedChargesForPlan } from "@/lib/api/subscriptions";
import { Alert } from "@/components/ui/alert";
import { getCurrentUsage, hasUsage, type CurrentUsage } from "@/lib/api/current-usage";
import { SubscriptionUsageThresholdCard } from "@/components/usage-controls/usage-invoice-threshold-card";
import { CurrentUsageCard } from "@/components/subscriptions/current-usage-card";
import { ItemModelPriceDialog } from "@/components/subscriptions/item-model-price-dialog";
import { listMeters, type Meter } from "@/lib/api/meters";
import { isListSource } from "@/lib/model-prices";
import type { Price, SubscriptionItem } from "@/lib/api";
import type { SubscriptionVolatileState } from "./refresh-action";
import { SubscriptionRefreshProvider } from "@/components/subscriptions/subscription-refresh-context";
import {
  SubscriptionRefreshControl,
  SubscriptionStatusChips,
  SubscriptionDuesChip,
  SubscriptionAttention,
  SubscriptionFigures,
  SubscriptionRefreshError,
} from "@/components/subscriptions/subscription-volatile-summary";

export const dynamic = "force-dynamic";

const INTERVAL_LABEL: Record<string, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
};

// Subscription detail, record-page layout: header card (Cancel / Edit / More), a
// needs-attention card with the billing-period track, four figures, then zones laid
// out row by row — Plan, Charges, Records, folded Details. Gated at 'ops';
// manager-only actions shown conditionally.
export default async function SubscriptionDetail({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string; sub: string }>;
  searchParams: Promise<{ error?: string; msg?: string; from?: string }>;
}) {
  const { biz, sub: subId } = await params;
  const { error, msg, from } = await searchParams;
  const user = await requirePermission("subscriptions:view", "ops");
  const isManager = allows(user, "subscriptions:manage", "manager");
  // Skipping a renewal is an ops action, like pause.
  const isOps = allows(user, "subscriptions:lifecycle", "ops");

  let businesses, sub, invoices, prices, products, coupons, scheduled, unbilled, entitlements;
  let customer, paymentMethods, transactions, creditNotes, events, emails;
  let renewalEstimate: RenewalEstimate | null = null;
  let usage: CurrentUsage | null = null;
  let listPriceItems: ListPriceItem[] = [];
  let upcomingRenewals: UpcomingRenewal[] = [];
  let renewalSkips: RenewalSkip[] = [];
  let commitment: SubscriptionCommitment | null = null;
  const rules: PlanAddonRule[] = [];
  try {
    sub = await getSubscriptionDetail(biz, subId);
    [businesses, invoices, prices, products, coupons, scheduled, unbilled, entitlements] =
      await Promise.all([
        listBusinesses(),
        // Every invoice of THIS subscription (the engine caps a page at 1000). The
        // customer's first page, filtered here, lost the subscription's older ones.
        listInvoices(biz, undefined, { limit: 1000, scope: { subscription: subId } }),
        listPrices(biz),
        listProducts(biz),
        listCoupons(biz),
        listScheduledChanges(biz, subId),
        listUnbilledCharges(biz, subId),
        listEntitlements(biz, subId),
      ]);
    // Detail-panel data (non-critical — failures degrade to empty rather than error the page).
    [customer, paymentMethods, transactions, creditNotes, events, emails] = await Promise.all([
      sub.customer ? getCustomer(biz, sub.customer).catch(() => null) : Promise.resolve(null),
      sub.customer
        ? listPaymentMethods(biz, sub.customer).catch(() => ({ data: [] }))
        : Promise.resolve({ data: [] }),
      sub.customer
        ? listTransactions(biz, {
            limit: HISTORY_PAGE,
            filters: [{ field: "subscription", op: "is", value: subId }],
          }).catch(() => null)
        : Promise.resolve(null),
      // Scoped to this subscription's customer server-side (see the customers
      // detail page — an unscoped read loses rows now that the list is paginated).
      (sub.customer
        ? listCreditNotes(biz, undefined, { customer: sub.customer, limit: 1000 })
        : Promise.resolve({ data: [] })
      ).catch(() => ({ data: [] })),
      listEventsForBusiness(biz, { resource_id: subId, limit: HISTORY_PAGE }).catch(() => null),
      // Email Logs are customer-scoped (there is no per-subscription email filter),
      // matching the Transactions/Credit Notes tabs beside them.
      (sub.customer
        ? listEmails(biz, { customer: sub.customer, limit: HISTORY_PAGE })
        : Promise.resolve(null)
      ).catch(() => null),
      ,
    ]);
    // Separate await, not folded into the tuple above: destructuring a mixed tuple
    // costs the inference on every other member.
    renewalEstimate = await getRenewalEstimate(biz, subId)
      .then((r) => r.estimate)
      .catch(() => null);
    // Only for a metered item. Usage fields are fixed after create, so the catalog flag
    // is the snapshot's.
    const meteredPrices = new Set(prices.data.filter((p) => p.metered).map((p) => p.id));
    if ((sub.items ?? []).some((it) => meteredPrices.has(it.price)))
      usage = await getCurrentUsage(biz, subId).catch(() => null);
    // Edit price on items that bill from the model price list (per-customer selling price).
    const listPrices_ = prices.data.filter((p) => isListSource(p.amount_source));
    const listItems = (sub.items ?? []).filter(
      (it) => it.id && listPrices_.some((p) => p.id === it.price),
    );
    if (isManager && listItems.length) {
      const meters = await listMeters(biz).catch(() => null);
      listPriceItems = listItems.flatMap((it) => {
        const price = listPrices_.find((x) => x.id === it.price)!;
        const meter = meters?.data.find((x) => x.id === price.meter);
        return meter ? [{ it, price, meter }] : [];
      });
    }
    commitment = sub.commitment
      ? await getSubscriptionCommitment(biz, subId).catch(() => null)
      : null;
    // Non-fatal: without them the page offers no skip, which is the safe reading.
    [upcomingRenewals, renewalSkips] = await Promise.all([
      listUpcomingRenewals(biz, subId)
        .then((r) => r.data)
        .catch(() => []),
      listRenewalSkips(biz, subId)
        .then((r) => r.data)
        .catch(() => []),
    ]);
    // Build plan→addon/charge applicability rules for trigger_charge resolution.
    rules.push(...(await listPlanAddonRules(biz, products.data)));
  } catch (e) {
    return (
      <>
        <PageHeader
          title="Subscription"
          breadcrumbs={[
            { label: "Businesses", href: "/" },
            { label: biz, href: `/businesses/${biz}` },
            { label: "Subscription" },
          ]}
        />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const bizRow = businesses.data.find((b) => b.id === biz);
  const name = bizRow?.name ?? "Business";
  // Every date on this page renders in the business timezone — the engine's term
  // boundaries are midnight in this zone, so UTC would show them a day off.
  const tz = bizRow?.timezone ?? null;

  // Cancellation reasons the operator may pick from (Settings → Reason codes).
  // Non-fatal: if this fetch fails the dialog falls back to its built-in list,
  // which is exactly what the backend would have returned anyway.
  let cancelReasons: Array<{ code: string; label: string }> | undefined;
  try {
    const offered = await listOfferedReasons(biz, "subscription_cancellation");
    cancelReasons = offered.data;
  } catch {
    cancelReasons = undefined;
  }
  const subInvoices = invoices.data.filter((i) => i.subscription === subId);

  // ── Non-Recurring Items (charged till date) ─────────────────────────────────
  // The aggregate of this subscription's `invoice_line_items` with `kind = 'one_time'`
  // — activation charges, one-time addons, `trigger_charge`, invoiced unbilled charges.
  // Filtering on that kind is also what keeps TAX lines out: they are their own
  // `kind = 'tax'` rows (and carry no price), so summing "lines with no interval"
  // would have double-counted the tax on every one-time fee.
  //
  // No new endpoint: only `GET /invoices/:inv` returns `lines` (the list endpoint omits
  // them), so the subscription's invoices are listed and then hydrated one at a time —
  // the same shape the credit-note builder already uses. Bounded at 100 (created_at
  // DESC); `oneTimeTruncated` says so out loud rather than showing a short total as if
  // it were the lifetime figure.
  let oneTimeRows: Array<{
    id: string;
    description: string;
    amountMinor: number;
    invoice: string;
    invoiceNumber: string | null;
    invoiceStatus: string;
    at: string | null;
  }> = [];
  let oneTimeTruncated = false;
  try {
    const charges = await listSubscriptionOneTimeCharges(biz, subId);
    oneTimeTruncated = charges.has_more === true;
    oneTimeRows = charges.data.map((l) => ({
      id: l.id,
      description: l.description,
      amountMinor: l.amount_minor,
      invoice: l.invoice,
      invoiceNumber: l.invoice_number,
      invoiceStatus: l.invoice_status,
      at: l.invoice_created_at,
    }));
  } catch {
    oneTimeRows = [];
  }
  const oneTimeTotalMinor = oneTimeRows.reduce((sum, r) => sum + r.amountMinor, 0);

  // Status helpers — use the serializer-derived status (non_renewing when active+cancel_at_period_end).
  const active =
    sub.status === "active" || sub.status === "in_trial" || sub.status === "non_renewing";
  /**
   * The Items card's discount row, worded HERE because this is the only place that
   * holds both halves: `sub.discount` names the applied discount, and the coupon's
   * size and duration live on the catalog row that `listCoupons` already loaded for
   * this page. The card itself stays presentational rather than growing a lookup.
   *
   * A coupon whose catalog row is missing (archived out of the list, or a code from
   * another business) still renders its code — losing the whole row because the
   * adjective is unavailable would hide a discount the customer is actually getting.
   */
  const discountCoupon =
    sub.discount?.source === "coupon" && sub.discount.coupon
      ? ((coupons.data as CouponDetail[]).find((c) => c.code === sub.discount!.coupon) ?? null)
      : null;
  const itemsDiscount = sub.discount
    ? {
        // `source` is optional on the wire type; anything that is not explicitly
        // manual is coupon-sourced, which is the same branch the label uses below.
        source: sub.discount.source === "manual" ? ("manual" as const) : ("coupon" as const),
        label:
          sub.discount.source === "manual"
            ? `${
                sub.discount.manual?.kind === "fixed_amount"
                  ? money(
                      sub.discount.manual.amount_off_minor ?? 0,
                      sub.discount.manual.currency ?? sub.currency,
                    )
                  : `${(sub.discount.manual?.percent_off_bps ?? 0) / 100}%`
              } off, manual discount`
            : discountCoupon
              ? `${sub.discount.coupon} (${
                  discountCoupon.kind === "percentage"
                    ? `${(discountCoupon.percent_off_bps ?? 0) / 100}% off`
                    : `${money(discountCoupon.amount_off_minor ?? 0, discountCoupon.currency ?? sub.currency)} off`
                }, ${couponDurationLabel(discountCoupon.duration_type, discountCoupon.duration_in_periods)})`
              : (sub.discount.coupon ?? "Coupon"),
        // Only a coupon has a catalog page to open; a manual discount has no row.
        href: discountCoupon ? `/businesses/${biz}/catalog/coupons/${discountCoupon.id}` : null,
        // `remaining_periods` is the live countdown and outranks the coupon's own
        // duration: a `repeating` coupon two periods in has three left, not five.
        detail:
          sub.discount.remaining_periods != null
            ? `${sub.discount.remaining_periods} period(s) remaining`
            : sub.discount.source === "manual"
              ? "Applicable forever"
              : discountCoupon
                ? `Applicable ${couponDurationLabel(discountCoupon.duration_type, discountCoupon.duration_in_periods).toLowerCase()}`
                : null,
        // Only a fixed amount has a money figure. A percentage depends on the
        // renewal's base, which this card explicitly does not compute.
        amountMinor:
          sub.discount.source === "manual"
            ? sub.discount.manual?.kind === "fixed_amount"
              ? (sub.discount.manual.amount_off_minor ?? null)
              : null
            : discountCoupon?.kind === "fixed_amount"
              ? (discountCoupon.amount_off_minor ?? null)
              : null,
        currency:
          sub.discount.source === "manual"
            ? (sub.discount.manual?.currency ?? sub.currency)
            : (discountCoupon?.currency ?? sub.currency),
        // The SAME control the action rail renders, so there is one definition of
        // what removing a discount does and one confirmation copy.
        action: isManager ? (
          <ActionButton
            resultAction={removeDiscountAction}
            fields={{ biz, sub: sub.id }}
            label="Remove"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs text-destructive"
            confirm={{
              title: "Remove discount?",
              description: "Future invoices use the full price.",
              confirmLabel: "Remove",
              destructive: true,
            }}
          />
        ) : null,
      }
    : null;

  const activeLike = sub.status === "active" || sub.status === "in_trial";
  const isNonRenewing = sub.status === "non_renewing";
  const isPaused = sub.status === "paused";
  // Resuming inside the paid term continues it uncharged; the engine decides on the
  // business clock, so the travelled instant is the one to compare.
  const resumeDefaults = resolveResumeDefaults(bizRow);
  // Plan credits on their own reset window: the only ones the pause and cancel rules change.
  const hasCreditWindows = (sub.items ?? []).some((it) => {
    const gc = (
      prices.data.find((p) => p.id === it.price) as
        | { grants_credit?: PriceGrantsCredit | null }
        | undefined
    )?.grants_credit;
    const every = gc?.kind === "per_cycle" ? gc.reset?.every : undefined;
    return !!every && every !== "term" && every !== "never";
  });
  const creditRules = resetRules(bizRow).planCredits;
  const resumeClock = isPaused ? await getTimeTravel(biz).catch(() => null) : null;
  const resumeNow =
    resumeClock?.status === "in_progress" && resumeClock.simulated_now
      ? new Date(resumeClock.simulated_now).getTime()
      : Date.now();
  const resumeInTerm =
    !!sub.current_period_start &&
    !!sub.current_period_end &&
    resumeNow < new Date(sub.current_period_end).getTime();
  // FAILED rows belong here too. The clock gives up on a scheduled change after
  // repeated failures, and filtering to pending-only meant the section simply
  // vanished — a cancellation the merchant scheduled, that never happened, with no
  // trace anywhere in the UI. That is the one row they most need to see.
  const pendingScheduled = scheduled.data.filter(
    (s) => s.status === "pending" || s.status === "scheduled" || s.status === "failed",
  );

  // Detail-panel data, scoped to this subscription.
  const subInvoiceIds = new Set(subInvoices.map((i) => i.id));
  // History: transactions, events and emails page through the engine; invoices and
  // credit notes are complete lists (a credit note has no subscription scope, so it is
  // matched to this subscription's invoices) and page locally.
  const subTransactions = cursorSource(transactions, "transactions", undefined, [
    `subscription:is:${subId}`,
  ]);
  const subCreditNotes = cursorSource({
    data: (creditNotes?.data ?? []).filter((c) => subInvoiceIds.has(c.invoice)),
  });
  const subEvents = cursorSource(events, "events", { resource_id: subId });
  // Not filtered to the subscription: email_messages carries a customer, not a
  // subscription, so these are the customer's billing emails (same scope as the
  // Transactions tab's source read).
  const subEmails = cursorSource(emails, "emails", { customer: sub.customer ?? undefined });
  const pmList = paymentMethods?.data ?? [];
  // Options for the Ship to control; null = the read failed, so no Change is offered.
  const shippingBook = sub.customer
    ? await listShippingAddresses(biz, sub.customer)
        .then((r) => r.data)
        .catch(() => null)
    : null;
  // Which card this subscription actually charges. `subscriptions.default_payment_method_id`
  // wins at collection time (`src/modules/invoicing/collection.ts`), so it must win here
  // too — this used to be `find(role === 'primary') ?? pmList[0]` over the CUSTOMER's
  // methods, which displayed a card the engine would not charge (and fell back to an
  // arbitrary first row). Only the subscription-scoped override is authoritative; when it
  // is unset, collection genuinely does use the customer's primary.
  const subPM = sub.default_payment_method
    ? (pmList.find((p) => p.id === sub.default_payment_method) ?? null)
    : null;
  const customerPrimaryPM = pmList.find((p) => p.role === "primary" || p.is_default) ?? null;
  const chargedPM = subPM ?? customerPrimaryPM;
  // A subscription-level override that we cannot resolve in the customer's list is worth
  // saying out loud rather than silently showing the customer's card instead.
  const pmMissing = !!sub.default_payment_method && !subPM;
  const refundableCreditsMinor =
    customer?.balances?.find((b) => b.currency_code === sub.currency)?.refundable_credits ?? 0;
  // Only PENDING rows are what `unbilled_charges_option` invoices or voids at cancel
  // (items.ts invoiceUnbilledCharges / deleteUnbilledCharges) — billed/voided ones are
  // already settled, so the cancel dialog must not count them into the choice it offers.
  const pendingUnbilledMinor = unbilled.data
    .filter((c) => c.status === "pending")
    .reduce((sum, c) => sum + (c.amount_minor ?? 0), 0);
  // Whole days left in the current term — the cancel dialog labels the credit
  // choice with it ("...for the unused period (28 days)").
  const unusedDays = sub.current_period_end
    ? Math.max(0, Math.ceil((new Date(sub.current_period_end).getTime() - Date.now()) / 86_400_000))
    : undefined;
  const custAddr = customer?.address ?? null;
  /**
   * The ACCOUNT HOLDER — the header link, and the name the cancel dialog talks about.
   * `accountHolderName` is the one chain for it (person → company → legacy `name` →
   * email); the two remaining fallbacks are for a customer we could not read at all.
   * NOT the billing contact: a subscription belongs to the account, not to whoever
   * receives its invoices.
   */
  const custName =
    (customer ? accountHolderName(customer) : null) ?? sub.customer_name ?? sub.customer ?? "—";
  /**
   * The name that HEADS the Billing Address card — the address's own contact, and only
   * when it has none does the account holder answer. That is `invoiceContactName`, the
   * same chain the invoice document uses, so this card previews the name this
   * subscription's invoices will actually print rather than the account's.
   */
  const billingName = customer ? invoiceContactName(customer) : null;

  // Plan + trigger_charge candidates.
  const planItem = (sub.items ?? []).find((i) => i.product_kind === "plan") ?? (sub.items ?? [])[0];
  const planProduct = planItem
    ? products.data.find(
        (p) =>
          p.kind === "plan" &&
          (sub.items ?? []).some(
            (i) => (i.product_kind === "plan" && i.id === planItem.id) || p.id === planItem.price,
          ),
      )
    : undefined;

  // Build trigger_charge rows: charge-kind products attached to the plan.
  const triggerRows: TriggerChargeRow[] = (() => {
    if (!planProduct) return [];
    const charges = attachedChargesForPlan(
      planProduct.id,
      rules,
      products.data,
      prices.data,
      sub.currency,
    );
    return charges.map((c) => ({
      productId: c.product.id,
      productName: c.product.name,
      applicability: c.applicability,
      amountMinor: c.price?.amount_minor ?? null,
      currency: c.price?.currency ?? null,
      interval: c.price?.interval ?? null,
    }));
  })();

  // Next Billing Amount — the engine's own renewal estimate, tax and coupons included.
  // This used to sum `unit_price_minor × quantity` over the items right here, which is a
  // PRE-TAX subtotal and nothing else: on an 18%-GST subscription the summary read
  // ₹40,044.00 where the real renewal (and this dashboard's own create-page preview) is
  // ₹47,251.92. `getRenewalEstimate` has existed for exactly this; the page simply never
  // called it.
  // Falls back to the old sum only if the estimate call failed, so a degraded panel still
  // shows something rather than a blank — labelled below when it does.
  const nextBillingAmount =
    renewalEstimate?.total_minor ??
    (sub.items ?? [])
      .filter((i) => i.price_type !== "one_time")
      .reduce((sum, i) => sum + (i.unit_price_minor ?? 0) * (i.quantity || 1), 0);
  const nextBillingIsEstimate = renewalEstimate?.total_minor != null;
  const renews = activeLike && !sub.cancel_at_period_end;
  const trialDaysLeft = sub.trial_end
    ? Math.max(0, Math.ceil((new Date(sub.trial_end).getTime() - Date.now()) / 86_400_000))
    : null;

  // Initial snapshot for the refreshable strip — reuses data already fetched above rather
  // than a redundant round trip on first paint. refresh-action.ts recomputes this shape.
  const initialVolatile: SubscriptionVolatileState = {
    status: sub.status,
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    canceled_at: sub.canceled_at ?? null,
    cancel_reason_code: sub.cancel_reason_code ?? null,
    current_period_start: sub.current_period_start ?? null,
    current_period_end: sub.current_period_end ?? null,
    next_billing_at: sub.next_billing_at ?? null,
    mrr: sub.mrr ?? 0,
    due_invoices_count: sub.due_invoices_count ?? 0,
    total_dues_minor: sub.total_dues_minor ?? 0,
    due_since: sub.due_since ?? null,
    next_billing_amount_minor: nextBillingIsEstimate ? nextBillingAmount : null,
    pending_scheduled_count: pendingScheduled.length,
    revenue_to_date_minor: sub.revenue_to_date_minor ?? 0,
    revenue_paid_invoices_count: sub.revenue_paid_invoices_count ?? 0,
    revenue_since: sub.revenue_since ?? null,
  };

  // Unpaid invoices, oldest first. The oldest drives the retry line; the track draws
  // up to two of them, each with its own declined attempts and next retry.
  const unpaid = unpaidInvoices(subInvoices);
  const oldestUnpaid = unpaid[0] ?? null;
  // Each unpaid invoice's payments and dunning, in the invoice page's words (1–2 only).
  const invoiceTracks = await loadInvoiceTimelines(biz, unpaid);
  // The BUSINESS clock: a running time travel bills on its simulated instant, so the
  // figures' day counts use it. Read once on the server so both renders agree.
  const clock = await getTimeTravel(biz).catch(() => null);
  const nowMs =
    clock?.status === "in_progress" && clock.simulated_now
      ? Date.parse(clock.simulated_now)
      : Date.now();

  const planName = planItem?.product_name ?? "Subscription";

  // Empty when the subscription cannot skip (trial, paused, cancelling, pending invoices).
  const renewalOptions: RenewalOption[] = upcomingRenewals.map((r) => ({
    renewal_at: r.renewal_at,
    label: fmtDate(r.renewal_at, tz),
    skipped: r.skipped,
    changeable: r.changeable,
  }));
  // A scheduled skip outside the upcoming list (the subscription stopped renewing) still
  // shows, with no undo.
  const skippedRenewals: RenewalOption[] = [
    ...renewalOptions.filter((r) => r.skipped),
    ...(sub.skipped_renewals ?? [])
      .filter((at) => !upcomingRenewals.some((u) => Date.parse(u.renewal_at) === Date.parse(at)))
      .map((at) => ({ renewal_at: at, label: fmtDate(at, tz), skipped: true, changeable: false })),
  ];
  const appliedSkips = renewalSkips
    .filter((s) => s.status === "applied")
    .sort((a, b) => Date.parse(a.renewal_at) - Date.parse(b.renewal_at));
  const discountRemove =
    isManager && sub.discount ? (
      <ActionButton
        resultAction={removeDiscountAction}
        fields={{ biz, sub: sub.id }}
        label={
          sub.discount.source === "manual"
            ? "Remove manual discount"
            : `Remove discount (${sub.discount.coupon})`
        }
        variant="link"
        size="sm"
        className="text-destructive"
        confirm={{
          title: "Remove discount?",
          description: "Future invoices use the full price.",
          confirmLabel: "Remove",
          destructive: true,
        }}
      />
    ) : null;

  const detailSections: FoldedSection[] = [
    {
      id: "entitlements",
      title: "Entitlements",
      summary: entitlements.data.length
        ? `${entitlements.data.length} feature${entitlements.data.length === 1 ? "" : "s"} · ${entitlements.data
            .map((e) => `${e.feature_name} ${entitlementValue(e.value)}`)
            .join(" · ")}`
        : "None",
      children:
        entitlements.data.length === 0 ? (
          <EmptyState
            icon={<Gift />}
            title="No entitlements"
            description="This subscription's plan grants no features. Add features to the plan in the catalog."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Feature</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entitlements.data.map((e) => (
                <TableRow key={e.feature_key}>
                  <TableCell>{e.feature_name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {e.feature_key}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {entitlementValue(e.value)}
                    {e.unit ? <span className="text-muted-foreground"> {e.unit}</span> : null}
                  </TableCell>
                  <TableCell>
                    <StatusChip status={e.source} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ),
    },
    {
      id: "timeline",
      title: "Timeline",
      summary: [
        sub.created_at ? `Created ${fmtDate(sub.created_at, tz)}` : null,
        sub.activated_at ? `active since ${fmtDate(sub.activated_at, tz)}` : null,
        renews && sub.next_billing_at ? `next renewal ${fmtDate(sub.next_billing_at, tz)}` : null,
        sub.canceled_at
          ? `${sub.status === "cancelled" ? "cancelled" : "cancels"} ${fmtDate(sub.canceled_at, tz)}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      children: (
        <Facts
          rows={[
            sub.created_at ? { label: "Created on", value: fmtDateTime(sub.created_at, tz) } : null,
            sub.start_date
              ? { label: "Scheduled start", value: fmtDateTime(sub.start_date, tz) }
              : null,
            sub.started_at ? { label: "Started on", value: fmtDateTime(sub.started_at, tz) } : null,
            sub.trial_start
              ? { label: "Trial started", value: fmtDateTime(sub.trial_start, tz) }
              : null,
            sub.trial_end
              ? {
                  label: "Trial ends",
                  value: `${fmtDateTime(sub.trial_end, tz)}${trialDaysLeft != null && sub.status === "in_trial" ? ` (${trialDaysLeft} days left)` : ""}`,
                }
              : null,
            sub.activated_at
              ? { label: "Active on", value: fmtDateTime(sub.activated_at, tz) }
              : null,
            renews
              ? { label: "Next billing on", value: fmtDateTime(sub.next_billing_at, tz) }
              : null,
            renews
              ? { label: "Next renewal on", value: fmtDateTime(sub.next_billing_at, tz) }
              : null,
            appliedSkips.length
              ? {
                  label: "Skipped renewals",
                  value: appliedSkips.map((s) => fmtDate(s.renewal_at, tz)).join(", "),
                }
              : null,
            sub.canceled_at
              ? { label: "Canceled on", value: fmtDateTime(sub.canceled_at, tz) }
              : null,
          ]}
        />
      ),
    },
    {
      // Tax exemption is a CUSTOMER-level flag; there is no subscription override, so
      // it reads through and is edited on the customer.
      id: "tax_details",
      title: "Tax details",
      summary: customer
        ? `${customer.tax_exempt ? "Exempt" : "Taxable"}, from the customer`
        : "Customer unavailable",
      children: (
        <div className="flex flex-col gap-3">
          <Facts
            rows={[
              {
                label: "Exempt from tax",
                value: customer ? (customer.tax_exempt ? "Yes" : "No") : "—",
              },
            ]}
          />
          {sub.customer ? (
            <Link
              href={`/businesses/${biz}/customers/${sub.customer}#tax`}
              className="text-sm text-primary hover:underline"
            >
              Manage on the customer
            </Link>
          ) : null}
        </div>
      ),
    },
    {
      id: "address",
      title: "Billing address",
      summary:
        custAddr && (custAddr.line1 || custAddr.city || custAddr.country)
          ? [billingName ?? custName, custAddr.city, custAddr.state, custAddr.country]
              .filter(Boolean)
              .join(" · ")
          : "None on file",
      children:
        custAddr && (custAddr.line1 || custAddr.city || custAddr.country) ? (
          <address className="text-sm leading-relaxed not-italic">
            {/* The BILLING CONTACT (what the invoice prints), then the company. */}
            <div className="font-medium">{billingName ?? custName}</div>
            {custAddr.company && custAddr.company !== (billingName ?? custName) ? (
              <div>{custAddr.company}</div>
            ) : null}
            {[custAddr.line1, custAddr.line2, custAddr.line3].filter(Boolean).map((l, i) => (
              <div key={i}>{l}</div>
            ))}
            <div>
              {[custAddr.city, custAddr.state, custAddr.postal_code].filter(Boolean).join(", ")}
            </div>
            {custAddr.country ? <div>{custAddr.country}</div> : null}
            {custAddr.phone ? (
              <div className="mt-1 text-muted-foreground">{custAddr.phone}</div>
            ) : null}
          </address>
        ) : (
          <p className="text-sm text-muted-foreground">
            No billing address on file.{" "}
            <Link
              href={`/businesses/${biz}/customers/${sub.customer}/edit`}
              className="font-medium text-primary hover:underline"
            >
              Add billing address
            </Link>
          </p>
        ),
    },
    {
      id: "invoice_note",
      title: "Invoice note",
      summary: sub.invoice_notes ? sub.invoice_notes : "None",
      children: sub.invoice_notes ? (
        <p className="text-sm whitespace-pre-wrap">{sub.invoice_notes}</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          No subscription invoice note.{" "}
          {isManager && active ? (
            <Link
              href={`/businesses/${biz}/subscriptions/${sub.id}/change`}
              className="font-medium text-primary hover:underline"
            >
              Add subscription invoice note
            </Link>
          ) : null}{" "}
          to show personalised information on this subscription&rsquo;s invoices.
        </p>
      ),
    },
    {
      // Edited on the Change subscription page, as a customer's is on Edit customer.
      id: "metadata",
      title: "JSON metadata",
      summary:
        sub.metadata && Object.keys(sub.metadata).length
          ? `${Object.keys(sub.metadata).length} key${Object.keys(sub.metadata).length === 1 ? "" : "s"}`
          : "None",
      children:
        sub.metadata && Object.keys(sub.metadata).length > 0 ? (
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
            {JSON.stringify(sub.metadata, null, 2)}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">
            No metadata. Metadata holds your own key-value pairs for this subscription. We store
            them but do not interpret them.
          </p>
        ),
    },
  ];

  const configRow = (label: string, control: React.ReactNode) => ({ label, value: control });

  return (
    <SubscriptionRefreshProvider biz={biz} subId={subId} initial={initialVolatile}>
      <div className="flex flex-col gap-4">
        <RecordVisit
          biz={biz}
          kind="subscription"
          id={sub.id}
          label={planItem?.product_name ?? sub.id}
          detail={custName}
        />
        <RecordCrumbs
          // The trail follows where the operator came from: the customer page links
          // here with `?from=customer`; the list, and a direct link, get Subscriptions.
          items={[
            { label: name, href: `/businesses/${biz}` },
            ...(from === "customer" && sub.customer
              ? [
                  { label: "Customers", href: `/businesses/${biz}/customers` },
                  { label: custName, href: `/businesses/${biz}/customers/${sub.customer}` },
                ]
              : [{ label: "Subscriptions", href: `/businesses/${biz}/subscriptions` }]),
            { label: planName },
          ]}
          right={<SubscriptionRefreshControl />}
        />

        <RecordHeader
          title={planName}
          chips={
            <>
              <SubscriptionStatusChips />
              <SubscriptionDuesChip currency={sub.currency} />
            </>
          }
          facts={[
            // The serializer does not join the customer's name, so it comes from the
            // customer fetched above; the company is dropped when it IS `custName`.
            <span key="cus" className="inline-flex flex-wrap gap-x-2">
              {customer?.company && customer.company !== custName ? (
                <span>{customer.company}</span>
              ) : null}
              <Link
                href={`/businesses/${biz}/customers/${sub.customer}`}
                className="font-medium text-primary hover:underline"
              >
                {custName}
              </Link>
            </span>,
            <Chip key="cur" tone="gray">
              {currencyFlag(sub.currency) ? `${currencyFlag(sub.currency)} ` : ""}
              {sub.currency}
            </Chip>,
            sub.billing_period_unit
              ? `Billed ${INTERVAL_LABEL[sub.billing_period_unit] ?? sub.billing_period_unit}`
              : planItem?.interval
                ? `Billed ${INTERVAL_LABEL[planItem.interval] ?? planItem.interval}`
                : null,
            <IdChip key="id" label="Subscription ID" id={sub.id} />,
          ]}
          actions={
            <>
              {/* Cancel is the most-used subscription action, so it stays on the page;
                  while a cancellation is already scheduled the header offers to remove it. */}
              {isManager && isNonRenewing ? (
                <RemoveScheduledCancellationButton biz={biz} sub={sub.id} />
              ) : activeLike ? (
                <CancelSubscriptionDialog
                  trigger="button"
                  biz={biz}
                  sub={sub.id}
                  customerName={custName}
                  currency={sub.currency}
                  refundableCreditsMinor={refundableCreditsMinor}
                  unbilledChargesMinor={pendingUnbilledMinor}
                  openInvoicesMinor={sub.total_dues_minor ?? 0}
                  openInvoicesCount={sub.due_invoices_count ?? 0}
                  periodEnd={
                    sub.current_period_end ? fmtDate(sub.current_period_end, tz) : undefined
                  }
                  unusedDays={unusedDays}
                  defaultCancelOption={bizRow?.default_cancel_option}
                  defaultCreditOption={bizRow?.default_credit_option_for_cancel}
                  defaultUnbilledOption={bizRow?.default_unbilled_on_cancel}
                  reasons={cancelReasons}
                  reasonRequired={billingRules(bizRow).required_reasons.cancel_subscription}
                  defaultFinalPeriod={billingRules(bizRow).specific_date_cancel_final_period}
                  defaultCreditsOnCancel={
                    hasCreditWindows ? creditRules.on_cancel_at_period_end : undefined
                  }
                />
              ) : null}
              {/* A CANCELLED subscription reactivates through the edit screen, which
                  previews the invoice the fresh term raises — never a one-click charge. */}
              {isManager && (active || sub.status === "cancelled") ? (
                <Button asChild>
                  <Link href={`/businesses/${biz}/subscriptions/${sub.id}/change`}>
                    {sub.status === "cancelled" ? "Reactivate subscription" : "Edit subscription"}
                  </Link>
                </Button>
              ) : null}
              <MoreMenu>
                <MoreSection heading="Subscription">
                  {isPaused ? (
                    <ResumeSubscriptionDialog
                      biz={biz}
                      sub={sub.id}
                      inTerm={resumeInTerm}
                      termEnd={
                        sub.current_period_end ? fmtDate(sub.current_period_end, tz) : undefined
                      }
                      defaultCharges={resumeDefaults.chargesOnResume}
                      defaultUnpaid={resumeDefaults.unpaidInvoicesOnResume}
                      locked={resumeDefaults.locked}
                    />
                  ) : activeLike ? (
                    <PauseSubscriptionDialog
                      biz={biz}
                      sub={sub.id}
                      periodEnd={
                        sub.current_period_end ? fmtDate(sub.current_period_end, tz) : undefined
                      }
                      defaults={resumeDefaults}
                      defaultCreditsOnPause={hasCreditWindows ? creditRules.on_pause : undefined}
                    />
                  ) : null}
                  {isOps && renewalOptions.length > 0 ? (
                    <SkipRenewalDialog biz={biz} sub={sub.id} renewals={renewalOptions} />
                  ) : null}
                  {/* `changeTermEnd` refuses anything but a stored `active` status, which
                      `non_renewing` is; a trial's term end IS its trial end. */}
                  {isManager && (sub.status === "active" || isNonRenewing) ? (
                    <ChangeTermEndDialog
                      biz={biz}
                      sub={sub.id}
                      currentTermEnd={sub.current_period_end ?? undefined}
                    />
                  ) : null}
                  {isManager && sub.status === "in_trial" ? (
                    <EditTrialEndDialog
                      biz={biz}
                      sub={sub.id}
                      currentTrialEnd={sub.trial_end ?? undefined}
                      // The engine refuses `immediately` for an auto-collecting subscription
                      // with no payment method — the conversion would cancel it for no card.
                      endTrialNowBlocked={
                        (sub.auto_collection ?? customer?.auto_collection ?? "on") !== "off" &&
                        pmList.length === 0
                      }
                    />
                  ) : null}
                </MoreSection>
                {isManager ? (
                  <MoreSection heading="Discounts">
                    {sub.discount ? (
                      discountRemove
                    ) : active ? (
                      <>
                        {/* The coupon-code field lives on the change page. */}
                        <RailLink href={`/businesses/${biz}/subscriptions/${sub.id}/change`}>
                          Add coupon
                        </RailLink>
                        <AddManualDiscountDialog biz={biz} sub={sub.id} currency={sub.currency} />
                      </>
                    ) : (
                      <span className="px-2.5 py-2 text-xs text-muted-foreground">No discount</span>
                    )}
                  </MoreSection>
                ) : null}
                {isManager && active ? (
                  <MoreSection heading="Charges">
                    <RailLink href={`/businesses/${biz}/subscriptions/${sub.id}/add_charge_price`}>
                      Add charge
                    </RailLink>
                    <RailLink href={`/businesses/${biz}/subscriptions/${sub.id}/add_charge`}>
                      Create quick charge
                    </RailLink>
                  </MoreSection>
                ) : null}
                <MoreSection heading="Customer">
                  <RailLink href={`/businesses/${biz}/customers/${sub.customer}`}>
                    Change customer details
                  </RailLink>
                </MoreSection>
                {isManager ? (
                  <MoreSection>
                    {/* Deleting is NOT cancelling: nothing is credited, no final invoice is
                        raised and no cancellation is recorded — for a live subscription it
                        simply stops the billing. The copy changes with the status. */}
                    <ActionButton
                      resultAction={deleteSubscriptionAction}
                      fields={{ biz, sub: sub.id }}
                      label="Delete subscription"
                      variant="link"
                      size="sm"
                      className="text-destructive"
                      confirm={{
                        title: "Delete this subscription?",
                        // `<span className="block">`, not `<p>`: DialogDescription is a
                        // paragraph, and a nested one is a hydration error.
                        description: (
                          <>
                            {activeLike ? (
                              <span className="block">
                                This subscription is live. If you delete it, billing stops but the
                                subscription is not cancelled. We do not raise a final invoice, give
                                credit for unused time or record a cancellation. To close the term
                                correctly, cancel the subscription instead.
                              </span>
                            ) : null}
                            <span className={activeLike ? "mt-2 block" : "block"}>
                              Its invoices and payments stay on the customer. The customer must
                              still pay any amount that is owed. We delete the subscription from the
                              account. You cannot restore it from here.
                            </span>
                          </>
                        ),
                        confirmLabel: "Delete",
                        destructive: true,
                      }}
                    />
                  </MoreSection>
                ) : null}
              </MoreMenu>
            </>
          }
        />

        {error ? <ErrorState description={error} /> : null}
        {msg ? <Alert tone="info">{msg}</Alert> : null}
        <SubscriptionRefreshError />

        <SubscriptionAttention
          biz={biz}
          sub={sub.id}
          currency={sub.currency}
          tz={tz}
          dunning={
            oldestUnpaid
              ? {
                  invoice: oldestUnpaid.id,
                  number: oldestUnpaid.number ?? null,
                  attempt_count: oldestUnpaid.attempt_count ?? 0,
                  next_attempt_at: oldestUnpaid.next_attempt_at ?? null,
                  collectable:
                    isManager && ["payment_due", "not_paid"].includes(oldestUnpaid.status),
                }
              : null
          }
          invoiceTracks={invoiceTracks}
          autoCollection={(sub.auto_collection ?? customer?.auto_collection ?? "on") !== "off"}
          pms={pmList}
          firstTried={chargedPM}
          // The header carries the button while non_renewing; the notice alone elsewhere.
          canRemoveCancellation={false}
        />
        <SubscriptionFigures currency={sub.currency} tz={tz} nowMs={nowMs} />

        <Zone title="Plan">
          <Row span="8/4">
            <RecordCard
              id="items"
              title="Subscription items"
              actions={
                isManager && (active || sub.status === "cancelled") ? (
                  <Link
                    href={`/businesses/${biz}/subscriptions/${sub.id}/change`}
                    className="text-primary hover:underline"
                  >
                    Edit
                  </Link>
                ) : null
              }
              footer={
                pendingScheduled.length ? (
                  <div className="flex flex-col gap-1.5">
                    {pendingScheduled.map((s) => (
                      <div key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-semibold">Scheduled change</span>
                        <span className="capitalize">{s.type}</span>
                        <span className="text-muted-foreground">
                          · effective {fmtDateTime(s.effective_at, tz)}
                        </span>
                        <StatusChip status={s.status} />
                        {/* Why it hasn't happened: the give-up reason on a failed row, or the
                            in-flight error while it is still retrying. */}
                        {s.last_error ? (
                          <span className="text-destructive">
                            {s.last_error}
                            {s.attempts > 0 && s.status !== "failed"
                              ? ` · retried ${s.attempts}×`
                              : ""}
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : undefined
              }
            >
              {/* Tax comes from the renewal estimate fetched above — no second call and no
                  rate re-derived here; null when that call failed, and the card then shows
                  nothing rather than implying zero. */}
              <SubscriptionItems
                items={sub.items ?? []}
                currency={sub.currency}
                biz={biz}
                taxLines={renewalEstimate?.tax_lines}
                taxMinor={renewalEstimate?.tax_minor}
                discountMinor={renewalEstimate?.discount_minor}
                discount={itemsDiscount}
                itemActions={itemModelPriceActions(biz, subId, listPriceItems)}
              />
            </RecordCard>
            <Stack>
              {/* The card this subscription actually charges: its own override wins at
                  collection time, else the customer's primary. */}
              <RecordCard
                id="payment_methods"
                title="Payment method"
                actions={
                  sub.customer ? (
                    <RequestUpdateButton
                      biz={biz}
                      customer={sub.customer}
                      email={customer?.email}
                      variant="link"
                    />
                  ) : null
                }
              >
                <div className="flex flex-col gap-3">
                  {pmMissing ? (
                    <Alert tone="warning">
                      This subscription charges payment method{" "}
                      <span className="font-mono">{sub.default_payment_method}</span>. That payment
                      method is not in the customer&apos;s current list. It may have been removed.
                    </Alert>
                  ) : null}
                  {chargedPM ? (
                    <ul className="-my-3">
                      <PaymentMethodRow
                        pm={chargedPM}
                        tz={tz}
                        note={
                          subPM
                            ? "set on this subscription"
                            : pmMissing
                              ? "customer's primary, shown as a fallback"
                              : "customer's primary"
                        }
                        menu={
                          sub.customer ? (
                            <Link
                              href={`/businesses/${biz}/customers/${sub.customer}#payment-methods`}
                            >
                              Manage on customer
                            </Link>
                          ) : null
                        }
                      />
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No payment method on file. The customer adds one from their portal.
                    </p>
                  )}
                </div>
              </RecordCard>
              <RecordCard id="configurations" title="Subscription configurations">
                {/* Label above value: beside a 40% label column the values and their
                    Change links had no room and wrapped out of line. */}
                <SettingsList
                  rows={[
                    configRow(
                      "Ship to",
                      <ShipToInline
                        biz={biz}
                        sub={subId}
                        customer={sub.customer}
                        pickedId={sub.shipping_address_id}
                        resolved={sub.shipping_address}
                        addresses={shippingBook}
                        canEdit={isManager && sub.status !== "cancelled"}
                      />,
                    ),
                    configRow(
                      "Auto collection",
                      <AutoCollectionInline
                        biz={biz}
                        sub={subId}
                        value={sub.auto_collection ?? customer?.auto_collection ?? null}
                        overridden={sub.auto_collection != null}
                        canEdit={isManager}
                      />,
                    ),
                    // Counts cycles AFTER the current one: 0 = this term is the last,
                    // null renews forever.
                    configRow(
                      "Billing cycles",
                      <BillingCyclesInline
                        biz={biz}
                        sub={subId}
                        value={sub.remaining_billing_cycles}
                        periodEndLabel={
                          sub.current_period_end
                            ? fmtDate(sub.current_period_end, tz)
                            : "at the term end"
                        }
                        canEdit={isManager}
                      />,
                    ),
                    ...(renewalOptions.length > 0 || skippedRenewals.length > 0
                      ? [
                          configRow(
                            "Skipped renewals",
                            <SkippedRenewals
                              biz={biz}
                              sub={sub.id}
                              skipped={skippedRenewals}
                              canEdit={isOps}
                            />,
                          ),
                        ]
                      : []),
                    configRow(
                      "Minimum commitment",
                      <CommitmentInline
                        biz={biz}
                        sub={subId}
                        currency={sub.currency}
                        amountMinor={sub.commitment?.amount_minor ?? null}
                        countedMinor={commitment?.counted_minor ?? null}
                        shortfallMinor={commitment?.shortfall_minor ?? null}
                        canEdit={isOps && sub.status !== "cancelled"}
                      />,
                    ),
                    ...(sub.bill_usage_monthly
                      ? [
                          configRow(
                            "Usage billing",
                            <span className="font-medium text-foreground">
                              Every month
                              {sub.current_sub_period_end ? (
                                <span className="ml-1.5 font-normal text-muted-foreground">
                                  next on {fmtDate(sub.current_sub_period_end, tz)}
                                </span>
                              ) : null}
                            </span>,
                          ),
                        ]
                      : []),
                    // Per-subscription ceilings; they can only NARROW the business setting.
                    configRow(
                      "Refundable credit",
                      <CreditUsageInline
                        biz={biz}
                        sub={subId}
                        kind="refundable"
                        value={sub.max_refundable_credits_usage_minor}
                        currency={sub.currency}
                        businessAllows={
                          (bizRow?.credits_flexibility?.refundable?.recurring?.mode ?? "auto") !==
                          "none"
                        }
                        canEdit={isManager}
                      />,
                    ),
                    configRow(
                      "Excess payments",
                      <CreditUsageInline
                        biz={biz}
                        sub={subId}
                        kind="excess"
                        value={sub.max_excess_payment_usage_minor}
                        currency={sub.currency}
                        businessAllows={
                          (bizRow?.credits_flexibility?.excess?.recurring?.mode ?? "auto") !==
                          "none"
                        }
                        canEdit={isManager}
                      />,
                    ),
                  ]}
                />
              </RecordCard>
            </Stack>
          </Row>
          {hasUsage(usage) ? (
            <RecordCard id="usage" title="Usage this period">
              <CurrentUsageCard usage={usage} tz={tz} />
            </RecordCard>
          ) : null}
          {(sub.items ?? []).some((it) =>
            prices.data.some((p) => p.id === it.price && p.metered),
          ) && allows(user, "usage_controls:view", "manager") ? (
            <React.Suspense fallback={null}>
              <SubscriptionUsageThresholdCard
                biz={biz}
                subscription={sub.id}
                product={prices.data.find((p) => p.id === planItem?.price)?.product ?? null}
                currency={sub.currency}
                canManage={allows(user, "usage_controls:manage", "manager")}
              />
            </React.Suspense>
          ) : null}
        </Zone>

        <Zone title="Charges">
          <Row span="6/6">
            <RecordCard
              id="unbilled"
              title="Unbilled charges"
              meta={
                pendingUnbilledMinor > 0
                  ? `${money(pendingUnbilledMinor, sub.currency)} pending`
                  : undefined
              }
              actions={
                isManager && active ? (
                  <Link
                    href={`/businesses/${biz}/subscriptions/${sub.id}/add_charge_price`}
                    className="text-primary hover:underline"
                  >
                    Add charge
                  </Link>
                ) : null
              }
              flush={unbilled.data.length > 0}
              footer={
                isManager && active && triggerRows.length > 0 ? (
                  <div id="trigger" className="space-y-2">
                    <span className="font-semibold">Quick charges</span>
                    <TriggerChargeCard biz={biz} sub={sub.id} rows={triggerRows} />
                  </div>
                ) : undefined
              }
            >
              {unbilled.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This subscription has no unbilled charges.
                </p>
              ) : (
                <Paged
                  size={10}
                  items={unbilled.data.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="pl-5 wrap-anywhere whitespace-normal">
                        {c.description}
                        <div className="font-mono text-xs text-muted-foreground">{c.id}</div>
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
            {/* Every one-time line this subscription has been billed for. */}
            <RecordCard
              id="non_recurring"
              title="Non-recurring items"
              flush={oneTimeRows.length > 0}
              footer={
                oneTimeRows.length ? (
                  <div className="flex flex-col gap-1">
                    <div className="flex">
                      <span className="text-muted-foreground">Total charged, excl. tax</span>
                      <span className="ml-auto font-semibold tabular-nums">
                        {money(oneTimeTotalMinor, sub.currency)} {sub.currency}
                      </span>
                    </div>
                    {oneTimeTruncated ? (
                      <span className="text-xs text-muted-foreground">
                        This subscription has more than 100 invoices. This total counts only the 100
                        most recent invoices.
                      </span>
                    ) : null}
                  </div>
                ) : undefined
              }
            >
              {oneTimeRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This subscription has no billed one-time charges.
                </p>
              ) : (
                <Paged
                  size={10}
                  items={oneTimeRows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="pl-5">{r.at ? fmtDate(r.at, tz) : "—"}</TableCell>
                      <TableCell className="wrap-anywhere whitespace-normal">
                        {r.description}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/businesses/${biz}/invoices/${r.invoice}`}
                          className="text-primary hover:underline"
                        >
                          {r.invoiceNumber ?? r.invoice}
                        </Link>
                        <StatusChip status={r.invoiceStatus} className="ml-2" />
                      </TableCell>
                      <TableCell className="pr-5 text-right tabular-nums">
                        {money(r.amountMinor, sub.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                >
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-5">Date</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Invoice</TableHead>
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
          </Row>
        </Zone>

        <Zone title="Records">
          <Row span="12">
            <RecordCard id="history" title="History">
              <CustomerHistory
                biz={biz}
                invoices={cursorSource({ data: subInvoices })}
                transactions={subTransactions}
                creditNotes={subCreditNotes}
                events={subEvents}
                emails={subEmails}
              />
            </RecordCard>
          </Row>
          <Row span="8/4">
            <ActivityLogCard
              biz={biz}
              resourceType="subscription"
              resourceId={sub.id}
              tz={tz}
              layout="card"
              previewRows={5}
            />
            <CommentsCard
              biz={biz}
              resourceType="subscription"
              resourceId={sub.id}
              backPath={`/businesses/${biz}/subscriptions/${sub.id}`}
              layout="card"
            />
          </Row>
        </Zone>

        <div className="mt-4">
          <FoldedCard
            title="Details"
            sections={detailSections}
            actions={
              isManager && active ? (
                <Link
                  href={`/businesses/${biz}/subscriptions/${sub.id}/change`}
                  className="text-primary hover:underline"
                >
                  Edit
                </Link>
              ) : undefined
            }
          />
        </div>
      </div>
    </SubscriptionRefreshProvider>
  );
}

/** A settings card's rows: label above value, one per row. */
function SettingsList({ rows }: { rows: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <dl className="-my-1 divide-y text-sm">
      {rows.map((r) => (
        <div key={r.label} className="py-2.5 first:pt-0 last:pb-0">
          <dt className="text-xs text-muted-foreground">{r.label}</dt>
          <dd className="mt-0.5">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A switch entitlement arrives as the string "true" / "false", not a boolean. */
function entitlementValue(v: unknown): string {
  if (v === true || v === "true") return "enabled";
  if (v === false || v === "false") return "disabled";
  return String(v ?? "—");
}

type ListPriceItem = {
  it: SubscriptionItem;
  price: Price;
  meter: Meter;
};

/** "Edit price" on each item that bills from the model price list (per-customer selling price). */
function itemModelPriceActions(biz: string, sub: string, rows: ListPriceItem[]) {
  if (!rows.length) return undefined;
  return Object.fromEntries(
    rows.map(({ it, price: p, meter: m }) => [
      it.id!,
      <ItemModelPriceDialog
        key={it.id}
        biz={biz}
        sub={sub}
        item={it.id!}
        itemName={it.product_name || it.price}
        override={{
          markup_percent: it.selling_price?.markup_percent ?? null,
          rates: it.selling_price?.rates ?? null,
        }}
        price={{
          currency: p.currency,
          markup_percent: p.markup_percent ?? null,
          markup_base: p.markup_base === "cost" ? "cost" : "list",
          quantity_divisor: String(p.quantity_divisor ?? 1),
          cost_first: p.amount_source === "event_cost_or_list",
        }}
        meter={{ group_by: m.group_by, price_list: m.price_list ?? null }}
      />,
    ]),
  );
}
