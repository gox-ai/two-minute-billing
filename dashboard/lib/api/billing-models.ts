// The billing models one business has data for. Read-only, SERVER-ONLY.
//
// GET /v1/businesses/:biz/billing_models: the same detector Home and the dashboard presets use.
import { cache } from "react";
import { apiGet } from "@/lib/api";
import type { BillingModelId } from "@/lib/billing-models";

/** Null when the engine could not answer: callers then show everything. */
export const getBillingModels = cache(async (biz: string): Promise<BillingModelId[] | null> => {
  try {
    const r = await apiGet<{ models: BillingModelId[] }>(`/v1/businesses/${biz}/billing_models`);
    return r.models;
  } catch {
    return null;
  }
});
