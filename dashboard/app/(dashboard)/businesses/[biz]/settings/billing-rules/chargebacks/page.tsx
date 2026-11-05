import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { saveChargebackAction } from "../../actions";
import { FormIds, ruleCrumbs } from "../_parts/shared";
import { ChargebackFields } from "./chargeback-fields";

export const dynamic = "force-dynamic";

// Billing rules → Chargeback management (0244), applied by applyChargebackPolicy. A lost
// chargeback is always booked as an expense and the invoice stays PAID; this decides
// what ELSE happens.
//
// Deliberately absent, not "coming soon":
//   · "Mark invoice as Not Paid and record refund" — would resurrect receivables with no
//     matching ledger entry.
//   · A credit note on INITIATED — the money may still be with us, and a win reinstates it.
//   · Chargeback notification rules — out of scope.
const SUB_LABELS: Record<string, string> = {
  no_action: "No action",
  cancel_immediately: "Cancel immediately",
  cancel_end_of_term: "Cancel at end of term",
  pause_indefinitely: "Pause indefinitely",
  pause_end_of_term: "Pause at end of term",
};

export default async function ChargebackSettings({ params }: { params: Promise<{ biz: string }> }) {
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

  // Mirrors resolveChargebackConfig: record-only until this form is saved.
  const cfg = b.chargeback_config ?? null;
  const d = {
    onLostInvoice: cfg?.on_lost_invoice ?? "no_action",
    onInitiated: cfg?.on_initiated_subscription ?? "no_action",
    onLost: cfg?.on_lost_subscription ?? "no_action",
    cascade: cfg?.cascade_to_other_subscriptions ?? false,
    stopCollecting: cfg?.stop_collecting_all ?? false,
  };
  const acts = d.onInitiated !== "no_action" || d.onLost !== "no_action";

  return (
    <SettingsPage
      title="Chargeback management"
      crumbs={ruleCrumbs(biz, "Chargebacks")}
      description="What happens when a customer disputes a payment. We always book a lost dispute as a loss, and the invoice stays paid. These settings decide what else happens."
    >
      <ActionForm action={saveChargebackAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                {
                  label: "Invoice on loss",
                  value: d.onLostInvoice === "credit_note" ? "Credit note raised" : "No action",
                },
                { label: "Subscription when opened", value: SUB_LABELS[d.onInitiated] },
                { label: "Subscription on loss", value: SUB_LABELS[d.onLost] },
                acts && {
                  label: "Other subscriptions",
                  value: d.cascade ? "Also changed" : "Not changed",
                },
                {
                  label: "Collection",
                  value: d.stopCollecting ? "Stopped for the customer" : "Continues",
                },
              ]}
            />
          }
          save={{ note: "Applies to disputes opened or lost from now on." }}
        >
          <ChargebackFields d={d} />
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
