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
import { saveRoundOffAction } from "../../actions";
import { ChoiceRow } from "../_parts/rows";
import { FormIds, ruleCrumbs } from "../_parts/shared";

export const dynamic = "force-dynamic";

// Billing rules → Round-off invoice amount (`invoice_rounding`). roundingDeltaFor
// rounds the post-tax total, half up, to one major unit of the invoice's currency
// (`minorScale`): 100 minor for USD, 1000 for KWD, a no-op for JPY.
const OPTIONS = [
  {
    value: "none",
    label: "No rounding",
    consequence: "Invoices show their exact total.",
  },
  {
    value: "nearest_unit",
    label: "Round to nearest unit",
    consequence:
      "We round the total after tax to the nearest whole unit, with halves rounded up. For example, 1,234.50 becomes 1,235.00. We book the difference to its own round-off line.",
  },
];

export default async function RoundOffSettings({ params }: { params: Promise<{ biz: string }> }) {
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

  const rounding = b.invoice_rounding ?? "none";

  return (
    <SettingsPage
      title="Round-off invoice amount"
      crumbs={ruleCrumbs(biz, "Round-off")}
      description="Round the invoice total to the nearest whole currency unit."
    >
      <ActionForm action={saveRoundOffAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                {
                  label: "Invoice totals",
                  value: rounding === "nearest_unit" ? "Rounded to the nearest unit" : "Exact",
                },
              ]}
            />
          }
          save={{ note: "Applies to invoices raised from now on." }}
        >
          <SettingsCard title="Round-off" meta="Invoice total">
            <ChoiceRow
              name="invoice_rounding"
              label="Round off the invoice total"
              help="The ledger still reconciles exactly: the adjustment is its own line."
              defaultValue={rounding}
              options={OPTIONS}
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
