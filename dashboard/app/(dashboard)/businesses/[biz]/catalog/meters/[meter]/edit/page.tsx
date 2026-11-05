import { listBusinesses } from "@/lib/api";
import { getMeter } from "@/lib/api/meters";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { MeterForm } from "@/components/catalog/meter-form";
import { getModelPriceSource } from "@/lib/api/model-prices";

export const dynamic = "force-dynamic";

export default async function EditMeterPage({
  params,
}: {
  params: Promise<{ biz: string; meter: string }>;
}) {
  await requirePermission("meters:manage", "manager");
  const { biz, meter } = await params;

  let businesses, m;
  try {
    [businesses, m] = await Promise.all([listBusinesses(), getMeter(biz, meter)]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Edit meter" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  if (!m)
    return (
      <>
        <PageHeader title="Edit meter" />
        <ErrorState title="Not found" description={`We could not find the meter ${meter}.`} />
      </>
    );
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;
  const listHref = `/businesses/${biz}/catalog/meters`;
  const b = businesses.data.find((x) => x.id === biz);
  const currencies = [b?.default_currency, ...(b?.currencies ?? [])].filter(
    (c): c is string => !!c,
  );
  const providers = (await getModelPriceSource().catch(() => null))?.providers ?? [];
  const detailHref = `${listHref}/${m.id}`;
  return (
    <MeterForm
      biz={biz}
      providers={providers}
      currencies={currencies}
      meter={m}
      returnTo={detailHref}
      crumbs={[
        { label: name, href: `/businesses/${biz}` },
        { label: "Product Catalog" },
        { label: "Meters", href: listHref },
        { label: m.name, href: detailHref },
        { label: "Edit" },
      ]}
    />
  );
}
