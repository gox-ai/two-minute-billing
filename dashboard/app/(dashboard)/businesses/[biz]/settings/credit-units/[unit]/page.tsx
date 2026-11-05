import { getBusiness } from "@/lib/api/business-settings";
import { getCreditUnit } from "@/lib/api/credits";
import { businessCurrencyOptions } from "@/lib/business-currencies";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { ArchiveCreditUnitButton, CreditUnitForm } from "@/components/credits/credit-unit-form";

export const dynamic = "force-dynamic";

export default async function EditCreditUnitPage({
  params,
}: {
  params: Promise<{ biz: string; unit: string }>;
}) {
  await requirePermission("credits:manage", "ops");
  const { biz, unit } = await params;
  let business, u;
  try {
    [business, u] = await Promise.all([getBusiness(biz), getCreditUnit(biz, unit)]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Edit credit unit" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  if (!u)
    return (
      <>
        <PageHeader title="Edit credit unit" />
        <ErrorState title="Not found" description={`We could not find the credit unit ${unit}.`} />
      </>
    );
  const listHref = `/businesses/${biz}/settings/credit-units`;
  return (
    <CreditUnitForm
      biz={biz}
      unit={u}
      returnTo={listHref}
      currencies={business ? businessCurrencyOptions(business) : null}
      defaultCurrency={u.currency}
      archive={<ArchiveCreditUnitButton biz={biz} unit={u} />}
      crumbs={[
        { label: business?.name ?? biz, href: `/businesses/${biz}` },
        { label: "Settings", href: `/businesses/${biz}/settings` },
        { label: "Credit units", href: listHref },
        { label: u.plural_name },
      ]}
    />
  );
}
