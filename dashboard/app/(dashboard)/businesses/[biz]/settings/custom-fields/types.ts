import type { CustomFieldType } from "@/lib/api/custom-fields";

/** The type picker's options; `TYPE_LABEL` names a stored `data_type` in the list. */
export const TYPE_OPTIONS: Array<{ value: CustomFieldType; label: string }> = [
  { value: "string", label: "Text" },
  { value: "long_text", label: "Long text" },
  { value: "email", label: "Email" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Yes / No" },
  { value: "date", label: "Date" },
  { value: "enum", label: "Dropdown" },
];

export const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  TYPE_OPTIONS.map((o) => [o.value, o.label]),
);
