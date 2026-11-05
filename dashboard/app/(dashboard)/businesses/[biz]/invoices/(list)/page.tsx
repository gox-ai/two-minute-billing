import { listBusinesses, listInvoices, listCustomers } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ManualInvoiceForm } from "@/components/invoices/manual-invoice-form";
import { InvoicesTable } from "@/components/invoices/invoices-table";
import { ErrorState } from "@/components/states";
import { Alert } from "@/components/ui/alert";
import { urlFilters } from "@/lib/list-source";

export const dynamic = "force-dynamic";

/** Rows per page — keep in step with the page size in /api/lists/[entity]. */
const PAGE_SIZE = 50;

export default async function InvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{
    msg?: string;
    error?: string;
    /** `status`, `dunning_status[in]`, `ar_bucket[is]` … — bracketed keys can't be named. */
    [param: string]: string | undefined;
  }>;
}) {
  const [{ biz }, search] = await Promise.all([params, searchParams]);
  const { msg, error } = search;
  await requirePermission("invoices:view", "ops");

  /**
   * The deep link's narrowing, built once and used twice — to fetch the server-rendered
   * first page, and to tell the table what it is looking at. The receivables ageing ladder
   * and the dunning-status summary link here, so the SSR page must already be narrowed or
   * the reader sees the whole book flash under a heading naming one bucket.
   */
  const deepLinkFilters = urlFilters(search, {
    status: true,
    dunning_status: true,
    ar_bucket: true,
    written_off: true,
    customer: true,
    due_date: true,
  });

  let businesses, invoices, customers;
  try {
    [businesses, invoices, customers] = await Promise.all([
      listBusinesses(),
      // First page only — paginated server-side (docs/GUIDE.md §3.4).
      listInvoices(biz, undefined, { limit: PAGE_SIZE, filters: deepLinkFilters }),
      // FIRST PAGE ONLY. Seeds the manual-invoice picker so its dialog is not empty on
      // open; every keystroke after that is a server search (`searchCustomersAction`).
      // This used to be `limit: 1000` filtered in the browser, so a business past that
      // could not invoice its newer customers and the picker said nothing about it.
      listCustomers(biz, { limit: 25 }),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Invoices & Credit Notes" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const business = businesses.data.find((b) => b.id === biz);
  const name = business?.name ?? biz;

  return (
    <>
      {/* Create lives in the list top bar (it opens a dialog), and the chrome
          stays visible at zero rows — the table renders its own empty state. */}
      <InvoicesTable
        page={{
          title: "Invoices & Credit Notes",
          breadcrumbs: [{ label: name, href: `/businesses/${biz}` }, { label: "Invoices" }],
          notice: (
            <>
              {msg ? (
                <Alert tone="info" className="mb-6">
                  {msg}
                </Alert>
              ) : null}
              {error ? <ErrorState className="mb-6" description={error} /> : null}
            </>
          ),
        }}
        biz={biz}
        rows={invoices.data}
        total={invoices.total ?? invoices.data.length}
        hasMore={invoices.has_more}
        nextCursor={invoices.next_cursor}
        initialFilters={deepLinkFilters}
        createSlot={
          <ManualInvoiceForm
            biz={biz}
            customers={customers.data}
            currencies={business?.currencies}
          />
        }
      />
    </>
  );
}
