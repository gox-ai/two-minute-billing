import { listBusinesses, listCoupons, listCouponSets } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { CouponSetsTable } from "@/components/catalog/coupon-sets-table";
import { GenerateCouponSetDialog } from "@/components/catalog/generate-coupon-set-dialog";
import { EmptyState, ErrorState } from "@/components/states";
import { Ticket } from "lucide-react";
import { Alert } from "@/components/ui/alert";

export const dynamic = "force-dynamic";

export default async function CouponSetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ msg?: string; error?: string }>;
}) {
  await requirePermission("coupons:view", "manager");
  const { biz } = await params;
  const { msg, error } = await searchParams;

  let businesses, sets, coupons;
  try {
    [businesses, sets, coupons] = await Promise.all([
      listBusinesses(),
      listCouponSets(biz),
      listCoupons(biz),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Coupon sets" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;

  // The generate dialog is the list's create action (it opens a modal, not a page).
  // The generate dialog is the list's create action (a modal, not a page).
  const generateDialog =
    coupons.data.length > 0 ? (
      <GenerateCouponSetDialog biz={biz} coupons={coupons.data} />
    ) : undefined;

  return (
    <>
      {coupons.data.length === 0 ? (
        <>
          <PageHeader
            title="Coupon sets"
            breadcrumbs={[
              { label: name, href: `/businesses/${biz}` },
              { label: "Product catalog" },
              { label: "Coupon sets" },
            ]}
          />
          {msg ? (
            <Alert tone="info" className="mb-6">
              {msg}
            </Alert>
          ) : null}
          {error ? <ErrorState className="mb-6" description={error} /> : null}
          <EmptyState
            icon={<Ticket />}
            title="Create a coupon first"
            description="A coupon set needs a parent coupon. Its codes use the discount of the parent coupon."
          />
        </>
      ) : (
        <CouponSetsTable
          emptyAction={
            <GenerateCouponSetDialog biz={biz} coupons={coupons.data} variant="outline" />
          }
          page={{
            title: "Coupon sets",
            breadcrumbs: [
              { label: name, href: `/businesses/${biz}` },
              { label: "Product catalog" },
              { label: "Coupon sets" },
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
          rows={sets.data}
          createSlot={generateDialog}
        />
      )}
    </>
  );
}
