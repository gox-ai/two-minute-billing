import * as React from "react";
import { getReport, listBusinesses, type AnalyticsRange } from "@/lib/api";
import { listRetries } from "@/lib/api/retries";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { EmptyState, ErrorState } from "@/components/states";
import { CurrencyPicker } from "@/components/analytics/home/currency-picker";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AttentionCard, RecordCard, Row } from "@/components/patterns/record-page";
import { Block, BlockLink, Grid, Stack } from "@/components/analytics/layout";
import { ZoneHeading, ZoneMeta } from "@/components/analytics/home/zone";
import {
  breakdownLinks,
  coverageLabel,
  type ReportPayload,
} from "@/components/reports/report-format";
import { RecoveryRangePicker } from "@/components/reports/recovery/recovery-range-picker";
import {
  RECOVERY_RANGES,
  DEFAULT_RECOVERY_RANGE,
} from "@/components/reports/recovery/recovery-ranges";
import { RecoveryFigure } from "@/components/reports/recovery/recovery-figure";
import { G } from "@/components/analytics/glossary";
import {
  ByOutcomeCard,
  DunningOutcomesCard,
  TABLE_EDGE,
} from "@/components/reports/recovery/outcome-cards";
import {
  ActiveRecoveries,
  ActiveRecoveriesNote,
  type Ladder,
} from "@/components/reports/recovery/active-recoveries";
import {
  DUNNING_FALLBACK_RETRY_DAYS,
  outcomeLabel,
  OUTCOME_FILLS,
  recoveryTotals,
} from "@/components/reports/recovery/dunning-outcomes";
import { money } from "@/lib/format";
import { RotateCcw } from "lucide-react";
import {
  RecoveryCurrentSkeleton,
  RecoveryPerformanceSkeleton,
} from "@/components/reports/recovery/skeletons";
import { NavPendingProvider, PendingContent } from "@/components/navigation/nav-pending";

export const dynamic = "force-dynamic";

/** How many active recoveries the summary shows before handing off to /retries. */
const ACTIVE_ROWS = 8;

/**
 * Recovery — what failed to collect, what dunning got back, and what it is still working.
 *
 * Three questions, and they are NOT measured the same way, which is the whole reason this
 * page is laid out in three blocks instead of one strip of tiles:
 *
 *  · the PERIOD block is two flows over the selected window — a count of refused charges
 *    and an amount recovered. They are different units and no ratio is drawn between them,
 *    because "dollars per declined attempt" is not a recovery rate.
 *  · the LIFETIME block is `dunning_status_summary`, which carries `asOf: "computed_at"`
 *    (`modules/metrics/daily/measures.ts`). It describes the instant the writer ran and has
 *    NO history: an earlier period is unknown, not zero. So it is stated as an instant and
 *    never drawn as a trend — a twelve-month line of it would be invented history.
 *  · the ACTIVE block is the live campaign state, straight off the retry rows.
 *
 * The recovery rate lives with the lifetime block for the same reason: its denominator is
 * every invoice the campaign has ever taken in, which is exactly the population the
 * as-of-now summary enumerates, and no windowed measure can produce one honestly.
 */
