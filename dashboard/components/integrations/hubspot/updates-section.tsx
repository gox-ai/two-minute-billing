import type { ConnectedHubSpot } from "@/lib/api/hubspot";
import { SelectAnswer, SettingRow, ToggleAnswer } from "@/components/patterns/settings-page";
import { RecordCard } from "@/components/patterns/record-page";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { saveHubSpotUpdatesAction } from "@/app/(dashboard)/businesses/[biz]/integrations/hubspot/actions-updates";

/** HubSpot → billing: what a HubSpot edit does, and who wins when both sides changed. */
export async function UpdatesSection({ biz, hs }: { biz: string; hs: ConnectedHubSpot }) {
  const u = hs.settings.updates;
  const shared = hs.settings.customers.multipleCustomersPerCompany;
  const pullOff =
    u.remoteChange === "nothing"
      ? "HubSpot changes do not sync back, so this setting has no effect."
      : undefined;
  return (
    <ActionForm action={saveHubSpotUpdatesAction} className="space-y-3">
      <input type="hidden" name="biz" value={biz} />
      <RecordCard
        title="Changes made in HubSpot"
        flush
        footer={
          <div className="flex justify-end">
            <SubmitButton size="sm" variant="outline">
              Save update rules
            </SubmitButton>
          </div>
        }
      >
        <div className="divide-y">
          <SettingRow
            question="When a contact or company changes in HubSpot"
            help="We check this on each automatic sync (every 15 minutes) and on Sync now. A blank value in HubSpot never clears a customer field. This rule also applies to deal fields that map from HubSpot. We read back custom fields and auto-collection, and a blank deal value clears our value. We never take status, plan or amounts from HubSpot."
            note={
              shared
                ? "Several customers share companies, so company changes in HubSpot do not sync back. Contact changes continue to sync."
                : undefined
            }
          >
            <SelectAnswer
              name="remote_change"
              defaultValue={u.remoteChange}
              options={[
                { value: "overwrite_local", label: "Update the customer here" },
                { value: "nothing", label: "Leave the customer as it is" },
              ]}
            />
          </SettingRow>
          <SettingRow
            question="Update billing addresses from HubSpot?"
            help="When off, you change the billing address only here: in billing, checkout and the customer portal. The billing address sets tax. We ignore HubSpot address edits."
            note={pullOff}
          >
            <ToggleAnswer
              name="pull_address"
              defaultChecked={u.pullAddress}
              label="Update billing addresses from HubSpot"
            />
          </SettingRow>
          <SettingRow
            question="Update email addresses from HubSpot?"
            help="Invoices and payment emails go to this address. When off, we ignore HubSpot email edits."
            note={pullOff}
          >
            <ToggleAnswer
              name="pull_email"
              defaultChecked={u.pullEmail}
              label="Update email addresses from HubSpot"
            />
          </SettingRow>
          <SettingRow
            question="When a record changes here and in HubSpot between syncs"
            help="Flagged records stop syncing in both directions until you select a version under Conflicts."
          >
            <SelectAnswer
              name="conflict"
              defaultValue={u.conflict}
              options={[
                { value: "local_wins", label: "Keep ours and update HubSpot" },
                { value: "remote_wins", label: "Take HubSpot's values" },
                { value: "flag", label: "Flag it and let me decide" },
              ]}
            />
          </SettingRow>
        </div>
      </RecordCard>
    </ActionForm>
  );
}
