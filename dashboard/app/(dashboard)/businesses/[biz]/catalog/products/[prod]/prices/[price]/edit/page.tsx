import { listBusinesses, getProduct, getPrice } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { PriceForm } from "@/components/catalog/price-form";
import { listMeters } from "@/lib/api/meters";
import { loadGrantsCreditContext } from "@/lib/api/credits";
import { ErrorState } from "@/components/states";
import type { Price } from "@/lib/api";

export const dynamic = "force-dynamic";

function freqLabel(p: Price): string {
  if (p.type === "one_time" || !p.interval) return "One-time";
  const n = p.interval_count ?? 1;
  if (n === 1)
    return (
      { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" }[p.interval] ?? p.interval
    );
  return `Every ${n} ${p.interval}s`;
}

export default async function EditPrice({
  params,
}: {
  params: Promise<{ biz: string; prod: string; price: string }>;
}) {
  await requirePermission("catalog:manage", "manager");
  const { biz, prod, price } = await params;

  let businesses, product, p;
  try {
    [businesses, product, p] = await Promise.all([
      listBusinesses(),
      getProduct(biz, prod),
      getPrice(biz, price),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Edit price" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const bizName = businesses.data.find((b) => b.id === biz)?.name ?? biz;
  const meters = p.meter ? await listMeters(biz).catch(() => null) : null;
  const credits = await loadGrantsCreditContext(
    biz,
    businesses.data.find((b) => b.id === biz),
  );
  const detailHref = `/businesses/${biz}/catalog/products/${prod}`;
  const selfHref = `${detailHref}/prices/${price}`;

  return (
    <PriceForm
      biz={biz}
      product={product}
      price={p}
      meters={meters?.data}
      credits={credits}
      returnTo={selfHref}
      crumbs={[
        { label: bizName, href: `/businesses/${biz}` },
        { label: "Product Catalog" },
        { label: product.name, href: detailHref },
        { label: `${p.currency}, ${freqLabel(p)}`, href: selfHref },
        { label: "Edit" },
      ]}
    />
  );
}
