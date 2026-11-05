import Link from "next/link";
import { listBusinesses } from "@/lib/api";
import { listReceipts, type ReceiptScope } from "@/lib/api/receipts";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { Alert } from "@/components/ui/alert";
import { ReceiptsTable } from "@/components/receipts/receipts-table";
import { urlFilters } from "@/lib/list-source";

export const dynamic = "force-dynamic";

/** Rows per page — keep in step with the page size in /api/lists/[entity]. */
const PAGE_SIZE = 50;

const SCOPE_LABEL: Record<keyof ReceiptScope, string> = {
  customer: "customer",
  invoice: "invoice",
  payment: "payment",
  payment_request: "payment request",
};

export default async function ReceiptsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ [param: string]: string | undefined }>;
}) {
  const [{ biz }, search] = await Promise.all([params, searchParams]);
  await requirePermission("payments:view", "ops");

  // The bare scoping params the engine accepts; one record's receipts (from its page).
  const scope: ReceiptScope = {};
  for (const k of Object.keys(SCOPE_LABEL) as Array<keyof ReceiptScope>)
    if (search[k]) scope[k] = search[k];
  const scoped = Object.entries(scope) as Array<[keyof ReceiptScope, string]>;

  let businesses, receipts;
  try {
    [businesses, receipts] = await Promise.all([
      listBusinesses(),
      listReceipts(biz, { limit: PAGE_SIZE, scope }),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Receipts" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;

  return (
    <ReceiptsTable
      page={{
        title: "Receipts",
        breadcrumbs: [{ label: name, href: `/businesses/${biz}` }, { label: "Receipts" }],
        description: "A numbered record of each payment that you received.",
        notice: scoped.length ? (
          <Alert tone="info">
            Receipts for{" "}
            {scoped.map(([k, v], i) => (
              <span key={k}>
                {i > 0 ? ", " : ""}
                {SCOPE_LABEL[k]} <span className="font-mono text-xs">{v}</span>
              </span>
            ))}
            .{" "}
            <Link href={`/businesses/${biz}/receipts`} className="text-primary hover:underline">
              View all receipts
            </Link>
          </Alert>
        ) : undefined,
      }}
      biz={biz}
      rows={receipts.data}
      total={receipts.total ?? receipts.data.length}
      hasMore={receipts.has_more}
      nextCursor={receipts.next_cursor}
      scope={scope}
      initialFilters={urlFilters(search, { paid_at: true, created_at: true, currency: true })}
    />
  );
}
