import type { MetadataRuleType } from "@/lib/api/metadata-rules";

/** The type picker's options; `TYPE_LABEL` names a stored `data_type` in the list. */
export const TYPE_OPTIONS: Array<{ value: MetadataRuleType; label: string }> = [
  { value: "string", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "True or false" },
  { value: "date", label: "Date" },
  { value: "email", label: "Email" },
  { value: "enum", label: "One of a list" },
  { value: "object", label: "Object" },
  { value: "array", label: "Array" },
];

export const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  TYPE_OPTIONS.map((o) => [o.value, o.label]),
);

/** Types whose value is text, so a pattern and a maximum length apply. */
export const TEXT_TYPES: MetadataRuleType[] = ["string", "email", "enum", "date"];

/** The item-type picker for an array rule. "" means items of any type. */
export const ITEM_TYPE_OPTIONS = [
  { value: "", label: "Any type" },
  { value: "string", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "True or false" },
];

/** A new rule pre-filled from a path already in use. Same shape as `draftRuleFrom`'s result. */
export type RuleDraft = ReturnType<typeof import("@/lib/metadata-editor").draftRuleFrom>;
