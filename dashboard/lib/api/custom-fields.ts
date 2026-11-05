// Typed fetchers for the Custom Fields surface (SET-4). Server-only — imports the
// frozen api client. Route shapes mirror src/modules/custom-fields/serialize.
import { apiGet, apiWrite } from "@/lib/api";

interface List<T> {
  object: "list";
  data: T[];
}

export const CUSTOM_FIELD_ENTITIES = ["customer", "subscription"] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];
export const CUSTOM_FIELD_TYPES = [
  "string",
  "number",
  "boolean",
  "date",
  "enum",
  "email",
  "long_text",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export interface CustomFieldDefinition {
  object: "custom_field_definition";
  id: string;
  entity_type: CustomFieldEntity;
  api_name: string;
  cf_name: string;
  label: string;
  data_type: CustomFieldType;
  enum_options: string[] | null;
  /**
   * How the field behaves as a list filter — the ENGINE's answer, not a mapping repeated
   * here. `null` means this field's `data_type` is not filterable.
   */
  filter_kind: "text" | "enum" | "number" | "bool" | "date" | null;
  filter_ops: string[] | null;
  required: boolean;
  is_pii: boolean;
  show_in_portal: boolean;
  position: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
  resource_version: number;
}

export function listCustomFieldDefinitions(
  biz: string,
  opts?: { entityType?: CustomFieldEntity; includeArchived?: boolean },
) {
  const qs = new URLSearchParams();
  if (opts?.entityType) qs.set("entity_type", opts.entityType);
  if (opts?.includeArchived) qs.set("include_archived", "true");
  const suffix = qs.toString() ? `?${qs}` : "";
  return apiGet<List<CustomFieldDefinition>>(
    `/v1/businesses/${biz}/custom_field_definitions${suffix}`,
  );
}

export function createCustomFieldDefinition(
  biz: string,
  body: {
    entity_type: CustomFieldEntity;
    api_name: string;
    label: string;
    data_type: CustomFieldType;
    enum_options?: string[];
    required?: boolean;
    is_pii?: boolean;
    show_in_portal?: boolean;
  },
) {
  return apiWrite(`/v1/businesses/${biz}/custom_field_definitions`, body, "POST");
}

export function updateCustomFieldDefinition(
  biz: string,
  id: string,
  body: Partial<{
    label: string;
    enum_options: string[];
    required: boolean;
    is_pii: boolean;
    show_in_portal: boolean;
    position: number;
    archived: boolean;
  }>,
) {
  return apiWrite(`/v1/businesses/${biz}/custom_field_definitions/${id}`, body, "PATCH");
}

export function archiveCustomFieldDefinition(biz: string, id: string) {
  return apiWrite(`/v1/businesses/${biz}/custom_field_definitions/${id}`, {}, "DELETE");
}
