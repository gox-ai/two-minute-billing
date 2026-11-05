import Link from "next/link";
import { listBusinesses } from "@/lib/api";
import { listPaymentRequests } from "@/lib/api/payment-requests";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { Alert } from "@/components/ui/alert";
import { PaymentRequestsTable } from "@/components/payment-requests/payment-requests-table";

export const dynamic = "force-dynamic";

/** Rows per page — keep in step with the page size in /api/lists/[entity]. */
const PAGE_SIZE = 50;

export default async function PaymentRequestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ customer?: string }>;
}) {
  const [{ biz }, { customer }] = await Promise.all([params, searchParams]);
  await requirePermission("payments:view", "ops");

  let businesses, requests;
  try {
    [businesses, requests] = await Promise.all([
      listBusinesses(),
      listPaymentRequests(biz, { limit: PAGE_SIZE, scope: { customer } }),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Payment requests" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;

  return (
    <PaymentRequestsTable
      page={{
        title: "Payment requests",
        breadcrumbs: [{ label: name, href: `/businesses/${biz}` }, { label: "Payment requests" }],
        description:
          "One request for several open invoices of a customer. Create one from the customer page.",
        notice: customer ? (
          <Alert tone="info">
            Payment requests for customer{" "}
            <Link
              href={`/businesses/${biz}/customers/${customer}`}
              className="font-mono text-xs text-primary hover:underline"
            >
              {customer}
            </Link>
            .{" "}
            <Link
              href={`/businesses/${biz}/payment_requests`}
              className="text-primary hover:underline"
            >
              View all payment requests
            </Link>
          </Alert>
        ) : undefined,
      }}
      customer={customer}
      biz={biz}
      rows={requests.data}
      total={requests.total ?? requests.data.length}
      hasMore={requests.has_more}
      nextCursor={requests.next_cursor}
    />
  );
}
