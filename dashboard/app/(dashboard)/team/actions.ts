"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { apiDelete, apiPatch, apiPost } from "@/lib/api";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";

function roleBody(fd: FormData) {
  const name = String(fd.get("name") ?? "").trim();
  const description = String(fd.get("description") ?? "").trim();
  const permissions = fd.getAll("perm").map(String);
  return { name, description: description || null, permissions };
}

function check(b: ReturnType<typeof roleBody>): ActionResult | null {
  if (!b.name)
    return actionError("Correct the highlighted fields.", { errors: { name: "Enter a name." } });
  if (b.permissions.length === 0) return actionError("Select at least one permission.");
  return null;
}

/** Create a custom role (0389). */
export async function createRoleAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("roles:manage", "admin");
  const b = roleBody(formData);
  const bad = check(b);
  if (bad) return bad;
  const res = await apiPost("/v1/roles", b);
  if (!res.ok) return actionError(res.error ?? "We could not create the role.");
  revalidatePath("/team/roles");
  return actionOk("Role created.");
}

/** Change a custom role. Sends the version the editor opened, so a lost update is refused. */
export async function updateRoleAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("roles:manage", "admin");
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return actionError("The role ID is missing. Reload the page.");
  const b = roleBody(formData);
  const bad = check(b);
  if (bad) return bad;
  const version = Number(formData.get("version"));
  const res = await apiPatch(`/v1/roles/${id}`, {
    ...b,
    ...(Number.isInteger(version) && version > 0 ? { version } : {}),
  });
  if (!res.ok) return actionError(res.error ?? "We could not change the role.");
  revalidatePath("/team/roles");
  revalidatePath("/team");
  return actionOk("Role changed.");
}

/** Delete a custom role. The engine refuses while a member has it. */
export async function deleteRoleAction(id: string): Promise<{ ok: boolean; error?: string }> {
  await requirePermission("roles:manage", "admin");
  const res = await apiDelete(`/v1/roles/${id}`);
  if (res.ok) revalidatePath("/team/roles");
  return { ok: res.ok, error: res.error };
}
