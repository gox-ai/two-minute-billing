import {
  getSubscription,
  getCustomer,
  listBusinesses,
  listPrices,
  listProducts,
  listProductGroups,
  listCoupons,
  getRenewalEstimate,
  listPaymentMethods,
  type Coupon,
  type Customer,
  type Price,
  type Product,
  type ProductGroup,
  type RenewalEstimate,
} from "@/lib/api";
import { accountHolderName } from "@/lib/names";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { SubscriptionChangeForm } from "@/components/subscriptions/subscription-change-form";
import { changeRuleDefaults } from "@/lib/billing-rules";
import { loadMetadataEditor } from "@/lib/api/metadata-rules";
import type { MetadataEditorData } from "@/components/form/metadata-field";
import {
  listDifferentialRules,
  listPlanAddonRules,
  type DifferentialRule,
  type PlanAddonRule,
} from "@/lib/api/subscriptions";

export const dynamic = "force-dynamic";

/**
 * "Change subscription" form. Pre-fills from the
 * current subscription items; mandatory addons are auto-included (non-removable
 * "Required" badge); a live proration estimate rail drives POST …/:sub/estimate.
 *
 * Auth: manager. Redirects back to detail on apply.
 */
export default async function ChangeSubscriptionPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string; sub: string }>;
  searchParams: Promise<{ error?: string; msg?: string }>;
}) {
  const { biz, sub: subId } = await params;
  const { error } = await searchParams;
  await requirePermission("subscriptions:view", "manager");

  let sub,
    businesses,
    prices: { data: Price[] },
    products: { data: Product[] },
    productGroups: { data: ProductGroup[] };
  let coupons: { data: Coupon[] } = { data: [] };
  let customer: Customer | null = null;
  // In trial, "End the trial now" bills the FIRST TERM today — so the confirm dialog needs
  // that invoice's real figure. Nothing else on this screen can supply it: the change
  // estimate prices the item edits, not the term. Tolerated failure; the form then states
  // the mechanism without quoting a number rather than quoting a wrong one.
  let firstTerm: RenewalEstimate | null = null;
  /**
   * Does the payer have ANY payment method row? That is the exact test the engine runs at
   * a trial end (`isUncollectableAutoCollect`): auto-collect on + no payment method at all
   * + an amount owed ⇒ it CANCELS the subscription with `no_card` instead of activating it.
   * "End the trial now" walks straight into that, so the screen has to say so. `null` =
   * unknown (fetch failed) and claims nothing.
   */
  let hasPaymentMethod: boolean | null = null;
  const rules: PlanAddonRule[] = [];
  let differentials: DifferentialRule[] = [];
  let metadataEditor: MetadataEditorData | null = null;

  try {
    [sub, businesses, prices, products, productGroups, coupons] = await Promise.all([
      getSubscription(biz, subId),
      listBusinesses(),
      listPrices(biz),
      listProducts(biz),
      listProductGroups(biz).catch(() => ({ data: [] })),
      // The `Add Coupon` catalog picker. Bounded list; a failure must not take the
      // page down — `Add Coupon Code` still works against an empty catalog.
      listCoupons(biz).catch(() => ({ data: [] as Coupon[] })),
    ]);

    // Build plan→addon applicability rules (mandatory auto-include + recommended chips).
    // CAT-7: plan-specific differential add-on prices, for the per-line Amount preview.
    const [addonRules, diffRules, mdEditor] = await Promise.all([
      listPlanAddonRules(biz, products.data),
      listDifferentialRules(biz, products.data),
      // Never throws: null falls back to the plain JSON field.
      loadMetadataEditor(biz, "subscription"),
    ]);
    metadataEditor = mdEditor;
    rules.push(...addonRules);
    differentials = diffRules;
    // The payer: the header chip, and the RESOLVED value behind the auto-collection
    // "inherit" option (the engine falls back to `customers.auto_collection` when the
    // subscription's own column is null). Tolerated failure — the form degrades to the
    // customer id and the generic inherit label rather than 500ing the whole page.
    customer = sub.customer ? await getCustomer(biz, sub.customer).catch(() => null) : null;
    if (sub.status === "in_trial") {
      [firstTerm, hasPaymentMethod] = await Promise.all([
        getRenewalEstimate(biz, subId)
          .then((r) => r.estimate)
          .catch(() => null),
        sub.customer
          ? listPaymentMethods(biz, sub.customer)
              .then((r) => r.data.length > 0)
              .catch(() => null)
          : Promise.resolve(null),
      ]);
    }
  } catch (e) {
    return (
      <>
        <PageHeader
          title="Change subscription"
          breadcrumbs={[
            { label: "Businesses", href: "/" },
            { label: biz, href: `/businesses/${biz}` },
            { label: "Subscriptions", href: `/businesses/${biz}/subscriptions` },
            { label: subId, href: `/businesses/${biz}/subscriptions/${subId}` },
            { label: "Change" },
          ]}
        />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const bizRow = businesses.data.find((b) => b.id === biz);
  const name = bizRow?.name ?? biz;

  return (
    <SubscriptionChangeForm
      biz={biz}
      sub={subId}
      businessName={name}
      // Proration dates render in the business timezone, not UTC.
      tz={bizRow?.timezone ?? null}
      // The business's own Invoicing Options default, so the form PRESELECTS what would
      // happen rather than assuming. `changeSubscription` resolves this exact column when
      // a request omits `invoice_immediately` (2026-08-19), and `?? false` matches the
      // engine's own tail for a row it cannot read. `serializeBusiness` puts it on the
      // list payload, so no extra fetch.
      defaultInvoiceImmediately={bizRow?.default_invoice_immediately ?? false}
      reactivationCharges={
        bizRow?.billing_rules_config?.reactivation_charges ?? "invoice_immediately"
      }
      // Resolved as `resolveDunningConfig` does: an absent key inherits
      // `collect_on_payment_method_update`, and both absent mean refuse.
      reactivationChargeFailure={
        (bizRow?.dunning_config?.require_successful_charge_on_reactivation ??
        bizRow?.dunning_config?.collect_on_payment_method_update ??
        true)
          ? "refuse"
          : "dun"
      }
      // The rules a change may override for itself, resolved: each control's preselection.
      changeRules={changeRuleDefaults(bizRow)}
      currency={sub.currency}
      // Billing Cycles is already on the subscription this page fetched, so hand it over
      // rather than making the client round-trip for it. Without this prop the control
      // has to load its own value and sits disabled until it arrives — and the one thing
      // it must never do is render a confident "Forever" before it knows. `null` IS the
      // real answer for an uncapped subscription, hence `?? null` and not `?? 0`.
      remainingBillingCycles={sub.remaining_billing_cycles ?? null}
      items={sub.items ?? []}
      prices={prices.data}
      products={products.data}
      productGroups={productGroups.data}
      rules={rules}
      differentials={differentials}
      coupons={coupons.data}
      // The discount ALREADY on the subscription — distinct from `coupons`, which is the
      // catalog this screen can add FROM. Without it the form could not tell a discounted
      // subscription from an undiscounted one: it offered "Add Coupon" on both, and the
      // engine refuses the second one ("A discount is already applied to this
      // subscription"). Already on the payload this page fetches; nothing new is loaded.
      appliedDiscount={sub.discount ?? null}
      customerId={sub.customer ?? ""}
      // The ACCOUNT HOLDER — this form changes the account's subscription, so it
      // names the account, never the billing contact who receives its invoices. The
      // hand-rolled chain here also skipped `company`, so a company-only customer fell
      // through to the legacy `name` (now last) or the email.
      customerName={(customer ? accountHolderName(customer) : null) ?? sub.customer ?? ""}
      customerAutoCollection={customer?.auto_collection ?? null}
      status={sub.status}
      // null throughout a trial; the form's `canApplyAtTermEnd` already treats absent as
      // "no term to apply at", which is the correct reading for a trialling subscription.
      currentPeriodEnd={sub.current_period_end ?? undefined}
      trialEnd={sub.trial_end ?? null}
      firstTerm={firstTerm}
      hasPaymentMethod={hasPaymentMethod}
      autoCollection={sub.auto_collection ?? null}
      poNumber={sub.po_number ?? null}
      invoiceNotes={sub.invoice_notes ?? null}
      metadata={sub.metadata ?? null}
      metadataEditor={metadataEditor}
      error={error}
    />
  );
}
