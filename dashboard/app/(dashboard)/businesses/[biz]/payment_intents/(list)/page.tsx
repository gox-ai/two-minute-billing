import { listBusinesses } from "@/lib/api";
import { listPaymentIntents } from "@/lib/api/payments";
import { getGatewayCatalogOrEmpty } from "@/lib/api/gateways";
import {
  getPaymentsAnalytics,
  isPaymentsAnalyticsRange,
  type PaymentsAnalytics,
  type PaymentsAnalyticsRange,
} from "@/lib/api/analytics";
import { PaymentIntentsTable } from "@/components/payments/payment-intents-table";
import { DashboardTabs } from "@/components/analytics/dashboard-tabs";
import {
  PaymentsAnalyticsBlock,
  type PaymentsAnalyticsConfig,
} from "@/components/analytics/payments-analytics-block";
import { ErrorState } from "@/components/states";
import { requirePermission } from "@/lib/session";
import { urlFilters } from "@/lib/list-source";

export const dynamic = "force-dynamic";

const DEFAULT_RANGE: PaymentsAnalyticsRange = "this_month";

/**
 * The payment-intents Dashboard tab: Total Revenue, Successful Payments,
 * Pending Payment Intents, Failed Amount and Failure Rate, then a Failure Trend
 * and a Gateway breakdown. Same block as /transactions — only this config differs.
 *
 * `Total Revenue` is this screen's name for the same measure /transactions calls
 * Gross Volume, so the label is overridden and the number is identical.
 *
 * The failure measures are still TRANSACTION-level, not intent-level, and the
 * tiles keep saying so. What CHANGED in Phase 4 is only the reason: the schema
 * now CAN answer it — `transactions` carries `payment_intent_id` and
 * `payment_attempt_id`, and `payment_attempts.status` has a real `failed` — but
 * `src/modules/metrics/payments-analytics.ts` still aggregates `transactions`
 * alone, so the numbers this endpoint returns have not changed. Relabelling them
 * "intent failures" without changing that read would be a lie in the one place an
 * operator cannot check it, so the ⓘ stays honest and the backend work is
 * reported instead. `payment_intents` itself still has no `failed` status — an
 * intent-level count has to come from the ATTEMPTS.
 */
const ANALYTICS: PaymentsAnalyticsConfig = {
  lead: "gross_volume",
  tiles: ["successful_payments", "pending_payment_intents", "failed_amount", "failure_rate"],
  charts: [{ key: "failed_transactions", label: "Failure trend" }],
  breakdowns: ["gateways"],
  labels: { gross_volume: "Total revenue" },
  // Every figure here reads the transaction log, so it counts payments that never had an
  // intent (intents exist only for 3DS and off-session challenges). Say so beside the list.
  note: "These figures include all payment attempts in the transaction log. Some of these attempts do not have a payment intent.",
};

export default async function PaymentIntentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{
    tab?: string;
    range?: string;
    gateway?: string;
    payment_method?: string;
    /** `field:op:value`, repeatable (see `urlFilters`). */
    filter?: string | string[];
    customer?: string;
    status?: string;
    purpose?: string;
  }>;
}) {
  const [{ biz }, search] = await Promise.all([params, searchParams]);
  await requirePermission("payments:view", "ops");

  const tab = search.tab === "list" ? "list" : "dashboard";
  const range = isPaymentsAnalyticsRange(search.range) ? search.range : DEFAULT_RANGE;

  // A deep link's narrowing (`?filter=customer:is:cus_…`). The engine takes exactly these
  // three as bare params, so the first page is narrowed with the `is` rows only.
  const deepLinkFilters = urlFilters(search, { customer: true, status: true, purpose: true });
  const pick = (field: string) =>
    deepLinkFilters.find((f) => f.field === field && f.op === "is")?.value;

  const [businesses, intents, gatewayCatalog] = await Promise.all([
    listBusinesses(),
    listPaymentIntents(biz, {
      limit: 50,
      customer: pick("customer"),
      status: pick("status"),
      purpose: pick("purpose"),
    }),
    getGatewayCatalogOrEmpty(),
  ]);
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;

  // Analytics gets its own try: the list must survive a failing metrics read.
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

  return (
    <>
      {/* The list draws the page header (count and Refresh beside the title, as on every
          other list); the tabs and the Dashboard tab's block sit between it and the list. */}
      <PaymentIntentsTable
        page={{
          title: "Payment intents",
          breadcrumbs: [{ label: name, href: `/businesses/${biz}` }, { label: "Payment intents" }],
          refreshesPage: true,
          notice: (
            <>
              <DashboardTabs
                basePath={`/businesses/${biz}/payment_intents`}
                search={search}
                listLabel="All payment intents"
                active={tab}
              />
              {analyticsError ? (
                <ErrorState
                  className="mb-6"
                  title="We could not load the payments dashboard"
                  description={<span className="font-mono text-xs">{analyticsError}</span>}
                />
              ) : null}
              {analytics ? <PaymentsAnalyticsBlock data={analytics} config={ANALYTICS} /> : null}
            </>
          ),
        }}
        biz={biz}
        gatewayCatalog={gatewayCatalog}
        rows={intents.data}
        total={intents.total ?? intents.data.length}
        hasMore={intents.has_more}
        nextCursor={intents.next_cursor}
        initialFilters={deepLinkFilters}
      />
    </>
  );
}
