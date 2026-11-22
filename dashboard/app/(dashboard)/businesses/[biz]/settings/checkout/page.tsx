import Link from "next/link";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { saveCheckoutSettingsAction } from "../actions";
import { CheckoutFields, type CheckoutDefaults } from "./checkout-form";

export const dynamic = "force-dynamic";

/**
 * Checkout → how the hosted checkout looks and what it asks a buyer. The portal has its own
 * page; both write one `storefront_config`, so this page's save sends only its own keys
 * (see `saveCheckoutSettingsAction`).
 */
export default async function CheckoutSettings({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");

  let b;
  try {
    b = await getBusiness(biz);
  } catch (e) {
    return (
      <ErrorState description={<span className="font-mono text-xs">{(e as Error).message}</span>} />
    );
  }
  if (!b)
    return <ErrorState title="Not found" description={`We could not find the business ${biz}.`} />;

  const base = `/businesses/${biz}/settings`;
  const sc = b.storefront_config;
  const d: CheckoutDefaults = {
    coupons: b.allow_customer_coupons === true,
    couponCodeLimit: b.max_customer_coupon_codes ?? 1,
    hideZeroLines: sc?.hide_zero_value_lines === true,
    collectPoNumber: sc?.collect_po_number === true,
    returnUrl: sc?.default_return_url ?? "",
    cancelUrl: sc?.default_cancel_url ?? "",
    oneTimeSave:
      sc?.one_time_save_payment_method === "never" || sc?.one_time_save_payment_method === "always"
        ? sc.one_time_save_payment_method
        : "ask",
    recurringConsent: sc?.recurring_consent === true,
    requireTerms: sc?.require_terms === true,
    termsUrl: sc?.terms_url ?? "",
    privacyUrl: sc?.privacy_url ?? "",
    marketingConsent: sc?.marketing_consent === true,
    checkoutLayout: sc?.checkout_layout === "one_page" ? "one_page" : "steps",
    botCheckAfterFailures: sc?.bot_check_after_failures ?? null,
  };

  return (
    <SettingsPage
      title="Checkout"
      crumbs={[{ label: "Settings", href: base }, { label: "Checkout" }]}
      description="How the hosted checkout looks and what it asks a buyer."
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href={`/businesses/${biz}/reports/checkout`}>Checkout report</Link>
        </Button>
      }
    >
      <ActionForm action={saveCheckoutSettingsAction}>
        <input type="hidden" name="biz" value={biz} />
        {b.resource_version != null ? (
          <input type="hidden" name="expected_version" value={b.resource_version} />
        ) : null}
        <SettingsColumns
          summary={<SettingsSummary items={summaryItems(d)} />}
          save={{ note: "Applies to the next checkout a customer opens." }}
        >
          <CheckoutFields d={d} base={base} />
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}

/** "Your setup": the SAVED values, in plain lines. */
function summaryItems(d: CheckoutDefaults) {
  const save = (v: CheckoutDefaults["oneTimeSave"]) =>
    v === "always"
      ? "Payment method saved"
      : v === "never"
        ? "Payment method not saved"
        : "The customer selects";
  return [
    { label: "Layout", value: d.checkoutLayout === "one_page" ? "One page" : "Steps" },
    {
      label: "Consent",
      value:
        [
          d.recurringConsent ? "Recurring charge" : null,
          d.requireTerms ? "Terms" : null,
          d.marketingConsent ? "Marketing opt-in" : null,
        ]
          .filter(Boolean)
          .join(" · ") || "Not asked",
    },
    { label: "Coupon codes", value: d.coupons ? "Customers can add and remove them" : "Off" },
    { label: "One-time purchases", value: save(d.oneTimeSave) },
    {
      label: "Line items",
      value: [
        d.hideZeroLines ? "Zero-value lines hidden" : "All lines shown",
        d.collectPoNumber ? "PO number collected" : null,
      ]
        .filter(Boolean)
        .join(" · "),
    },
    {
      label: "Redirect defaults",
      value:
        d.returnUrl && d.cancelUrl
          ? "Return and cancel URLs set"
          : d.returnUrl || d.cancelUrl
            ? `Only the ${d.returnUrl ? "return" : "cancel"} URL is set`
            : "None. Every call must send both.",
    },
  ];
}
