"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { parseForm, actionOk, actionError, type ActionResult } from "@/lib/action-result";
import { requirePermission } from "@/lib/session";
import {
  createCustomFieldDefinition,
  updateCustomFieldDefinition,
  archiveCustomFieldDefinition,
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPES,
  type CustomFieldEntity,
  type CustomFieldType,
} from "@/lib/api/custom-fields";

const settingsPath = (biz: string) => `/businesses/${biz}/settings/custom-fields`;

function fromWrite(
  res: { ok: boolean; status: number; error?: string; requestId?: string },
  okMessage: string,
): ActionResult {
  if (res.ok) return actionOk(okMessage);
  if (res.status === 409)
    return actionError(res.error ?? "Someone changed this custom field after you opened it.", {
      code: "conflict",
    });
  return actionError(res.error ?? `We could not complete the request (${res.status}).`, {
    requestId: res.requestId,
  });
}

const createSchema = z.object({
  biz: z.string().min(1),
  entity_type: z.enum(
    CUSTOM_FIELD_ENTITIES as readonly [CustomFieldEntity, ...CustomFieldEntity[]],
  ),
  api_name: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z][a-z0-9_]*$/, "Use lowercase snake_case that starts with a letter."),
  label: z.string().min(1).max(200),
  data_type: z.enum(CUSTOM_FIELD_TYPES as readonly [CustomFieldType, ...CustomFieldType[]]),
});

export async function createDefinitionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");

  const { data, error } = parseForm(createSchema, formData);
  if (error) return error;
  const { biz, entity_type, api_name, label, data_type } = data;
  const enumOptions = String(formData.get("enum_options") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (data_type === "enum" && enumOptions.length === 0)
    return actionError(
      "Enter at least one option for a dropdown field. Separate options with commas.",
      { errors: { enum_options: "Enter at least one option." } },
    );

  const res = await createCustomFieldDefinition(biz, {
    entity_type,
    api_name,
    label,
    data_type,
    enum_options: data_type === "enum" ? enumOptions : undefined,
    required: formData.get("required") === "on",
    is_pii: formData.get("is_pii") === "on",
    show_in_portal: formData.get("show_in_portal") === "on",
  });
  if (res.ok) revalidatePath(settingsPath(biz));
  return fromWrite(res, `Custom field cf_${api_name} created`);
}

export async function archiveDefinitionAction(biz: string, id: string): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");

  const res = await archiveCustomFieldDefinition(biz, id);
  if (res.ok) revalidatePath(settingsPath(biz));
  return fromWrite(res, "Custom field archived");
}

export async function restoreDefinitionAction(biz: string, id: string): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");

  const res = await updateCustomFieldDefinition(biz, id, { archived: false });
  if (res.ok) revalidatePath(settingsPath(biz));
  return fromWrite(res, "Custom field restored");
}
