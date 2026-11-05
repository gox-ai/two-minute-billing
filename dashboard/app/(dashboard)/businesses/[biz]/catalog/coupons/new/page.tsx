import { listBusinesses, listProducts } from "@/lib/api";
import { getCoupon } from "@/lib/api/coupons";
import type { Product } from "@/lib/api/coupons";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { CouponFormPage } from "@/components/catalog/coupon-form-page";
import { ErrorState } from "@/components/states";

export const dynamic = "force-dynamic";

export default async function NewCouponPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ clone?: string }>;
}) {
  await requirePermission("coupons:manage", "manager");
  const { biz } = await params;
  const { clone: cloneId } = await searchParams;

  let businesses, products;
  try {
    [businesses, products] = await Promise.all([listBusinesses(), listProducts(biz)]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Create Coupon" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const business = businesses.data.find((b) => b.id === biz);
  const name = business?.name ?? biz;
  const listHref = `/businesses/${biz}/catalog/coupons`;
  const clone = cloneId ? ((await getCoupon(biz, cloneId)) ?? undefined) : undefined;

  return (
    <CouponFormPage
      biz={biz}
      currencies={business?.currencies}
      defaultCurrency={business?.default_currency}
      products={products.data as Product[]}
      clone={clone}
      backHref={listHref}
      crumbs={[
        { label: name, href: `/businesses/${biz}` },
        { label: "Product Catalog" },
        { label: "Coupons", href: listHref },
        { label: clone ? "Clone coupon" : "New coupon" },
      ]}
    />
  );
}
