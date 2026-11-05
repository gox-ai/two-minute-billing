import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import {
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { SettingSwitch } from "@/components/settings/setting-switch";
import { AddressFormatField } from "@/components/settings/address-format-field";
import { SignatureImageField } from "@/components/settings/signature-image-field";
import { brandImageSupport } from "@/lib/api/brand-images";
import { saveDocumentFieldsAction, savePaymentInstructionSettingsAction } from "../actions";
import { PaymentInstructionRows } from "./payment-instruction-rows";

export const dynamic = "force-dynamic";

const ADDRESS_FORMAT = { expanded: "Expanded", single_line: "Single line", custom: "Custom" };

/**
 * Settings → Documents: what BOTH the invoice and the credit note show — kept off the
 * per-document pages so editing invoices never silently changes credit notes.
 */
export default async function DocumentSettings({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");

  // Whether a file picker can work at all — see the brand settings page.
  const upload = await brandImageSupport();

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
  // Each default is the engine resolver's value, so an unset key renders as what the
  // document already does — never as `false`.
  const common = b.invoice_customization?.common ?? null;
  const signature = b.invoice_customization?.signature ?? null;
  const pi = b.invoice_customization?.payment_instructions ?? null;

  const fields = {
    show_customer_id: common?.show_customer_id ?? true,
    show_subscription_id: common?.show_subscription_id ?? true,
    show_customer_info: common?.show_customer_info ?? true,
    show_shipping_info: common?.show_shipping_info ?? false,
    show_payment_stub: common?.show_payment_stub ?? true,
    show_exchange_rate: common?.show_exchange_rate ?? false,
  };
  const FIELD_NAMES: Record<keyof typeof fields, string> = {
    show_customer_id: "customer ID",
    show_subscription_id: "subscription ID",
    show_customer_info: "billing address",
    show_shipping_info: "shipping address",
    show_payment_stub: "payments footer",
    show_exchange_rate: "exchange rate",
  };
  const shown = (Object.keys(fields) as Array<keyof typeof fields>).filter((k) => fields[k]);
  const addressFormat = common?.address_format ?? "expanded";
  const position = signature?.position ?? "bottom_right";
  const sigParts = [signature?.image_url && "image", signature?.caption && "caption"].filter(
    (p): p is string => !!p,
  );
  const piMode = pi?.mode ?? "all";
  const piPersonalize = pi?.personalize ?? false;

  const toggle = (name: keyof typeof fields, label: string) => (
    <SettingSwitch name={name} label={label} defaultChecked={fields[name]} />
  );

  return (
    <SettingsPage
      title="Documents"
      crumbs={[{ label: "Settings", href: base }, { label: "Documents" }]}
      description="What appears on both your invoices and your credit notes."
    >
      <SettingsColumns
        summary={
          <SettingsSummary
            items={[
              {
                label: "Shows",
                value: shown.length
                  ? capitalise(shown.map((k) => FIELD_NAMES[k]).join(", "))
                  : "None of the optional fields",
              },
              { label: "Seller address", value: ADDRESS_FORMAT[addressFormat] },
              {
                label: "Signature",
                value: sigParts.length
                  ? `${capitalise(sigParts.join(" and "))} · ${position === "bottom_left" ? "bottom left" : "bottom right"}`
                  : "None",
              },
              {
                label: "Payment instructions",
                value: `${piMode === "preferred_offline" ? "Customer's preferred method" : "All"}${
                  piPersonalize ? ", matched to the invoice" : ""
                }`,
              },
            ]}
          />
        }
      >
        <ActionForm action={saveDocumentFieldsAction} className="flex flex-col gap-5">
          <input type="hidden" name="biz" value={biz} />
          {b.resource_version != null ? (
            <input type="hidden" name="expected_version" value={b.resource_version} />
          ) : null}

          <SettingsCard title="Shared fields" meta="On invoices and credit notes">
            <SettingRow
              label="Customer ID"
              placement="end"
              control={toggle("show_customer_id", "Show the customer ID")}
            />
            <SettingRow
              label="Subscription ID"
              placement="end"
              control={toggle("show_subscription_id", "Show the subscription ID")}
            />
            <SettingRow
              label="Billing address & customer tax number"
              // The name the document is addressed to is deliberately not toggleable.
              help="The customer's address and their GSTIN / VAT number. The name the document is addressed to always shows."
              placement="end"
              control={toggle("show_customer_info", "Show the billing address and tax number")}
            />
            <SettingRow
              label="Shipping address"
              help="Shows only when the customer or the invoice has a shipping address."
              placement="end"
              control={toggle("show_shipping_info", "Show the shipping address")}
            />
            <SettingRow
              label="Payments and refunds"
              // Gates the footer LIST only; the totals keep their Payments line.
              help="The list of payments at the foot of the document. The totals still show the amount paid, so the totals stay correct."
              placement="end"
              control={toggle("show_payment_stub", "Show the payments and refunds footer")}
            />
            <SettingRow
              label="Exchange rate"
              // The rate stamped when the document was issued (0228), never today's.
              help={`For a document in a currency other than ${b.default_currency ?? "your default currency"}. We show the rate on the day that we issued the document, if the Currencies page had a rate for that currency. A credit note shows the rate of its invoice.`}
              placement="end"
              control={toggle("show_exchange_rate", "Show the exchange rate")}
            />
          </SettingsCard>

          <AddressFormatField
            defaultFormat={addressFormat}
            defaultCustom={common?.custom_address ?? ""}
            address={b.address ?? null}
          />

          <SettingsCard title="Signature" meta="At the foot of every invoice and credit note">
            <SettingRow
              label="Position"
              htmlFor="signature_position"
              // Pinned to the PDF page foot so a short invoice does not sign halfway up.
              help="Pinned to that corner at the foot of the page, above your contact line."
              control={
                <SelectField
                  name="signature_position"
                  defaultValue={position}
                  className="w-full sm:w-56"
                  options={[
                    { value: "bottom_right", label: "Bottom right" },
                    { value: "bottom_left", label: "Bottom left" },
                  ]}
                />
              }
            />
            <SettingRow
              label="Signature line"
              htmlFor="signature_caption"
              errorFor="signature_caption"
              help="Plain text, for example “Authorised by Acme Billing”. Maximum 500 characters."
              control={
                <Input
                  id="signature_caption"
                  name="signature_caption"
                  defaultValue={signature?.caption ?? ""}
                  maxLength={500}
                  placeholder="Authorised by …"
                />
              }
            />
            <div className="px-5 py-4">
              <SignatureImageField
                biz={biz}
                defaultValue={signature?.image_url ?? ""}
                upload={upload}
              />
            </div>
          </SettingsCard>

          <div>
            <SubmitButton>Save document fields</SubmitButton>
          </div>
        </ActionForm>

        <ActionForm action={savePaymentInstructionSettingsAction}>
          <input type="hidden" name="biz" value={biz} />
          {b.resource_version != null ? (
            <input type="hidden" name="expected_version" value={b.resource_version} />
          ) : null}
          <SettingsCard
            title="Payment instructions"
            meta="Which of your instructions print on an invoice"
            actions={
              <Link href={`${base}/payment-instructions`} className="text-primary hover:underline">
                Manage instructions
              </Link>
            }
            footer={
              <SubmitButton size="sm" variant="outline">
                Save payment instruction settings
              </SubmitButton>
            }
          >
            <PaymentInstructionRows mode={piMode} personalize={piPersonalize} />
          </SettingsCard>
        </ActionForm>
      </SettingsColumns>
    </SettingsPage>
  );
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
