import { listBusinesses } from "@/lib/api";
import { listEmails } from "@/lib/api/emails";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { EmailsTable } from "@/components/emails/emails-table";
import { ErrorState } from "@/components/states";
import { urlFilters } from "@/lib/list-source";

export const dynamic = "force-dynamic";

/** Rows per page — keep in step with the page size in `/api/lists/emails`. */
const PAGE_SIZE = 50;

export default async function EmailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ [param: string]: string | string[] | undefined }>;
}) {
  const [{ biz }, search] = await Promise.all([params, searchParams]);
  await requirePermission("emails:view", "ops");
  // A deep link's narrowing (`?filter=status:in:failed,bounced`), applied to the first page
  // and handed to the table so its pills and Clear know about it.
  const deepLinkFilters = urlFilters(search, { status: true, type: true });

  // First page only — the list is paginated server-side (50/page) and later
  // pages stream in through /api/lists/emails.
  let businesses, emails;
  try {
    [businesses, emails] = await Promise.all([
      listBusinesses(),
      listEmails(biz, { limit: PAGE_SIZE, filters: deepLinkFilters }),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Emails" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;

  return (
    <>
      {/* The list chrome stays visible at zero rows — the table owns its empty state. */}
      <EmailsTable
        page={{
          title: "Emails",
          breadcrumbs: [{ label: name, href: `/businesses/${biz}` }, { label: "Emails" }],
        }}
        biz={biz}
        rows={emails.data}
        total={emails.total ?? emails.data.length}
        hasMore={emails.has_more}
        nextCursor={emails.next_cursor}
        initialFilters={deepLinkFilters}
      />
    </>
  );
}
