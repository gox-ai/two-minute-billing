import { listBusinesses } from "@/lib/api";
import { urlFilters } from "@/lib/list-source";
import { listCreditNotes } from "@/lib/api/credit-notes";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { CreditNotesTable } from "@/components/credit-notes/credit-notes-table";
import { Alert } from "@/components/ui/alert";

export const dynamic = "force-dynamic";

/** Rows per page — keep in step with the page size in /api/lists/[entity]. */
const PAGE_SIZE = 50;

export default async function CreditNotesPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{
    invoice?: string;
    customer?: string;
    kind?: string;
    status?: string;
    msg?: string;
    error?: string;
  }>;
}) {
  const { biz } = await params;
  const { invoice, customer, kind, status, msg, error } = await searchParams;
  await requirePermission("credit_notes:view", "ops");

  /**
   * The deep link's narrowing, built ONCE and used twice: to fetch the server-rendered
   * first page, and — via `initialFilters` — to tell the table what it is looking at.
   *
   * Passing it only to the fetch is what made `?customer=&kind=&status=` a lie: the
   * first paint was narrowed, the table believed it was not (no pills, no Clear), and
   * the next `fetchPage` dropped all three and quietly showed every credit note in the
   * business under a header still naming one customer. `customer` moves in here with
   * kind/status because `fetchPage` never forwarded it either — only `invoice` is a
   * scope param the source carries.
   */
  const deepLinkFilters = urlFilters(
    { customer, kind, status },
    { customer: true, kind: true, status: true },
  );

  let businesses, notes;
  try {
    [businesses, notes] = await Promise.all([
      listBusinesses(),
      // First page only — paginated server-side (docs/GUIDE.md §3.4).
      // `customer`/`kind`/`status` exist so the customer page's Balances & Credits
      // panel can deep-link the refundable figure to the notes that BACK it: customer
      // + type + status, 3 filters, and the listed notes' available amounts sum to the
      // tile. `customer` is a scope param the route allow-lists; kind/status go through
      // the normal filter mechanism.
      listCreditNotes(biz, { invoice, limit: PAGE_SIZE, filters: deepLinkFilters }),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader
          title="Credit Notes"
          breadcrumbs={[
            { label: "Businesses", href: "/" },
            { label: biz, href: `/businesses/${biz}` },
            { label: "Credit Notes" },
          ]}
        />
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
      {/* Create lives in the list top bar; the table owns its empty state. */}
      <CreditNotesTable
        page={{
          title: "Credit Notes",
          description: invoice ? (
            <span className="text-sm text-muted-foreground">
              Filtered to invoice <span className="font-mono">{invoice}</span>
            </span>
          ) : customer ? (
            <span className="text-sm text-muted-foreground">
              Filtered to customer <span className="font-mono">{customer}</span>
              {kind || status
                ? ` · ${[kind, status?.replace(/_/g, " ")].filter(Boolean).join(" · ")}`
                : ""}
            </span>
          ) : undefined,
          breadcrumbs: [
            { label: "Businesses", href: "/" },
            { label: name, href: `/businesses/${biz}` },
            { label: "Credit Notes" },
          ],
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
        rows={notes.data}
        invoice={invoice}
        total={notes.total ?? notes.data.length}
        hasMore={notes.has_more}
        nextCursor={notes.next_cursor}
        initialFilters={deepLinkFilters}
        createHref={`/businesses/${biz}/credit_notes/new${invoice ? `?invoice=${invoice}` : ""}`}
      />
    </>
  );
}
