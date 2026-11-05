import { listBusinesses, getProduct } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { PriceForm } from "@/components/catalog/price-form";
import { listMeters } from "@/lib/api/meters";
import { loadGrantsCreditContext } from "@/lib/api/credits";
import { Alert } from "@/components/ui/alert";
import { ErrorState } from "@/components/states";

export const dynamic = "force-dynamic";

/**
 * Price create, pre-scoped from the pricing matrix: currency/frequency arrive
 * as query params (the empty cell clicked). `error` is set when a new plan's first
 * price failed after the plan itself was created.
 */
export default async function NewPrice({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string; prod: string }>;
  searchParams: Promise<{ currency?: string; interval?: string; type?: string; error?: string }>;
}) {
  const { biz, prod } = await params;
  const { currency, interval, type, error } = await searchParams;
  await requirePermission("catalog:manage", "manager");

  let businesses, product;
  try {
    [businesses, product] = await Promise.all([listBusinesses(), getProduct(biz, prod)]);
  } catch (e) {
    return (
      <>
        <PageHeader title="New price" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const business = businesses.data.find((b) => b.id === biz);
  // A failed read offers no meter rather than failing the page.
  const meters = await listMeters(biz)
    .then((r) => r.data.filter((m) => m.status === "active"))
    .catch(() => []);
  const credits = await loadGrantsCreditContext(biz, business);
  const detailHref = `/businesses/${biz}/catalog/products/${prod}`;

  return (
    <>
      {error ? (
        <Alert tone="warning" className="mb-6">
          {error}
        </Alert>
      ) : null}
      <PriceForm
        biz={biz}
        product={product}
        returnTo={detailHref}
        crumbs={[
          { label: business?.name ?? biz, href: `/businesses/${biz}` },
          { label: "Product Catalog" },
          { label: product.name, href: detailHref },
          { label: "New price" },
        ]}
        currencies={business?.currencies}
        billingFrequencies={business?.billing_frequencies}
        defaultCurrency={currency ?? business?.default_currency ?? undefined}
        defaultInterval={interval}
        defaultType={type === "one_time" ? "one_time" : interval ? "recurring" : undefined}
        defaultTaxBehavior={business?.default_tax_behavior}
        taxBehaviorByCurrency={business?.tax_behavior_by_currency}
        meters={meters}
        credits={credits}
      />
    </>
  );
}
