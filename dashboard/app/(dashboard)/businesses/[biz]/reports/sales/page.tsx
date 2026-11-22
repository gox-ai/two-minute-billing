import Link from "next/link";
import { reportCrumbs } from "@/lib/report-crumbs";
import { listBusinesses, getReport } from "@/lib/api";
import { queryAnalytics, type AnalyticsQuery, type BatchEntry } from "@/lib/analytics-api";
import { requirePermission } from "@/lib/session";
import { modelEmptyState } from "@/components/reports/model-empty-state";
import { PageHeader } from "@/components/page-header";
import { Grid, Stack } from "@/components/analytics/layout";
import { RecordCard, Row } from "@/components/patterns/record-page";
import { ZoneHeading, ZoneMeta } from "@/components/analytics/home/zone";
import { BarList, Headline, pick, slices } from "@/components/analytics/home/parts";
import { BucketBars } from "@/components/charts/bucket-bars";
import { ErrorState } from "@/components/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { NavPendingProvider, PendingContent } from "@/components/navigation/nav-pending";
import { ReportFilters } from "@/components/reports/hosted/report-filters";
import { CohortGrid } from "@/components/reports/report-shapes";
import {
  DEFAULT_HOSTED_RANGE,
  resolveHostedWindow,
  spanLabel,
} from "@/components/reports/hosted/window";
import { HostedReportSkeleton, changeOf, count, rate } from "@/components/reports/hosted/parts";
import { splitRowLabel, type ReportPayload } from "@/components/reports/report-format";
import { axisLabel } from "@/components/analytics/series-format";
import { regionName } from "@/lib/countries";
import { money } from "@/lib/format";

export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

const BUYER_TYPE: Record<string, string> = {
  first: "First-time buyers",
  returning: "Returning buyers",
};

/**
 * Reports → Sales: one-time orders. Orders, revenue, buyers, refunds, where it sells, and
 * whether buyers come back. Money is held per currency and never added across currencies.
 */
