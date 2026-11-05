import Link from "next/link";
import { listBusinesses, listProducts } from "@/lib/api";
import { listOfferedReasons } from "@/lib/api/reason-codes";
import { getCancellationAnalytics } from "@/lib/api/cancellation-analytics";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { Block, Grid, Stack } from "@/components/analytics/layout";
import { RecordCard, Row } from "@/components/patterns/record-page";
import { ZoneHeading, ZoneMeta } from "@/components/analytics/home/zone";
import { Alert } from "@/components/ui/alert";
import { EmptyState, ErrorState } from "@/components/states";
import { CancellationFilters } from "@/components/reports/cancellations/cancellation-filters";
import { CANCELLATION_INTERVALS, NO_REASON_LABEL } from "@/components/reports/cancellations/cuts";
import {
  DEFAULT_RANGE,
  previousWindow,
  spanLabel,
  resolveCancellationWindow,
  windowLabel,
} from "@/components/reports/cancellations/window";
import {
  CAUSE_LABELS,
  FLUSH_TABLE,
  InsightTable,
  KindBars,
  LargestLosses,
  MrrLostTrend,
  Tile,
  changeBps,
} from "@/components/reports/cancellations/insights";
import { CancellationsSkeleton } from "@/components/reports/cancellations/skeletons";
import { NavPendingProvider, PendingContent } from "@/components/navigation/nav-pending";
import { money, moneyCompact, pctFromBps } from "@/lib/format";
import { G } from "@/components/analytics/glossary";

export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

const KIND_LABELS = {
  paying: "Paying customers",
  trial_not_converted: "Trials that did not convert",
  no_mrr: "No MRR at cancellation",
} as const;

/**
 * Cancellations — what they cost, why, and who left.
 *
 * A cancellation is classified by what it cost, from the ledger's churn movements: most are
 * trials that never paid, and counting them beside paying customers buries the losses that
 * matter. Everything below the "what left" split is about paying cancellations only.
 */
