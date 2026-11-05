import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { savePaymentTermsAction } from "../../actions";
import { FormIds, ruleCrumbs } from "../_parts/shared";
import { NetDaysRow } from "./net-days-row";

export const dynamic = "force-dynamic";

// Billing rules → Payment terms (Net-D). `default_due_days` is the LAST fallback in
// netTermDaysFrom: subscription, then customer, then this; 0 and null fall through.
export default async function PaymentTermsSettings({
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

  const due = b.default_due_days ?? null;

  return (
    <SettingsPage
      title="Payment terms"
      crumbs={ruleCrumbs(biz, "Payment terms")}
      description="The credit period your customers get before an invoice is due. The invoice shows it as the due date."
    >
      <ActionForm action={savePaymentTermsAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[{ label: "Default terms", value: due ? `Net ${due}` : "Due on issue" }]}
            />
          }
          save={{ note: "Applies to invoices issued from now on." }}
        >
          <SettingsCard title="Net terms" meta="Business default">
            <NetDaysRow defaultValue={due} />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
