import { listBusinesses } from "@/lib/api";
import { getGatewayCatalogOrEmpty } from "@/lib/api/gateways";
import { listTransactions } from "@/lib/api/payments";
import {
  getPaymentsAnalytics,
  isPaymentsAnalyticsRange,
  type PaymentsAnalytics,
  type PaymentsAnalyticsRange,
} from "@/lib/api/analytics";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { TransactionsTable } from "@/components/payments/transactions-table";
import { DashboardTabs } from "@/components/analytics/dashboard-tabs";
import {
  PaymentsAnalyticsBlock,
  type PaymentsAnalyticsConfig,
} from "@/components/analytics/payments-analytics-block";
import { ErrorState } from "@/components/states";
import { urlFilters } from "@/lib/list-source";

export const dynamic = "force-dynamic";

/** Rows per page — keep in step with the page size in /api/lists/[entity]. */
const PAGE_SIZE = 50;

/** The default period. A month of activity is the useful default for a payments log. */
const DEFAULT_RANGE: PaymentsAnalyticsRange = "this_month";

/**
 * The transactions Dashboard tab: Gross Volume, Refunds, Chargebacks,
 * Transactions and Failure Rate, then Error Details and the Payment Method
 * Breakdown. Every one of those maps to a series/breakdown the payments-analytics
 * read returns — nothing here is rendered without a number behind it.
 */
const ANALYTICS: PaymentsAnalyticsConfig = {
  lead: "gross_volume",
  tiles: ["refunds", "chargebacks", "transaction_count", "failure_rate"],
  breakdowns: ["error_details", "payment_methods"],
};

export default async function TransactionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{
    tab?: string;
    range?: string;
    gateway?: string;
    payment_method?: string;
    status?: string;
    type?: string;
    customer?: string;
    invoice?: string;
    /** `occurred_at[on|after|before]` — bracketed keys can't be named literally. */
    [param: string]: string | undefined;
  }>;
}) {
  const [{ biz }, search] = await Promise.all([params, searchParams]);
  await requirePermission("payments:view", "ops");

  const tab = search.tab === "list" ? "list" : "dashboard";
  // A hand-typed `?range=` must not blank the page: the API 400s on an unknown
  // value, so fall back to the default rather than forwarding it.
  const range = isPaymentsAnalyticsRange(search.range) ? search.range : DEFAULT_RANGE;

  let businesses, transactions;
  try {
    [businesses, transactions] = await Promise.all([
      listBusinesses(),
      listTransactions(biz, { limit: PAGE_SIZE }),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Transactions" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  // Analytics gets its own try: the list is the page's job and must survive a
  // failing metrics read.
  let analytics: PaymentsAnalytics | null = null;
  let analyticsError: string | undefined;
  if (tab === "dashboard") {
    try {
      analytics = await getPaymentsAnalytics(biz, {
        range,
        gateway: search.gateway,
        payment_method: search.payment_method,
      });
    } catch (e) {
      analyticsError = (e as Error).message;
    }
  }

  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;
  // Stripe and PayPal select the mode in the deep link to a charge, so the list's
  // Gateway Charge Id column needs this business's mode (see `gatewayObjectUrl`).
  const livemode = businesses.data.find((b) => b.id === biz)?.livemode ?? null;
  const needsAttention = transactions.data.filter(
    (t) => t.status === "needs_attention" || t.status === "timeout",
  ).length;

  const gatewayCatalog = await getGatewayCatalogOrEmpty();
  return (
    <>
      <PageHeader
        title="Transactions"
        breadcrumbs={[{ label: name, href: `/businesses/${biz}` }, { label: "Transactions" }]}
        description={
          needsAttention > 0
            ? `${needsAttention} transaction${needsAttention === 1 ? "" : "s"} need${needsAttention === 1 ? "s" : ""} an operator verdict`
            : undefined
        }
      />

      <DashboardTabs
        basePath={`/businesses/${biz}/transactions`}
        search={search}
        listLabel="All Transactions"
        active={tab}
      />

      {/* The list renders on BOTH tabs; the Dashboard tab only ADDS this block
          above it. */}
      {analyticsError ? (
        <ErrorState
          className="mb-6"
          title="We could not load the payments dashboard"
          description={<span className="font-mono text-xs">{analyticsError}</span>}
        />
      ) : null}
      {analytics ? <PaymentsAnalyticsBlock data={analytics} config={ANALYTICS} /> : null}

      {/* The list chrome stays visible at zero rows — the table owns its empty state. */}
      {/* `?status=failed`, `?type=refund`, … used to be ignored by the list, which
          held its filter state internally — the URL claimed a filter and the table
          showed the whole log. `payment_method` is deliberately absent: it is an
          analytics dimension and the list has no matching filter field (the row's
          payment method is an object, not a filterable column). */}
      <TransactionsTable
        gatewayCatalog={gatewayCatalog}
        biz={biz}
        livemode={livemode}
        rows={transactions.data}
        total={transactions.total ?? transactions.data.length}
        hasMore={transactions.has_more}
        nextCursor={transactions.next_cursor}
        initialFilters={urlFilters(search, {
          status: true,
          type: true,
          customer: true,
          invoice: true,
          gateway: true,
          // `occurred_at[on|after|before]` — Business Home's revenue figures link
          // here, cut on the settlement date their own arithmetic uses.
          occurred_at: true,
          // `payment_intent[is]=pi_…` — the intent detail page's "View transactions".
          // The column, the filter field and the engine filter all already existed; this
          // map is the one place that has to name a param for it to survive the URL, and
          // without the entry the link rendered fine and narrowed nothing.
          payment_intent: true,
        })}
      />
    </>
  );
}
