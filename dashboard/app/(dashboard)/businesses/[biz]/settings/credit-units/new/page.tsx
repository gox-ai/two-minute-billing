import { getBusiness } from "@/lib/api/business-settings";
import { businessCurrencyOptions } from "@/lib/business-currencies";
import { requirePermission } from "@/lib/session";
import { CreditUnitForm } from "@/components/credits/credit-unit-form";

export const dynamic = "force-dynamic";

export default async function NewCreditUnitPage({ params }: { params: Promise<{ biz: string }> }) {
  await requirePermission("credits:manage", "ops");
  const { biz } = await params;
  const business = await getBusiness(biz).catch(() => undefined);
  const listHref = `/businesses/${biz}/settings/credit-units`;
  return (
    <CreditUnitForm
      biz={biz}
      returnTo={listHref}
      currencies={business ? businessCurrencyOptions(business) : null}
      defaultCurrency={(business?.default_currency ?? "USD").toUpperCase()}
      crumbs={[
        { label: business?.name ?? biz, href: `/businesses/${biz}` },
        { label: "Settings", href: `/businesses/${biz}/settings` },
        { label: "Credit units", href: listHref },
        { label: "New credit unit" },
      ]}
    />
  );
}
