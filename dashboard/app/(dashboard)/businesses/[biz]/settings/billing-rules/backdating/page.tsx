import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { saveBackdatingAction } from "../../actions";
import { FormIds, ruleCrumbs } from "../_parts/shared";
import { BackdatingFields } from "./backdating-fields";
import { ACTIONS, type BackdateAction } from "./operations";

export const dynamic = "force-dynamic";

// Billing rules → Backdating (`backdating_config`). The one screen here that can REFUSE
// operations the API accepts today: backdating is unbounded by default, so every control
// only narrows. Resolved by resolveBackdatingConfig and enforced by isBackdateAllowed at
// the create / change / cancel / reactivate call sites.
const ACTION_KEYS = ACTIONS.map((a) => a.value);

export default async function BackdatingSettings({ params }: { params: Promise<{ biz: string }> }) {
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

  const stored = b.backdating_config ?? null;
  // Mirror the engine resolver: every default is permissive.
  const enabled = stored?.enabled ?? true;
  const rawActions = stored?.allowed_actions;
  let allowed: BackdateAction[];
  if (!Array.isArray(rawActions)) {
    allowed = ACTION_KEYS;
  } else {
    const known = ACTION_KEYS.filter((a) => rawActions.includes(a));
    // Empty = the merchant unchecked everything; nothing recognisable = malformed → default.
    allowed = known.length > 0 || rawActions.length === 0 ? known : ACTION_KEYS;
  }
  const rawCutoff = stored?.cutoff_day_of_month ?? null;
  const cutoff =
    rawCutoff != null && Number.isInteger(rawCutoff) && rawCutoff >= 1 && rawCutoff <= 10
      ? String(rawCutoff)
      : "";
  const pastOnCreate = stored?.allow_past_invoice_date_on_create ?? true;
  const pastOnChange = stored?.allow_past_invoice_date_on_change ?? true;
  const timezone = b.timezone || "UTC";

  const labels = ACTIONS.filter((a) => allowed.includes(a.value)).map((a) =>
    a.label.replace(" subscription", "").toLowerCase(),
  );
  const pastInvoices = [
    allowed.includes("create") && pastOnCreate && "on create",
    allowed.includes("change") && pastOnChange && "on change",
  ].filter(Boolean);

  return (
    <SettingsPage
      title="Backdating"
      crumbs={ruleCrumbs(biz, "Backdating")}
      description="Whether subscription operations may use a date in the past, and how far back. Backdating has no limits until you set them here. Each setting can make us reject requests that the API accepts today."
    >
      <ActionForm action={saveBackdatingAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={
                enabled
                  ? [
                      {
                        label: "Operations",
                        value: labels.length
                          ? capitalise(labels.join(", "))
                          : "None. We reject every backdate.",
                      },
                      {
                        label: "Cut-off",
                        value: cutoff ? `Last month closes on day ${cutoff}` : "None",
                      },
                      {
                        label: "Past invoice dates",
                        value: pastInvoices.length
                          ? `Allowed ${pastInvoices.join(" and ")}`
                          : "Not allowed",
                      },
                      { label: "Calendar", value: timezone },
                    ]
                  : [{ label: "Backdating", value: "Off. We reject every past date." }]
              }
            />
          }
          save={{ note: "Applies to the next request that carries a past date." }}
        >
          <BackdatingFields
            d={{ enabled, allowed, cutoff, pastOnCreate, pastOnChange }}
            timezone={b.timezone ? b.timezone : "UTC (no time zone set)"}
          />
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
