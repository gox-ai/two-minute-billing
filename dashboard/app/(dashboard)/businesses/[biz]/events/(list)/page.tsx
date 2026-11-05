import { listBusinesses } from "@/lib/api";
import { listEventsForBusiness } from "@/lib/api/developer";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { EventsTable } from "@/components/events/events-table";
import { ErrorState } from "@/components/states";
import { urlFilters } from "@/lib/list-source";

export const dynamic = "force-dynamic";

/** Rows per page — keep in step with the page size in /api/lists/[entity]. */
const PAGE_SIZE = 50;

export default async function BusinessEventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{
    type?: string;
    resource_type?: string;
    resource_id?: string;
    source?: string;
  }>;
}) {
  const [{ biz }, search] = await Promise.all([params, searchParams]);
  await requirePermission("events:view", "developer");

  let businesses, page;
  try {
    [businesses, page] = await Promise.all([
      listBusinesses(),
      listEventsForBusiness(biz, { limit: PAGE_SIZE }),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Events" />
        <ErrorState
          title="We could not load the events"
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;

  return (
    <>
      {/* The list chrome stays visible at zero rows — the table owns its empty state. */}
      {/* A deep link into a scoped audit view (`?resource_id=inv_…`) has to reach the
          list's filter state, or the URL narrows nothing and the reader believes it did. */}
      <EventsTable
        page={{
          breadcrumbs: [{ label: name, href: `/businesses/${biz}` }, { label: "Events" }],
          title: "Events",
          description: "Audit every domain event emitted for this business.",
        }}
        biz={biz}
        rows={page.data}
        total={page.total ?? page.data.length}
        hasMore={page.has_more}
        nextCursor={page.next_cursor}
        initialFilters={urlFilters(search, {
          type: true,
          resource_type: true,
          resource_id: true,
          source: true,
        })}
      />
    </>
  );
}
