import { redirect } from "next/navigation";
import Link from "next/link";
import { listReports } from "@/lib/api";
import { listMeasures } from "@/lib/analytics-api";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { dimensionLabel } from "@/components/reports/report-format";
import { exploreHref, isReading, type MeasureMeta } from "@/components/analytics/explore/query";
import { WidgetLibrary, type LibraryWidget } from "@/components/reports/widget-library";

export const dynamic = "force-dynamic";

/**
 * The widget library.
 *
 * A widget is one reusable answer with its cut pinned — a measure off the semantic layer, or
 * a report the engine reconstructs. They were two nouns on two screens for one idea; this is
 * the single place you browse everything that can be opened or placed.
 *
 * `?report=` is still honoured because dashboards and older links point that way; it lands on
 * the widget's own page, which is where it always belonged.
 */

/** Measure grains, in the order a person reads them. */
const GRAIN_LABELS: Record<string, string> = {
  day: "day",
  week: "week",
  month: "month",
  quarter: "quarter",
  year: "year",
};

/**
 * The widgets that answer as a grid and can never be expressed as a measure: two retention
 * cohorts, two waterfalls, the plan movement matrix, and three that need a global ranking or
 * band edges denominated at read time. Each cuts by two things at once or chooses its
 * dimension domain when the question is asked, so the library is the only place they exist.
 */
const GRID_ONLY = new Set([
  "mrr_retention_cohort",
  "subscription_retention_cohort",
  "mrr_movement_summary",
  "account_summary",
  "plan_movement_summary",
  "customer_concentration",
  "top_customers_by_mrr",
  "customers_by_mrr_band",
]);

const FAMILY_ORDER = [
  "Grids and cohorts",
  "Money at an instant",
  "Money over a period",
  "Counts",
  "Rates and ratios",
  "Scheduled and forward-looking",
  "Bands and ladders",
];

/** The shelf a widget sits on, from what it IS — the same rule for both kinds. */
function familyOf(unit: string, basis: string, gridOnly: boolean): string {
  if (gridOnly) return "Grids and cohorts";
  if (basis === "Scheduled") return "Scheduled and forward-looking";
  if (basis === "Bands") return "Bands and ladders";
  if (unit === "Rate") return "Rates and ratios";
  if (unit === "Money")
    return basis === "At an instant" ? "Money at an instant" : "Money over a period";
  return "Counts";
}

export default async function WidgetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{
    report?: string;
    range?: string;
    currency?: string;
    group_by?: string;
    granularity?: string;
  }>;
}) {
  const { biz } = await params;
  const { report, ...opts } = await searchParams;
  await requirePermission("reports:view", "ops");

  if (report) {
    const qs = new URLSearchParams(
      Object.entries(opts).filter(([, v]) => v != null && v !== "") as [string, string][],
    ).toString();
    redirect(`/businesses/${biz}/reports/stats/${report}${qs ? `?${qs}` : ""}`);
  }

  const crumbs = [{ label: "Reports", href: `/businesses/${biz}/reports` }];

  let measures: MeasureMeta[];
  let reports: Awaited<ReturnType<typeof listReports>>;
  try {
    [measures, reports] = await Promise.all([
      listMeasures() as Promise<MeasureMeta[]>,
      listReports(biz),
    ]);
  } catch (e) {
    // Two top-level elements, header then body — the section layout places them.
    return (
      <>
        <PageHeader title="Stats" breadcrumbs={crumbs} className="mb-0" />
        <div>
          <ErrorState
            description={<span className="font-mono text-xs">{(e as Error).message}</span>}
          />
        </div>
      </>
    );
  }

  const explorePath = `/businesses/${biz}/reports/explore`;

  const fromMeasures: LibraryWidget[] = measures.map((m) => {
    const unitLabel = m.unit === "money" ? "Money" : m.unit === "count" ? "Count" : "Rate";
    const basisLabel = isReading(m)
      ? "Live reading"
      : m.kind === "stock"
        ? "At an instant"
        : "Over a period";
    const grain = m.grains.includes("month") ? "month" : (m.grains[0] ?? "month");
    // Explore IS a measure's own page: one column, no dimension, the measure's default cut.
    const href = exploreHref(explorePath, {
      measures: [m.id],
      dimension: null,
      range: "12m",
      grain,
    });
    return {
      id: m.id,
      name: m.name,
      description: m.description,
      source: "measure",
      family: familyOf(unitLabel, basisLabel, false),
      unitLabel,
      basisLabel,
      dimensions: m.dimensions.map(dimensionLabel),
      grains: m.grains.map((g) => GRAIN_LABELS[g] ?? g),
      href,
      placeable: true,
      gridOnly: false,
    };
  });

  const fromReports: LibraryWidget[] = reports.data.map((r) => {
    // The engine publishes more shapes than `ReportSummary` declares (`buckets`, `periodic`,
    // `cohort`); widen here rather than edit the shared client type.
    const shape = r.shape as string;
    const unitLabel = r.kind === "money" ? "Money" : r.kind === "count" ? "Count" : "Rate";
    const gridOnly = GRID_ONLY.has(r.key);
    const basisLabel = gridOnly
      ? shape === "cohort"
        ? "Cohort grid"
        : shape === "periodic"
          ? "Period-by-period grid"
          : "Ranked grid"
      : shape === "stock"
        ? "At an instant"
        : shape === "forward"
          ? "Scheduled"
          : shape === "buckets"
            ? "Bands"
            : "Over a period";
    return {
      id: r.key,
      name: r.name,
      description: r.description,
      source: "report",
      family: familyOf(unitLabel, basisLabel, gridOnly),
      unitLabel,
      basisLabel,
      dimensions: r.dimensions.map(dimensionLabel),
      grains: (r.granularities ?? []).map((g) => GRAIN_LABELS[g] ?? g),
      href: `/businesses/${biz}/reports/stats/${r.key}`,
      // A board tile resolves through the semantic layer, so a report widget cannot be one.
      // Placing one would need a measure of the same id — see the grid-only note above.
      placeable: false,
      gridOnly,
    };
  });

  const widgets = [...fromMeasures, ...fromReports].sort(
    (a, b) =>
      FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) ||
      a.name.localeCompare(b.name),
  );

  return (
    <>
      <PageHeader
        title="Stats"
        description="All the measures and reports that this business can open or put on a board, in one list."
        breadcrumbs={crumbs}
        className="mb-0"
        actions={
          <Button asChild variant="outline">
            <Link href={`/businesses/${biz}/reports/dashboards`}>Dashboards</Link>
          </Button>
        }
      />
      <WidgetLibrary widgets={widgets} />
    </>
  );
}
