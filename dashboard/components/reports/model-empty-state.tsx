import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/states";
import { reportCrumbs } from "@/lib/report-crumbs";
import { getBillingModels } from "@/lib/api/billing-models";
import { hasModel, MODEL_NOUNS, type BillingModelId } from "@/lib/billing-models";

/**
 * A report page for a model the business does not use. The menu hides it, but a shared link
 * still opens, and shows what fills it instead of an empty report.
 *
 * Returns the page to render, or `null` when the business has the model (or the engine could
 * not say, which is never a reason to hide a report).
 */
export async function modelEmptyState(biz: string, model: BillingModelId, title: string) {
  if (hasModel(await getBillingModels(biz), model)) return null;
  const noun = MODEL_NOUNS[model];
  return (
    <>
      <PageHeader title={title} breadcrumbs={reportCrumbs(biz, null, title)} />
      <div className="rounded-xl border bg-card">
        <EmptyState
          title={`No ${noun} data`}
          description={`This report is for ${noun}. This business has no ${noun} in the last 90 days. The report shows data when it has some.`}
        />
      </div>
    </>
  );
}
