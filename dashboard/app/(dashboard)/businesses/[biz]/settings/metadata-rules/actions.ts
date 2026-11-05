"use server";

import { revalidatePath } from "next/cache";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import { requirePermission } from "@/lib/session";
import {
  createMetadataKeyRule,
  updateMetadataKeyRule,
  archiveMetadataKeyRule,
  updateMetadataRuleSettings,
  METADATA_RULE_ENTITIES,
  METADATA_RULE_TYPES,
  METADATA_ITEM_TYPES,
  type MetadataItemType,
  type MetadataRuleEntity,
  type MetadataRuleType,
} from "@/lib/api/metadata-rules";

const settingsPath = (biz: string) => `/businesses/${biz}/settings/metadata-rules`;
const TEXT_TYPES: MetadataRuleType[] = ["string", "email", "enum", "date"];

/** An API refusal; when it names a field, the form shows the message on that field. */
function fromWrite(
  res: { ok: boolean; status: number; error?: string; param?: string; requestId?: string },
  okMessage: string,
): ActionResult {
  if (res.ok) return actionOk(okMessage);
  if (res.status === 409)
    return actionError(res.error ?? "Someone changed this rule after you opened it.", {
      code: "conflict",
    });
  const message = res.error ?? `We could not complete the request (${res.status}).`;
  return actionError(message, {
    requestId: res.requestId,
    ...(res.param ? { errors: { [res.param]: message } } : {}),
  });
}

const text = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
/** An optional number field: empty means "none" (null), anything else must parse. */
const num = (fd: FormData, k: string): number | null | "invalid" => {
  const raw = text(fd, k);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : "invalid";
};
const list = (fd: FormData, k: string) =>
  text(fd, k)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const BOUND_LABEL: Record<string, string> = {
  min: "Minimum",
  max: "Maximum",
  min_items: "Minimum items",
  max_items: "Maximum items",
};

/**
 * The number options (number rules) and the item options (array rules). Empty means "none",
 * so an edit can clear a bound. Returns the first field that is not a number, if any.
 */
function boundOptions(fd: FormData, dataType: MetadataRuleType) {
  if (dataType === "number") {
    const min = num(fd, "min");
    const max = num(fd, "max");
    const bad = min === "invalid" ? "min" : max === "invalid" ? "max" : null;
    return {
      bad,
      body: {
        integer: fd.get("integer") === "on",
        min: min === "invalid" ? null : min,
        max: max === "invalid" ? null : max,
      },
    };
  }
  if (dataType === "array") {
    const itemTypeRaw = text(fd, "item_type");
    const itemType = (METADATA_ITEM_TYPES as readonly string[]).includes(itemTypeRaw)
      ? (itemTypeRaw as MetadataItemType)
      : null;
    const values = itemType === "string" ? list(fd, "item_enum_options") : [];
    const minItems = num(fd, "min_items");
    const maxItems = num(fd, "max_items");
    const bad =
      minItems === "invalid" || (minItems !== null && !Number.isInteger(minItems))
        ? "min_items"
        : maxItems === "invalid" || (maxItems !== null && !Number.isInteger(maxItems))
          ? "max_items"
          : null;
    return {
      bad,
      body: {
        item_type: itemType,
        item_enum_options: values.length ? values : null,
        min_items: typeof minItems === "number" ? minItems : null,
        max_items: typeof maxItems === "number" ? maxItems : null,
      },
    };
  }
  return { bad: null, body: {} };
}

const badBound = (field: string) =>
  actionError(`${BOUND_LABEL[field]} must be a number.`, {
    errors: { [field]: field.endsWith("_items") ? "Enter a whole number." : "Enter a number." },
  });

/** The fields both dialogs post. Empty means "none", so an edit can clear a pattern. */
function ruleOptions(fd: FormData, dataType: MetadataRuleType) {
  const isText = TEXT_TYPES.includes(dataType);
  const maxRaw = text(fd, "max_length");
  const max = maxRaw ? Number(maxRaw) : null;
  return {
    description: text(fd, "description") || null,
    ...(isText ? { pattern: text(fd, "pattern") || null, max_length: max } : {}),
    ...(dataType === "enum"
      ? {
          enum_options: text(fd, "enum_options")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : {}),
  };
}

export async function createRuleAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = text(formData, "biz");
  const entity = text(formData, "entity_type") as MetadataRuleEntity;
  const dataType = text(formData, "data_type") as MetadataRuleType;
  const key = text(formData, "key");
  if (!biz || !METADATA_RULE_ENTITIES.includes(entity))
    return actionError("The form is not complete.");
  if (!METADATA_RULE_TYPES.includes(dataType))
    return actionError("Select a type.", { errors: { data_type: "Select a type." } });
  if (!key) return actionError("Enter a path.", { errors: { key: "Enter a path." } });
  const options = ruleOptions(formData, dataType);
  if (options.max_length != null && !Number.isInteger(options.max_length))
    return actionError("Maximum length must be a whole number.", {
      errors: { max_length: "Enter a whole number." },
    });
  const bounds = boundOptions(formData, dataType);
  if (bounds.bad) return badBound(bounds.bad);
  const res = await createMetadataKeyRule(biz, {
    entity_type: entity,
    key,
    data_type: dataType,
    ...options,
    ...bounds.body,
  });
  if (res.ok) revalidatePath(settingsPath(biz));
  return fromWrite(res, `Rule for ${key} created`);
}

export async function updateRuleAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = text(formData, "biz");
  const id = text(formData, "id");
  const dataType = text(formData, "data_type") as MetadataRuleType;
  if (!biz || !id || !METADATA_RULE_TYPES.includes(dataType))
    return actionError("The form is not complete.");
  const options = ruleOptions(formData, dataType);
  if (options.max_length != null && !Number.isInteger(options.max_length))
    return actionError("Maximum length must be a whole number.", {
      errors: { max_length: "Enter a whole number." },
    });
  const bounds = boundOptions(formData, dataType);
  if (bounds.bad) return badBound(bounds.bad);
  const version = Number(text(formData, "version"));
  const res = await updateMetadataKeyRule(biz, id, {
    ...options,
    ...bounds.body,
    ...(Number.isInteger(version) ? { expected_version: version } : {}),
  });
  if (res.ok) revalidatePath(settingsPath(biz));
  return fromWrite(res, "Rule saved");
}

export async function archiveRuleAction(biz: string, id: string): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const res = await archiveMetadataKeyRule(biz, id);
  if (res.ok) revalidatePath(settingsPath(biz));
  return fromWrite(res, "Rule archived");
}

export async function restoreRuleAction(biz: string, id: string): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const res = await updateMetadataKeyRule(biz, id, { archived: false });
  if (res.ok) revalidatePath(settingsPath(biz));
  return fromWrite(res, "Rule restored");
}

export async function setValidationAction(
  biz: string,
  entity: MetadataRuleEntity,
  on: boolean,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const res = await updateMetadataRuleSettings(biz, entity, {
    metadata_validation: on ? "on" : "off",
  });
  if (res.ok) revalidatePath(settingsPath(biz));
  return fromWrite(res, on ? "Metadata validation enabled" : "Metadata validation disabled");
}

export async function setStrictAction(
  biz: string,
  entity: MetadataRuleEntity,
  on: boolean,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const res = await updateMetadataRuleSettings(biz, entity, { strict: on });
  if (res.ok) revalidatePath(settingsPath(biz));
  return fromWrite(res, on ? "Strict mode enabled" : "Strict mode disabled");
}
