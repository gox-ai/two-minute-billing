import { getBusiness } from "@/lib/api/business-settings";
import { businessCurrencyOptions } from "@/lib/business-currencies";
import { requirePermission } from "@/lib/session";
import { CreditUnitForm } from "@/components/credits/credit-unit-form";
import { listProducts } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function NewCreditUnitPage({ params }: { params: Promise<{ biz: string }> }) {
  await requirePermission("credits:manage", "ops");
  const { biz } = await params;
  const [business, products] = await Promise.all([
    getBusiness(biz).catch(() => undefined),
    listProducts(biz).catch(() => null),
  ]);
  const planOptions = (products?.data ?? [])
    .filter((p) => (p.kind ?? "plan") === "plan")
    .map((p) => ({ value: p.id, label: p.name }));
  const listHref = `/businesses/${biz}/settings/credit-units`;
  return (
    <CreditUnitForm
      biz={biz}
      returnTo={listHref}
      planOptions={planOptions}
      currencies={business ? businessCurrencyOptions(business) : null}
      defaultCurrency={(business?.default_currency ?? "USD").toUpperCase()}
      crumbs={[
        { label: "Settings", href: `/businesses/${biz}/settings` },
        { label: "Credit units", href: listHref },
        { label: "New credit unit" },
      ]}
    />
  );
}
