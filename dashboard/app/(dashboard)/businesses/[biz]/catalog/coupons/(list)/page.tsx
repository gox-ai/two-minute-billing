import { listBusinesses, listCoupons, listPrices, listInvoices } from "@/lib/api";
import type { CouponDetail } from "@/lib/api/coupons";
import { requirePermission } from "@/lib/session";
import { CouponsTable } from "@/components/catalog/coupons-table";
import { ShowArchivedToggle } from "@/components/catalog/show-archived-toggle";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { Alert } from "@/components/ui/alert";

export const dynamic = "force-dynamic";

export default async function CouponsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ archived?: string; msg?: string; error?: string }>;
}) {
  const { biz } = await params;
  const { archived, msg, error } = await searchParams;
  const showArchived = archived === "1";
  await requirePermission("coupons:view", "manager");

  let businesses, coupons, prices, invoices;
  try {
    [businesses, coupons, prices, invoices] = await Promise.all([
      listBusinesses(),
      listCoupons(biz, { includeArchived: showArchived }),
      listPrices(biz),
      listInvoices(biz),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Coupons" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const business = businesses.data.find((b) => b.id === biz);
  const name = business?.name ?? biz;
  const currency = prices.data[0]?.currency ?? invoices.data[0]?.currency ?? "USD";
  const basePath = `/businesses/${biz}/catalog/coupons`;

  return (
    <>
      {/* Create + show-archived live in the list top bar now. */}
      <CouponsTable
        page={{
          title: "Coupons",
          breadcrumbs: [
            { label: name, href: `/businesses/${biz}` },
            { label: "Product Catalog" },
            { label: "Coupons" },
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
        rows={coupons.data as CouponDetail[]}
        currency={currency}
        topBarExtras={<ShowArchivedToggle basePath={basePath} showing={showArchived} />}
      />
    </>
  );
}
