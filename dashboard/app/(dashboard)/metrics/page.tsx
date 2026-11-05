import { NavPendingProvider, PendingContent } from "@/components/navigation/nav-pending";
import {
  OrgMetricsSkeleton,
  PortfolioCurrentSkeleton,
  PortfolioPerformanceSkeleton,
} from "@/components/analytics/org/skeletons";
import { measurePolarity } from "@/components/analytics/series-format";
import {
  listMeasures,
  queryAnalytics,
  AnalyticsRefused,
  type AnalyticsMeasure,
  type AnalyticsQuery,
  type BatchEntry,
  type Grain,
  getSyncedAt,
} from "@/lib/analytics-api";
import { listBusinesses } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { SyncedBadge } from "@/components/analytics/synced-badge";
import { PageHeader } from "@/components/page-header";
import { ErrorState, EmptyState } from "@/components/states";
import { Alert } from "@/components/ui/alert";
import { Grid, Stack, Block } from "@/components/analytics/layout";
import { ZoneHeading, ZoneMeta } from "@/components/analytics/home/zone";
import { Lead, localYmd, rangeLabel as rangeWindow } from "@/components/analytics/home/parts";
import {
  PortfolioCurrent,
  PortfolioPerformance,
  portfolioQueries,
  rateQueries,
  type Biz,
} from "@/components/analytics/org/portfolio";
import { CutMenu } from "@/components/analytics/cut-controls";
import { CurrencyRefusal } from "@/components/analytics/currency-refusal";
import { CoverageNote } from "@/components/analytics/coverage-note";
import { EXPLORE_RANGES, GRAIN_LABEL } from "@/components/analytics/cut-options";
import { measureValue, measureValueCompact } from "@/components/analytics/format";
import { money } from "@/lib/api";
import {
  ok,
  splitByKey,
  windowChangeBps,
  billedCurrencies,
  excludedBusinesses,
  type ConvertedResult,
} from "@/components/analytics/org/conversion";
import { ConversionNote } from "@/components/analytics/org/conversion-note";
import { BusinessMixChart, type MixSeries } from "@/components/analytics/org/business-mix-chart";
import { CompareTable, type CompareRow } from "@/components/analytics/org/compare-table";

export const dynamic = "force-dynamic";

/** The batch endpoint answers at most 24 questions; one slot is the answer itself. */
const MAX_CURRENCY_QUERIES = 20;
/** Series any denser than this is a legend nobody reads — the table below carries the rest. */
const MAX_DRAWN_SERIES = 5;

/**
 * Compare businesses — Explore, with `business` fixed as the split.
 *
 * `metric_daily` carries `business_id` like any other column, so the whole comparison is ONE
 * question: `split=business`. The screen this replaces fetched a separate analytics payload per
 * business and added them up, which multiplied one slow call by the business count and could
 * only ever compare the measures that endpoint happened to return.
 *
 * Money is converted into the organization's base currency and the conversion says what it
 * dropped: a currency with no rate is excluded and named, never summed in as zero.
 */
