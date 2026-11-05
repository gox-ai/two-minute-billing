import Link from "next/link";
import { getSyncedAt, listMeasures, queryAnalytics, type BatchEntry } from "@/lib/analytics-api";
import { listBusinesses } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { EXPLORE_RANGES } from "@/components/analytics/cut-options";
import { Stack } from "@/components/analytics/layout";
import { AttentionCard, RecordCard, type AttentionItem } from "@/components/patterns/record-page";
import { SyncedBadge } from "@/components/analytics/synced-badge";
import { dimensionLabel } from "@/components/reports/report-format";
import { GRAIN_PHRASE, RANGE_PHRASE } from "@/components/analytics/explore/subjects";
import { ControlPanel, type PanelMeasure } from "@/components/analytics/explore/panel";
import { ExploreResultSkeleton } from "@/components/analytics/explore/skeletons";
import { NavPendingProvider, PendingContent } from "@/components/navigation/nav-pending";
import { ExploreResult } from "@/components/analytics/explore/result";
import {
  exploreHref,
  offerDimensions,
  offerGrains,
  parseQuery,
  planQueries,
  type MeasureMeta,
} from "@/components/analytics/explore/query";
import {
  currencyOf,
  indexAnswers,
  instantsOf,
  refusalFor,
} from "@/components/analytics/explore/answers";

export const dynamic = "force-dynamic";

/**
 * Explore: a query builder.
 *
 * Measures are the COLUMNS, one dimension is the ROWS, a period governs both, and the result
 * is one chart plus one table. Change anything on the left and the whole result re-renders —
 * there are no steps and nothing to navigate between, which is the convention anyone who has
 * used a BI tool already knows.
 *
 * The query lives entirely in the URL (`?m=mrr&m=mrr_churn&dim=plan&range=12m&grain=month`), so
 * a view is a shareable link and Back undoes exactly one change. Every column is answered by
 * ONE batched `POST /v1/analytics/query`, so two columns of the same table can never disagree
 * about when they were true.
 */
