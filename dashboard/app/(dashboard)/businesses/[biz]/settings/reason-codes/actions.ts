"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import {
  createReasonCode,
  updateReasonCode,
  deleteReasonCode,
  REASON_CODE_APPLIES_TO,
  type ReasonCodeAppliesTo,
} from "@/lib/api/reason-codes";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function revalidate(biz: string) {
  revalidatePath(`/businesses/${biz}/settings/reason-codes`);
  // The cancel dialog reads the offered list, so any subscription page showing
  // it must re-render too.
  revalidatePath(`/businesses/${biz}/subscriptions`, "layout");
}

function appliesTo(fd: FormData): ReasonCodeAppliesTo | null {
  const v = str(fd, "applies_to");
  return (REASON_CODE_APPLIES_TO as readonly string[]).includes(v)
    ? (v as ReasonCodeAppliesTo)
    : null;
}

export async function createReasonCodeAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const scope = appliesTo(fd);
  if (!scope) return actionError("Select what this reason applies to.");

  const label = str(fd, "label");
  if (!label) return actionError("Enter a label.", { errors: { label: "Required" } });
  if (label.length > 200)
    return actionError("The label is too long. Use 200 characters or fewer.", {
      errors: { label: "Max 200 characters" },
    });
  const code = str(fd, "code");
  if (code.length > 64)
    return actionError("The code is too long. Use 64 characters or fewer.", {
      errors: { code: "Max 64 characters" },
    });
  // Blank code → derive from the label, so the common case is one field.
  const finalCode = code || label;

  const res = await createReasonCode(biz, { applies_to: scope, code: finalCode, label });
  if (!res.ok) {
    if (res.status === 409)
      return actionError(res.error ?? "That code already exists", { code: "conflict" });
    return actionError(res.error ?? "We could not create the reason code.");
  }
  revalidate(biz);
  return actionOk("Reason code created");
}

export async function updateReasonCodeAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  const id = str(fd, "id");
  if (!biz || !id)
    return actionError("The business ID or the reason code ID is missing. Reload the page.");

  const body: { label?: string; enabled?: boolean } = {};
  const label = str(fd, "label");
  if (label) {
    if (label.length > 200)
      return actionError("The label is too long. Use 200 characters or fewer.", {
        errors: { label: "Max 200 characters" },
      });
    body.label = label;
  }
  // Only sent by the enable/disable control, so its absence must not read as false.
  if (fd.has("enabled")) body.enabled = str(fd, "enabled") === "true";

  const res = await updateReasonCode(biz, id, body);
  if (!res.ok) return actionError(res.error ?? "We could not save the reason code.");
  revalidate(biz);
  return actionOk("Reason code saved");
}

export async function deleteReasonCodeAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  const id = str(fd, "id");
  if (!biz || !id)
    return actionError("The business ID or the reason code ID is missing. Reload the page.");

  const res = await deleteReasonCode(biz, id);
  if (!res.ok) return actionError(res.error ?? "We could not delete the reason code.");
  revalidate(biz);
  // Records already carrying this code keep it — it's stored as text, not a FK.
  return actionOk("Reason code deleted");
}
