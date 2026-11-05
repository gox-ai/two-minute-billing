import { listBusinesses } from "@/lib/api";
import { listRetries } from "@/lib/api/retries";
import { DEFAULT_RETRY_SORT, DEFAULT_RETRY_STATE } from "@/lib/retries-format";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { RetriesTable } from "@/components/retries/retries-table";
import { ErrorState } from "@/components/states";

export const dynamic = "force-dynamic";

/** Rows per page — keep in step with the page size in /api/lists/[entity]. */
const PAGE_SIZE = 50;

/**
 * Retries — invoices under retry.
 *
 * The screen an operator opens to answer "what is failing to collect, and why".
 * Every field shown was already stored; it was scattered across invoice rows and
 * per-invoice Collections cards with nowhere to see it together.
 */
export default async function RetriesPage({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("invoices:view", "ops");

  let businesses, retries;
  try {
    [businesses, retries] = await Promise.all([
      listBusinesses(),
      listRetries(biz, { limit: PAGE_SIZE, state: DEFAULT_RETRY_STATE, sort: DEFAULT_RETRY_SORT }),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Retries" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;

  return (
    <>
      <RetriesTable
        page={{
          title: "Retries",
          description:
            "Invoices that need attention for collection, and the invoices that dunning recovered.",
          breadcrumbs: [{ label: name, href: `/businesses/${biz}` }, { label: "Retries" }],
        }}
        biz={biz}
        rows={retries.data}
        total={retries.total ?? retries.data.length}
        hasMore={retries.has_more}
        nextCursor={retries.next_cursor}
      />
    </>
  );
}
