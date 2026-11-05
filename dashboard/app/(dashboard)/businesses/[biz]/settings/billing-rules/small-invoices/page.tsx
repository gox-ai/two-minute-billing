import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { money } from "@/lib/format";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { saveSmallInvoicesAction } from "../invoice-rules-actions";
import { ChoiceRow } from "../_parts/rows";
import { FormIds, ruleCrumbs } from "../_parts/shared";
import { CurrencyAmountRows, businessCurrencies } from "../_parts/currency-amounts";

export const dynamic = "force-dynamic";

// Billing rules → Small invoices (`invoice_rules_config.small_invoice_*`, 0486).
// Not offered: "Roll into the next invoice". The ledger has no carried-debit balance, and
// folding the lines into the next invoice would bill metered usage twice.
// The engine does not know gateway minimum charge amounts, so no minimum is pre-filled.
const OPTIONS = [
  {
    value: "charge",
    label: "Charge anyway",
    consequence: "We charge every renewal invoice, however small the amount due.",
  },
  {
    value: "write_off",
    label: "Write off below a limit",
    consequence:
      "When a renewal invoice is charged automatically and its amount due is below the limit for its currency, we do not charge it. We write it off with a credit note.",
  },
];

export default async function SmallInvoicesSettings({
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

  const action = b.invoice_rules_config?.small_invoice_action ?? "charge";
  const thresholds = b.invoice_rules_config?.small_invoice_thresholds ?? {};
  const currencies = businessCurrencies(b, thresholds);
  const set = currencies.filter((c) => thresholds[c] != null);

  return (
    <SettingsPage
      title="Small invoices"
      crumbs={ruleCrumbs(biz, "Small invoices")}
      description="What we do with a renewal invoice whose amount due is too small to charge."
    >
      <ActionForm action={saveSmallInvoicesAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                { label: "Small invoices", value: OPTIONS.find((o) => o.value === action)!.label },
                ...(action === "write_off"
                  ? set.map((c) => ({ label: `Limit ${c}`, value: money(thresholds[c]!, c) }))
                  : []),
              ]}
            />
          }
          save={{ note: "Applies to renewals from now on." }}
        >
          <SettingsCard title="Small invoices" meta="Amount due">
            <ChoiceRow
              name="small_invoice_action"
              label="When the amount due is small"
              help="Invoices that the customer pays without auto-collection are not changed."
              defaultValue={action}
              options={OPTIONS}
            />
          </SettingsCard>
          <SettingsCard title="Limit per currency" meta="Amount due">
            <CurrencyAmountRows
              currencies={currencies}
              amounts={thresholds}
              help="Used with “Write off below a limit”. An amount due below this is written off. Leave empty to charge every amount."
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
