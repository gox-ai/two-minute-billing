import { requirePermission } from "@/lib/session";
import { loadSubscriptionChargeContext } from "@/lib/subscription-charge-context";
import { getCustomer, getSubscription, listBusinesses } from "@/lib/api";
import { accountHolderName } from "@/lib/names";
import { ErrorState } from "@/components/states";
import { PageHeader } from "@/components/page-header";
import { SubscriptionChargeForm } from "@/components/charges/subscription-charge-form";

export const dynamic = "force-dynamic";

/**
 * `Add Charge` page. Catalog-driven; no free-text amount.
 */
export default async function SubscriptionAddChargePage({
  params,
}: {
  params: Promise<{ biz: string; sub: string }>;
}) {
  const { biz, sub } = await params;
  await requirePermission("subscriptions:view", "manager");

  const [ctx, businesses, subscription] = await Promise.all([
    loadSubscriptionChargeContext(biz, sub),
    listBusinesses().catch(() => null),
    getSubscription(biz, sub).catch(() => null),
  ]);
  if ("error" in ctx) {
    return (
      <>
        <PageHeader title="Add Charge" breadcrumbs={[{ label: "Businesses", href: "/" }]} />
        <ErrorState description={<span className="font-mono text-xs">{ctx.error}</span>} />
      </>
    );
  }

  // Named the way the subscription page names it: plan product, then the account holder.
  const items = subscription?.items ?? [];
  const planName = (items.find((i) => i.product_kind === "plan") ?? items[0])?.product_name ?? sub;
  const customer = subscription?.customer
    ? await getCustomer(biz, subscription.customer).catch(() => null)
    : null;
  const customerName =
    (customer ? accountHolderName(customer) : null) ?? subscription?.customer_name ?? null;

  return (
    <SubscriptionChargeForm
      biz={biz}
      sub={sub}
      mode="catalog"
      currency={ctx.currency}
      chargePrices={ctx.chargePrices}
      products={ctx.products}
      businessName={businesses?.data.find((b) => b.id === biz)?.name ?? biz}
      planName={planName}
      customerName={customerName}
    />
  );
}
