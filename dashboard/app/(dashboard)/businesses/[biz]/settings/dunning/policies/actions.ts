"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import {
  archiveDunningPolicy,
  createDunningPolicy,
  updateDunningPolicy,
} from "@/lib/api/dunning-policies";
import { getBusiness, updateBusiness } from "@/lib/api/business-settings";
import { parseDunningForm } from "../parse";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

const listPath = (biz: string) => `/businesses/${biz}/settings/dunning/policies`;

function revalidate(biz: string, dpol?: string) {
  revalidatePath(listPath(biz));
  revalidatePath(`/businesses/${biz}/settings/dunning`);
  if (dpol) revalidatePath(`${listPath(biz)}/${dpol}`);
}

/** Name, code and description, checked the way the API checks them. */
function readIdentity(
  fd: FormData,
): { name: string; code: string; description: string | null } | { error: ActionResult } {
  const name = str(fd, "name");
  const code = str(fd, "code");
  const description = str(fd, "description");
  const errors: Record<string, string> = {};
  if (!name) errors.name = "Enter a name.";
  else if (name.length > 200) errors.name = "Use 200 characters or fewer.";
  if (!code) errors.code = "Enter a code.";
  else if (code.length > 64) errors.code = "Use 64 characters or fewer.";
  if (description.length > 2000) errors.description = "Use 2,000 characters or fewer.";
  if (Object.keys(errors).length)
    return { error: actionError("Correct the highlighted fields.", { errors }) };
  return { name, code, description: description || null };
}

export async function createDunningPolicyAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("dunning_policies:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const id = readIdentity(fd);
  if ("error" in id) return id.error;
  const parsed = parseDunningForm(fd);
  if ("error" in parsed) return parsed.error;

  const res = await createDunningPolicy(biz, {
    name: id.name,
    code: id.code,
    ...(id.description ? { description: id.description } : {}),
    config: parsed.data.perInvoice,
  });
  if (!res.ok) {
    if (res.status === 409)
      return actionError(res.error ?? "We could not create the policy. The code is in use.", {
        errors: { code: "This code is in use." },
      });
    return actionError(res.error ?? "We could not create the dunning policy.");
  }
  revalidate(biz);
  const dpol = (res.data as { id?: string } | undefined)?.id;
  // A create lands on its new record, so a redirect rather than an in-place result.
  redirect(
    dpol
      ? `${listPath(biz)}/${dpol}?msg=${encodeURIComponent("Dunning policy created.")}`
      : listPath(biz),
  );
}

export async function updateDunningPolicyAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("dunning_policies:manage", "admin");
  const biz = str(fd, "biz");
  const dpol = str(fd, "dpol");
  if (!biz || !dpol)
    return actionError("The business ID or the policy ID is missing. Reload the page.");
  const id = readIdentity(fd);
  if ("error" in id) return id.error;
  const parsed = parseDunningForm(fd);
  if ("error" in parsed) return parsed.error;
  const version = Number(str(fd, "expected_version"));

  const res = await updateDunningPolicy(biz, dpol, {
    name: id.name,
    code: id.code,
    description: id.description,
    // Replaces the whole stored set; an empty schedule omits `retries` so defaults apply.
    config: parsed.data.perInvoice,
    ...(Number.isInteger(version) && str(fd, "expected_version") !== ""
      ? { expected_version: version }
      : {}),
  });
  revalidate(biz, dpol);
  if (!res.ok) {
    if (res.status === 409)
      return actionError(res.error ?? "Someone changed this policy after you opened it.", {
        code: "conflict",
      });
    return actionError(res.error ?? "We could not save the dunning policy.");
  }
  return actionOk("Dunning policy saved.");
}

export async function archiveDunningPolicyAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("dunning_policies:manage", "admin");
  const biz = str(fd, "biz");
  const dpol = str(fd, "dpol");
  if (!biz || !dpol)
    return actionError("The business ID or the policy ID is missing. Reload the page.");
  const res = await archiveDunningPolicy(biz, dpol);
  revalidate(biz, dpol);
  // 409 while customers use it: the API message names how many.
  if (!res.ok) return actionError(res.error ?? "We could not archive the dunning policy.");
  return actionOk("Dunning policy archived.");
}

/**
 * Settings → Dunning → Policies → Plans (2.48): one policy per plan, stored on the business
 * as `dunning_config.plan_policies`. Posted as `plan_policy:<plan id>` = dpol_… or blank.
 */
export async function savePlanDunningPoliciesAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const map: Record<string, string> = {};
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith("plan_policy:")) continue;
    const plan = k.slice("plan_policy:".length);
    const pol = String(v).trim();
    if (plan && pol) map[plan] = pol;
  }
  let current;
  try {
    current = await getBusiness(biz);
  } catch (e) {
    return actionError((e as Error).message);
  }
  if (!current) return actionError(`We could not find the business ${biz}.`);
  // The API assigns `dunning_config` whole: keep every other key.
  const version = Number(str(fd, "expected_version"));
  const res = await updateBusiness(biz, {
    dunning_config: { ...current.dunning_config, plan_policies: map },
    ...(Number.isInteger(version) && version > 0 ? { expected_version: version } : {}),
  });
  revalidate(biz);
  if (!res.ok) {
    if (res.status === 409)
      return actionError(res.error ?? "Someone changed this business after you opened it.", {
        code: "conflict",
      });
    return actionError(res.error ?? "We could not save the plan dunning policies.");
  }
  return actionOk("Plan dunning policies saved.");
}
