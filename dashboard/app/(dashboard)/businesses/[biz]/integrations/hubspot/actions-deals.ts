"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import {
  getHubSpotPipelines,
  updateHubSpotSettings,
  type HubSpotFieldMapping,
  type HubSpotSubscriptionStatus,
} from "@/lib/api/hubspot";

const STATUSES: HubSpotSubscriptionStatus[] = [
  "future",
  "in_trial",
  "active",
  "non_renewing",
  "paused",
  "cancelled",
];

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function mappings(fd: FormData, k: string): HubSpotFieldMapping[] | null {
  try {
    const rows = JSON.parse(str(fd, k) || "[]");
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

export async function saveHubSpotDealsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("integrations:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");

  const nameFormat = str(fd, "name_format");
  if (!nameFormat) return actionError("Enter a name format for deals");
  const fields = mappings(fd, "deal_fields");
  if (!fields) return actionError("We could not read the field mappings.");
  const posted = new Set(fd.getAll("statuses").map(String));

  const deals: Record<string, unknown> = {
    enabled: fd.get("enabled") === "on",
    statuses: STATUSES.filter((s) => posted.has(s)),
    mode: str(fd, "mode"),
    subscriptionIdProperty: str(fd, "subscription_id_property") || null,
    matchByAssociation: fd.get("match_by_association") === "on",
    onChange: str(fd, "on_change"),
    amount: str(fd, "amount"),
    nameFormat,
    fields,
  };

  // Pipeline and stages only when the form could list them; otherwise the saved ones stand.
  let note = "";
  if (fd.get("pipelines_loaded") === "1") {
    const pipelineId = str(fd, "pipeline_id") || null;
    if (pipelineId !== (str(fd, "saved_pipeline_id") || null)) {
      // Stage ids belong to one pipeline: a new pipeline starts with an empty map.
      deals.pipelineId = pipelineId;
      deals.stageMap = {};
      if (pipelineId) note = ". Now map the stages of the new pipeline";
    } else if (pipelineId) {
      const pipelines = await getHubSpotPipelines(biz)
        .then((r) => r.data)
        .catch(() => null);
      const valid = pipelines
        ? new Set(pipelines.find((p) => p.id === pipelineId)?.stages.map((s) => s.id))
        : null;
      const stageMap: Partial<Record<HubSpotSubscriptionStatus, string>> = {};
      for (const s of STATUSES) {
        const stage = str(fd, `stage_${s}`);
        if (!stage) continue;
        if (valid && !valid.has(stage))
          return actionError(
            "A selected stage is not in this pipeline now. Reload the page and select the stage again",
          );
        stageMap[s] = stage;
      }
      deals.stageMap = stageMap;
    } else {
      deals.stageMap = {};
    }
  }

  const res = await updateHubSpotSettings(biz, { deals });
  if (!res.ok) return actionError(res.error ?? "We could not save deal sync.");
  revalidatePath(`/businesses/${biz}/integrations/hubspot`);
  return actionOk(`Deal sync saved${note}`);
}
