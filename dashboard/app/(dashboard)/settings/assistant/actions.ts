"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import { assistantFetch } from "@/lib/assistant-proxy";
import { ASSISTANT_NAME } from "@/lib/assistant";

async function put(body: unknown): Promise<ActionResult | null> {
  const res = await assistantFetch("/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res) return actionError("Sign in again.");
  if (res.ok) return null;
  const msg = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error
    ?.message;
  return actionError(msg ?? "We could not save the settings. Try again.");
}

export async function saveAssistantEnabledAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const err = await put({ enabled: formData.get("enabled") === "on" });
  if (err) return err;
  revalidatePath("/settings/assistant");
  return actionOk(`${ASSISTANT_NAME} settings saved.`);
}

export async function saveAssistantKeyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const provider = String(formData.get("provider") ?? "");
  const model = String(formData.get("model") ?? "").trim();
  const apiKey = String(formData.get("api_key") ?? "").trim();
  if (!provider || !apiKey) {
    return actionError("Correct the highlighted fields.", {
      errors: {
        ...(provider ? {} : { provider: "Select a provider." }),
        ...(apiKey ? {} : { api_key: "Enter the API key." }),
      },
    });
  }
  const err = await put({ own_key: { provider, model: model || null, api_key: apiKey } });
  if (err) return err;
  revalidatePath("/settings/assistant");
  return actionOk("Model key saved.");
}

export async function removeAssistantKeyAction(_prev: ActionResult | null): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const err = await put({ own_key: null });
  if (err) return err;
  revalidatePath("/settings/assistant");
  return actionOk("Model key removed.");
}

export async function saveAssistantActionsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const actions = formData.get("actions_enabled") === "on";
  // Money actions need actions on; a disabled switch posts nothing, so this follows.
  const money = actions && formData.get("money_actions_enabled") === "on";
  const err = await put({ actions_enabled: actions, money_actions_enabled: money });
  if (err) return err;
  revalidatePath("/settings/assistant");
  return actionOk(`${ASSISTANT_NAME} settings saved.`);
}
