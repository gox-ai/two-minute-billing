import { listBusinesses, listCustomers, listSubscriptions, type Subscription } from "@/lib/api";
import { getGatewayCatalogOrEmpty } from "@/lib/api/gateways";
import { listCustomFieldDefinitions, type CustomFieldDefinition } from "@/lib/api/custom-fields";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { CustomersTable } from "@/components/customers/customers-table";
import { ErrorState } from "@/components/states";
import { Alert } from "@/components/ui/alert";
import { TestLimitNotice } from "@/components/test-limits";
import { urlFilters } from "@/lib/list-source";
import { getCountries } from "@/lib/api/geo";

export const dynamic = "force-dynamic";

/** Rows per page — keep in step with the page size in `/api/lists/customers`. */
const PAGE_SIZE = 50;

export default async function CustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ biz }, search] = await Promise.all([params, searchParams]);
  const msg = typeof search.msg === "string" ? search.msg : undefined;
  const error = typeof search.error === "string" ? search.error : undefined;
  await requirePermission("customers:view", "manager");

  // Deep links from Business Home's signup counts arrive as
  // `?created_at[on]=…` / `?created_at[after]=…&created_at[before]=…`, in the
  // BUSINESS timezone — the API hands those dates back on `analytics.windows`
  // rather than the browser recomputing them, so the list opens on exactly the
  // rows the clicked figure counted.
  const initialFilters = urlFilters(search, { created_at: true });

  // Custom fields are admin-defined and per-business, so the filter builder can only
  // learn them at runtime. Archived ones are included deliberately: archiving rejects
  // new values but existing ones still read, so a retired field is exactly the one an
  // operator filters on to find the rows that still carry it.
  //
  // Started here so it overlaps the list reads, and its rejection is handled in place
  // rather than by the try/catch below — losing a few filter rows must not cost the
  // operator the whole page.
  // The Country filters need the WHOLE reference, not the countries on the loaded page —
  // see `lib/filter-options.ts`. `getCountries` is `cache`d, so this is one fetch shared
  // with anything else on the request that wants it.
  const countriesPromise = getCountries().catch(
    () => [] as Awaited<ReturnType<typeof getCountries>>,
  );

  const customFieldsPromise = listCustomFieldDefinitions(biz, {
    entityType: "customer",
    includeArchived: true,
  }).then(
    (r) => r.data,
    () => [] as CustomFieldDefinition[],
  );

  // First page only — the list is paginated server-side (50/page) and later pages
  // stream in through /api/lists/customers. Subscription Info is hydrated for just
  // this page's customers, so neither query grows with the business.
  let businesses, customers, subs;
  try {
    businesses = await listBusinesses();
    customers = await listCustomers(biz, { limit: PAGE_SIZE });
    subs = customers.data.length
      ? await listSubscriptions(
          biz,
          customers.data.map((c) => c.id),
        )
      : { data: [] as Subscription[] };
  } catch (e) {
    return (
      <>
        <PageHeader title="Customers" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const customFields = await customFieldsPromise;
  const countries = await countriesPromise;
  const bizRow = businesses.data.find((b) => b.id === biz);
  const name = bizRow?.name ?? biz;
  // Newest-first subs per customer for the Subscription Info column.
  const subsByCustomer: Record<string, Subscription[]> = {};
  for (const s of subs.data) {
    if (!s.customer) continue;
    (subsByCustomer[s.customer] ??= []).push(s);
  }

  const gatewayCatalog = await getGatewayCatalogOrEmpty();
  return (
    <>
      {/* The list chrome (Create/Import, segments, filters) stays visible even
          with zero customers — CustomersTable renders its own empty state. */}
      <CustomersTable
        page={{
          title: "Customers",
          breadcrumbs: [{ label: name, href: `/businesses/${biz}` }, { label: "Customers" }],
          notice: (
            <>
              <TestLimitNotice biz={biz} kind="customers" livemode={bizRow?.livemode} />
              {msg ? (
                <Alert tone="info" className="mb-6">
                  {msg}
                </Alert>
              ) : null}
              {error ? <ErrorState className="mb-6" description={error} /> : null}
            </>
          ),
        }}
        gatewayCatalog={gatewayCatalog}
        biz={biz}
        rows={customers.data}
        subsByCustomer={subsByCustomer}
        total={customers.total ?? customers.data.length}
        hasMore={customers.has_more}
        nextCursor={customers.next_cursor}
        initialFilters={initialFilters}
        customFields={customFields}
        countries={countries}
      />
    </>
  );
}
