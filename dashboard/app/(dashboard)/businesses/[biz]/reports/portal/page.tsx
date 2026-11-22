import Link from "next/link";
import { reportCrumbs } from "@/lib/report-crumbs";
import { listBusinesses, listProducts } from "@/lib/api";
import { listOfferedReasons } from "@/lib/api/reason-codes";
import { getPortalReport, type PortalActionKey } from "@/lib/api/hosted-page-reports";
import { getBillingModels } from "@/lib/api/billing-models";
import { hasModel } from "@/lib/billing-models";
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
  DELETE_REASON_LABELS,
  FunnelTable,
  HostedReportSkeleton,
  LiveStrip,
  OFFER_LABELS,
  arrivalLabel,
  changeOf,
  count,
  methodLabel,
  rate,
} from "@/components/reports/hosted/parts";
import {
  PortalCountries,
  PortalDevices,
  PortalSections,
  collectingNote,
  trackingFilters,
} from "@/components/reports/hosted/tracking";
import { emailTypeLabel } from "@/lib/email-types";
import { money } from "@/lib/format";
import { fmtDateTime } from "@/lib/format-date";
import { Download } from "lucide-react";

export const dynamic = "force-dynamic";

const SUBSCRIPTION_ACTIONS = new Set<PortalActionKey>(["changed_plan", "paused", "cancelled"]);

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * The portal report: how customers arrive at the customer portal, what they do there, the
 * money it collects and the customers the cancel flow keeps. Every figure is from data we
 * store today.
 *
 * Section order: live strip → scorecards → arrivals → funnel → trend → actions and payments →
 * payment methods → plan changes and retention → sections viewed → countries and devices →
 * recent visits. The visit cards, PDF downloads and the Country and Device filters read
 * first-party tracking (`storefront-analytics`).
 */
