import {
  listBusinesses,
  listCustomers,
  listPrices,
  listProducts,
  listProductGroups,
  listCoupons,
  type Coupon,
} from "@/lib/api";
import {
  listDifferentialRules,
  listPlanAddonRules,
  type DifferentialRule,
} from "@/lib/api/subscriptions";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import {
  SubscriptionCreateForm,
  type PlanAddonRule,
} from "@/components/subscriptions/subscription-create-form";
import { ErrorState } from "@/components/states";

export const dynamic = "force-dynamic";

/**
 * New subscription: customer → line builder (mandatory addons auto-included) →
 * billing/invoicing cards, beside a live first-invoice preview.
 */
export default async function NewSubscriptionPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ customer?: string; error?: string }>;
}) {
  const { biz } = await params;
  const { customer, error } = await searchParams;
  await requirePermission("subscriptions:manage", "manager");

  let businesses, customers, prices, products, productGroups;
  let coupons: { data: Coupon[] } = { data: [] };
  const rules: PlanAddonRule[] = [];
  let differentials: DifferentialRule[] = [];
  try {
    [businesses, customers, prices, products, productGroups, coupons] = await Promise.all([
      listBusinesses(),
      // Feeds the "Pick a customer" modal — bulk read, capped at the API's max
      // (>1000 customers needs a typeahead; logged under Deferred in PROGRESS).
      // FIRST PAGE ONLY — seeds the picker dialog; searching goes to the server
      // (`searchCustomersAction`). Was `limit: 1000` filtered client-side, which made
      // customer 1001 unfindable with no indication that a cap existed.
      listCustomers(biz, { limit: 25 }),
      listPrices(biz),
      listProducts(biz),
      listProductGroups(biz).catch(() => ({ data: [] })),
      // Feeds the `Add Coupon` catalog picker. Bounded list (catalog-sized), and a
      // failure here must not take down the create page — the free-text
      // `Add Coupon Code` path still works with an empty catalog.
      listCoupons(biz).catch(() => ({ data: [] as Coupon[] })),
    ]);
    // CP-6: addon applicability per plan (mandatory auto-include, recommended chips), and
    // CAT-7: plan-specific differential add-on prices (per-line Amount preview).
    const [addonRules, diffRules] = await Promise.all([
      listPlanAddonRules(biz, products.data, ["addon"]),
      listDifferentialRules(biz, products.data),
    ]);
    rules.push(...addonRules);
    differentials = diffRules;
  } catch (e) {
    return (
      <>
        <PageHeader title="New subscription" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const business = businesses.data.find((b) => b.id === biz);
  const name = business?.name ?? biz;

  return (
    <SubscriptionCreateForm
      biz={biz}
      businessName={name}
      // The RESOLVED default, not a "same as business" placeholder: the form preselects
      // this and always posts an explicit boolean, so the screen previews the real
      // outcome instead of leaving the column NULL and inheriting silently.
      businessCreatePendingInvoices={business?.create_pending_invoices === true}
      customers={customers.data.filter((c) => c.active !== false)}
      prices={prices.data}
      products={products.data}
      productGroups={productGroups.data}
      rules={rules}
      differentials={differentials}
      coupons={coupons.data}
      initialCustomer={customer}
      error={error}
    />
  );
}
