"use client";

import { cn } from "@/lib/utils";
import { useDefaultState } from "@/lib/use-default-state";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { CheckboxField } from "@/components/ui/checkbox";
import { createDefinitionAction } from "./actions";
import { TYPE_OPTIONS } from "./types";

/**
 * The create form. A client island only so the dropdown options can hide unless the
 * type is Dropdown — the action ignores them otherwise. Hidden, not unmounted.
 *
 * Omitted: a "Show in portal" checkbox. `show_in_portal` is stored, but the self-serve
 * portal renders no custom fields, so the box would promise something nothing does.
 */
export function AddFieldForm({ biz }: { biz: string }) {
  const [type, setType] = useDefaultState("string");
  return (
    <ActionForm action={createDefinitionAction} className="flex flex-col gap-4 px-5 py-4">
      <input type="hidden" name="biz" value={biz} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="entity_type" label="Applies to" required>
          <SelectField
            name="entity_type"
            defaultValue="customer"
            ariaLabel="Applies to"
            options={[
              { value: "customer", label: "Customer" },
              { value: "subscription", label: "Subscription" },
            ]}
          />
        </Field>
        <Field
          name="data_type"
          label="Type"
          required
          help="You cannot change this after you create the field."
        >
          <SelectField
            name="data_type"
            value={type}
            onValueChange={setType}
            ariaLabel="Field type"
            options={TYPE_OPTIONS}
          />
        </Field>
        <Field
          name="api_name"
          label="API name"
          required
          help={
            <>
              Use lowercase snake_case that starts with a letter. It shows as{" "}
              <span className="font-mono">cf_&lt;name&gt;</span>. You cannot change it later.
            </>
          }
        >
          <Input
            name="api_name"
            required
            maxLength={50}
            placeholder="po_number"
            className="font-mono"
          />
        </Field>
        <Field name="label" label="Label" required>
          <Input name="label" required maxLength={200} placeholder="PO number" />
        </Field>
        <div className={cn("sm:col-span-2", type !== "enum" && "hidden")}>
          <Field
            name="enum_options"
            label="Dropdown options"
            help="Separate the options with commas. A value must be one of these options."
          >
            <Input name="enum_options" placeholder="bronze, silver, gold" />
          </Field>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <CheckboxField
          name="required"
          label="Required"
          hint="A record that you create in the dashboard or through the API must have a value. You cannot clear the value later. Hosted checkout signups do not ask for it."
        />
        <CheckboxField
          name="is_pii"
          label="Contains personal data"
          hint="This marks the definition for your own records and the API. We do not mask the values."
        />
      </div>
      <div>
        <SubmitButton>Create custom field</SubmitButton>
      </div>
    </ActionForm>
  );
}
