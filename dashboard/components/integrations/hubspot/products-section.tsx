import type { ConnectedHubSpot } from "@/lib/api/hubspot";
import { SettingRow, ToggleAnswer } from "@/components/patterns/settings-page";
import { RecordCard } from "@/components/patterns/record-page";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { saveHubSpotProductsAction } from "@/app/(dashboard)/businesses/[biz]/integrations/hubspot/actions-products";

/** Product sync on/off. Each price is its own HubSpot product. */
export async function ProductsSection({ biz, hs }: { biz: string; hs: ConnectedHubSpot }) {
  return (
    <ActionForm action={saveHubSpotProductsAction} className="space-y-3">
      <input type="hidden" name="biz" value={biz} />
      <RecordCard
        title="Products"
        flush
        footer={
          <div className="flex justify-end">
            <SubmitButton size="sm" variant="outline">
              Save product sync
            </SubmitButton>
          </div>
        }
      >
        <div className="divide-y">
          <SettingRow
            question="Sync products to HubSpot?"
            help={
              <>
                Each price becomes a HubSpot product, so a plan billed monthly and yearly appears
                twice. Flat and per-unit prices sync when they bill weekly, every 2 weeks, monthly,
                quarterly, every 6 months or every 1–5 years. Tiered, volume, stair-step, package,
                usage and percentage prices do not sync, because HubSpot keeps one price per
                product. When you archive a price, we archive its HubSpot product. After you enable
                this setting, use Resync everything to send your existing prices.
              </>
            }
          >
            <ToggleAnswer
              name="products_enabled"
              defaultChecked={hs.settings.products.enabled}
              label="Sync products to HubSpot"
            />
          </SettingRow>
        </div>
      </RecordCard>
    </ActionForm>
  );
}
