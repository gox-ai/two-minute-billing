import { listBusinesses, getProduct, listProductGroups, listPrices } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ProductForm } from "@/components/catalog/product-form";
import { ErrorState } from "@/components/states";
import { productImageSupport } from "@/lib/api/product-images";

export const dynamic = "force-dynamic";

const KIND_META: Record<string, { plural: string; page: string }> = {
  plan: { plural: "Plans", page: "plans" },
  addon: { plural: "Addons", page: "addons" },
  charge: { plural: "One-time products", page: "charges" },
};

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ biz: string; prod: string }>;
}) {
  await requirePermission("catalog:manage", "manager");
  const { biz, prod } = await params;

  let businesses, product, groups, prices, imageSupport;
  try {
    [businesses, product, groups, prices, imageSupport] = await Promise.all([
      listBusinesses(),
      getProduct(biz, prod),
      listProductGroups(biz),
      listPrices(biz, { includeArchived: true }),
      productImageSupport(),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Edit" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const business = businesses.data.find((b) => b.id === biz);
  const kind = (product.kind ?? "plan") as "plan" | "addon" | "charge";
  const meta = KIND_META[kind] ?? KIND_META.plan;
  const detailHref = `/businesses/${biz}/catalog/products/${prod}`;

  return (
    <ProductForm
      biz={biz}
      kind={kind}
      groups={groups.data}
      product={product}
      listHref={detailHref}
      returnTo={detailHref}
      priceCount={prices.data.filter((p) => p.product === product.id).length}
      imageSupport={imageSupport}
      crumbs={[
        { label: business?.name ?? biz, href: `/businesses/${biz}` },
        { label: "Product Catalog" },
        { label: meta.plural, href: `/businesses/${biz}/catalog/${meta.page}` },
        { label: product.name, href: detailHref },
        { label: "Edit" },
      ]}
      business={{ default_tax_code: business?.default_tax_code ?? null }}
    />
  );
}
