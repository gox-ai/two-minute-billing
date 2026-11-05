import { listReports } from "@/lib/api";
import { ReportsRail } from "./reports-rail";

/**
 * The stats section's shell: page header across the top, the reports rail and the page's
 * body side by side under it.
 *
 * ⚠️ A LAYOUT so the rail stays mounted (no flash, no refetch, scroll kept) while moving
 * between reports. The catalogue is fetched once here for the same reason.
 *
 * Each page (and its loading.tsx) renders exactly TWO top-level elements: its header, then
 * its body. The children wrapper is `display: contents`, so both become cells of this grid
 * and the header can span the rail. Below lg the rail stacks between header and body,
 * height-capped so it never pushes the page far down. No `loading.tsx` beside this: an ancestor boundary
 * would preempt every report's own skeleton.
 */
export default async function ReportsAllLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  const reports = await listReports(biz).catch(() => null);

  // No rail rather than an empty one implying an empty catalogue.
  if (!reports?.data?.length) return <div className="flex flex-col gap-5">{children}</div>;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[216px_minmax(0,1fr)]">
      <div className="contents *:row-3 *:min-w-0 lg:*:col-2 lg:*:row-2 [&>*:first-child]:row-1 lg:[&>*:first-child]:col-span-full lg:[&>*:first-child]:row-1">
        {children}
      </div>
      <aside className="row-2 max-h-72 min-w-0 overflow-y-auto lg:sticky lg:top-4 lg:col-1 lg:max-h-[calc(100vh-6rem)] lg:self-start">
        <ReportsRail biz={biz} reports={reports.data} />
      </aside>
    </div>
  );
}
