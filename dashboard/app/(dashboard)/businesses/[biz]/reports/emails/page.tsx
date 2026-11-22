import Link from "next/link";
import { Download } from "lucide-react";
import { reportCrumbs } from "@/lib/report-crumbs";
import { listBusinesses } from "@/lib/api";
import { getEmailReport, type EmailCounts, type EmailStatus } from "@/lib/api/email-report";
import { emailTypeLabel, transportLabel, type EmailTransport } from "@/lib/email-types";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/patterns/chip";
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
  rate,
} from "@/components/reports/hosted/parts";
import { money } from "@/lib/format";
import { fmtDate, fmtDateTime } from "@/lib/format-date";

export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** The type's label; a type with no label (an older one) reads as words, not as a key. */
function typeLabel(type: string): string {
  const label = emailTypeLabel(type);
  if (label !== type) return label;
  const words = type.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const STATUS_LABELS: Record<EmailStatus, string> = {
  delivered: "Delivered",
  not_sent: "Not sent to a mail server",
  pending: "Waiting",
  failed: "Failed",
  bounced: "Bounced",
  complained: "Complaint",
  skipped: "Skipped",
};
const STATUS_TONES: Record<EmailStatus, "green" | "tan" | "red" | "gray"> = {
  delivered: "green",
  not_sent: "gray",
  pending: "tan",
  failed: "red",
  bounced: "red",
  complained: "red",
  skipped: "gray",
};
const OUTCOME_LABELS = { failed: "Failed", bounced: "Bounced", complained: "Complaint" } as const;

const transportName = (t: string) =>
  t === "unknown" ? "Not recorded" : transportLabel(t as EmailTransport);

/**
 * The email report: how billing emails are delivered, why some fail, and what customers do
 * after the ones that carry a portal link. Opens and clicks come from emails sent with tracking
 * on; a business with it off, or a period before it began, shows a dash and a note, not 0%.
 *
 * Section order: live strip → scorecards → funnel and trend → by email type → failures and
 * transports → recipient domains and the failed-payment sequence → skipped → recent emails.
 */
export default async function EmailReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("reports:view", "ops");
  const [{ biz }, search] = await Promise.all([params, searchParams]);

  let businesses;
  try {
    businesses = await listBusinesses();
  } catch (e) {
    return (
      <>
        <PageHeader title="Email report" />
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
  const typeParam = /^[a-z_]{1,64}$/.test(one(search.type)) ? one(search.type) : "";
  const transportParam = /^[a-z_]{1,32}$/.test(one(search.transport)) ? one(search.transport) : "";

  let r;
  try {
    r = await getEmailReport(biz, {
      start: win.start,
      end: win.end,
      compare,
      ...(typeParam ? { type: typeParam } : {}),
      ...(transportParam ? { transport: transportParam } : {}),
    });
  } catch (e) {
    return (
      <>
        <PageHeader
          title="Email report"
          breadcrumbs={reportCrumbs(biz, business?.name, "Emails")}
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
  const emails = `/businesses/${biz}/emails`;
  const logHref = (type: string) => `${emails}?filter=type:in:${type}`;
  const csvHref = (() => {
    const qs = new URLSearchParams({ start: r.start, end: r.end });
    if (typeParam) qs.set("type", typeParam);
    if (transportParam) qs.set("transport", transportParam);
    return `/businesses/${biz}/reports/emails/csv?${qs}`;
  })();
  const trk = r.tracking;
  const trackedSince = trk.since ? fmtDate(trk.since, tz) : null;
  // Why a rate may be missing or partial: never a 0% that tracking did not measure.
  const trackNote =
    !trk.enabled && t.tracked === 0
      ? "Tracking is off. Turn it on in the email settings."
      : !trackedSince
        ? "Tracking starts with the next email"
        : !trk.covers_period
          ? `Tracking opens and clicks since ${trackedSince}`
          : null;
  const engaged = (c: { tracked: number }, v: number | null) => (c.tracked > 0 ? v : null);
  const portalNote = transportParam ? "Not shown when you filter by transport" : undefined;
  const lastStep = r.dunning.steps.length;
  const dunningLabel = (n: number) => (n === lastStep ? `Number ${n} and later` : `Number ${n}`);
  const countCells = (c: EmailCounts) => (
    <>
      <TableCell className="text-right">{count(c.queued)}</TableCell>
      <TableCell className="text-right">{count(c.delivered)}</TableCell>
      <TableCell className="text-right">{rate(c.delivered_bps)}</TableCell>
      <TableCell className="text-right">{count(c.bounced)}</TableCell>
      <TableCell className="text-right">{count(c.complained)}</TableCell>
      <TableCell className="text-right">{count(c.failed)}</TableCell>
    </>
  );
  const countHeads = (
    <>
      <TableHead className="text-right">Queued</TableHead>
      <TableHead className="text-right">Delivered</TableHead>
      <TableHead className="text-right">Delivered rate</TableHead>
      <TableHead className="text-right">Bounced</TableHead>
      <TableHead className="text-right">Complaints</TableHead>
      <TableHead className="text-right">Failed</TableHead>
    </>
  );

  return (
    <NavPendingProvider>
      <PageHeader
        title="Email report"
        description="How your billing emails are delivered, why some fail, and what customers do after the ones that carry a portal link."
        breadcrumbs={reportCrumbs(biz, business?.name, "Emails")}
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
                param: "type",
                ariaLabel: "Email type",
                value: typeParam,
                options: [
                  { value: "", label: "All email types" },
                  ...[...new Set([...r.options.types, ...(typeParam ? [typeParam] : [])])].map(
                    (x) => ({ value: x, label: typeLabel(x) }),
                  ),
                ],
              },
              {
                param: "transport",
                ariaLabel: "Transport",
                value: transportParam,
                options: [
                  { value: "", label: "All transports" },
                  ...[
                    ...new Set([
                      ...r.options.transports,
                      ...(transportParam ? [transportParam] : []),
                    ]),
                  ].map((x) => ({ value: x, label: transportName(x) })),
                ],
              },
            ]}
          />
          <ZoneMeta>{spanLabel(r.start, r.end, tz)}</ZoneMeta>
        </ZoneHeading>
        <PendingContent skeleton={<HostedReportSkeleton label="email report" />}>
          <div className="flex flex-col gap-4">
            <LiveStrip
              active={`${count(r.live.waiting)} waiting to be sent`}
              recent={`${count(r.live.queued_last_30_minutes)} queued in the last 30 minutes`}
              perMinute={r.live.per_minute}
              label="Emails queued per minute"
            />

            <Grid className="gap-4">
              <Headline
                span={3}
                label="Emails queued"
                value={count(t.queued)}
                note={`${count(t.delivered)} delivered to a mail server`}
                change={changeOf(t.queued, p?.queued, "up", versus)}
                spark={r.series.queued}
              />
              <Headline
                span={3}
                label="Delivered rate"
                value={rate(t.delivered_bps)}
                note={`${count(t.delivered)} of ${count(t.attempted)} that reached an outcome`}
                change={changeOf(t.delivered_bps, p?.delivered_bps, "up", versus)}
                spark={r.series.delivered_bps}
              />
              <Headline
                span={3}
                label="Open rate"
                value={t.tracked > 0 ? rate(t.open_bps) : "—"}
                note={
                  t.tracked > 0
                    ? `${count(t.opened)} of ${count(t.tracked)} delivered. ${count(t.machine_opened)} more by mail privacy proxies or scanners.${trackNote ? ` ${trackNote}.` : ""}`
                    : (trackNote ?? "No tracked email in this period")
                }
                change={changeOf(
                  engaged(t, t.open_bps),
                  p ? engaged(p, p.open_bps) : undefined,
                  "up",
                  versus,
                )}
                spark={t.tracked > 0 ? r.series.open_bps : undefined}
              />
              <Headline
                span={3}
                label="Click rate"
                value={t.tracked > 0 ? rate(t.click_bps) : "—"}
                note={
                  t.tracked > 0
                    ? `${count(t.clicked)} of ${count(t.tracked)} delivered. Clicks by scanners are left out.`
                    : (trackNote ?? "No tracked email in this period")
                }
                change={changeOf(
                  engaged(t, t.click_bps),
                  p ? engaged(p, p.click_bps) : undefined,
                  "up",
                  versus,
                )}
                spark={t.tracked > 0 ? r.series.click_bps : undefined}
              />
              <Headline
                span={3}
                label="Bounce rate"
                value={rate(t.bounce_bps)}
                note={`${count(t.bounced)} bounced`}
                change={changeOf(t.bounce_bps, p?.bounce_bps, "down", versus)}
                spark={r.series.bounce_bps}
              />
              <Headline
                span={3}
                label="Complaint rate"
                value={rate(t.complaint_bps)}
                note={`${count(t.complained)} marked as spam`}
                change={changeOf(t.complaint_bps, p?.complaint_bps, "down", versus)}
                spark={r.series.complaint_bps}
              />
              <Headline
                span={3}
                label="Failed"
                value={count(t.failed)}
                note="Out of retries"
                change={changeOf(t.failed, p?.failed, "down", versus)}
                spark={r.series.failed}
              />
              <Headline
                span={3}
                label="Skipped"
                value={count(t.skipped)}
                note="Not sent, with a reason"
                change={changeOf(t.skipped, p?.skipped, "down", versus)}
                spark={r.series.skipped}
              />
              <Headline
                span={3}
                label="Portal visits from emails"
                value={t.link_visits == null ? "—" : count(t.link_visits)}
                note={portalNote ?? "Customers who opened a portal link from an email"}
                change={changeOf(t.link_visits, p?.link_visits, "up", versus)}
                spark={r.series.link_visits ?? undefined}
              />
              <Headline
                span={3}
                label="Recovered by failed-payment emails"
                value={t.recovered_minor == null ? "—" : money(t.recovered_minor, ccy)}
                note={portalNote ?? "Same figure as the portal report"}
                change={changeOf(t.recovered_minor, p?.recovered_minor, "up", versus)}
                spark={r.series.recovered_minor ?? undefined}
              />
            </Grid>

            <Row span="6/6">
              <RecordCard
                title="From queue to payment"
                meta="Emails queued in this period"
                flush
                footer={
                  <span className="text-xs text-muted-foreground">
                    The last step counts invoices paid within {r.dunning.hold_days} days after a
                    delivered email that asked for payment. Opened and clicked count emails sent
                    with tracking on, by people only. The portal link step counts only links that
                    led to a portal visit.
                  </span>
                }
              >
                <FunnelTable unit="Emails" steps={r.funnel} />
              </RecordCard>
              <RecordCard title="Emails per day" meta="Queued, with the share that did not arrive">
                <BucketBars
                  labels={r.days.map((d) => d.label)}
                  values={r.series.queued}
                  part={{ label: "Failed, bounced or complaint", values: r.series.problems }}
                  notes={
                    r.previous_series
                      ? r.previous_series.queued.map((n) => `Queued, previous period: ${count(n)}`)
                      : undefined
                  }
                  seriesLabel="Queued"
                  tone="brand"
                  kind="count"
                  height={220}
                  barMaxWidth={r.days.length <= 16 ? 32 : 18}
                  empty={
                    <p className="text-sm text-muted-foreground">
                      We queued no email in this period.
                    </p>
                  }
                />
              </RecordCard>
            </Row>

            <RecordCard
              title="By email type"
              meta="Each type queued in this period"
              flush
              footer={
                <span className="text-xs text-muted-foreground">
                  Open and click rates cover delivered emails sent with tracking on. Portal visits
                  count customers who arrived from a link in this type of email. Paid counts
                  invoices paid after an email that asked for payment.
                </span>
              }
            >
              <Table phone="stack">
                <TableHeader>
                  <TableRow>
                    <TableHead phone="title">Email</TableHead>
                    {countHeads}
                    <TableHead className="text-right">Opened</TableHead>
                    <TableHead className="text-right">Open rate</TableHead>
                    <TableHead className="text-right">Clicked</TableHead>
                    <TableHead className="text-right">Click rate</TableHead>
                    <TableHead className="text-right">Portal visits</TableHead>
                    <TableHead className="text-right">Paid afterwards</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.by_type.map((x) => (
                    <TableRow key={x.type}>
                      <TableCell>
                        <Link href={logHref(x.type)} className="text-primary hover:underline">
                          {typeLabel(x.type)}
                        </Link>
                      </TableCell>
                      {countCells(x)}
                      <TableCell className="text-right">
                        {x.tracked > 0 ? count(x.opened) : "—"}
                      </TableCell>
                      <TableCell className="text-right">{rate(engaged(x, x.open_bps))}</TableCell>
                      <TableCell className="text-right">
                        {x.tracked > 0 ? count(x.clicked) : "—"}
                      </TableCell>
                      <TableCell className="text-right">{rate(engaged(x, x.click_bps))}</TableCell>
                      <TableCell className="text-right">
                        {x.link_visits == null ? "—" : count(x.link_visits)}
                      </TableCell>
                      <TableCell className="text-right">{count(x.paid_after)}</TableCell>
                    </TableRow>
                  ))}
                  {r.by_type.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={13} className="text-muted-foreground">
                        We queued no email in this period.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </RecordCard>

            <RecordCard
              title="Most-clicked links"
              meta="Clicks by people on emails queued in this period"
              flush
              footer={
                <span className="text-xs text-muted-foreground">
                  The path shows plain words only. We hide ids and tokens, and we never keep the
                  query string.
                </span>
              }
            >
              <Table phone="stack">
                <TableHeader>
                  <TableRow>
                    <TableHead phone="title">Link</TableHead>
                    <TableHead className="text-right">Clicks</TableHead>
                    <TableHead className="text-right">Emails</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.top_links.map((l, i) => (
                    <TableRow key={`${l.label}-${l.host}-${l.path}-${i}`}>
                      <TableCell>
                        {l.label ?? `${l.host ?? ""}${l.path ?? ""}`}
                        {l.label && l.host ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {l.host}
                            {l.path}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">{count(l.clicks)}</TableCell>
                      <TableCell className="text-right">{count(l.emails)}</TableCell>
                    </TableRow>
                  ))}
                  {r.top_links.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="text-muted-foreground">
                        {trackNote ?? "People clicked no tracked link in this period."}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </RecordCard>

            <Row span="6/6">
              <RecordCard
                title="Why emails did not arrive"
                meta="Responses stored for failed, bounced and complained emails"
                footer={
                  <span className="text-xs text-muted-foreground">
                    Addresses are removed from the responses.
                  </span>
                }
              >
                {r.reasons.length > 0 ? (
                  <BarList
                    share={false}
                    rows={r.reasons.map((x, i) => ({
                      key: `${x.outcome}-${i}`,
                      label: `${OUTCOME_LABELS[x.outcome]}: ${x.reason ?? "No response stored"}`,
                      total: x.count,
                    }))}
                    format={count}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No email failed or bounced in this period.
                  </p>
                )}
              </RecordCard>
              <RecordCard title="By transport" meta="How the emails were sent" flush>
                <Table phone="stack">
                  <TableHeader>
                    <TableRow>
                      <TableHead phone="title">Transport</TableHead>
                      {countHeads}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.by_transport.map((x) => (
                      <TableRow key={x.transport}>
                        <TableCell>{transportName(x.transport)}</TableCell>
                        {countCells(x)}
                      </TableRow>
                    ))}
                    {r.by_transport.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-muted-foreground">
                          We queued no email in this period.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </RecordCard>
            </Row>

            <Row span="6/6">
              <RecordCard
                title="Recipient domains"
                meta="The ten busiest. Domain only, never the address."
                flush
              >
                <Table phone="stack">
                  <TableHeader>
                    <TableRow>
                      <TableHead phone="title">Domain</TableHead>
                      <TableHead className="text-right">Delivered</TableHead>
                      <TableHead className="text-right">Bounced</TableHead>
                      <TableHead className="text-right">Failed</TableHead>
                      <TableHead className="text-right">Bounce rate</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.by_domain.map((x) => (
                      <TableRow key={x.domain}>
                        <TableCell>{x.domain}</TableCell>
                        <TableCell className="text-right">{count(x.delivered)}</TableCell>
                        <TableCell className="text-right">{count(x.bounced)}</TableCell>
                        <TableCell className="text-right">{count(x.failed)}</TableCell>
                        <TableCell className="text-right">{rate(x.bounce_bps)}</TableCell>
                      </TableRow>
                    ))}
                    {r.by_domain.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="text-muted-foreground">
                          No email reached a mail server in this period.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </RecordCard>
              <RecordCard
                title="Failed-payment emails in order"
                meta="Payment failed, needs approval and action needed, in the order each invoice got them"
                flush
                footer={
                  <span className="text-xs text-muted-foreground">
                    Paid afterwards: the customer paid the invoice within {r.dunning.hold_days} days
                    and before the next email of the sequence.
                  </span>
                }
              >
                <Table phone="stack">
                  <TableHeader>
                    <TableRow>
                      <TableHead phone="title">Email</TableHead>
                      <TableHead className="text-right">Sent</TableHead>
                      <TableHead className="text-right">Paid afterwards</TableHead>
                      <TableHead className="text-right">Share paid</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.dunning.steps.map((s) => (
                      <TableRow key={s.position}>
                        <TableCell>{dunningLabel(s.position)}</TableCell>
                        <TableCell className="text-right">{count(s.sent)}</TableCell>
                        <TableCell className="text-right">{count(s.recovered)}</TableCell>
                        <TableCell className="text-right">
                          {rate(s.sent > 0 ? Math.round((s.recovered * 10_000) / s.sent) : null)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </RecordCard>
            </Row>

            <RecordCard title="Skipped emails" meta="The reason stored on each email">
              {r.skipped_reasons.length > 0 ? (
                <BarList
                  share={false}
                  rows={r.skipped_reasons.map((x, i) => ({
                    key: `skip-${i}`,
                    label: x.reason ?? "No reason stored",
                    total: x.count,
                  }))}
                  format={count}
                />
              ) : (
                <p className="text-sm text-muted-foreground">We skipped no email in this period.</p>
              )}
            </RecordCard>

            <RecordCard title="Recent emails" meta="Newest first" flush>
              <Table phone="stack">
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead phone="title">Customer</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Opened</TableHead>
                    <TableHead>Clicked</TableHead>
                    <TableHead className="text-right">Outcome</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.recent.map((e) => (
                    <TableRow key={e.email}>
                      <TableCell className="whitespace-nowrap">{fmtDateTime(e.at, tz)}</TableCell>
                      <TableCell>
                        {e.customer ? (
                          <Link
                            href={`/businesses/${biz}/customers/${e.customer}`}
                            className="text-primary hover:underline"
                          >
                            {e.customer_name ?? e.customer}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>{typeLabel(e.type)}</TableCell>
                      <TableCell>
                        <Chip tone={STATUS_TONES[e.status]} className="text-xs">
                          {STATUS_LABELS[e.status]}
                        </Chip>
                      </TableCell>
                      <TableCell>{e.opened == null ? "—" : e.opened ? "Yes" : "No"}</TableCell>
                      <TableCell>{e.clicked == null ? "—" : e.clicked ? "Yes" : "No"}</TableCell>
                      <TableCell className="text-right">
                        {e.paid_after
                          ? "Invoice paid afterwards"
                          : e.portal_opened
                            ? "Portal link opened"
                            : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                  {r.recent.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-muted-foreground">
                        We queued no email in this period.
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
