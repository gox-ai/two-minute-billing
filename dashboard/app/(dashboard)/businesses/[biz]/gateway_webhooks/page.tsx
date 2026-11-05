import { listBusinesses } from "@/lib/api";
import { getGatewayCatalogOrEmpty } from "@/lib/api/gateways";
import { listGatewayWebhooks } from "@/lib/api/payments";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { GatewayWebhooksTable } from "@/components/payments/gateway-webhooks-table";
import { ErrorState } from "@/components/states";
import { urlFilters } from "@/lib/list-source";
import { todayInTz } from "@/lib/tz";
import type { ListServerFilter } from "@/components/patterns/list-page";

export const dynamic = "force-dynamic";

/** Rows per page — keep in step with the page size in /api/lists/[entity]. */
const PAGE_SIZE = 50;

export default async function GatewayWebhooksPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{
    outcome?: string;
    gateway_key?: string;
    type?: string;
    transaction?: string;
    intent?: string;
    all?: string;
  }>;
}) {
  const [{ biz }, search] = await Promise.all([params, searchParams]);
  await requirePermission("gateways:view", "ops");

  let businesses, webhooks;
  try {
    [businesses, webhooks] = await Promise.all([
      listBusinesses(),
      listGatewayWebhooks(biz, { limit: PAGE_SIZE }),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Gateway Webhooks" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const business = businesses.data.find((b) => b.id === biz);
  const name = business?.name ?? biz;

  // This log opens scoped to "This day". On ALL TIME the first screen of a busy gateway
  // was arbitrary history and an operator debugging today's callbacks had to scroll past
  // it. The scope is a real, visible filter row
  // ("1 Filter" + "Clear filters"), never a hidden narrowing — and an explicit URL
  // scope wins, as does `?all=1` for the whole log.
  //
  // `on`, not a range: the received_at filter implements only on/after/before, so
  // "this day" is one day — resolved in the BUSINESS timezone, like every other date
  // on this screen (a UTC "today" drops this morning's rows for an IST business).
  const fromUrl = urlFilters(search, {
    outcome: true,
    gateway_key: true,
    type: true,
    transaction: true,
    intent: true,
  });
  const initialFilters: ListServerFilter[] =
    fromUrl.length > 0 || search.all
      ? fromUrl
      : [{ field: "received_at", op: "on", value: todayInTz(business?.timezone) }];

  const gatewayCatalog = await getGatewayCatalogOrEmpty();
  return (
    <>
      {/* The list chrome stays visible at zero rows — the table owns its empty state. */}
      <GatewayWebhooksTable
        page={{
          title: "Gateway Webhooks",
          breadcrumbs: [{ label: name, href: `/businesses/${biz}` }, { label: "Gateway webhooks" }],
        }}
        gatewayCatalog={gatewayCatalog}
        biz={biz}
        rows={webhooks.data}
        total={webhooks.total ?? webhooks.data.length}
        hasMore={webhooks.has_more}
        nextCursor={webhooks.next_cursor}
        initialFilters={initialFilters}
      />
    </>
  );
}
