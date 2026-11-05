import Link from "next/link";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getReport, listBusinesses, type AnalyticsRange } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { ReportPanel, REPORT_RANGES } from "@/components/reports/report-panel";
import { NavPendingProvider } from "@/components/navigation/nav-pending";
import type { ReportPayload } from "@/components/reports/report-format";
import { MetricContext } from "@/components/reports/metric-context";

export const dynamic = "force-dynamic";

/**
 * One widget on a page of its own.
 *
 * The canonical address for a widget the engine reconstructs: what a deep link opens, what
 * the CSV route hangs off, and what someone pastes into a ticket. It is also the ONLY export
 * in the product — the semantic layer has no CSV, which is why Explore draws its own export
 * disabled.
 */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string; key: string }>;
  searchParams: Promise<{
    range?: string;
    currency?: string;
    /** day | week | month — how finely the series is cut, independently of `range`. */
    granularity?: string;
    group_by?: string;
    view?: string;
  }>;
}) {
  const { biz, key } = await params;
  const {
    range: rangeParam,
    currency: currencyParam,
    group_by: groupBy,
    granularity,
    view,
  } = await searchParams;
  await requirePermission("reports:view", "ops");

  const range: AnalyticsRange = (REPORT_RANGES as string[]).includes(rangeParam ?? "")
    ? (rangeParam as AnalyticsRange)
    : "12m";

  let report: ReportPayload, businesses;
  try {
    [report, businesses] = await Promise.all([
      getReport(biz, key, {
        range,
        currency: currencyParam,
        granularity,
        groupBy,
      }) as Promise<ReportPayload>,
      listBusinesses(),
    ]);
  } catch (e) {
    // Two top-level elements, header then body — the section layout places them.
    return (
      <>
        <PageHeader
          title="Report"
          className="mb-0"
          breadcrumbs={[
            { label: "Reports", href: `/businesses/${biz}/reports` },
            { label: "Stats", href: `/businesses/${biz}/reports/stats` },
          ]}
        />
        <div>
          <ErrorState
            description={<span className="font-mono text-xs">{(e as Error).message}</span>}
          />
        </div>
      </>
    );
  }

  const tz = businesses.data.find((b) => b.id === biz)?.timezone ?? null;
  const qs = (over: Record<string, string>) => {
    const merged: Record<string, string> = {
      range,
      ...(currencyParam ? { currency: currencyParam } : {}),
      ...(granularity ? { granularity } : {}),
      ...(groupBy ? { group_by: groupBy } : {}),
      ...(view ? { view } : {}),
      ...over,
    };
    // An empty override CLEARS the key — "None" has to remove the breakdown, not ask for a
    // breakdown by nothing, which the engine would refuse.
    return new URLSearchParams(
      Object.entries(merged).filter(([, v]) => v !== "") as [string, string][],
    ).toString();
  };

  // The toolbar's links reload the body inside ReportPanel's own PendingContent. Two
  // top-level elements, header then body — the section layout places them.
  return (
    <NavPendingProvider>
      <PageHeader
        title={report.name}
        description={report.description}
        className="mb-0"
        breadcrumbs={[
          { label: "Reports", href: `/businesses/${biz}/reports` },
          { label: "Stats", href: `/businesses/${biz}/reports/stats` },
          { label: report.name },
        ]}
        actions={
          <>
            <Link
              href={`/businesses/${biz}/reports/stats`}
              className="text-sm font-medium text-primary hover:underline"
            >
              All stats
            </Link>
            {/* The CSV comes from the engine's own resolver, not this page's JSON — the
                download and the screen are the same answer rendered twice. */}
            <Button asChild variant="outline">
              <a href={`/businesses/${biz}/reports/stats/${key}/csv?${qs({})}`}>
                <Download aria-hidden className="text-muted-foreground" />
                Download CSV
              </a>
            </Button>
          </>
        }
      />
      <div className="flex min-w-0 flex-col gap-5">
        <ReportPanel
          report={report}
          biz={biz}
          hrefFor={(over) => `/businesses/${biz}/reports/stats/${key}?${qs(over)}`}
          groupBy={groupBy ?? null}
          view={view ?? null}
          tz={tz}
        />
        {/* Where the figure has been, what moved it, which plans it sits in — each only
            where the report supports it. */}
        <MetricContext biz={biz} report={report} currency={currencyParam} />
      </div>
    </NavPendingProvider>
  );
}