export default async function MetricsPage({
  searchParams,
}: {
  searchParams: Promise<{
    measure?: string;
    period?: string;
    /** The old name for `period`, kept so existing links still land on their window. */
    range?: string;
    grain?: string;
    currency?: string;
  }>;
}) {
  const {
    measure: measureParam,
    period: periodParam,
    range: rangeParam,
    grain: grainParam,
    currency: currencyParam,
  } = await searchParams;
  await requirePermission("reports:view", "ops");

  let measures: AnalyticsMeasure[];
  let businesses;
  try {
    [measures, businesses] = await Promise.all([listMeasures(), listBusinesses()]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Metrics" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  // A measure with no `business` dimension has nothing to compare here: offering it would be a
  // control that answers 422.
  const comparable = measures.filter((m) => m.dimensions.includes("business"));
  if (comparable.length === 0) {
    return (
      <>
        <PageHeader title="Metrics" />
        <Grid>
          <Block span={12}>
            <EmptyState
              title="Nothing to compare yet"
              description="No measure in this organization's semantic layer can be split by business."
            />
          </Block>
        </Grid>
      </>
    );
  }

  const measure = comparable.find((m) => m.id === measureParam) ?? comparable[0]!;
  // Defaults to the last 30 days by day — the window the organization home charts, so the
  // two pages open on the same picture. A year by month drew as an empty axis on any book
  // younger than a year. Both stay one click away in the controls.
  const asked = periodParam ?? rangeParam;
  const range = EXPLORE_RANGES.some((r) => r.id === asked) ? asked! : "30d";
  /** The portfolio's grain: days inside a quarter, months beyond. */
  const periodGrain: "day" | "month" = ["6m", "12m", "this_year"].includes(range) ? "month" : "day";
  const grains = measure.grains;
  const grain: Grain = (
    grains.includes((grainParam ?? "") as Grain)
      ? grainParam
      : !asked && grains.includes("day")
        ? "day"
        : grains.includes("month")
          ? "month"
          : grains[0]
  ) as Grain;

  const businessCount = Math.max(businesses.data.length, 1);
  // Org-level comparison is live: test mode lives inside each business.
  const visible: Biz[] = businesses.data
    .filter((b) => b.livemode === "live")
    .map((b) => ({ id: b.id, name: b.name, currency: b.default_currency }));
  const currencies = billedCurrencies(businesses.data).slice(0, MAX_CURRENCY_QUERIES);

  /**
   * ONE round trip. The comparison itself is a single question — the fact table already carries
   * the business — and the extra slots are one per CURRENCY the book uses, so each row can also
   * be read in the currency it actually bills. Never one call per business.
   */
  const ownKeyFor = (c: string) => `own_${c}`;
  const queries: AnalyticsQuery[] = [
    {
      key: "main",
      measure: measure.id,
      split: "business",
      split_limit: businessCount,
      ...(currencyParam ? { currency: currencyParam } : {}),
    },
    ...(measure.unit === "money" && !currencyParam
      ? currencies.map((c) => ({
          key: ownKeyFor(c),
          measure: measure.id,
          split: "business",
          split_limit: businessCount,
          currency: c,
        }))
      : []),
  ];

  let batch: BatchEntry[] = [];
  let hardError: string | null = null;
  const syncedAtP = getSyncedAt();
  // Three batches, in parallel: the comparison, the portfolio, and the per-business rates
  // (one question per business — retention and churn do not combine across businesses).
  const RATE_BATCH = 48;
  const rateQs = rateQueries(visible, { range });
  const rateChunks: AnalyticsQuery[][] = [];
  for (let i = 0; i < rateQs.length; i += RATE_BATCH)
    rateChunks.push(rateQs.slice(i, i + RATE_BATCH));
  let portfolio: BatchEntry[] = [];
  let rateEntries: BatchEntry[] = [];
  try {
    [batch, portfolio, rateEntries] = await Promise.all([
      queryAnalytics({ range, grain, queries }),
      queryAnalytics({
        queries: portfolioQueries({
          period: { range, grain: periodGrain },
          businessCount,
          currencies,
          scoped: !!currencyParam,
        }),
        ...(currencyParam ? { currency: currencyParam } : {}),
      }).catch(() => [] as BatchEntry[]),
      Promise.all(
        rateChunks.map((q) =>
          queryAnalytics({
            queries: q,
            ...(currencyParam ? { currency: currencyParam } : {}),
          }).catch(() => [] as BatchEntry[]),
        ),
      ).then((parts) => parts.flat()),
    ]);
  } catch (e) {
    hardError = (e as Error).message;
  }
  const answers = new Map(portfolio.map((e) => [e.key, e]));
  const rates = new Map(rateEntries.map((e) => [e.key, e]));
  // The resolved dates beside the picker, as Home states them — not the preset's name twice.
  const netRange = ok(answers.get("net_biz"))?.range;
  const window = netRange
    ? rangeWindow(localYmd(netRange.start, null), localYmd(netRange.end, null))
    : null;
  const reportingCurrency = ok(answers.get("mrr"))?.currency ?? "USD";
  const syncedAt = await syncedAtP;
  const byKey = new Map(batch.map((e) => [e.key, e]));
  const main: ConvertedResult | null = ok(byKey.get("main"));
  const mainEntry = byKey.get("main");
  const refusal =
    mainEntry && mainEntry.object === "analytics_error"
      ? new AnalyticsRefused(mainEntry.error.message, {
          param: mainEntry.error.param,
          options: mainEntry.error.options,
        })
      : null;

  const qs = (over: Record<string, string>) => {
    const merged: Record<string, string> = {
      measure: measure.id,
      period: range,
      grain,
      ...(currencyParam ? { currency: currencyParam } : {}),
      ...over,
    };
    return new URLSearchParams(
      Object.entries(merged).filter(([, v]) => v !== "") as [string, string][],
    ).toString();
  };
  const hrefFor = (over: Record<string, string>) => `/metrics?${qs(over)}`;

  // Own-currency figures, one lookup per business, from the per-currency slots above.
  // A list, not a joined string: a business billing three currencies shows three lines,
  // never one sentence wrapping into the row below it.
  const ownByBusiness = new Map<string, string[]>();
  for (const c of currencies) {
    for (const [key, row] of splitByKey(ok(byKey.get(ownKeyFor(c))))) {
      if (row.total == null || row.total === 0) continue;
      ownByBusiness.set(key, [...(ownByBusiness.get(key) ?? []), money(row.total, c)]);
    }
  }

  const splitRows = [...splitByKey(main)].map(([, row]) => row);
  const ordered = [...splitRows].sort((a, z) => (z.total ?? 0) - (a.total ?? 0));

  const rows: CompareRow[] = ordered.map((row) => ({
    key: row.key,
    label: row.label,
    value: row.total == null ? null : measureValue(row.total, main!.unit, main!.currency),
    valueNote: "no rate",
    ownCurrency: ownByBusiness.get(row.key) ?? null,
    changeBps: windowChangeBps(row.points),
    shareBps:
      main?.total && row.total != null ? Math.round((row.total / main.total) * 10_000) : null,
  }));

  /**
   * The businesses the conversion left out — named under the chart rather than drawn flat.
   * A row the engine could not convert comes back with null points, so it would otherwise
   * take a legend entry and draw nothing, which reads as zero.
   */
  const dropped = excludedBusinesses(businesses.data, main?.missing_rates ?? []);
  const notDrawn =
    dropped.length <= 3
      ? dropped.map((b) => b.name)
      : [...dropped.slice(0, 3).map((b) => b.name), `${dropped.length - 3} more`];

  const drawn = ordered
    .filter((r) => r.points.some((p) => p.value != null))
    .slice(0, MAX_DRAWN_SERIES);
  const series: MixSeries[] = drawn.map((r) => ({
    key: r.key,
    label: r.label,
    values: r.points.map((p) => p.value),
  }));
  const periods = main?.series.map((p) => p.label) ?? [];

  const compareControls = (
    <div className="flex flex-wrap items-center gap-2">
      <CutMenu
        label="Measure"
        current={measure.id}
        options={comparable.map((m) => ({
          id: m.id,
          label: m.name,
          href: `${hrefFor({ measure: m.id, grain: "" })}#compare`,
        }))}
      />
      {grains.length > 1 ? (
        <>
          <span className="text-sm text-muted-foreground">by</span>
          <CutMenu
            label="Grain"
            current={grain}
            options={grains.map((g) => ({
              id: g,
              label: (GRAIN_LABEL[g] ?? g).toLowerCase(),
              href: `${hrefFor({ grain: g })}#compare`,
            }))}
          />
        </>
      ) : null}
    </div>
  );

  const periodMenu = (
    <CutMenu
      label="Period"
      current={range}
      options={EXPLORE_RANGES.map((r) => ({ ...r, href: hrefFor({ period: r.id }) }))}
    />
  );

  return (
    <NavPendingProvider>
      <PageHeader
        title="Metrics"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SyncedBadge syncedAt={syncedAt} />
            {currencies.length > 1 ? (
              <CutMenu
                label="Currency"
                current={currencyParam ?? ""}
                active={!!currencyParam}
                options={[
                  {
                    id: "",
                    label: `Reported in ${reportingCurrency}, converted`,
                    href: hrefFor({ currency: "" }),
                  },
                  ...currencies.map((c) => ({
                    id: c,
                    label: `${c} only`,
                    href: hrefFor({ currency: c }),
                  })),
                ]}
              />
            ) : null}
          </div>
        }
      />

      <Stack>
        <PendingContent
          keepFor={["Period", "Measure", "Grain"]}
          skeleton={<PortfolioCurrentSkeleton />}
        >
          <PortfolioCurrent answers={answers} businesses={visible} />
        </PendingContent>

        <div className="mt-4">
          <ZoneHeading zone="performance">
            {periodMenu}
            {window ? <ZoneMeta>{window}</ZoneMeta> : null}
          </ZoneHeading>
        </div>
        <PendingContent keepFor={["Measure", "Grain"]} skeleton={<PortfolioPerformanceSkeleton />}>
          <PortfolioPerformance
            answers={answers}
            rates={rates}
            businesses={visible}
            currency={reportingCurrency}
          />
        </PendingContent>

        <div id="compare" className="scroll-mt-6">
          <PendingContent skeleton={<OrgMetricsSkeleton />}>
            {hardError ? (
              <ErrorState description={<span className="font-mono text-xs">{hardError}</span>} />
            ) : refusal && refusal.param === "currency" ? (
              <CurrencyRefusal refusal={refusal} hrefFor={(c) => hrefFor({ currency: c })} />
            ) : refusal ? (
              // The engine's own sentence, verbatim — no options to offer for a non-currency refusal.
              <Alert tone="error" title="This combination is not available">
                {refusal.message}
              </Alert>
            ) : main && rows.length === 0 ? (
              <Grid>
                <Block span={12}>
                  <EmptyState
                    title="Nothing to compare yet"
                    description="No live business has a figure for this measure in the selected period. Figures show after a business starts billing."
                  />
                </Block>
              </Grid>
            ) : main ? (
              <Stack>
                <Grid>
                  <Block
                    span={12}
                    title="Compare any measure"
                    action={compareControls}
                    footer={
                      main.coverage ? <CoverageNote coverage={main.coverage} compact /> : undefined
                    }
                  >
                    <Lead value={measureValueCompact(main.total, main.unit, main.currency)} />
                    <div className="mt-4">
                      {periods.length > 0 && series.length > 0 ? (
                        <BusinessMixChart
                          periods={periods}
                          series={series}
                          unit={main.unit}
                          currency={main.currency}
                          notDrawn={notDrawn}
                        />
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          No series for this window. The rows below show the totals.
                        </p>
                      )}
                    </div>
                  </Block>
                </Grid>

                <Grid>
                  <CompareTable
                    rows={rows}
                    valueHeader={main.currency ? `${measure.name}, ${main.currency}` : measure.name}
                    showOwnCurrency={ownByBusiness.size > 0}
                    exploreQuery={new URLSearchParams({
                      measure: measure.id,
                      range,
                      grain,
                    }).toString()}
                    polarity={measurePolarity(measure.id)}
                  />
                </Grid>
                <ConversionNote result={main} businesses={businesses.data} />
              </Stack>
            ) : null}
          </PendingContent>
        </div>
      </Stack>
    </NavPendingProvider>
  );
}
