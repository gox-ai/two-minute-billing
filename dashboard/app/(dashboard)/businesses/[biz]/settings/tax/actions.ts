"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import { updateBusiness } from "@/lib/api/business-settings";
import { taxSettingsPatchFromForm } from "@/lib/tax-settings-form";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/**
 * Settings → Tax (`tax_settings`, 0489). The screen posts every listed currency; an unset
 * one stays unset unless the operator changed or ticked it. A country row cleared to empty
 * is removed.
 */
export async function saveTaxSettingsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const parsed = taxSettingsPatchFromForm(fd);
  if ("error" in parsed)
    return actionError(parsed.error, parsed.errors ? { errors: parsed.errors } : undefined);
  const version = Number(str(fd, "expected_version"));
  const res = await updateBusiness(biz, {
    ...parsed.patch,
    ...(Number.isFinite(version) && version > 0 ? { expected_version: version } : {}),
  });
  revalidatePath(`/businesses/${biz}/settings`);
  if (res.ok) return actionOk("Tax settings saved");
  if (res.status === 409)
    return actionError(res.error ?? "Someone changed this business after you opened it.", {
      code: "conflict",
    });
  return actionError(res.error ?? "We could not save the tax settings.");
}
