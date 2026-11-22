import { listBusinesses, listPrices, listProducts } from "@/lib/api";
import { getGatewayCatalogOrEmpty } from "@/lib/api/gateways";
import { listCustomFieldDefinitions, type CustomFieldDefinition } from "@/lib/api/custom-fields";
import { listOrders } from "@/lib/api/orders";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { OrdersTable } from "@/components/orders/orders-table";
import { ErrorState } from "@/components/states";
import { urlFilters } from "@/lib/list-source";

export const dynamic = "force-dynamic";

/** Rows per page — keep in step with the page size in /api/lists/[entity]. */
const PAGE_SIZE = 50;

export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ [param: string]: string | undefined }>;
}) {
  const [{ biz }, search] = await Promise.all([params, searchParams]);
  await requirePermission("invoices:view", "ops");

  // A link from a report narrows the first page too, so the list never flashes the whole book.
  const deepLinkFilters = urlFilters(search, {
    order_status: true,
    product: true,
    coupon: true,
    customer: true,
    created_at: true,
  });

  let businesses, orders, products, prices, customFields;
  try {
    [businesses, orders, products, prices, customFields] = await Promise.all([
      listBusinesses(),
      listOrders(biz, { limit: PAGE_SIZE, filters: deepLinkFilters }),
      listProducts(biz, { includeArchived: true }),
      listPrices(biz, { includeArchived: true }),
      // The customer's custom fields filter orders. Their own handler: losing a few filter
      // rows must not cost the operator the page.
      listCustomFieldDefinitions(biz, { entityType: "customer", includeArchived: true }).then(
        (r) => r.data,
        () => [] as CustomFieldDefinition[],
      ),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Orders" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;
  const gatewayCatalog = await getGatewayCatalogOrEmpty();
  // Only products an order can hold: a one-time price that is not a credit pack. Archived
  // ones stay, because past orders still carry them.
  const orderable = new Set(
    prices.data
      .filter(
        (p) =>
          p.type === "one_time" &&
          (p as { grants_credit?: { kind?: string } | null }).grants_credit?.kind !== "pack",
      )
      .map((p) => p.product),
  );

  return (
    <OrdersTable
      page={{
        title: "Orders",
        description: "Invoices for one-time products. Credit pack purchases are in Invoices.",
        breadcrumbs: [{ label: name, href: `/businesses/${biz}` }, { label: "Orders" }],
      }}
      biz={biz}
      rows={orders.data}
      total={orders.total ?? orders.data.length}
      hasMore={orders.has_more}
      nextCursor={orders.next_cursor}
      initialFilters={deepLinkFilters}
      products={products.data
        .filter((p) => orderable.has(p.id))
        .map((p) => ({ id: p.id, name: p.name }))}
      customFields={customFields}
      gatewayCatalog={gatewayCatalog}
    />
  );
}
