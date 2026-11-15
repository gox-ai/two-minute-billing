"use server";

import { updateOrgAction } from "@/app/actions";
import { actionOk, type ActionResult } from "@/lib/action-result";
import { requirePermission } from "@/lib/session";
import { saveSessionPolicyAction } from "./security-actions";

/**
 * Save for General, Legal entity and Reporting. Each page posts only its own fields, and
 * `updateOrgAction` sends only the fields present in the form (`formData.has`), so a page
 * never blanks a field that lives on another page. The session policy is written only when
 * its rows were on the page.
 */
export async function saveOrgSettingsAction(
  prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  // An unset zone posts "" and there is no "unset" to choose; leave it alone.
  if (fd.get("timezone") === "") fd.delete("timezone");
  const org = await updateOrgAction(prev, fd);
  if (!org.ok) return org;
  if (fd.get("session_policy") === "1") {
    const policy = await saveSessionPolicyAction(prev, fd);
    if (!policy.ok) return policy;
  }
  return actionOk("Settings saved.");
}

/** Save for Security: the roles that must use 2FA. No organization field is on that page. */
export async function saveSecuritySettingsAction(
  prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("security:manage", "admin");
  if (fd.get("session_policy") !== "1") return actionOk("Settings saved.");
  const policy = await saveSessionPolicyAction(prev, fd);
  if (!policy.ok) return policy;
  return actionOk("Settings saved.");
}
