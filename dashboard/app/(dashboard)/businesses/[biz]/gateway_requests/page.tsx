import { listBusinesses } from "@/lib/api";
import { getGatewayCatalogOrEmpty } from "@/lib/api/gateways";
import { listGatewayRequests } from "@/lib/api/payments";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { GatewayRequestsTable } from "@/components/payments/gateway-requests-table";
import { ErrorState } from "@/components/states";
import { urlFilters } from "@/lib/list-source";

export const dynamic = "force-dynamic";

/** Rows per page — keep in step with the page size in /api/lists/[entity]. */
const PAGE_SIZE = 50;

export default async function GatewayRequestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{
    gateway_key?: string;
    operation?: string;
    source?: string;
    method?: string;
    /**
     * The payment-intent detail page's "View Request/Response Logs" links here
     * with the ATTEMPT's trace id. `gateway_request_logs` is platform-global with
     * no RLS, so it has no FK to an attempt — the trace id is the only
     * correlation key. The engine's filter allow-list (GATEWAY_REQUEST_FILTERS)
     * already includes `trace_id`, so this narrows in SQL, not on the page.
     */
    trace_id?: string;
    /** A transaction's or an attempt's own calls (`gatewayLogsHref`). */
    span_id?: string;
  }>;
}) {
  const [{ biz }, search] = await Promise.all([params, searchParams]);
  await requirePermission("gateways:view", "ops");

  let businesses, requests;
  try {
    [businesses, requests] = await Promise.all([
      listBusinesses(),
      listGatewayRequests(biz, { limit: PAGE_SIZE }),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Gateway Requests" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;

  const gatewayCatalog = await getGatewayCatalogOrEmpty();
  return (
    <>
      {/* The list chrome stays visible at zero rows — the table owns its empty state. */}
      <GatewayRequestsTable
        page={{
          title: "Gateway Requests",
          breadcrumbs: [{ label: name, href: `/businesses/${biz}` }, { label: "Gateway requests" }],
        }}
        gatewayCatalog={gatewayCatalog}
        biz={biz}
        rows={requests.data}
        total={requests.total ?? requests.data.length}
        hasMore={requests.has_more}
        nextCursor={requests.next_cursor}
        initialFilters={urlFilters(search, {
          gateway_key: true,
          operation: true,
          source: true,
          method: true,
          trace_id: true,
          span_id: true,
        })}
      />
    </>
  );
}
