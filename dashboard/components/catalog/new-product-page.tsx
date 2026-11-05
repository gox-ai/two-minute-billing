import { listBusinesses, listProductGroups } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { ProductForm } from "@/components/catalog/product-form";
import { ErrorState } from "@/components/states";
import { productImageSupport } from "@/lib/api/product-images";

const META = {
  plan: { noun: "plan", plural: "Plans", page: "plans" },
  addon: { noun: "addon", plural: "Addons", page: "addons" },
  charge: { noun: "one-time product", plural: "One-time products", page: "charges" },
} as const;

/** The New plan / addon / charge page body; the three routes differ only by kind. */
export async function NewProductPage({
  biz,
  kind,
  group,
}: {
  biz: string;
  kind: "plan" | "addon" | "charge";
  group?: string;
}) {
  const meta = META[kind];
  let businesses, groups, imageSupport;
  try {
    [businesses, groups, imageSupport] = await Promise.all([
      listBusinesses(),
      listProductGroups(biz),
      productImageSupport(),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title={`New ${meta.noun}`} />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const business = businesses.data.find((b) => b.id === biz);
  const listHref = `/businesses/${biz}/catalog/${meta.page}`;
  return (
    <ProductForm
      biz={biz}
      kind={kind}
      groups={groups.data}
      defaultGroup={group}
      imageSupport={imageSupport}
      listHref={listHref}
      crumbs={[
        { label: business?.name ?? biz, href: `/businesses/${biz}` },
        { label: "Product Catalog" },
        { label: meta.plural, href: listHref },
        { label: `New ${meta.noun}` },
      ]}
      business={{
        default_currency: business?.default_currency,
        currencies: business?.currencies,
        billing_frequencies: business?.billing_frequencies,
        default_tax_behavior: business?.default_tax_behavior,
        tax_behavior_by_currency: business?.tax_behavior_by_currency,
        default_tax_code: business?.default_tax_code ?? null,
      }}
    />
  );
}
