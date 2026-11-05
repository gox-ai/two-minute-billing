"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { CheckboxField } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  MetadataKeyRule,
  MetadataRuleEntity,
  MetadataRuleType,
} from "@/lib/api/metadata-rules";
import { createRuleAction, updateRuleAction } from "./actions";
import { ITEM_TYPE_OPTIONS, TYPE_LABEL, TYPE_OPTIONS, TEXT_TYPES, type RuleDraft } from "./types";

/**
 * Add or edit one rule. On edit, the path and the type are shown but not editable: the API
 * keeps both fixed, because changing them would change how stored values are read.
 */
export function RuleDialog({
  biz,
  entity,
  rule,
  draft,
  trigger,
}: {
  biz: string;
  entity: MetadataRuleEntity;
  /** Present when editing. */
  rule?: MetadataKeyRule;
  /** A new rule pre-filled from a path in use ("Suggested from your data"). */
  draft?: RuleDraft;
  trigger: (open: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [type, setType] = useDefaultState<MetadataRuleType>(
    rule?.data_type ?? draft?.data_type ?? "string",
  );
  const isText = TEXT_TYPES.includes(type);
  const [itemType, setItemType] = useDefaultState<string>(
    rule?.item_type ?? draft?.item_type ?? "",
  );
  const entityLabel = entity === "customer" ? "customer" : "subscription";

  return (
    <>
      {trigger(() => setOpen(true))}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md" className="flex max-h-[85vh] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {rule ? "Edit the rule" : `Create a ${entityLabel} metadata rule`}
            </DialogTitle>
            <DialogDescription>
              While validation is on, the rule checks each later write of {entityLabel} metadata.
              The path is optional: the rule checks a value only when it is present. The rule does
              not change stored data.
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action={rule ? updateRuleAction : createRuleAction}
            onSuccess={() => setOpen(false)}
            className="-mx-6 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-1"
          >
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="entity_type" value={entity} />
            {rule ? (
              <>
                <input type="hidden" name="id" value={rule.id} />
                <input type="hidden" name="version" value={rule.version} />
                <input type="hidden" name="data_type" value={rule.data_type} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <ReadOnly label="Path" value={rule.key} mono />
                  <ReadOnly label="Type" value={TYPE_LABEL[rule.data_type] ?? rule.data_type} />
                </div>
              </>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  name="key"
                  label="Path"
                  required
                  help={
                    <>
                      A key, or a dot path into nested objects, such as{" "}
                      <span className="font-mono">billing.po</span>. Up to 5 levels of letters,
                      digits, _ and -. You cannot change it later.
                    </>
                  }
                >
                  <Input
                    name="key"
                    required
                    defaultValue={draft?.key ?? ""}
                    maxLength={329}
                    placeholder="billing.po"
                    className="font-mono"
                  />
                </Field>
                <Field name="data_type" label="Type" required help="You cannot change it later.">
                  <SelectField
                    name="data_type"
                    value={type}
                    onValueChange={(v) => setType(v as MetadataRuleType)}
                    ariaLabel="Type"
                    options={TYPE_OPTIONS}
                  />
                </Field>
              </div>
            )}
            {type === "enum" ? (
              <Field
                name="enum_options"
                label="Allowed values"
                help="Separate the values with commas. A value must be one of them."
              >
                <Input
                  name="enum_options"
                  defaultValue={(rule?.enum_options ?? draft?.enum_options)?.join(", ") ?? ""}
                  placeholder="gold, silver"
                />
              </Field>
            ) : null}
            {type === "object" ? (
              <p className="m-0 text-sm text-muted-foreground">
                The value must be a JSON object. Add rules for paths below it, such as{" "}
                <span className="font-mono">{rule?.key ?? "billing"}.po</span>, to check its
                contents. With no rules below it, any content is allowed.
              </p>
            ) : null}
            {type === "number" ? (
              <>
                <CheckboxField
                  name="integer"
                  label="Whole numbers only"
                  hint="Refuse a value such as 1.5."
                  defaultChecked={rule?.integer ?? false}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field name="min" label="Minimum" help="Optional. The value can be equal to it.">
                    <Input
                      name="min"
                      type="number"
                      step="any"
                      defaultValue={rule?.min ?? ""}
                      placeholder="0"
                      className="w-32"
                    />
                  </Field>
                  <Field name="max" label="Maximum" help="Optional. The value can be equal to it.">
                    <Input
                      name="max"
                      type="number"
                      step="any"
                      defaultValue={rule?.max ?? ""}
                      className="w-32"
                    />
                  </Field>
                </div>
              </>
            ) : null}
            {type === "array" ? (
              <>
                <p className="m-0 text-sm text-muted-foreground">
                  The value must be a JSON array. Set an item type to check each item.
                </p>
                <Field name="item_type" label="Item type">
                  <SelectField
                    name="item_type"
                    value={itemType}
                    onValueChange={setItemType}
                    ariaLabel="Item type"
                    options={ITEM_TYPE_OPTIONS}
                  />
                </Field>
                {itemType === "string" ? (
                  <Field
                    name="item_enum_options"
                    label="Allowed item values"
                    help="Optional. Separate the values with commas. Each item must be one of them."
                  >
                    <Input
                      name="item_enum_options"
                      defaultValue={
                        (rule?.item_enum_options ?? draft?.item_enum_options)?.join(", ") ?? ""
                      }
                      placeholder="Hourly, Daily, Weekly, Monthly"
                    />
                  </Field>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field name="min_items" label="Minimum items" help="Optional.">
                    <Input
                      name="min_items"
                      type="number"
                      min={0}
                      step={1}
                      defaultValue={rule?.min_items ?? ""}
                      className="w-32"
                    />
                  </Field>
                  <Field name="max_items" label="Maximum items" help="Optional.">
                    <Input
                      name="max_items"
                      type="number"
                      min={0}
                      step={1}
                      defaultValue={rule?.max_items ?? ""}
                      className="w-32"
                    />
                  </Field>
                </div>
              </>
            ) : null}
            {isText ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  name="pattern"
                  label="Pattern"
                  help="Optional. A regular expression that the full value must match."
                >
                  <Input
                    name="pattern"
                    defaultValue={rule?.pattern ?? ""}
                    maxLength={200}
                    placeholder="PO-\d+"
                    className="font-mono"
                  />
                </Field>
                <Field name="max_length" label="Maximum length" help="Optional. In characters.">
                  <Input
                    name="max_length"
                    type="number"
                    min={1}
                    max={16000}
                    defaultValue={rule?.max_length ?? ""}
                    className="w-32"
                  />
                </Field>
              </div>
            ) : null}
            <Field name="description" label="Description" help="Optional. For your team only.">
              <Input
                name="description"
                defaultValue={rule?.description ?? ""}
                maxLength={500}
                placeholder="The purchase order number from the CRM"
              />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton>{rule ? "Save the rule" : "Create the rule"}</SubmitButton>
            </div>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReadOnly({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-1">
      <p className="m-0 text-sm font-medium">{label}</p>
      <p className={mono ? "m-0 font-mono text-sm" : "m-0 text-sm"}>{value}</p>
    </div>
  );
}
