import type { ConnectedHubSpot } from "@/lib/api/hubspot";
import { getHubSpotObjects } from "@/lib/api/hubspot";
import { Alert } from "@/components/ui/alert";
import { SelectField } from "@/components/ui/select-field";
import { SettingRow, ToggleAnswer } from "@/components/patterns/settings-page";
import { RecordCard } from "@/components/patterns/record-page";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { saveHubSpotInvoicesAction } from "@/app/(dashboard)/businesses/[biz]/integrations/hubspot/actions-invoices";

/** Invoice sync on/off and the custom object it writes to (HubSpot Enterprise only). */
export async function InvoicesSection({ biz, hs }: { biz: string; hs: ConnectedHubSpot }) {
  const inv = hs.settings.invoices;
  const objects = await getHubSpotObjects(biz).catch(() => null);
  const reconnect = `/integrations/hubspot/start?biz=${encodeURIComponent(biz)}`;
  const missing = objects?.missing_scopes ?? [];
  const options = (objects?.data ?? []).map((o) => ({ value: o.id, label: o.label }));
  // The saved object stays selectable even when discovery failed or the object is gone.
  if (inv.objectType && !options.some((o) => o.value === inv.objectType))
    options.unshift({ value: inv.objectType, label: inv.objectType });

  return (
    <ActionForm action={saveHubSpotInvoicesAction} className="space-y-3">
      <input type="hidden" name="biz" value={biz} />
      <RecordCard
        title="Invoices"
        flush
        footer={
          <div className="flex justify-end">
            <SubmitButton size="sm" variant="outline">
              Save invoice sync
            </SubmitButton>
          </div>
        }
      >
        <div className="divide-y">
          {missing.length > 0 ? (
            <div className="px-5 py-4">
              <Alert tone="warning" title="HubSpot did not give access to custom objects.">
                Invoices sync to a custom object, and custom objects need HubSpot Enterprise. To
                sync invoices, connect HubSpot again and allow the access.{" "}
                <a href={reconnect} className="font-medium underline">
                  Reconnect HubSpot
                </a>
              </Alert>
            </div>
          ) : objects && objects.data.length === 0 ? (
            <div className="px-5 py-4">
              <Alert tone="info" title="Your HubSpot portal has no custom objects.">
                Create a custom object for invoices in HubSpot. Then reload this page.
              </Alert>
            </div>
          ) : !objects ? (
            <div className="px-5 py-4">
              <Alert tone="error">We could not read the custom objects from HubSpot.</Alert>
            </div>
          ) : null}
          <SettingRow
            question="Sync invoices to HubSpot?"
            help="We send each invoice when you finalize it. We update it when it is paid, voided, credited or written off. Drafts do not sync. After you enable this setting, we send your existing invoices."
          >
            <ToggleAnswer
              name="invoices_enabled"
              defaultChecked={inv.enabled}
              label="Sync invoices to HubSpot"
            />
          </SettingRow>
          <SettingRow
            question="HubSpot object for invoices"
            help={
              <>
                Give the custom object these properties (internal names):{" "}
                <span className="font-mono text-xs">
                  {(objects?.invoice_properties ?? []).join(", ")}
                </span>
                . The property invoice_id is necessary. Make it unique, so that HubSpot cannot keep
                two records for one invoice. We do not send a property that the object does not
                have. To show the invoices on contacts, companies and deals, associate the object
                with them.
              </>
            }
          >
            <SelectField
              name="invoice_object"
              size="sm"
              className="sm:w-60"
              ariaLabel="HubSpot object for invoices"
              defaultValue={inv.objectType ?? ""}
              disabled={options.length === 0}
              options={[{ value: "", label: "No object" }, ...options]}
            />
          </SettingRow>
        </div>
      </RecordCard>
    </ActionForm>
  );
}
