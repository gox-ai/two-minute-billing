import { reportCrumbs } from "@/lib/report-crumbs";
import { listBusinesses, listProducts } from "@/lib/api";
import { getCheckoutReport } from "@/lib/api/hosted-page-reports";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Grid, Stack } from "@/components/analytics/layout";
import { RecordCard, Row } from "@/components/patterns/record-page";
import { ZoneHeading, ZoneMeta } from "@/components/analytics/home/zone";
import { BarList, Headline } from "@/components/analytics/home/parts";
import { BucketBars } from "@/components/charts/bucket-bars";
import { ErrorState } from "@/components/states";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { NavPendingProvider, PendingContent } from "@/components/navigation/nav-pending";
import { ReportFilters } from "@/components/reports/hosted/report-filters";
import {
  DEFAULT_HOSTED_RANGE,
  resolveHostedWindow,
  spanLabel,
} from "@/components/reports/hosted/window";
import {
  FunnelTable,
  HostedReportSkeleton,
  LiveStrip,
  changeOf,
  count,
  fmtDuration,
  gatewayLabel,
  methodLabel,
  rate,
} from "@/components/reports/hosted/parts";
import {
  CheckoutBrowsers,
  CheckoutDevices,
  CheckoutStepTime,
  WhereBuyersCome,
  collectingNote,
  trackingFilters,
  visitorConversion,
} from "@/components/reports/hosted/tracking";
import { regionName } from "@/lib/countries";
import { money } from "@/lib/format";
import { Download } from "lucide-react";

export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * The checkout report: how buyers move through hosted checkout links, how they pay and what
 * reminders recover. Every figure is from data we store today.
 *
 * Section order: live strip → scorecards → funnel → trend → where buyers come from → by link →
 * payment methods and failures → abandoned and coupons → countries and time to complete →
 * devices and browsers → time on each step. The visit cards and the Country and Device
 * filters read first-party tracking (`storefront-analytics`).
 */
