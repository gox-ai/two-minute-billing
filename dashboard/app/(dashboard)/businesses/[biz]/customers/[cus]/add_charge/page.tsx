import { requirePermission } from "@/lib/session";
import { loadChargeContext } from "@/lib/charge-context";
import { getCustomer, listBusinesses } from "@/lib/api";
import { accountHolderName } from "@/lib/names";
import { ErrorState } from "@/components/states";
import { PageHeader } from "@/components/page-header";
import { CustomerChargeForm } from "@/components/charges/customer-charge-form";

export const dynamic = "force-dynamic";

/**
 * `Create Quick Charge` page.
 * Ad-hoc charges: amount + service period + description, no catalog item needed.
 */
export default async function CustomerQuickChargePage({
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
        <PageHeader
          title="Create Quick Charge"
          breadcrumbs={[{ label: "Businesses", href: "/" }]}
        />
        <ErrorState description={<span className="font-mono text-xs">{ctx.error}</span>} />
      </>
    );
  }

  return (
    <CustomerChargeForm
      biz={biz}
      cus={cus}
      mode="quick"
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
