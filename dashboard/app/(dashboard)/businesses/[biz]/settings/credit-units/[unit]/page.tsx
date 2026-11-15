import { isApiNotFound, listProducts } from "@/lib/api";
import { listPlanOverdraftLimits } from "@/lib/api/credit-settings";
import { notFound } from "next/navigation";
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
    if (isApiNotFound(e)) notFound();
    return (
      <>
        <PageHeader title="Edit credit unit" />
        <ErrorState
          error={e}
          thing="credit unit"
          back={{ label: "View credit units", href: `/businesses/${biz}/settings/credit-units` }}
          retry
        />
      </>
    );
  }
  if (!u) notFound();
  const noValue = u.minor_per_unit == null;
  // A save replaces the stored plan limits with the form's list, so the form must never start
  // from a list that failed to load: that save would remove every stored limit.
  let products: Awaited<ReturnType<typeof listProducts>> | null = null;
  let planOverdrafts: Awaited<ReturnType<typeof listPlanOverdraftLimits>> = [];
  if (noValue) {
    try {
      [products, planOverdrafts] = await Promise.all([
        listProducts(biz),
        listPlanOverdraftLimits(biz, unit),
      ]);
    } catch (e) {
      return (
        <>
          <PageHeader title="Edit credit unit" />
          <ErrorState
            error={e}
            thing="plan overdraft limits"
            title="We could not load the plan overdraft limits of this unit."
            back={{ label: "View credit units", href: `/businesses/${biz}/settings/credit-units` }}
            retry
          />
        </>
      );
    }
  }
  const planOptions = (products?.data ?? [])
    .filter((p) => (p.kind ?? "plan") === "plan")
    .map((p) => ({ value: p.id, label: p.name }));
  const listHref = `/businesses/${biz}/settings/credit-units`;
  return (
    <CreditUnitForm
      biz={biz}
      unit={u}
      returnTo={listHref}
      planOptions={planOptions}
      planOverdrafts={planOverdrafts.flatMap((o) =>
        o.product ? [{ product: o.product, overdraft_limit: o.overdraft_limit }] : [],
      )}
      currencies={business ? businessCurrencyOptions(business) : null}
      defaultCurrency={u.currency}
      archive={<ArchiveCreditUnitButton biz={biz} unit={u} />}
      crumbs={[
        { label: "Settings", href: `/businesses/${biz}/settings` },
        { label: "Credit units", href: listHref },
        { label: u.plural_name },
      ]}
    />
  );
}