export default async function SalesReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("reports:view", "ops");
  const [{ biz }, search] = await Promise.all([params, searchParams]);
  const empty = await modelEmptyState(biz, "one_time", "Sales");
  if (empty) return empty;

  let businesses;
  try {
    businesses = await listBusinesses();
  } catch (e) {
    return (
      <>
        <PageHeader title="Sales" />
        <ErrorState error={e} thing="sales report" retry />
      </>
    );
  }
  const business = businesses.data.find((b) => b.id === biz) ?? null;
  const tz = business?.timezone ?? null;
  const crumbs = reportCrumbs(biz, business?.name, "Sales");
  const win = resolveHostedWindow(one(search.range) || DEFAULT_HOSTED_RANGE, tz);
  const compare = one(search.compare) !== "off";
  const currencies = Array.from(
    new Set([business?.default_currency, ...(business?.currencies ?? [])].filter(Boolean)),
  ).map((c) => String(c).toUpperCase());
  const asked = one(search.currency).toUpperCase();
  const cur = currencies.includes(asked) ? asked : (currencies[0] ?? "USD");

  const W = { start: win.start, end: win.end, grain: "month" as const };
  const C = compare ? { compare: "previous" as const } : {};
  const days = { start: win.start, end: win.end, grain: "day" as const };
  const queries: AnalyticsQuery[] = [
    { key: "orders", measure: "orders", ...W, ...C },
    { key: "orders_day", measure: "orders", ...days },
    { key: "revenue_day", measure: "order_revenue", ...days },
    { key: "revenue", measure: "order_revenue", ...W, ...C },
    { key: "aov", measure: "average_order_value", ...W, ...C },
    { key: "buyers", measure: "buyers", ...W, ...C },
    { key: "returning_rate", measure: "returning_buyer_rate", ...W, ...C },
    { key: "refunds", measure: "order_refunds", ...W, ...C },
    { key: "refund_rate", measure: "order_refund_rate", ...W, ...C },
    { key: "discount", measure: "order_discount", ...W },
    { key: "by_product", measure: "order_revenue", split: "product", split_limit: 25, ...W },
    { key: "units_product", measure: "units_sold", split: "product", split_limit: 25, ...W },
    { key: "refunds_product", measure: "order_refunds", split: "product", split_limit: 25, ...W },
    { key: "by_buyer", measure: "order_revenue", split: "buyer_type", ...W },
    { key: "by_country", measure: "order_revenue", split: "country", split_limit: 10, ...W },
    { key: "by_gateway", measure: "order_revenue", split: "gateway", split_limit: 10, ...W },
    { key: "by_coupon", measure: "order_revenue", split: "coupon", split_limit: 10, ...W },
    { key: "lifetime", measure: "buyer_lifetime_revenue", ...W },
  ];

  let batch: BatchEntry[];
  let repeat: ReportPayload | null = null;
  let revenueCohort: ReportPayload | null = null;
  try {
    const grid = (key: string) =>
      getReport(biz, key, { currency: cur }).then(
        (r) => r as unknown as ReportPayload,
        () => null,
      );
    [batch, repeat, revenueCohort] = await Promise.all([
      queryAnalytics({ queries, business: biz, currency: cur }),
      grid("repeat_purchase_cohort"),
      grid("buyer_revenue_cohort"),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Sales" breadcrumbs={crumbs} />
        <ErrorState error={e} thing="sales report" retry />
      </>
    );
  }

  const total = (k: string) => pick(batch, k)?.total ?? null;
  const prev = (k: string) => pick(batch, k)?.compare?.previous_total ?? null;
  const cmp = pick(batch, "orders")?.compare;
  const versus = cmp ? `vs ${spanLabel(cmp.start, cmp.end, tz)}` : "vs the previous period";
  const chg = (k: string, good: "up" | "down") => changeOf(total(k), prev(k), good, versus);
  const series = (k: string) => (pick(batch, k)?.series ?? []).map((p) => p.value ?? null);
  const labels = (pick(batch, "orders_day")?.series ?? []).map((p) => axisLabel(p.label));
  const moneyOrDash = (n: number | null) => (n == null ? "—" : money(n, cur));
  const countOrDash = (n: number | null) => (n == null ? "—" : count(n));

  const refundRows = new Map(slices(pick(batch, "refunds_product")).map((r) => [r.key, r.total]));
  const unitRows = new Map(slices(pick(batch, "units_product")).map((r) => [r.key, r.total]));
  const products = slices(pick(batch, "by_product"));
  const bars = (key: string, dimension: string, name?: (k: string, l: string) => string) =>
    slices(pick(batch, key)).map((r) => ({
      key: r.key,
      label: name
        ? name(r.key, splitRowLabel(dimension, r.key, r.label))
        : splitRowLabel(dimension, r.key, r.label),
      total: r.total,
    }));

  return (
    <NavPendingProvider>
      <PageHeader
        title="Sales"
        description="Orders for one-time products: how much you sold, who bought, what came back and where it sells."
        breadcrumbs={crumbs}
      />
      <Stack>
        <ZoneHeading zone="performance">
          <ReportFilters
            range={win.rangeId}
            compare={compare}
            filters={[
              {
                param: "currency",
                ariaLabel: "Currency",
                value: cur,
                options: currencies.map((c) => ({ value: c, label: c })),
              },
            ]}
          />
          <ZoneMeta>
            {spanLabel(win.start, win.end, tz)} · All figures in {cur}
          </ZoneMeta>
        </ZoneHeading>
        <PendingContent skeleton={<HostedReportSkeleton label="sales report" />}>
          <div className="flex flex-col gap-4">
            <Grid className="gap-4">
              <Headline
                span={3}
                label="Orders"
                value={countOrDash(total("orders"))}
                href={`/businesses/${biz}/orders?${new URLSearchParams([
                  ["filter", `created_at:on_or_after:${win.start}`],
                  ["filter", `created_at:on_or_before:${win.end}`],
                ]).toString()}`}
                change={chg("orders", "up")}
              />
              <Headline
                span={3}
                label="Order revenue"
                value={moneyOrDash(total("revenue"))}
                change={chg("revenue", "up")}
              />
              <Headline
                span={3}
                label="Average order value"
                value={moneyOrDash(total("aov"))}
                note="Revenue ÷ orders"
                change={chg("aov", "up")}
              />
              <Headline
                span={3}
                label="Buyers"
                value={countOrDash(total("buyers"))}
                change={chg("buyers", "up")}
              />
              <Headline
                span={3}
                label="Returning buyer rate"
                value={rate(total("returning_rate"))}
                note="Buyers who ordered before"
                change={chg("returning_rate", "up")}
              />
              <Headline
                span={3}
                label="Refunds"
                value={moneyOrDash(total("refunds"))}
                change={chg("refunds", "down")}
              />
              <Headline
                span={3}
                label="Refund rate"
                value={rate(total("refund_rate"))}
                change={chg("refund_rate", "down")}
              />
              <Headline
                span={3}
                label="Revenue per buyer, all time"
                value={moneyOrDash(total("lifetime"))}
                note="Order revenue ÷ buyers, to the end of the period"
              />
            </Grid>

            <RecordCard
              title="Orders and revenue"
              meta={`Per day, ${spanLabel(win.start, win.end, tz)}`}
            >
              <BucketBars
                labels={labels}
                values={series("revenue_day")}
                markers={series("orders_day")}
                markerLabel="Orders"
                seriesLabel="Order revenue"
                tone="brand"
                kind="money"
                currency={cur}
                height={240}
                empty={<p className="text-sm text-muted-foreground">No orders in this period.</p>}
              />
            </RecordCard>

            <RecordCard title="By product" meta="Sorted by revenue" flush>
              <Table phone="stack">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5" phone="title">
                      Product
                    </TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead phone="aside" className="text-right">
                      Revenue
                    </TableHead>
                    <TableHead className="pr-5 text-right">Refunds</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {products.map((p) => (
                    <TableRow key={p.key}>
                      <TableCell className="pl-5">
                        {/* The report keys a product by its row id, which the Orders product filter does not take. */}
                        <Link
                          href={`/businesses/${biz}/catalog/charges`}
                          className="text-primary hover:underline"
                        >
                          {splitRowLabel("product", p.key, p.label)}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right">
                        {countOrDash(unitRows.get(p.key) ?? null)}
                      </TableCell>
                      <TableCell className="text-right">{money(p.total, cur)}</TableCell>
                      <TableCell className="pr-5 text-right">
                        {money(refundRows.get(p.key) ?? 0, cur)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {products.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="pl-5 text-muted-foreground">
                        No orders in this period.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </RecordCard>

            <Row span="6/6">
              <RecordCard title="First-time and returning buyers" meta="Order revenue">
                <BarList
                  rows={bars("by_buyer", "buyer_type", (k, l) => BUYER_TYPE[k] ?? l)}
                  format={(n) => money(n, cur)}
                />
              </RecordCard>
              <RecordCard
                title="Discounts"
                meta="Given on orders"
                footer={
                  <Link
                    href={`/businesses/${biz}/customers?filter=order_count:gte:2`}
                    className="text-sm text-primary hover:underline"
                  >
                    Repeat buyers
                  </Link>
                }
              >
                <span className="text-2xl font-semibold tabular-nums">
                  {moneyOrDash(total("discount"))}
                </span>
              </RecordCard>
            </Row>

            {repeat?.matrix && repeat.matrix.rows.length > 0 ? (
              <RecordCard
                title="Repeat purchases by cohort"
                meta="Share of each month's first-time buyers who ordered again"
                flush
              >
                <CohortGrid matrix={repeat.matrix} currency={cur} />
              </RecordCard>
            ) : null}
            {revenueCohort?.matrix && revenueCohort.matrix.rows.length > 0 ? (
              <RecordCard
                title="Revenue per buyer by cohort"
                meta="Order revenue so far, divided by the buyers in the cohort"
                flush
              >
                <CohortGrid matrix={revenueCohort.matrix} currency={cur} />
              </RecordCard>
            ) : null}

            <Row span="6/6">
              <RecordCard title="Order revenue by country">
                <BarList
                  rows={bars("by_country", "country", (k, l) =>
                    k.toLowerCase() === "none" ? l : regionName(k),
                  )}
                  format={(n) => money(n, cur)}
                />
              </RecordCard>
              <RecordCard title="Order revenue by payment gateway">
                <BarList rows={bars("by_gateway", "gateway")} format={(n) => money(n, cur)} />
              </RecordCard>
            </Row>
            <RecordCard title="Order revenue by coupon">
              <BarList rows={bars("by_coupon", "coupon")} format={(n) => money(n, cur)} />
            </RecordCard>
            {/* A top-buyers list is omitted: no customer list sorts by order revenue yet. */}
          </div>
        </PendingContent>
      </Stack>
    </NavPendingProvider>
  );
}
