import { listBusinesses, listProducts } from "@/lib/api";
import { getCoupon } from "@/lib/api/coupons";
import type { Product } from "@/lib/api/coupons";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { CouponFormPage } from "@/components/catalog/coupon-form-page";
import { ErrorState } from "@/components/states";

export const dynamic = "force-dynamic";

export default async function EditCouponPage({
  params,
}: {
  params: Promise<{ biz: string; cpn: string }>;
}) {
  await requirePermission("coupons:manage", "manager");
  const { biz, cpn } = await params;

  let businesses, products, coupon;
  try {
    [businesses, products, coupon] = await Promise.all([
      listBusinesses(),
      listProducts(biz),
      getCoupon(biz, cpn),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Edit Coupon" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  if (!coupon) {
    return (
      <>
        <PageHeader title="Edit Coupon" />
        <ErrorState description={`We could not find the coupon ${cpn}.`} />
      </>
    );
  }
  const business = businesses.data.find((b) => b.id === biz);
  const name = business?.name ?? biz;
  const listHref = `/businesses/${biz}/catalog/coupons`;
  const detailHref = `${listHref}/${coupon.id}`;

  return (
    <CouponFormPage
      biz={biz}
      currencies={business?.currencies}
      defaultCurrency={business?.default_currency}
      products={products.data as Product[]}
      existing={coupon}
      backHref={detailHref}
      crumbs={[
        { label: name, href: `/businesses/${biz}` },
        { label: "Product Catalog" },
        { label: "Coupons", href: listHref },
        { label: coupon.name ?? coupon.code, href: detailHref },
        { label: "Edit" },
      ]}
    />
  );
}