export default async function PortalReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("reports:view", "ops");
  const [{ biz }, search] = await Promise.all([params, searchParams]);

  let businesses, products, offered, models;
  try {
    [businesses, products, offered, models] = await Promise.all([
      listBusinesses(),
      listProducts(biz).then(
        (r) => r.data,
        () => [],
      ),
      listOfferedReasons(biz, "subscription_cancellation").then(
        (r) => r.data,
        () => [],
      ),
      getBillingModels(biz),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Portal report" />
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
  // The cancel flow and plan changes are for subscriptions only.
  const hasSubs = hasModel(models, "subscriptions");
  const plans = products
    .filter((p) => (p.kind ?? "plan") === "plan" && p.active)
    .map((p) => ({ id: p.id, name: p.name }));
  const plan = plans.some((p) => p.id === one(search.plan)) ? one(search.plan) : "";
  const arrived = /^[a-z_]{1,64}$/.test(one(search.arrived)) ? one(search.arrived) : "";
  const countryParam = /^[A-Za-z]{2}$/.test(one(search.country))
    ? one(search.country).toUpperCase()
    : "";
  const deviceParam = ["desktop", "mobile", "tablet"].includes(one(search.device))
    ? one(search.device)
    : "";

  let r;
  try {
    r = await getPortalReport(biz, {
      start: win.start,
      end: win.end,
      compare,
      ...(plan ? { plan } : {}),
      ...(arrived ? { arrivedFrom: arrived } : {}),
      ...(countryParam ? { country: countryParam } : {}),
      ...(deviceParam ? { device: deviceParam } : {}),
    });
  } catch (e) {
    return (
      <>
        <PageHeader
          title="Portal report"
          breadcrumbs={reportCrumbs(biz, business?.name, "Portal")}
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
  const arrival = (k: string) => arrivalLabel(k, emailTypeLabel);
  const reasonLabels = new Map(offered.map((x) => [x.code, x.label]));
  const reasonLabel = (code: string | null) =>
    code == null ? "No reason given" : (reasonLabels.get(code) ?? code);
  const actionLabel = new Map(r.actions.map((a) => [a.action, a.label]));
  const csvHref = (() => {
    const qs = new URLSearchParams({ start: r.start, end: r.end });
    if (plan) qs.set("plan", plan);
    if (arrived) qs.set("arrived", arrived);
    if (countryParam) qs.set("country", countryParam);
    if (deviceParam) qs.set("device", deviceParam);
    return `/businesses/${biz}/reports/portal/csv?${qs}`;
  })();
  const ret = r.retention;
  const tracking = r.tracking;
  const trackNote = collectingNote(tracking.since, r.start, tz);
  // "Downloaded an invoice PDF" comes from visit tracking; it sits after "Paid an invoice".
  const actionRows = r.actions
    .filter((a) => hasSubs || !SUBSCRIPTION_ACTIONS.has(a.action))
    .flatMap((a) => {
      const row = { key: a.action as string, label: a.label, total: a.count };
      return a.action === "paid_invoice"
        ? [row, { key: "pdf", label: "Downloaded an invoice PDF", total: tracking.pdf_downloads }]
        : [row];
    });
  const paidTotal = r.payments.methods.reduce(
    (a, m) => ({
      paid: a.paid + m.paid,
      amount: a.amount + m.amount_minor,
      failed: a.failed + m.failed,
    }),
    { paid: 0, amount: 0, failed: 0 },
  );
  const outcome = (v: (typeof r.recent)[number]): string => {
    if (v.paid_minor > 0) return `Paid ${money(v.paid_minor, ccy)}`;
    const first = v.actions[0] as PortalActionKey | undefined;
    return first ? (actionLabel.get(first) ?? first) : "No action";
  };

  return (
    <NavPendingProvider>
      <PageHeader
        title="Portal report"
        description={`How customers arrive at your portal, what they do there${hasSubs ? ", what they pay and who the cancel flow keeps" : " and what they pay"}.`}
        breadcrumbs={reportCrumbs(biz, business?.name, "Portal")}
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
                param: "arrived",
                ariaLabel: "Arrived from",
                value: arrived,
                options: [
                  { value: "", label: "All arrivals" },
                  ...[...new Set([...r.options.arrivals, ...(arrived ? [arrived] : [])])].map(
                    (a) => ({ value: a, label: arrival(a) }),
                  ),
                ],
              },
              {
                param: "plan",
                ariaLabel: "Plan",
                value: plan,
                options: [
                  { value: "", label: "All plans" },
                  ...plans.map((x) => ({ value: x.id, label: x.name })),
                ],
              },
              ...trackingFilters(r.options, { country: countryParam, device: deviceParam }),
            ]}
          />
          <ZoneMeta>{spanLabel(r.start, r.end, tz)}</ZoneMeta>
        </ZoneHeading>
        <PendingContent skeleton={<HostedReportSkeleton label="portal report" />}>
          <div className="flex flex-col gap-4">
            <LiveStrip
              active={`${count(r.live.active_now)} in the portal`}
              recent={`${count(r.live.visits_last_30_minutes)} visits in the last 30 minutes`}
              perMinute={r.live.per_minute}
              label="Visits per minute"
            />

            <Grid className="gap-4">
              <Headline
                span={3}
                label="Portal visits"
                value={count(t.visits)}
                change={changeOf(t.visits, p?.visits, "up", versus)}
                spark={r.series.visits}
              />
              <Headline
                span={3}
                label="Customers"
                value={count(t.customers)}
                note="Customers who visited"
                change={changeOf(t.customers, p?.customers, "up", versus)}
                spark={r.series.customers}
              />
              <Headline
                span={3}
                label="Visits with an action"
                value={rate(t.action_rate_bps)}
                note={`${count(t.visits_with_action)} of ${count(t.visits)} visits`}
                change={changeOf(t.action_rate_bps, p?.action_rate_bps, "up", versus)}
                spark={r.series.action_rate_bps}
              />
              <Headline
                span={3}
                label="Paid in the portal"
                value={money(t.paid_minor, ccy)}
                note={`${count(t.invoices_paid)} ${t.invoices_paid === 1 ? "invoice" : "invoices"}`}
                change={changeOf(t.paid_minor, p?.paid_minor, "up", versus)}
                spark={r.series.paid_minor}
              />
              <Headline
                span={3}
                label="Recovered from failed-payment emails"
                value={money(t.recovered_from_failed_emails_minor, ccy)}
                change={changeOf(
                  t.recovered_from_failed_emails_minor,
                  p?.recovered_from_failed_emails_minor,
                  "up",
                  versus,
                )}
                spark={r.series.recovered_from_failed_emails_minor}
              />
              <Headline
                span={3}
                label="Payment methods added"
                value={count(t.methods_added)}
                change={changeOf(t.methods_added, p?.methods_added, "up", versus)}
                spark={r.series.methods_added}
              />
              {hasSubs ? (
                <>
                  <Headline
                    span={3}
                    label="Cancellations"
                    value={count(t.cancellations)}
                    note="Through the portal cancel flow"
                    change={changeOf(t.cancellations, p?.cancellations, "down", versus)}
                    spark={r.series.cancellations}
                  />
                  <Headline
                    span={3}
                    label="Save rate"
                    value={rate(t.save_rate_bps)}
                    note={`${count(ret.saved)} saved of ${count(ret.saved + ret.lost)}`}
                    change={changeOf(t.save_rate_bps, p?.save_rate_bps, "up", versus)}
                  />
                </>
              ) : null}
            </Grid>

            <RecordCard
              title="How customers arrive"
              meta="How each portal link was made"
              flush
              footer={
                <span className="text-xs text-muted-foreground">
                  An email link carries the type of the email that sent it. A customer can arrive in
                  more than one way, so the customer rows can add up to more than the total.
                </span>
              }
            >
              <Table phone="stack">
                <TableHeader>
                  <TableRow>
                    <TableHead phone="title">Arrived from</TableHead>
                    <TableHead className="text-right">Visits</TableHead>
                    <TableHead className="text-right">Customers</TableHead>
                    <TableHead className="text-right">Visits with an action</TableHead>
                    <TableHead className="text-right">Action rate</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.arrivals.map((a) => (
                    <TableRow key={a.arrival}>
                      <TableCell>{arrival(a.arrival)}</TableCell>
                      <TableCell className="text-right">{count(a.visits)}</TableCell>
                      <TableCell className="text-right">{count(a.customers)}</TableCell>
                      <TableCell className="text-right">{count(a.visits_with_action)}</TableCell>
                      <TableCell className="text-right">{rate(a.action_rate_bps)}</TableCell>
                      <TableCell className="text-right">
                        {a.paid_minor > 0 ? money(a.paid_minor, ccy) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                  {r.arrivals.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-muted-foreground">
                        No portal visits in this period.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
                {r.arrivals.length > 1 ? (
                  <TableFooter>
                    <TableRow>
                      <TableCell>All</TableCell>
                      <TableCell className="text-right">{count(t.visits)}</TableCell>
                      <TableCell className="text-right">{count(t.customers)}</TableCell>
                      <TableCell className="text-right">{count(t.visits_with_action)}</TableCell>
                      <TableCell className="text-right">{rate(t.action_rate_bps)}</TableCell>
                      <TableCell className="text-right">{money(t.paid_minor, ccy)}</TableCell>
                    </TableRow>
                  </TableFooter>
                ) : null}
              </Table>
            </RecordCard>

            <Row span="6/6">
              <RecordCard
                title="From link to action"
                meta="Portal links made in this period"
                flush
                footer={
                  <span className="text-xs text-muted-foreground">
                    Every email that has a portal button makes a link, so most links are never
                    opened.
                  </span>
                }
              >
                <FunnelTable unit="Links" steps={r.funnel} />
              </RecordCard>
              <RecordCard title="Visits and visits with an action" meta="Per day">
                <BucketBars
                  labels={r.days.map((d) => d.label)}
                  values={r.series.visits}
                  markers={r.series.visits_with_action}
                  markerLabel="With an action"
                  notes={
                    r.previous_series
                      ? r.previous_series.visits_with_action.map(
                          (n) => `With an action, previous period: ${count(n)}`,
                        )
                      : undefined
                  }
                  seriesLabel="Visits"
                  tone="brand"
                  kind="count"
                  height={220}
                  barMaxWidth={r.days.length <= 16 ? 32 : 18}
                  empty={
                    <p className="text-sm text-muted-foreground">
                      No portal visits in this period.
                    </p>
                  }
                />
              </RecordCard>
            </Row>

            <Row span="6/6">
              <RecordCard
                title="What customers do"
                meta="Completed actions. One visit can have more than one."
              >
                {actionRows.some((a) => a.total > 0) ? (
                  <BarList share={false} rows={actionRows} format={count} />
                ) : (
                  <p className="text-sm text-muted-foreground">No actions in this period.</p>
                )}
                {trackNote ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Invoice PDF downloads: {trackNote}
                  </p>
                ) : null}
              </RecordCard>
              <RecordCard
                title="Payments in the portal"
                meta={`${count(paidTotal.paid)} paid · saved method ${count(r.payments.saved_method)} · new method ${count(r.payments.new_method)}`}
                flush
              >
                <Table phone="stack">
                  <TableHeader>
                    <TableRow>
                      <TableHead phone="title">Method</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Failed</TableHead>
                      <TableHead className="text-right">Success rate</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.payments.methods.map((m) => (
                      <TableRow key={m.method}>
                        <TableCell>{methodLabel(m.method)}</TableCell>
                        <TableCell className="text-right">{count(m.paid)}</TableCell>
                        <TableCell className="text-right">{money(m.amount_minor, ccy)}</TableCell>
                        <TableCell className="text-right">{count(m.failed)}</TableCell>
                        <TableCell className="text-right">{rate(m.success_rate_bps)}</TableCell>
                      </TableRow>
                    ))}
                    {r.payments.methods.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="text-muted-foreground">
                          No payments in the portal in this period.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                  {r.payments.methods.length > 1 ? (
                    <TableFooter>
                      <TableRow>
                        <TableCell>All methods</TableCell>
                        <TableCell className="text-right">{count(paidTotal.paid)}</TableCell>
                        <TableCell className="text-right">{money(paidTotal.amount, ccy)}</TableCell>
                        <TableCell className="text-right">{count(paidTotal.failed)}</TableCell>
                        <TableCell className="text-right">
                          {rate(
                            paidTotal.paid + paidTotal.failed > 0
                              ? Math.round(
                                  (paidTotal.paid / (paidTotal.paid + paidTotal.failed)) * 10_000,
                                )
                              : null,
                          )}
                        </TableCell>
                      </TableRow>
                    </TableFooter>
                  ) : null}
                </Table>
              </RecordCard>
            </Row>

            <Row span={hasSubs ? "6/6" : "12"}>
              <RecordCard
                title="Payment methods"
                meta={`${count(r.payment_methods.added)} added · ${count(r.payment_methods.deleted)} deleted · ${count(r.payment_methods.made_primary)} made primary`}
                footer={
                  <span className="text-xs text-muted-foreground">
                    We ask why when you turn it on in{" "}
                    <Link
                      href={`/businesses/${biz}/settings/portal`}
                      className="text-primary hover:underline"
                    >
                      Settings, Customer portal
                    </Link>
                    .
                  </span>
                }
              >
                <h3 className="mb-2 text-sm font-medium">Why customers delete a method</h3>
                {r.payment_methods.delete_reasons.length > 0 ? (
                  <BarList
                    rows={r.payment_methods.delete_reasons.map((d) => ({
                      key: d.reason,
                      label: DELETE_REASON_LABELS[d.reason] ?? d.reason,
                      total: d.count,
                    }))}
                    format={count}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">No method deleted in this period.</p>
                )}
              </RecordCard>
              {hasSubs ? (
                <RecordCard
                  title="Plan changes and cancellations"
                  meta={`${count(r.plan_changes.changed_plan)} plan changes · ${count(r.plan_changes.paused)} pauses · ${count(r.plan_changes.cancelled)} cancellations`}
                  footer={
                    <span className="text-xs text-muted-foreground">
                      Saved: the customer took an offer and did not cancel in the {ret.hold_days}{" "}
                      days after it.
                    </span>
                  }
                >
                  <h3 className="mb-2 text-sm font-medium">Cancel flow</h3>
                  <FunnelTable
                    unit="Customers"
                    steps={[
                      { label: "Started to cancel", sessions: ret.started },
                      { label: "Saw an offer", sessions: ret.saw_offer },
                      { label: "Took an offer", sessions: ret.accepted },
                      { label: "Saved", sessions: ret.saved },
                    ]}
                  />
                  {ret.offers.length > 0 ? (
                    <>
                      <h3 className="mt-5 mb-2 text-sm font-medium">Offers taken</h3>
                      <BarList
                        share={false}
                        rows={ret.offers.map((o) => ({
                          key: o.offer,
                          label: `${OFFER_LABELS[o.offer] ?? o.offer} (${count(o.saved)} saved)`,
                          total: o.accepted,
                        }))}
                        format={count}
                      />
                    </>
                  ) : null}
                </RecordCard>
              ) : null}
            </Row>

            {hasSubs ? (
              <RecordCard
                title="Cancellation reasons"
                meta={`${count(ret.started)} who started to cancel`}
                flush
              >
                <Table phone="stack">
                  <TableHeader>
                    <TableRow>
                      <TableHead phone="title">Reason</TableHead>
                      <TableHead className="text-right">Started to cancel</TableHead>
                      <TableHead className="text-right">Saved</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ret.reasons.map((x) => (
                      <TableRow key={x.reason ?? "none"}>
                        <TableCell>{reasonLabel(x.reason)}</TableCell>
                        <TableCell className="text-right">{count(x.started)}</TableCell>
                        <TableCell className="text-right">{count(x.saved)}</TableCell>
                      </TableRow>
                    ))}
                    {ret.reasons.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="text-muted-foreground">
                          No customer started to cancel in this period.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </RecordCard>
            ) : null}

            <PortalSections tracking={tracking} note={trackNote} />
            <Row span="6/6">
              <PortalCountries tracking={tracking} note={trackNote} />
              <PortalDevices tracking={tracking} note={trackNote} />
            </Row>

            <RecordCard title="Recent portal visits" meta="Newest first" flush>
              <Table phone="stack">
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead phone="title">Customer</TableHead>
                    <TableHead>Arrived from</TableHead>
                    <TableHead>Actions</TableHead>
                    <TableHead className="text-right">Outcome</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.recent.map((v) => (
                    <TableRow key={v.session}>
                      <TableCell className="whitespace-nowrap">{fmtDateTime(v.at, tz)}</TableCell>
                      <TableCell>
                        <Link
                          href={`/businesses/${biz}/customers/${v.customer}`}
                          className="text-primary hover:underline"
                        >
                          {v.customer_name ?? v.customer}
                        </Link>
                      </TableCell>
                      <TableCell>{arrival(v.arrival)}</TableCell>
                      <TableCell>
                        {v.actions.length > 0
                          ? v.actions.map((a) => actionLabel.get(a) ?? a).join(", ")
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">{outcome(v)}</TableCell>
                    </TableRow>
                  ))}
                  {r.recent.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground">
                        No portal visits in this period.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </RecordCard>

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