export default async function CheckoutReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("reports:view", "ops");
  const [{ biz }, search] = await Promise.all([params, searchParams]);

  let businesses, products;
  try {
    [businesses, products] = await Promise.all([
      listBusinesses(),
      listProducts(biz).then(
        (r) => r.data,
        () => [],
      ),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Checkout report" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const business = businesses.data.find((b) => b.id === biz) ?? null;
  const tz = business?.timezone ?? null;
  const win = resolveHostedWindow(one(search.range) || DEFAULT_HOSTED_RANGE, tz);
  const compare = one(search.compare) !== "off";
  // Every product a checkout link sells: plans, addons, one-time charges and credit packs.
  const sold = products.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name }));
  const product = sold.some((p) => p.id === one(search.product)) ? one(search.product) : "";
  const linkParam = one(search.link);
  const countryParam = /^[A-Za-z]{2}$/.test(one(search.country))
    ? one(search.country).toUpperCase()
    : "";
  const deviceParam = ["desktop", "mobile", "tablet"].includes(one(search.device))
    ? one(search.device)
    : "";

  let r;
  try {
    r = await getCheckoutReport(biz, {
      start: win.start,
      end: win.end,
      compare,
      ...(product ? { product } : {}),
      ...(linkParam ? { paymentLink: linkParam } : {}),
      ...(countryParam ? { country: countryParam } : {}),
      ...(deviceParam ? { device: deviceParam } : {}),
    });
  } catch (e) {
    return (
      <>
        <PageHeader
          title="Checkout report"
          breadcrumbs={reportCrumbs(biz, business?.name, "Checkout")}
        />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const ccy = r.currency;
  const t = r.totals;
  const p = r.previous;
  const versus = `vs ${spanLabel(r.previous_start, r.previous_end, tz)}`;
  const csvHref = (() => {
    const qs = new URLSearchParams({ start: r.start, end: r.end });
    if (product) qs.set("product", product);
    if (linkParam) qs.set("link", linkParam);
    if (countryParam) qs.set("country", countryParam);
    if (deviceParam) qs.set("device", deviceParam);
    return `/businesses/${biz}/reports/checkout/csv?${qs}`;
  })();

  const funnel = r.funnel;
  const exits = funnel.slice(1).map((s, i) => ({
    label: s.label,
    left: Math.max(0, funnel[i]!.sessions - s.sessions),
  }));
  const topFailure = r.failures.reasons[0];
  const tracking = r.tracking;
  const trackNote = collectingNote(tracking.since, r.start, tz);

  return (
    <NavPendingProvider>
      <PageHeader
        title="Checkout report"
        description="How buyers move through your checkout links, how they pay, and what reminders recover."
        breadcrumbs={reportCrumbs(biz, business?.name, "Checkout")}
        actions={
          <Button asChild variant="outline" size="sm">
            <a href={csvHref} download>
              <Download className="size-4" aria-hidden />
              Export
            </a>
          </Button>
        }
      />
      <Stack>
        <ZoneHeading zone="performance">
          <ReportFilters
            range={win.rangeId}
            compare={compare}
            filters={[
              {
                param: "link",
                ariaLabel: "Checkout link",
                value: linkParam,
                options: [
                  { value: "", label: "All checkout links" },
                  ...r.options.payment_links.map((l) => ({ value: l.id, label: l.name })),
                ],
              },
              {
                param: "product",
                ariaLabel: "Product",
                value: product,
                options: [
                  { value: "", label: "All products" },
                  ...sold.map((x) => ({ value: x.id, label: x.name })),
                ],
              },
              ...trackingFilters(r.options, { country: countryParam, device: deviceParam }),
            ]}
          />
          <ZoneMeta>
            {spanLabel(r.start, r.end, tz)} ·{" "}
            {business?.livemode === "test" ? "Test mode" : "Live mode"}
          </ZoneMeta>
        </ZoneHeading>
        <PendingContent skeleton={<HostedReportSkeleton label="checkout report" />}>
          <div className="flex flex-col gap-4">
            <LiveStrip
              active={`${count(r.live.active_now)} in checkout`}
              recent={`${count(r.live.opened_last_30_minutes)} opened in the last 30 minutes`}
              perMinute={r.live.per_minute}
              label="Checkouts opened per minute"
            />

            <Grid className="gap-4">
              <Headline
                span={3}
                label="Checkouts opened"
                value={count(t.opened)}
                change={changeOf(t.opened, p?.opened, "up", versus)}
                spark={r.series.opened}
              />
              <Headline
                span={3}
                label="Conversion rate"
                value={rate(t.conversion_bps)}
                note="Completed ÷ opened"
                change={changeOf(t.conversion_bps, p?.conversion_bps, "up", versus)}
                spark={r.series.conversion_bps}
              />
              <Headline
                span={3}
                label="Completed checkouts"
                value={count(t.completed)}
                change={changeOf(t.completed, p?.completed, "up", versus)}
                spark={r.series.completed}
              />
              <Headline
                span={3}
                label="Revenue"
                value={money(t.revenue_minor, ccy)}
                change={changeOf(t.revenue_minor, p?.revenue_minor, "up", versus)}
                spark={r.series.revenue_minor}
              />
              <Headline
                span={3}
                label="Average order value"
                value={t.aov_minor == null ? "—" : money(t.aov_minor, ccy)}
                note="Revenue ÷ completed"
                change={changeOf(t.aov_minor, p?.aov_minor, "up", versus)}
                spark={r.series.aov_minor}
              />
              <Headline
                span={3}
                label="Abandoned"
                value={count(t.abandoned)}
                note="Left after they entered their details"
                change={changeOf(t.abandoned, p?.abandoned, "down", versus)}
                spark={r.series.abandoned}
              />
              <Headline
                span={3}
                label="Recovered by reminders"
                value={count(t.recovered)}
                note={`${money(t.recovered_revenue_minor, ccy)} revenue`}
                change={changeOf(t.recovered, p?.recovered, "up", versus)}
                spark={r.series.recovered}
              />
              <Headline
                span={3}
                label="Median time to complete"
                value={fmtDuration(t.median_complete_seconds)}
                change={changeOf(
                  t.median_complete_seconds,
                  p?.median_complete_seconds,
                  "down",
                  versus,
                )}
                spark={r.series.median_complete_seconds}
              />
            </Grid>

            <RecordCard
              title="Checkout funnel"
              meta="Closed funnel: a checkout counts at a step when it reached that step or a later one"
              flush
              footer={
                <span className="text-xs text-muted-foreground">
                  Most exits:{" "}
                  {exits.map((e) => `${e.label.toLowerCase()} ${count(e.left)}`).join(" · ")}
                  {topFailure
                    ? `. Most common payment failure: ${topFailure.reason} (${count(topFailure.sessions)}).`
                    : "."}
                </span>
              }
            >
              <FunnelTable unit="Checkouts" steps={funnel} timing />
            </RecordCard>

            <RecordCard
              title="Checkouts opened and completed"
              meta={`Per day, ${spanLabel(r.start, r.end, tz)}`}
            >
              <BucketBars
                labels={r.days.map((d) => d.label)}
                values={r.series.opened}
                markers={r.series.completed}
                markerLabel="Completed"
                notes={
                  r.previous_series
                    ? r.previous_series.completed.map(
                        (n) => `Completed, previous period: ${count(n)}`,
                      )
                    : undefined
                }
                seriesLabel="Opened"
                tone="brand"
                kind="count"
                height={240}
                barMaxWidth={r.days.length <= 16 ? 32 : 18}
                empty={
                  <p className="text-sm text-muted-foreground">No checkouts in this period.</p>
                }
              />
            </RecordCard>

            <WhereBuyersCome tracking={tracking} currency={ccy} note={trackNote} />

            <RecordCard title="By checkout link" meta="Sorted by revenue" flush>
              <Table phone="stack">
                <TableHeader>
                  <TableRow>
                    <TableHead phone="title">Checkout link</TableHead>
                    <TableHead className="text-right">Opened</TableHead>
                    <TableHead className="text-right">Completed</TableHead>
                    <TableHead className="text-right">Conversion</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">Average order</TableHead>
                    <TableHead className="text-right">Median time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.links.map((l) => (
                    <TableRow key={l.payment_link ?? "none"}>
                      <TableCell>{l.name ?? "Checkouts made by the API"}</TableCell>
                      <TableCell className="text-right">{count(l.opened)}</TableCell>
                      <TableCell className="text-right">{count(l.completed)}</TableCell>
                      <TableCell className="text-right">{rate(l.conversion_bps)}</TableCell>
                      <TableCell className="text-right">{money(l.revenue_minor, ccy)}</TableCell>
                      <TableCell className="text-right">
                        {l.aov_minor == null ? "—" : money(l.aov_minor, ccy)}
                      </TableCell>
                      <TableCell className="text-right">
                        {fmtDuration(l.median_complete_seconds)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {r.links.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-muted-foreground">
                        No checkouts in this period.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
                {r.links.length > 1 ? (
                  <TableFooter>
                    <TableRow>
                      <TableCell>All links</TableCell>
                      <TableCell className="text-right">{count(t.opened)}</TableCell>
                      <TableCell className="text-right">{count(t.completed)}</TableCell>
                      <TableCell className="text-right">{rate(t.conversion_bps)}</TableCell>
                      <TableCell className="text-right">{money(t.revenue_minor, ccy)}</TableCell>
                      <TableCell className="text-right">
                        {t.aov_minor == null ? "—" : money(t.aov_minor, ccy)}
                      </TableCell>
                      <TableCell className="text-right">
                        {fmtDuration(t.median_complete_seconds)}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                ) : null}
              </Table>
            </RecordCard>

            <Row span="6/6">
              <RecordCard
                title="Payment methods"
                meta={`${count(t.completed)} completed checkouts`}
                flush
                footer={
                  <span className="text-xs text-muted-foreground">
                    The method and gateway of the payment on each checkout&apos;s first invoice. No
                    payment: a trial, a free plan or a balance paid the invoice.
                  </span>
                }
              >
                <Table phone="stack">
                  <TableHeader>
                    <TableRow>
                      <TableHead phone="title">Method</TableHead>
                      <TableHead>Gateway</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.payment_methods.map((m) => (
                      <TableRow key={`${m.method}:${m.gateway ?? ""}`}>
                        <TableCell>{methodLabel(m.method)}</TableCell>
                        <TableCell>{gatewayLabel(m.gateway)}</TableCell>
                        <TableCell className="text-right">
                          {count(m.paid)}{" "}
                          <span className="text-muted-foreground">
                            {rate(
                              t.completed > 0 ? Math.round((m.paid / t.completed) * 10_000) : null,
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">{money(m.revenue_minor, ccy)}</TableCell>
                      </TableRow>
                    ))}
                    {r.payment_methods.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="text-muted-foreground">
                          No completed checkouts in this period.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </RecordCard>
              <RecordCard
                title="Payment failures"
                meta={`${count(r.failures.failed_attempts)} of ${count(r.failures.attempts)} attempts failed`}
                footer={
                  r.failures.sessions_with_failure > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {`${count(r.failures.paid_after_failure)} of ${count(r.failures.sessions_with_failure)} checkouts with a failure paid in the same checkout (${rate(Math.round((r.failures.paid_after_failure / r.failures.sessions_with_failure) * 10_000))}). Reasons are the newest refusal of each checkout, from the gateway.`}
                    </span>
                  ) : undefined
                }
              >
                {r.failures.reasons.length > 0 ? (
                  <BarList
                    rows={[
                      ...r.failures.reasons.map((x) => ({
                        key: x.reason,
                        label: x.reason === "unknown" ? "No reason recorded" : x.reason,
                        total: x.sessions,
                      })),
                      ...(r.failures.other_sessions > 0
                        ? [
                            {
                              key: "__other",
                              label: "Other reasons",
                              total: r.failures.other_sessions,
                            },
                          ]
                        : []),
                    ]}
                    format={count}
                    fill="bg-chart-4"
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">No payment failed in this period.</p>
                )}
              </RecordCard>
            </Row>

            <Row span="6/6">
              <RecordCard
                title="Abandoned and recovered"
                meta="Reminders count checkouts made in this period"
                footer={
                  <span className="text-xs text-muted-foreground">
                    Abandoned: a buyer entered their details and has not paid for an hour. Recovered
                    checkouts are part of the completed checkouts.
                  </span>
                }
              >
                <dl className="grid grid-cols-2 gap-4 text-sm">
                  {[
                    ["Abandoned", count(t.abandoned)],
                    ["Reminder emails sent", count(r.recovery.reminders_sent)],
                    ["Recovered", count(r.recovery.recovered)],
                    ["Recovered revenue", money(r.recovery.recovered_revenue_minor, ccy)],
                  ].map(([k, v]) => (
                    <div key={k} className="flex flex-col gap-0.5">
                      <dt className="text-xs text-muted-foreground">{k}</dt>
                      <dd className="text-lg font-medium tabular-nums">{v}</dd>
                    </div>
                  ))}
                </dl>
                <h3 className="mt-5 mb-2 text-sm font-medium">Recovered after each reminder</h3>
                <BarList
                  share={false}
                  rows={r.recovery.by_reminder.map((x) => ({
                    key: String(x.reminder),
                    label:
                      x.reminder === 1 ? "1st reminder, 1 hour after" : "2nd reminder, 1 day after",
                    total: x.recovered,
                  }))}
                  format={count}
                />
                {r.recovery.recovered === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No checkout completed after a reminder in this period.
                  </p>
                ) : null}
              </RecordCard>
              <RecordCard
                title="Coupons"
                meta={`${count(r.coupons.completed_with_coupon)} paid with a coupon`}
                flush
                footer={
                  <span className="text-xs text-muted-foreground">
                    With a coupon: {count(r.coupons.completed_with_coupon)} completed of{" "}
                    {count(r.coupons.sessions_with_coupon)} (
                    {rate(r.coupons.conversion_with_coupon_bps)}). Without:{" "}
                    {count(r.coupons.completed_without_coupon)} of{" "}
                    {count(r.coupons.sessions_without_coupon)} (
                    {rate(r.coupons.conversion_without_coupon_bps)}). Discount given:{" "}
                    {money(r.coupons.discount_minor, ccy)}.
                  </span>
                }
              >
                <Table phone="stack">
                  <TableHeader>
                    <TableRow>
                      <TableHead phone="title">Code</TableHead>
                      <TableHead className="text-right">Checkouts</TableHead>
                      <TableHead className="text-right">Completed</TableHead>
                      <TableHead className="text-right">Conversion</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.coupons.codes.map((c) => (
                      <TableRow key={c.code}>
                        <TableCell className="font-mono text-xs">{c.code}</TableCell>
                        <TableCell className="text-right">{count(c.sessions)}</TableCell>
                        <TableCell className="text-right">{count(c.completed)}</TableCell>
                        <TableCell className="text-right">
                          {rate(
                            c.sessions > 0 ? Math.round((c.completed / c.sessions) * 10_000) : null,
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {r.coupons.codes.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="text-muted-foreground">
                          No checkout used a coupon in this period.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </RecordCard>
            </Row>

            <Row span="6/6">
              <RecordCard
                title="Billing country"
                meta="Completed checkouts"
                flush
                footer={
                  <span className="text-xs text-muted-foreground">
                    Paid checkouts use the billing country. Conversion uses every tracked visitor
                    from that country.{trackNote ? ` ${trackNote}` : ""}
                  </span>
                }
              >
                {r.countries.length > 0 ? (
                  <Table phone="stack">
                    <TableHeader>
                      <TableRow>
                        <TableHead phone="title">Country</TableHead>
                        <TableHead className="text-right">Paid</TableHead>
                        <TableHead className="text-right">Visitor conversion</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {r.countries.slice(0, 8).map((c) => (
                        <TableRow key={c.country}>
                          <TableCell>
                            {c.country === "unknown" ? "No country" : regionName(c.country)}
                          </TableCell>
                          <TableCell className="text-right">{count(c.completed)}</TableCell>
                          <TableCell className="text-right">
                            {rate(visitorConversion(tracking, c.country))}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="px-5 py-4 text-sm text-muted-foreground">
                    No completed checkouts in this period.
                  </p>
                )}
              </RecordCard>
              <RecordCard
                title="Time to complete"
                meta={`From opened to paid · median ${fmtDuration(t.median_complete_seconds)}`}
              >
                {t.completed > 0 ? (
                  <BarList
                    rows={r.time_to_complete.map((b) => ({
                      key: b.band,
                      label: b.label,
                      total: b.completed,
                    }))}
                    format={count}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No completed checkouts in this period.
                  </p>
                )}
              </RecordCard>
            </Row>

            <Row span="6/6">
              <CheckoutDevices tracking={tracking} note={trackNote} />
              <CheckoutBrowsers tracking={tracking} note={trackNote} />
            </Row>
            <CheckoutStepTime tracking={tracking} note={trackNote} />

            {r.missing_rates.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Amounts in {r.missing_rates.join(", ")} have no exchange rate to {ccy}, so the {ccy}{" "}
                figures above do not include them.
              </p>
            ) : null}
          </div>
        </PendingContent>
      </Stack>
    </NavPendingProvider>
  );
}
