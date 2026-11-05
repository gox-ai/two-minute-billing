import { requirePermission } from "@/lib/session";
import { loadChargeContext } from "@/lib/charge-context";
import { getCustomer, listBusinesses } from "@/lib/api";
import { accountHolderName } from "@/lib/names";
import { ErrorState } from "@/components/states";
import { PageHeader } from "@/components/page-header";
import { CustomerChargeForm } from "@/components/charges/customer-charge-form";

export const dynamic = "force-dynamic";

/**
 * `Add Charge` page.
 * Catalog-driven: the repeater opens a "Search Charges" picker over charge-kind
 * catalog items. There is deliberately no free-text amount field — for a one-off
 * amount the operator wants Create Quick Charge instead.
 */
export default async function CustomerAddChargePage({
  params,
}: {
  params: Promise<{ biz: string; cus: string }>;
}) {
  const { biz, cus } = await params;
  await requirePermission("customers:view", "ops");

  const [ctx, businesses, customer] = await Promise.all([
    loadChargeContext(biz, cus),
    listBusinesses().catch(() => null),
    getCustomer(biz, cus).catch(() => null),
  ]);
  if ("error" in ctx) {
    return (
      <>
        <PageHeader title="Add Charge" breadcrumbs={[{ label: "Businesses", href: "/" }]} />
        <ErrorState description={<span className="font-mono text-xs">{ctx.error}</span>} />
      </>
    );
  }

  return (
    <CustomerChargeForm
      biz={biz}
      cus={cus}
      mode="catalog"
      defaultCurrency={ctx.txnCurrency}
      bizCurrencies={ctx.bizCurrencies}
      chargePrices={ctx.chargePrices}
      products={ctx.products}
      businessName={businesses?.data.find((b) => b.id === biz)?.name ?? biz}
      customerName={
        (customer && (customer.company || accountHolderName(customer) || customer.email)) || cus
      }
      autoCollection={customer?.auto_collection ?? null}
    />
  );
}