export default async function RecoveryReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ range?: string; currency?: string }>;
}) {
  const { biz } = await params;
  const { range: rangeParam, currency } = await searchParams;
  await requirePermission("reports:view", "ops");

  const range: AnalyticsRange = (RECOVERY_RANGES as string[]).includes(rangeParam ?? "")
    ? (rangeParam as AnalyticsRange)
    : DEFAULT_RECOVERY_RANGE;

  let businesses;
  try {
    businesses = await listBusinesses();
  } catch (e) {
    return (
      <>
        <PageHeader
          title="Recovery"
          breadcrumbs={[{ label: "Reports", href: `/businesses/${biz}/reports` }]}
        />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const business = businesses.data.find((b) => b.id === biz) ?? null;
  const tz = business?.timezone ?? null;
  const baseCurrency = business?.default_currency ?? "USD";
  const currencies = business?.currencies ?? [];

  // Each answer is caught on its own: one report key failing should narrow the page, not
  // replace it. A block with no answer says so rather than rendering a zero.
  const [outcomes, recovered, failed, retries] = await Promise.all([
    getReport(biz, "dunning_status_summary", { currency }).catch(
      () => null,
    ) as Promise<ReportPayload | null>,
    getReport(biz, "total_amount_recovered", { range, currency }).catch(
      () => null,
    ) as Promise<ReportPayload | null>,
    getReport(biz, "total_failed_payment_transactions", { range, currency }).catch(
      () => null,
    ) as Promise<ReportPayload | null>,
    listRetries(biz, { limit: ACTIVE_ROWS, state: "attention" }).catch(() => null),
  ]);

  const totals = recoveryTotals(outcomes?.rows);
  const ladder = resolveLadder(business);

  const outcomeRows = outcomes?.rows
    ? breakdownLinks(outcomes.rows, null, biz, outcomes).map((r) => ({
        ...r,
        group: outcomeLabel(r.group),
      }))
    : [];

  const outcomeParts = OUTCOME_FILLS.map((o) => ({
    ...o,
    value: outcomes?.rows?.find((r) => r.group === o.key)?.value ?? 0,
  })).filter((p) => p.value > 0);

  // Everything the retry queue holds, not just the rows fetched for the table.
  const underRetry = retries ? (retries.total ?? retries.data.length) : 0;

  const periodLabel = recovered ? coverageLabel(recovered) : null;

  return (
    <NavPendingProvider>
      <PageHeader
        title="Recovery"
        description="Refused charges, the money that dunning recovered, and the campaigns that still run."
        breadcrumbs={[{ label: "Reports", href: `/businesses/${biz}/reports` }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CurrencyPicker
              value={currency ?? "ALL"}
              baseCurrency={baseCurrency}
              available={currencies}
            />
          </div>
        }
      />

      <Stack>
        {/* A period change cannot move this zone, so it stays standing through one. */}
        <PendingContent keepFor={["range"]} skeleton={<RecoveryCurrentSkeleton />}>
          <Stack>
            {underRetry > 0 ? (
              <AttentionCard
                items={[
                  {
                    key: "retries",
                    tone: "warning",
                    title: `${underRetry.toLocaleString("en")} invoice${underRetry === 1 ? " is" : "s are"} under retry`,
                    actions: (
                      <>
                        <Button asChild variant="outline" size="sm">
                          <a href="#active">View them below</a>
                        </Button>
                        <Button asChild size="sm">
                          <Link href={`/businesses/${biz}/retries`}>All retries</Link>
                        </Button>
                      </>
                    ),
                  },
                ]}
              />
            ) : null}

            <ZoneHeading zone="current">
              <ZoneMeta>
                every invoice that entered dunning · the period does not change it
              </ZoneMeta>
            </ZoneHeading>

            {!outcomes ? (
              <Alert tone="warning">We could not load the collections outcome summary.</Alert>
            ) : totals.everEntered === 0 ? (
              <Grid>
                <Block span={12}>
                  <EmptyState
                    icon={<RotateCcw />}
                    title="No invoice has entered collections"
                    description="No invoice entered a dunning campaign yet. So we cannot calculate a recovery rate."
                  />
                </Block>
              </Grid>
            ) : (
              <Row span="8/4">
                <DunningOutcomesCard biz={biz} totals={totals} parts={outcomeParts} />
                <ByOutcomeCard rows={outcomeRows} />
              </Row>
            )}

            <RecordCard
              id="active"
              title="Active recoveries"
              meta={
                retries && retries.data.length > 0
                  ? retries.data.length < underRetry
                    ? `showing ${retries.data.length} of ${underRetry.toLocaleString("en")} needing attention`
                    : `${underRetry.toLocaleString("en")} needing attention`
                  : undefined
              }
              actions={<BlockLink href={`/businesses/${biz}/retries`}>All retries</BlockLink>}
              flush
              footer={
                retries && retries.data.length > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    <ActiveRecoveriesNote ladder={ladder} />
                  </span>
                ) : undefined
              }
            >
              {!retries ? (
                <div className="px-5 py-4">
                  <Alert tone="warning">We could not load the retry list.</Alert>
                </div>
              ) : (
                <div className={TABLE_EDGE}>
                  <ActiveRecoveries biz={biz} rows={retries.data} ladder={ladder} tz={tz} />
                </div>
              )}
            </RecordCard>
          </Stack>
        </PendingContent>

        {/* Performance: two flows over the chosen window, in different units, so no rate is
              drawn between them. */}
        <ZoneHeading zone="performance">
          <RecoveryRangePicker value={range} />
          {periodLabel ? <ZoneMeta>{periodLabel}</ZoneMeta> : null}
        </ZoneHeading>

        <PendingContent skeleton={<RecoveryPerformanceSkeleton />}>
          <Stack>
            <Grid>
              <RecoveryFigure
                span={6}
                label="Failed charges"
                value={failed?.headline != null ? failed.headline.toLocaleString("en") : "—"}
                note={
                  failed
                    ? "Payment attempts the gateway refused in this window, counted per transaction."
                    : "We could not load this figure."
                }
                info={G.failedCharges}
              />
              <RecoveryFigure
                span={6}
                label="Amount recovered"
                value={
                  recovered?.headline != null ? money(recovered.headline, recovered.currency) : "—"
                }
                note={
                  recovered
                    ? "Invoices that entered collections and were then paid."
                    : "We could not load this figure."
                }
                info={G.amountRecovered}
              />
            </Grid>
            <p className="-mt-3 text-xs text-muted-foreground">
              We do not show a rate between these two figures. A count of refused attempts and an
              amount of money have no shared denominator. The recovery rate above is measured
              against invoices.
            </p>
          </Stack>
        </PendingContent>
      </Stack>
    </NavPendingProvider>
  );
}

/**
 * The retry ladder this business actually runs.
 *
 * `dunning_config.retries` supersedes the legacy `dunning_retry_days`, and neither being
 * set means the engine's fallback applies. Resolved rather than defaulted, so the "attempt
 * N of M" column counts against the schedule that will really run.
 */
function resolveLadder(
  business: { dunning_config?: unknown; dunning_retry_days?: unknown } | null,
): Ladder {
  const cfg = (business?.dunning_config ?? null) as {
    retries?: Array<{ after_days: number }>;
    final_action?: { invoice?: string };
  } | null;
  const structured = cfg?.retries?.map((r) => r.after_days);
  const legacy = Array.isArray(business?.dunning_retry_days)
    ? (business.dunning_retry_days as number[])
    : null;
  const days = structured?.length ? structured : legacy?.length ? legacy : null;
  return {
    days: days ?? DUNNING_FALLBACK_RETRY_DAYS,
    isDefault: days == null,
    finalInvoiceAction: cfg?.final_action?.invoice ?? null,
  };
}
