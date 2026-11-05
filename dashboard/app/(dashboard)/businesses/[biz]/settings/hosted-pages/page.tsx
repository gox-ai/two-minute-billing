import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { listPrices, listProducts } from "@/lib/api";
import { money } from "@/lib/format";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { saveHostedPagesAction } from "../actions";
import { HostedPagesFields, type HostedPagesDefaults } from "./hosted-pages-form";

export const dynamic = "force-dynamic";

/**
 * Hosted pages → what a CUSTOMER may do on the checkout and the self-serve portal.
 * Separate from Brand styles (that surface's identity); this page is its behaviour.
 *
 * Not here: a plan-change switch — the portal has no route for it, so a switch would
 * reach nothing. It arrives with its route.
 */
export default async function HostedPagesSettings({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
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
  // ⚠️ The three portal permissions default ON (`!== false`); everything else defaults
  // OFF (`=== true`). Reading them alike would misreport an unconfigured business.
  const d: HostedPagesDefaults = {
    coupons: b.allow_customer_coupons === true,
    couponCodeLimit: b.max_customer_coupon_codes ?? 1,
    invoiceDownload: sc?.allow_invoice_download !== false,
    invoicePayment: sc?.allow_invoice_payment !== false,
    removePaymentMethod: sc?.allow_remove_payment_method !== false,
    cancel: sc?.allow_cancel_subscription === true,
    cancelTiming: sc?.cancel_timing === "immediately" ? "immediately" : "end_of_term",
    pauseResume: sc?.allow_pause_resume === true,
    reactivate: sc?.allow_reactivate === true,
    skipRenewal: sc?.allow_skip_renewal === true,
    skipRenewalLimit:
      Number.isInteger(sc?.skip_renewal_limit) &&
      sc!.skip_renewal_limit! >= 1 &&
      sc!.skip_renewal_limit! <= 12
        ? sc!.skip_renewal_limit!
        : 3,
    hideZeroLines: sc?.hide_zero_value_lines === true,
    collectPoNumber: sc?.collect_po_number === true,
    returnUrl: sc?.default_return_url ?? "",
    cancelUrl: sc?.default_cancel_url ?? "",
    linkErrorHtml: sc?.portal_link_error_html ?? "",
    oneTimeSave:
      sc?.one_time_save_payment_method === "never" || sc?.one_time_save_payment_method === "always"
        ? sc.one_time_save_payment_method
        : "ask",
    showUsage: sc?.portal_show_usage !== false,
    showUsageProjection: sc?.portal_show_usage_projection === true,
    recurringConsent: sc?.recurring_consent === true,
    requireTerms: sc?.require_terms === true,
    termsUrl: sc?.terms_url ?? "",
    privacyUrl: sc?.privacy_url ?? "",
    marketingConsent: sc?.marketing_consent === true,
    checkoutLayout: sc?.checkout_layout === "one_page" ? "one_page" : "steps",
    walletsFirst: sc?.wallets_first === true,
    botCheckAfterFailures: sc?.bot_check_after_failures ?? null,
    planChanges: sc?.allow_plan_changes === true,
    seatChanges:
      sc?.seat_changes === "increase" || sc?.seat_changes === "both" ? sc.seat_changes : "off",
    seatMin: sc?.seat_min ?? null,
    seatMax: sc?.seat_max ?? null,
    addonChanges: sc?.allow_addon_changes === true,
    shorterPeriod:
      sc?.shorter_period === "never" || sc?.shorter_period === "after_12_months"
        ? sc.shorter_period
        : "always",
    chargeUpgrade:
      sc?.charge_upgrade === "now" || sc?.charge_upgrade === "next_invoice"
        ? sc.charge_upgrade
        : "business_default",
    changeStatuses: sc?.change_statuses ?? ["active", "in_trial"],
    cancelScheduledChange: sc?.allow_cancel_scheduled_change !== false,
    cancelReason:
      sc?.cancel_reason === "off" || sc?.cancel_reason === "required"
        ? sc.cancel_reason
        : "optional",
    retentionPause: sc?.retention_pause === true,
    retentionPauseMonths:
      sc?.retention_pause_months === null ? null : (sc?.retention_pause_months ?? 3),
    retentionPauseChoice: sc?.retention_pause_choice === true,
    retentionDowngradePrice: sc?.retention_downgrade_price ?? "",
    retentionCoupon: sc?.retention_coupon ?? "",
    retentionContactUrl: sc?.retention_contact_url ?? "",
    retentionOfferOnce: sc?.retention_offer_once !== false,
    portalEmailCode: sc?.portal_email_code === true,
    portalLinkHours: sc?.portal_link_hours ?? null,
    portalEmailLinkDays: sc?.portal_email_link_days ?? null,
    portalSessionHours: sc?.portal_session_hours ?? null,
    portalHideCancelledSubscriptions: sc?.portal_hide_cancelled_subscriptions === true,
    portalHideZeroInvoices: sc?.portal_hide_zero_invoices === true,
    portalHideVoidedInvoices: sc?.portal_hide_voided_invoices === true,
    portalActions: {
      payInvoice: sc?.portal_actions?.pay_invoice !== false,
      updateCard: sc?.portal_actions?.update_card !== false,
      changePlan: sc?.portal_actions?.change_plan !== false,
      cancel: sc?.portal_actions?.cancel !== false,
    },
    portalReturnUrl: sc?.portal_return_url ?? "",
  };
  // The downgrade offer names a plan price; list the recurring plan prices to select from.
  const [priceList, productList] = await Promise.all([
    listPrices(biz).catch(() => null),
    listProducts(biz).catch(() => null),
  ]);
  const planProducts = new Map(
    (productList?.data ?? []).filter((p) => p.kind === "plan").map((p) => [p.id, p.name]),
  );
  const planPrices = (priceList?.data ?? [])
    .filter((p) => p.type === "recurring" && planProducts.has(p.product) && p.amount_minor != null)
    .map((p) => ({
      value: p.id,
      label: `${planProducts.get(p.product)} · ${money(p.amount_minor, p.currency)} every ${
        (p.interval_count ?? 1) > 1 ? `${p.interval_count} ${p.interval}s` : p.interval
      }`,
    }));

  return (
    <SettingsPage
      title="Hosted pages"
      crumbs={[{ label: "Settings", href: base }, { label: "Hosted pages" }]}
      description="What your customers can do on the hosted checkout and the self-serve portal."
    >
      <ActionForm action={saveHostedPagesAction}>
        <input type="hidden" name="biz" value={biz} />
        {b.resource_version != null ? (
          <input type="hidden" name="expected_version" value={b.resource_version} />
        ) : null}
        <SettingsColumns
          summary={<SettingsSummary items={summaryItems(d)} />}
          save={{ note: "Applies to the next page a customer opens." }}
        >
          <HostedPagesFields d={d} base={base} planPrices={planPrices} />
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}

/** "Your setup": the SAVED values, in plain lines. */
function summaryItems(d: HostedPagesDefaults) {
  const can = (pairs: Array<[boolean, string]>) => {
    const yes = pairs.filter(([on]) => on).map(([, what]) => what);
    return yes.length ? cap(yes.join(", ")) : "Nothing";
  };
  return [
    { label: "Coupon codes", value: d.coupons ? "Customers can add and remove them" : "Off" },
    {
      label: "In the portal, customers can",
      value: can([
        [d.invoiceDownload, "download invoices"],
        [d.invoicePayment, "pay unpaid invoices"],
        [d.removePaymentMethod, "remove payment methods"],
        [d.pauseResume, "pause and resume"],
        [d.skipRenewal, `skip up to ${d.skipRenewalLimit} renewals in 12 months`],
        [d.reactivate, "undo a cancellation"],
      ]),
    },
    {
      label: "Self-serve cancel",
      value: !d.cancel
        ? "Off"
        : d.cancelTiming === "immediately"
          ? "On · takes effect immediately"
          : "On · at the end of the term",
    },
    {
      label: "One-time purchases",
      value:
        d.oneTimeSave === "always"
          ? "Payment method saved"
          : d.oneTimeSave === "never"
            ? "Payment method not saved"
            : "The customer selects",
    },
    {
      label: "Checkout",
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
    {
      label: "Expired portal link",
      value: d.linkErrorHtml.trim() ? "Your own message" : "Default message",
    },
  ];
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
