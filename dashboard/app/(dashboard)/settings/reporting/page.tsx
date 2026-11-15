import { getMe, listBusinesses } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { SelectAnswer } from "@/components/patterns/settings-page";
import { SettingRow, SettingsCard, SettingsSaveBar } from "@/components/settings/settings-layout";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { OrgSettingsFrame } from "@/components/org-settings/org-settings-frame";
import { saveOrgSettingsAction } from "../save-actions";

export const dynamic = "force-dynamic";

// Settings → Reporting: the currency analytics totals in.
export default async function ReportingSettingsPage() {
  const me = await requirePermission("settings:manage", "admin");

  let org: Awaited<ReturnType<typeof getMe>>;
  let businesses: Awaited<ReturnType<typeof listBusinesses>>;
  try {
    [org, businesses] = await Promise.all([getMe(), listBusinesses()]);
  } catch (e) {
    return (
      <ErrorState
        title="We could not connect to the API"
        description={<span className="font-mono text-xs">{(e as Error).message}</span>}
      />
    );
  }

  // Real options only: the currencies the organization bills in (every business's
  // default and additional currencies), deduped and sorted.
  const currencyOptions = Array.from(
    new Set(
      businesses.data.flatMap((b) => [
        ...(b.default_currency ? [b.default_currency.toUpperCase()] : []),
        ...(b.currencies ?? []).map((c) => c.toUpperCase()),
      ]),
    ),
  ).sort();
  const several = currencyOptions.length > 1;

  return (
    <OrgSettingsFrame
      page="reporting"
      description="How analytics adds up amounts from all your businesses."
      liveAccessLocked={me.organization_live_access === "locked"}
    >
      <ActionForm action={saveOrgSettingsAction} className="flex flex-col gap-5">
        <SettingsCard title="Analytics" meta="Billed and stored amounts do not change">
          <SettingRow
            label="Reporting currency"
            htmlFor="base_currency"
            errorFor="base_currency"
            placement="end"
            help={
              several
                ? "Your businesses bill in more than one currency. Analytics converts each into this one with the rates on file, then adds them."
                : "Analytics reports in this currency and converts amounts billed in other currencies."
            }
            more={
              several
                ? "If a currency has no rate, we name it and do not drop it. Until you select a currency, we refuse a cross-currency total. A currency set on a request takes priority."
                : undefined
            }
            control={
              <SelectAnswer
                name="base_currency"
                defaultValue={org.base_currency ?? ""}
                ariaLabel="Reporting currency"
                options={[
                  { value: "", label: "Not set. Ask me each time" },
                  ...currencyOptions.map((c) => ({ value: c, label: c })),
                ]}
              />
            }
          />
        </SettingsCard>
        <SettingsSaveBar label="Save" />
      </ActionForm>
    </OrgSettingsFrame>
  );
}