export default async function ExplorePage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { biz } = await params;
  const sp = await searchParams;
  await requirePermission("reports:view", "ops");

  const basePath = `/businesses/${biz}/reports/explore`;
  const crumbs = [{ label: "Reports", href: `/businesses/${biz}/reports` }];

  // Never throws — a missing pill costs the pill, not the page.
  const syncedAtP = getSyncedAt(biz);
  let measures: MeasureMeta[];
  let businesses;
  try {
    [measures, businesses] = await Promise.all([
      listMeasures() as Promise<MeasureMeta[]>,
      listBusinesses(),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Explore" breadcrumbs={crumbs} />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const byId = new Map(measures.map((m) => [m.id, m]));

  // This business's own currencies, so a multi-currency business gets a real switcher rather
  // than only the refusal's one-click links.
  const thisBusiness = businesses.data.find((b) => b.id === biz);
  const knownCurrencies = thisBusiness?.currencies?.length
    ? thisBusiness.currencies
    : thisBusiness?.default_currency
      ? [thisBusiness.default_currency]
      : [];

  const query = parseQuery({ searchParams: sp, all: measures, byId, knownCurrencies });
  const selected = query.measures.map((m) => m.id);

  if (query.measures.length === 0) {
    return (
      <>
        <PageHeader title="Explore" breadcrumbs={crumbs} />
        <ErrorState description="The registry of this organization has no measures to query." />
      </>
    );
  }

  const queries = planQueries(query, biz);

  let entries: BatchEntry[];
  try {
    // ONE request for every column. Sharing one `as_of` across the table is the point.
    entries = await queryAnalytics({
      queries,
      business: biz,
      grain: query.grain,
      range: query.range,
      ...(query.currency ? { currency: query.currency } : {}),
    });
  } catch (e) {
    return (
      <>
        <PageHeader title="Explore" breadcrumbs={crumbs} />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const answers = indexAnswers(entries);
  const reportedIn = currencyOf(answers);
  const instants = instantsOf(answers);

  const refusals = query.measures.map((m) => refusalFor(answers, m.id)).filter((r) => r != null);
  const nameOf = new Map(query.measures.map((m) => [m.id, m.name]));

  // A money measure the engine will not total across currencies answers with the set it CAN
  // do — offered as one-click links rather than parsed out of the sentence.
  const currencyRefusal = refusals.find((r) => r.param === "currency" && r.options?.length);
  const currencyRefused = currencyRefusal
    ? refusals.filter((r) => r.param === "currency" && r.message === currencyRefusal.message)
    : [];
  const otherRefusals = refusals.filter((r) => !currencyRefused.includes(r));

  const dimensions = offerDimensions(query.measures, dimensionLabel);
  const grains = offerGrains(query.measures, GRAIN_PHRASE);

  const panelMeasures: PanelMeasure[] = measures.map((m): PanelMeasure => {
    const checked = selected.includes(m.id);
    const wouldBreakDimension =
      !!query.dimension && !checked && !m.dimensions.includes(query.dimension);
    return {
      id: m.id,
      name: m.name,
      description: m.description,
      checked,
      // The last measure cannot be unticked: a table with no columns is not a view.
      disabled: checked && selected.length === 1,
      note:
        checked && selected.length === 1
          ? "a view needs at least one measure"
          : wouldBreakDimension
            ? `no ${dimensionLabel(query.dimension!).toLowerCase()} breakdown. If you add it, the rows change back to periods`
            : undefined,
    };
  });

  const rowsLabel = query.dimension ? dimensionLabel(query.dimension) : "Period";
  const title = `${query.measures.map((m) => m.name).join(" · ")} by ${rowsLabel.toLowerCase()}`;
  const chip = `${RANGE_PHRASE[query.range] ?? query.range} · by ${GRAIN_PHRASE[query.grain] ?? query.grain}`;

  // The kinds in play. Mixing them is legal — each measure keeps its own column and its own
  // unit — but it must be SAID, because a reader scanning across a row would otherwise take a
  // rate and an amount for two figures of the same sort.
  const units = [...new Set(query.measures.map((m) => m.unit))];
  const syncedAt = await syncedAtP;
  const kinds = [...new Set(query.measures.map((m) => m.kind))];

  // Every warning on the page, in one band above the query.
  const attention: AttentionItem[] = [];
  if (currencyRefusal) {
    attention.push({
      key: "currency",
      tone: "warning",
      title: "Select a currency to total this across businesses",
      detail: `${currencyRefused.map((r) => nameOf.get(r.measure) ?? r.measure).join(", ")}: ${currencyRefusal.message}`,
      actions: currencyRefusal.options!.map((c) => (
        <Link
          key={c}
          href={exploreHref(basePath, {
            measures: selected,
            dimension: query.dimension,
            range: query.range,
            grain: query.grain,
            compare: query.compare,
            currency: c,
          })}
          className="rounded-md border bg-card px-2 py-1 text-xs font-medium text-primary hover:bg-accent"
        >
          Report in {c}
        </Link>
      )),
    });
  }
  if (otherRefusals.length > 0) {
    attention.push({
      key: "refused",
      tone: "attention",
      title: `We could not answer ${otherRefusals.length === 1 ? "a measure" : `${otherRefusals.length} measures`}`,
      detail: (
        <span className="flex flex-col gap-0.5">
          {otherRefusals.map((r) => (
            <span key={r.measure}>
              <span className="font-medium text-foreground">
                {nameOf.get(r.measure) ?? r.measure}
              </span>
              : {r.message}
            </span>
          ))}
        </span>
      ),
    });
  }
  if (query.dropped.length > 0) {
    attention.push({
      key: "dropped",
      tone: "warning",
      title: `We could not read ${query.dropped.length} measure${query.dropped.length === 1 ? "" : "s"} in the link`,
      detail: `The view ran without ${query.dropped.length === 1 ? "it" : "them"}.`,
    });
  }
  if (instants.length > 1) {
    attention.push({
      key: "instants",
      tone: "warning",
      title: "Columns were computed at different instants",
      detail: "Two columns of this table may not agree about the time when they were true.",
    });
  }
  if (query.droppedDimension) {
    attention.push({
      key: "rows",
      tone: "warning",
      title: "Rows changed back to periods",
      detail: `${query.droppedDimension.because} carries no ${dimensionLabel(query.droppedDimension.dimension).toLowerCase()} breakdown.`,
    });
  }

  const facts = [
    `${queries.length} measure${queries.length === 1 ? "" : "s"} · one request`,
    instants.length === 1 ? "every column at one instant" : null,
    reportedIn ? `reported in ${reportedIn}` : null,
    units.length > 1 ? `mixed units: ${units.join(", ")}, never added together` : null,
    kinds.length > 1 ? "both stocks and flows, each totaled its own way" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <NavPendingProvider>
      <PageHeader
        title="Explore"
        description="Select the measures that you want as columns and the dimension that you want as rows."
        breadcrumbs={crumbs}
        actions={<SyncedBadge syncedAt={syncedAt} />}
      />

      {/* No "Save view" and no "Export CSV". A view is fully described by its URL, but the
          engine stores no such thing — a saved report is a catalogue key and a board tile is a
          report key, neither of which can hold a measure set — and `/v1/analytics` serves no
          CSV. "Save view" needs an engine-side store of named queries (the URL, a name, an
          owner, org-scoped); "Export CSV" needs a CSV representation on the query endpoint.
          Until each exists, neither control ships: a button that cannot do its job is worse
          than its absence. */}

      <Stack>
        <AttentionCard items={attention} columns={false} />

        {/* Query 4, result 8; top-aligned, so neither card grows a gap above its footer. */}
        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
          <div className="min-w-0 xl:col-span-4">
            <RecordCard title="Query" flush>
              <ControlPanel
                basePath={basePath}
                measures={panelMeasures}
                selected={selected}
                dimensions={dimensions}
                dimension={query.dimension}
                grains={grains}
                grain={query.grain}
                ranges={EXPLORE_RANGES}
                range={query.range}
                comparable={query.measures.some((m) => m.supports_compare)}
                compare={query.compare}
                currencies={knownCurrencies}
                currency={query.currency}
                reportedIn={reportedIn}
                moneyInPlay={query.measures.some((m) => m.unit === "money")}
              />
            </RecordCard>
          </div>

          <div className="min-w-0 xl:col-span-8">
            <PendingContent skeleton={<ExploreResultSkeleton />}>
              <ExploreResult
                query={query}
                answers={answers}
                reportedIn={reportedIn}
                title={title}
                chip={chip}
                rowsLabel={rowsLabel}
                footer={
                  <span
                    data-explore-queries={queries.length}
                    data-explore-instants={instants.length}
                  >
                    {facts}
                  </span>
                }
              />
            </PendingContent>
          </div>
        </div>
      </Stack>
    </NavPendingProvider>
  );
}
