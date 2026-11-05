import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { money } from "@/lib/format";
import { majorStep, toMajorInput } from "@/lib/money";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { Input } from "@/components/ui/input";
import {
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { saveCardLimitAction } from "../../actions";
import { FormIds, ruleCrumbs } from "../_parts/shared";

export const dynamic = "force-dynamic";

// Billing rules → Card limit (`card_payment_limits`, 0482). invoicing/card-limit.ts: above the
// amount, collection skips card instruments and the portal offers no Pay now. Empty = no limit.
export default async function CardLimitSettings({ params }: { params: Promise<{ biz: string }> }) {
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

  const limits = b.card_payment_limits ?? {};
  // Every currency this business bills in, plus any that already holds a limit.
  const currencies = [
    ...new Set(
      [b.default_currency, ...(b.currencies ?? []), ...Object.keys(limits)]
        .filter((c): c is string => !!c)
        .map((c) => c.toUpperCase()),
    ),
  ];
  const set = currencies.filter((c) => limits[c] != null);

  return (
    <SettingsPage
      title="Card limit"
      crumbs={ruleCrumbs(biz, "Card limit")}
      description="The largest invoice amount that a customer can pay by card, for each currency."
    >
      <ActionForm action={saveCardLimitAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <input type="hidden" name="currencies" value={currencies.join(",")} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={
                set.length
                  ? set.map((c) => ({ label: c, value: money(limits[c]!, c) }))
                  : [{ label: "Card limit", value: "No limit" }]
              }
            />
          }
          save={{ note: "Applies to every collection from now on, also on open invoices." }}
        >
          <SettingsCard title="Limit per currency" meta="Amount due on the invoice">
            {currencies.length === 0 ? (
              <p className="m-0 px-5 py-4 text-sm text-muted-foreground">
                Set a default currency on the business profile first.
              </p>
            ) : (
              currencies.map((c) => (
                <SettingRow
                  key={c}
                  label={c}
                  htmlFor={`limit_${c}`}
                  errorFor={`limit_${c}`}
                  help="Leave empty for no limit. Above this amount, we do not charge a card. We charge the customer's other payment methods, if they have one. If not, the invoice stays open and the customer pays it another way. The customer portal does not show Pay now for it."
                  control={
                    <Input
                      id={`limit_${c}`}
                      name={`limit_${c}`}
                      type="number"
                      min="0"
                      step={majorStep(c)}
                      inputMode="decimal"
                      className="w-full sm:w-56"
                      defaultValue={toMajorInput(limits[c] ?? null, c)}
                      placeholder="No limit"
                    />
                  }
                />
              ))
            )}
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
