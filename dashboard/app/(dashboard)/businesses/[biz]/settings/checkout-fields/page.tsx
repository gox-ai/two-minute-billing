import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import type { CheckoutFieldKey } from "@/lib/api";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import {
  Consequence,
  More,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { saveCheckoutFieldsAction } from "./actions";
import { CheckoutFieldsCards } from "./checkout-fields-form";
import { isAlwaysAskedCheckoutField } from "@/lib/checkout-field-rules";
import { resolveCheckout, resolvePortal } from "./field-matrix";

export const dynamic = "force-dynamic";

// Checkout & Portal → Fields. Two matrices over the same address keys: checkout (0245) and
// portal, which adds `read_only`. This is ALSO the AVS control: AVS is checked gateway-side,
// so the postal-code row says so.

const LABELS: Record<CheckoutFieldKey, string> = {
  "customer.first_name": "First name",
  "customer.last_name": "Last name",
  "customer.email": "Email",
  "customer.phone": "Phone",
  "customer.company": "Company",
  "customer.tax_registration_number": "Tax registration number",
  "billing.line1": "Address line 1",
  "billing.line2": "Address line 2",
  "billing.line3": "Address line 3",
  "billing.city": "City",
  "billing.state": "State name",
  "billing.state_code": "State code",
  "billing.postal_code": "Postal code",
  "billing.country": "Country",
  "invoice.po_number": "PO number",
  "shipping.address": "Shipping address",
};

export default async function CheckoutFieldsSettings({
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
  const locks = b.address_field_locks ?? null;
  const checkout = resolveCheckout(b.checkout_field_config, locks);
  const portal = resolvePortal(b.portal_field_config, locks);
  const collectsPoNumber = b.storefront_config?.collect_po_number === true;

  // Email, PO number and shipping have their own lines, so they stay out of the lists.
  const ownLine = ["customer.email", "invoice.po_number", "shipping.address"];
  const listed = (values: Record<string, string>, state: string) =>
    Object.keys(values)
      .filter((k) => !ownLine.includes(k) && values[k] === state)
      // An always-asked field stored as Hidden still shows on the checkout.
      .filter((k) => !(values === checkout && state === "hide" && isAlwaysAskedCheckoutField(k)))
      .map((k) => LABELS[k as CheckoutFieldKey]);
  const list = (labels: string[]) => (labels.length ? labels.join(", ") : "None");
  const checkoutHidden = listed(checkout, "hide");
  const portalHidden = listed(portal, "hide");
  const portalReadOnly = listed(portal, "read_only");

  return (
    <SettingsPage
      title="Checkout and portal fields"
      crumbs={[{ label: "Settings", href: base }, { label: "Checkout and portal fields" }]}
      description="Which details the hosted checkout and the portal collect from a buyer, and which are required."
    >
      <ActionForm action={saveCheckoutFieldsAction}>
        <input type="hidden" name="biz" value={biz} />
        {b.resource_version != null ? (
          <input type="hidden" name="expected_version" value={b.resource_version} />
        ) : null}
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                { label: "Required at checkout", value: list(listed(checkout, "mandatory")) },
                checkoutHidden.length > 0 && {
                  label: "Hidden at checkout",
                  value: checkoutHidden.join(", "),
                },
                { label: "Required in the portal", value: list(listed(portal, "mandatory")) },
                portalReadOnly.length > 0 && {
                  label: "Read-only in the portal",
                  value: portalReadOnly.join(", "),
                },
                portalHidden.length > 0 && {
                  label: "Hidden in the portal",
                  value: portalHidden.join(", "),
                },
                { label: "Email", value: "Always required on a new subscription" },
                {
                  label: "PO number",
                  value: !collectsPoNumber
                    ? "Not collected"
                    : checkout["invoice.po_number"] === "mandatory"
                      ? "Required"
                      : "Optional",
                },
                {
                  label: "Shipping address",
                  value:
                    checkout["shipping.address"] === "hide"
                      ? "Not collected"
                      : checkout["shipping.address"] === "mandatory"
                        ? "Required"
                        : "Optional",
                },
              ]}
            />
          }
          save={{
            note: "Applies the next time a buyer sends a checkout or saves details in the portal.",
          }}
        >
          {/* What the engine and our hosted pages do: checkout-routes.ts, the portal
              route and the storefront's details forms. */}
          <SettingsCard title="How these apply" padded>
            <div className="flex flex-col gap-2.5">
              <Consequence>
                <b>Required</b> fields must have a value before we accept a buyer&rsquo;s details.{" "}
                <b>Hidden</b> fields do not show. <b>Read-only</b> fields show the saved value in
                the portal, and the buyer cannot change it.
              </Consequence>
              <More>
                The hosted checkout always asks for a first name. State and postal code are required
                only where the buyer&rsquo;s country uses them. Country cannot be hidden, because it
                sets the state list and the postal code format. These rules do not apply when you
                edit a customer in the dashboard. A checkout form that you build on the API can send
                a hidden field, and we keep that value.
              </More>
            </div>
          </SettingsCard>
          <CheckoutFieldsCards
            checkout={checkout}
            portal={portal}
            locks={locks}
            collectsPoNumber={collectsPoNumber}
            hostedPagesHref={`${base}/hosted-pages`}
          />
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
