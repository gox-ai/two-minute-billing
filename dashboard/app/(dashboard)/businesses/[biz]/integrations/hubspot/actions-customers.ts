"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import { updateHubSpotSettings, type HubSpotFieldMapping } from "@/lib/api/hubspot";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function mappings(fd: FormData, k: string): HubSpotFieldMapping[] | null {
  try {
    const rows = JSON.parse(str(fd, k) || "[]");
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

export async function saveHubSpotCustomersAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("integrations:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");

  const contactLocal = str(fd, "contact_match_local");
  const contactRemote = str(fd, "contact_match_remote");
  if (!contactLocal || !contactRemote) return actionError("Select how to match contacts");
  const companyLocal = str(fd, "company_match_local");
  const companyRemote = str(fd, "company_match_remote");
  if (companyLocal && !companyRemote)
    return actionError("Select the HubSpot company property to use for the match");

  const contactFields = mappings(fd, "contact_fields");
  const companyFields = mappings(fd, "company_fields");
  if (!contactFields || !companyFields) return actionError("We could not read the field mappings.");

  // Once on, the server refuses to turn sharing off; a disabled switch still posts "on".
  const res = await updateHubSpotSettings(biz, {
    customers: {
      scope: str(fd, "scope") === "active_subscriptions" ? "active_subscriptions" : "all",
      createMissing: fd.get("create_missing") === "on",
      contactMatch: { local: contactLocal, remote: contactRemote },
      companyMatch: companyLocal ? { local: companyLocal, remote: companyRemote } : null,
      multipleCustomersPerCompany: fd.get("multiple_customers_per_company") === "on",
      onMatch: str(fd, "on_match"),
      billingAddressViaCustomFields: fd.get("billing_address_via_custom_fields") === "on",
      contactFields,
      companyFields,
    },
    updates: { localChange: str(fd, "local_change") },
  });
  if (!res.ok) return actionError(res.error ?? "We could not save customer sync.");
  revalidatePath(`/businesses/${biz}/integrations/hubspot`);
  return actionOk("Customer sync saved");
}
