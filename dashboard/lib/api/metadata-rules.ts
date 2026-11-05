// Typed fetchers for metadata key rules (0332). Server-only. Shapes mirror
// src/modules/metadata-rules/service.ts `serializeRule` / `serializeConfig`.
import { apiGet, apiWrite } from "@/lib/api";

interface List<T> {
  object: "list";
  data: T[];
}

export const METADATA_RULE_ENTITIES = ["customer", "subscription"] as const;
export type MetadataRuleEntity = (typeof METADATA_RULE_ENTITIES)[number];
export const METADATA_RULE_TYPES = [
  "string",
  "number",
  "boolean",
  "date",
  "email",
  "enum",
  "object",
  "array",
] as const;
export type MetadataRuleType = (typeof METADATA_RULE_TYPES)[number];
export const METADATA_ITEM_TYPES = ["string", "number", "boolean"] as const;
export type MetadataItemType = (typeof METADATA_ITEM_TYPES)[number];

export interface MetadataKeyRule {
  object: "metadata_key_rule";
  id: string;
  entity_type: MetadataRuleEntity;
  key: string;
  data_type: MetadataRuleType;
  enum_options: string[] | null;
  pattern: string | null;
  max_length: number | null;
  integer: boolean;
  min: number | null;
  max: number | null;
  item_type: MetadataItemType | null;
  item_enum_options: string[] | null;
  min_items: number | null;
  max_items: number | null;
  description: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface MetadataEntitySettings {
  metadata_validation: "on" | "off";
  strict: boolean;
}

export interface MetadataRuleSettings {
  object: "metadata_rule_settings";
  customer: MetadataEntitySettings;
  subscription: MetadataEntitySettings;
}

export interface MetadataRuleBody {
  enum_options?: string[] | null;
  pattern?: string | null;
  max_length?: number | null;
  description?: string | null;
  integer?: boolean;
  min?: number | null;
  max?: number | null;
  item_type?: MetadataItemType | null;
  item_enum_options?: string[] | null;
  min_items?: number | null;
  max_items?: number | null;
}

export const listMetadataKeyRules = (biz: string) =>
  apiGet<List<MetadataKeyRule>>(`/v1/businesses/${biz}/metadata_key_rules?include_archived=true`);

export const getMetadataRuleSettings = (biz: string) =>
  apiGet<MetadataRuleSettings>(`/v1/businesses/${biz}/metadata_rule_settings`);

export const createMetadataKeyRule = (
  biz: string,
  body: MetadataRuleBody & {
    entity_type: MetadataRuleEntity;
    key: string;
    data_type: MetadataRuleType;
  },
) => apiWrite(`/v1/businesses/${biz}/metadata_key_rules`, body, "POST");

export const updateMetadataKeyRule = (
  biz: string,
  id: string,
  body: MetadataRuleBody & { archived?: boolean; expected_version?: number },
) => apiWrite(`/v1/businesses/${biz}/metadata_key_rules/${id}`, body, "PATCH");

export const archiveMetadataKeyRule = (biz: string, id: string) =>
  apiWrite(`/v1/businesses/${biz}/metadata_key_rules/${id}`, {}, "DELETE");

export const updateMetadataRuleSettings = (
  biz: string,
  entity: MetadataRuleEntity,
  patch: Partial<MetadataEntitySettings>,
) => apiWrite(`/v1/businesses/${biz}/metadata_rule_settings`, { [entity]: patch }, "PATCH");

export interface MetadataObservedKeyList {
  object: "list";
  entity_type: MetadataRuleEntity;
  sample_size: number;
  data: import("@/lib/metadata-editor").ObservedKey[];
}

export const listObservedMetadataKeys = (biz: string, entity: MetadataRuleEntity) =>
  apiGet<MetadataObservedKeyList>(
    `/v1/businesses/${biz}/metadata_observed_keys?entity_type=${entity}`,
  );

/**
 * Everything the metadata editor needs for one entity. Null when the rules or settings cannot be
 * read, so the form falls back to the plain JSON field. Suggestions are optional: a failed read
 * just means none.
 */
export async function loadMetadataEditor(
  biz: string,
  entity: MetadataRuleEntity,
): Promise<import("@/components/form/metadata-field").MetadataEditorData | null> {
  try {
    const [rules, settings, observed] = await Promise.all([
      apiGet<List<MetadataKeyRule>>(
        `/v1/businesses/${biz}/metadata_key_rules?entity_type=${entity}`,
      ),
      getMetadataRuleSettings(biz),
      listObservedMetadataKeys(biz, entity).catch(() => null),
    ]);
    return {
      rules: rules.data.filter((r) => !r.archived),
      validation: settings[entity].metadata_validation,
      strict: settings[entity].strict,
      observed: observed?.data ?? [],
    };
  } catch {
    return null;
  }
}
