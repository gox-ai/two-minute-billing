"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import { oauthWrite } from "@/lib/oauth";

/** Approve or deny a connection request. On success the client goes to `redirectTo`. */
export async function decideConnectionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("mcp:connect");
  const id = String(formData.get("request") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const business = String(formData.get("business") ?? "");
  if (decision === "approve" && !business) {
    return actionError("Correct the highlighted fields.", {
      errors: { business: "Select a business." },
    });
  }
  const r = await oauthWrite(
    `/auth/oauth/requests/${encodeURIComponent(id)}/${decision === "approve" ? "approve" : "deny"}`,
    "POST",
    decision === "approve" ? { business } : {},
  );
  if (!r.ok) return actionError(r.message);
  return actionOk(undefined, String(r.body.redirect_to ?? ""));
}

export async function disconnectAppAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("mcp:connect");
  const id = String(formData.get("grant") ?? "");
  const r = await oauthWrite(`/auth/oauth/grants/${encodeURIComponent(id)}`, "DELETE");
  if (!r.ok) return actionError(r.message);
  revalidatePath("/developer");
  return actionOk("Application disconnected.");
}