export default async function CancellationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("reports:view", "ops");
  const [{ biz }, search] = await Promise.all([params, searchParams]);

  const range = one(search.range) || DEFAULT_RANGE;
  const planParam = one(search.plan);
  // A hand-typed value is DROPPED rather than forwarded: an unrecognised one would narrow
  // the figures while the picker renders blank.
  const interval = CANCELLATION_INTERVALS.some((i) => i.value === one(search.interval))
    ? one(search.interval)
    : "";

  let businesses, offered, products;
  try {
    [businesses, offered, products] = await Promise.all([
      listBusinesses(),
      listOfferedReasons(biz, "subscription_cancellation"),
      listProducts(biz).then(
        (r) => r.data,
        () => [],
      ),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Cancellations" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const business = businesses.data.find((b) => b.id === biz) ?? null;
  const win = resolveCancellationWindow(
    range,
    business?.timezone,
    new Date(),
    business?.fiscal_year_start_month ?? 1,
  );
  const plans = products
    .filter((p) => (p.kind ?? "plan") === "plan" && p.active)
    .map((p) => ({ id: p.id, name: p.name }));
  const plan = plans.some((p) => p.id === planParam) ? planParam : "";
  const cuts = { ...(plan ? { plan } : {}), ...(interval ? { interval } : {}) };

  const prev = previousWindow(win);
  let now, before;
  try {
    [now, before] = await Promise.all([
      getCancellationAnalytics(biz, {
        start: win.start,
        end: win.end,
        buckets: win.buckets,
        ...cuts,
      }),
      getCancellationAnalytics(biz, { ...prev, ...cuts }),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Cancellations" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const ccy = now.currency;
  const labels = new Map(offered.data.map((r) => [r.code, r.label]));
  const reasonLabel = (code: string | null) =>
    code == null ? NO_REASON_LABEL : (labels.get(code) ?? code);
  const paying = now.totals.paying;
  const inv = now.causes.filter((c) => c.involuntary);
  const invLost = inv.reduce((a, c) => a + c.mrr_lost_minor, 0);
  const trials = now.kinds.find((k) => k.kind === "trial_not_converted")?.count ?? 0;
  const trialsBefore = before.kinds.find((k) => k.kind === "trial_not_converted")?.count ?? 0;
  // Nothing to compare against is said plainly, never left as a bare comparison.
  const prevLabel = spanLabel(prev.start, prev.end);
  const versus = (prior: number) => (prior > 0 ? `vs ${prevLabel}` : `none in ${prevLabel}`);
  // An imported free-text reason can read exactly like an offered code's label ("Other"): one row.
  const reasonRows = [
    ...now.reasons
      .reduce((m, r) => {
        const label = reasonLabel(r.reason);
        const row = m.get(label) ?? { key: r.reason ?? "", label, count: 0, mrr_lost_minor: 0 };
        row.count += r.count;
        row.mrr_lost_minor += r.mrr_lost_minor;
        return m.set(label, row);
      }, new Map<string, { key: string; label: string; count: number; mrr_lost_minor: number }>())
      .values(),
  ].sort((a, b) => b.mrr_lost_minor - a.mrr_lost_minor || b.count - a.count);
  const withReason = now.reasons.filter((r) => r.reason != null).reduce((a, r) => a + r.count, 0);

  const listHref = (() => {
    const sp = new URLSearchParams();
    sp.append("filter", "status:is:cancelled");
    sp.append("filter", `canceled_at:between:${win.start},${win.end}`);
    if (plan) sp.append("filter", `plan:is:${plan}`);
    if (interval) sp.append("filter", `billing_period_unit:is:${interval}`);
    return `/businesses/${biz}/subscriptions?${sp.toString()}`;
  })();

  const header = (
    <PageHeader
      title="Cancellations"
      description="What cancellations cost, why customers left, and how long they stayed."
      breadcrumbs={[{ label: "Reports", href: `/businesses/${biz}/reports` }]}
    />
  );
  // The period heading carries the filters, as Home's Performance zone carries its picker.
  const zone = (
    <ZoneHeading zone="performance">
      <CancellationFilters range={win.rangeId} plan={plan} interval={interval} plans={plans} />
      <ZoneMeta>{windowLabel(win)}</ZoneMeta>
    </ZoneHeading>
  );

  if (now.totals.count === 0) {
    return (
      <NavPendingProvider>
        {header}
        <Stack>
          {zone}
          <PendingContent skeleton={<CancellationsSkeleton />}>
            <Grid>
              <Block span={12}>
                <EmptyState
                  title="No cancellations in this window"
                  description="Make the period wider, or clear the plan and interval filters."
                />
              </Block>
            </Grid>
          </PendingContent>
        </Stack>
      </NavPendingProvider>
    );
  }

  return (
    <NavPendingProvider>
      {header}

      <Stack>
        {zone}
        <PendingContent skeleton={<CancellationsSkeleton />}>
          <div className="flex flex-col gap-4">
            <Grid className="gap-4">
              <Tile
                span={3}
                label="MRR lost"
                info={G.cancelMrrLost}
                value={moneyCompact(now.totals.mrr_lost_minor, ccy)}
                change={changeBps(now.totals.mrr_lost_minor, before.totals.mrr_lost_minor)}
                note={versus(before.totals.mrr_lost_minor)}
              />
              <Tile
                span={3}
                label="Paying cancellations"
                info={G.payingCancellations}
                value={paying.toLocaleString("en")}
                change={changeBps(paying, before.totals.paying)}
                note={versus(before.totals.paying)}
              />
              <Tile
                span={3}
                label="Involuntary share"
                info={G.involuntaryShare}
                value={
                  now.totals.mrr_lost_minor > 0
                    ? pctFromBps(Math.round((invLost / now.totals.mrr_lost_minor) * 10_000), 1)
                    : "—"
                }
                note={`${now.totals.involuntary.toLocaleString("en")} lost to payment, not choice`}
              />
              <Tile
                span={3}
                label="Trials not converted"
                info={G.trialsNotConverted}
                value={trials.toLocaleString("en")}
                change={changeBps(trials, trialsBefore)}
                note="never paid, no MRR lost"
              />
            </Grid>

            <Row span="8/4">
              <RecordCard
                title={win.grain === "month" ? "MRR lost by month" : "MRR lost by week"}
                meta={`${paying.toLocaleString("en")} paying ${paying === 1 ? "cancellation" : "cancellations"}`}
              >
                <MrrLostTrend
                  currency={ccy}
                  bars={win.buckets.map((b, i) => ({
                    key: b.key,
                    label: b.label,
                    start: b.start,
                    end: b.end,
                    lost: now.buckets[i]?.mrr_lost_minor ?? 0,
                    involuntary: now.buckets[i]?.involuntary_mrr_lost_minor ?? 0,
                    paying: now.buckets[i]?.paying ?? 0,
                  }))}
                />
              </RecordCard>
              {/* Not stretched to the chart's height: the footer stays under the bars. */}
              <div className="min-w-0 xl:self-start">
                <RecordCard
                  title="What left"
                  meta={`${now.totals.count.toLocaleString("en")} ${now.totals.count === 1 ? "cancellation" : "cancellations"}`}
                  actions={
                    <Link href={listHref} className="text-primary hover:underline">
                      View all {now.totals.count.toLocaleString("en")}
                    </Link>
                  }
                  footer={
                    paying > 0 ? (
                      <span className="text-xs text-muted-foreground">
                        This section shows only paying cancellations.
                      </span>
                    ) : undefined
                  }
                >
                  <KindBars
                    rows={now.kinds.map((k) => ({
                      key: k.kind,
                      label: KIND_LABELS[k.kind],
                      count: k.count,
                    }))}
                  />
                </RecordCard>
              </div>
            </Row>

            {paying > 0 ? (
              <>
                <Row span="6/6">
                  <RecordCard title="Why paying customers left" meta="by cause" flush>
                    <div className={FLUSH_TABLE}>
                      <InsightTable
                        compact
                        groupLabel="Cause"
                        currency={ccy}
                        rows={now.causes.map((c) => ({
                          key: c.cause,
                          label: CAUSE_LABELS[c.cause],
                          count: c.count,
                          mrr_lost_minor: c.mrr_lost_minor,
                        }))}
                      />
                    </div>
                  </RecordCard>
                  <RecordCard title="How long they stayed" meta="by tenure" flush>
                    <div className={FLUSH_TABLE}>
                      <InsightTable
                        compact
                        groupLabel="Tenure"
                        currency={ccy}
                        rows={now.tenure
                          .filter((t) => t.count > 0)
                          .map((t) => ({
                            key: t.band,
                            label: t.label,
                            count: t.count,
                            mrr_lost_minor: t.mrr_lost_minor,
                          }))}
                      />
                    </div>
                  </RecordCard>
                </Row>

                <Row span="12">
                  <RecordCard
                    title="Reasons given"
                    meta={`${withReason.toLocaleString("en")} of ${paying.toLocaleString("en")} paying ${paying === 1 ? "cancellation carries" : "cancellations carry"} a reason`}
                    flush
                    footer={
                      <span className="text-xs text-muted-foreground">
                        We store a reason when a person selects one in the cancellation dialog or
                        sends it as{" "}
                        <code className="rounded-md bg-muted px-1.5 py-px font-mono text-xs">
                          cancel_reason_code
                        </code>{" "}
                        on the API.
                      </span>
                    }
                  >
                    {offered.is_fallback ? (
                      <Alert tone="info" className="rounded-none border-0 border-b px-5 py-2.5">
                        {/* The link drops under the text on phones rather than squeezing it. */}
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                          <span className="min-w-0">
                            <strong className="font-semibold">
                              Reasons are not configured yet.
                            </strong>{" "}
                            The cancellation dialog offers the built-in list.
                          </span>
                          <Link
                            href={`/businesses/${biz}/settings/reason-codes`}
                            className="whitespace-nowrap sm:ml-auto"
                          >
                            Define your own reasons
                          </Link>
                        </div>
                      </Alert>
                    ) : null}
                    <div className={FLUSH_TABLE}>
                      <InsightTable groupLabel="Reason" currency={ccy} rows={reasonRows} />
                    </div>
                  </RecordCard>
                </Row>

                <Row span="12">
                  <RecordCard
                    title="Largest losses"
                    meta={`top ${now.top_losses.length.toLocaleString("en")} of ${paying.toLocaleString("en")}`}
                    flush
                  >
                    <div className={FLUSH_TABLE}>
                      <LargestLosses
                        biz={biz}
                        rows={now.top_losses}
                        currency={ccy}
                        timezone={now.timezone}
                        reasonLabel={reasonLabel}
                      />
                    </div>
                  </RecordCard>
                </Row>
              </>
            ) : null}

            {now.totals.unconverted > 0 ? (
              <p className="text-xs text-muted-foreground">
                {now.totals.unconverted.toLocaleString("en")} paying{" "}
                {now.totals.unconverted === 1 ? "cancellation is" : "cancellations are"} in a
                currency with no exchange rate to {ccy}, so the {ccy} totals above do not include{" "}
                {now.totals.unconverted === 1 ? "its loss" : "their losses"}.
              </p>
            ) : null}
            {Object.keys(now.totals.mrr_lost_by_currency).length > 1 ? (
              <p className="text-xs text-muted-foreground">
                MRR lost by currency:{" "}
                {Object.entries(now.totals.mrr_lost_by_currency)
                  .map(([c, v]) => money(v, c))
                  .join(" · ")}
                . Totals are in {ccy}. We convert each loss at the rate of its cancellation day.
              </p>
            ) : null}
          </div>
        </PendingContent>
      </Stack>
    </NavPendingProvider>
  );
}
