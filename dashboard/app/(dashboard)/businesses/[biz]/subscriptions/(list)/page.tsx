import { listBusinesses, listSubscriptions } from "@/lib/api";
import { getGatewayCatalogOrEmpty } from "@/lib/api/gateways";
import { listCustomFieldDefinitions, type CustomFieldDefinition } from "@/lib/api/custom-fields";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { SubscriptionsTable } from "@/components/subscriptions/subscriptions-table";
import { ErrorState } from "@/components/states";
import { TestLimitNotice } from "@/components/test-limits";
import { urlFilters } from "@/lib/list-source";

export const dynamic = "force-dynamic";

/** Rows per page — keep in step with the page size in /api/lists/[entity]. */
const PAGE_SIZE = 50;

export default async function SubscriptionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ biz }, search] = await Promise.all([params, searchParams]);
  await requirePermission("subscriptions:view", "manager");

  // Business Home's plan mix links here as `?plan=<product>&status=active`, the
  // same set that panel counts. Both land as visible, clearable filter rows.
  const initialFilters = urlFilters(search, { plan: true, status: true, currency: true });

  let businesses, subscriptions, customFields;
  try {
    // First page only — the list is paginated server-side (docs/GUIDE.md §3.4)
    // and later pages stream in through /api/lists/subscriptions.
    [businesses, subscriptions, customFields] = await Promise.all([
      listBusinesses(),
      listSubscriptions(biz, undefined, { limit: PAGE_SIZE }),
      // Custom fields are admin-defined and per-business, so the filter builder can
      // only learn them at runtime. Archived ones are included deliberately:
      // archiving rejects new values but existing ones still read, so a retired field
      // is exactly the one an operator filters on to find the rows still carrying it.
      //
      // Its own rejection handler rather than the catch below — losing a few filter
      // rows must not cost the operator the whole page.
      listCustomFieldDefinitions(biz, {
        entityType: "subscription",
        includeArchived: true,
      }).then(
        (r) => r.data,
        () => [] as CustomFieldDefinition[],
      ),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Subscriptions" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const bizRow = businesses.data.find((b) => b.id === biz);
  const name = bizRow?.name ?? biz;

  const gatewayCatalog = await getGatewayCatalogOrEmpty();
  return (
    <>
      {/* Create/Import live in the list top bar; the table owns its empty state. */}
      {/* tz: dates render in the business timezone, not UTC — the engine's term
          boundaries are midnight in that zone. */}
      <SubscriptionsTable
        page={{
          title: "Subscriptions",
          breadcrumbs: [{ label: name, href: `/businesses/${biz}` }, { label: "Subscriptions" }],
          notice: <TestLimitNotice biz={biz} kind="subscriptions" livemode={bizRow?.livemode} />,
        }}
        gatewayCatalog={gatewayCatalog}
        biz={biz}
        rows={subscriptions.data}
        tz={bizRow?.timezone ?? null}
        total={subscriptions.total ?? subscriptions.data.length}
        hasMore={subscriptions.has_more}
        nextCursor={subscriptions.next_cursor}
        initialFilters={initialFilters}
        customFields={customFields}
      />
    </>
  );
}
