import { listBusinesses } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { MeterForm } from "@/components/catalog/meter-form";
import { getModelPriceSource } from "@/lib/api/model-prices";

export const dynamic = "force-dynamic";

export default async function NewMeterPage({ params }: { params: Promise<{ biz: string }> }) {
  await requirePermission("meters:manage", "manager");
  const { biz } = await params;
  const businesses = await listBusinesses().catch(() => null);
  const name = businesses?.data.find((b) => b.id === biz)?.name ?? biz;
  const listHref = `/businesses/${biz}/catalog/meters`;
  const b = businesses?.data.find((x) => x.id === biz);
  const currencies = [b?.default_currency, ...(b?.currencies ?? [])].filter(
    (c): c is string => !!c,
  );
  const providers = (await getModelPriceSource().catch(() => null))?.providers ?? [];
  return (
    <MeterForm
      biz={biz}
      providers={providers}
      currencies={currencies}
      returnTo={listHref}
      crumbs={[
        { label: name, href: `/businesses/${biz}` },
        { label: "Product Catalog" },
        { label: "Meters", href: listHref },
        { label: "New meter" },
      ]}
    />
  );
}
