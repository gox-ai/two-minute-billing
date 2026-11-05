import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/form/field";
import type { CustomFieldDefinition } from "@/lib/api/custom-fields";
import { SelectField } from "@/components/ui/select-field";
import { CheckboxField } from "@/components/ui/checkbox";

/**
 * Inputs for a business's admin-DEFINED custom fields (SET-4), one typed control
 * per active definition.
 *
 * Field names are the API's flat `cf_<api_name>` form, which the customer routes
 * collect straight off the raw body (`collectCustomFields`), so no nesting is
 * needed. Values are validated and type-coerced server-side by `validateAndCoerce`.
 *
 * Only ACTIVE definitions get a control: the service rejects a write to an archived
 * field, so rendering one would be a box that always errors. Stored values for
 * archived fields still display on the detail page.
 *
 * An empty input means CLEAR (the service normalizes '' → null for every type), and
 * a required field is marked so — the service refuses to clear one.
 */
export function CustomFieldsFields({
  definitions,
  values,
}: {
  definitions: CustomFieldDefinition[];
  /** Stored values keyed by `api_name` (the customer's `custom_fields` object). */
  values?: Record<string, unknown> | null;
}) {
  const active = definitions
    .filter((d) => !d.archived)
    .sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
  if (active.length === 0) return null;

  const current = values ?? {};
  return (
    <div className="flex flex-col gap-4">
      {active.map((d) => {
        const name = `cf_${d.api_name}`;
        const raw = current[d.api_name];
        const asStr = raw == null ? "" : String(raw);
        // Custom-field errors from the server come back as one general
        // CustomFieldError message (surfaced via the enclosing ActionForm's
        // toast), not a per-`cf_<name>` entry — the service validates against
        // admin-DEFINED, dynamic definitions it alone knows, so there is no
        // fixed per-field zod shape to key an inline error off. `<Field>` still
        // gives every custom field the same label/help/required/aria wiring as
        // every other input on this form.
        return (
          <Field
            key={d.id}
            name={name}
            label={d.label}
            required={d.required}
            help={
              <>
                <span className="font-mono">{d.cf_name}</span> · {d.data_type}
                {d.is_pii ? " · PII" : ""}
              </>
            }
          >
            {d.data_type === "boolean" ? (
              // The hidden `false` posts FIRST so an unchecked box still sends a
              // value; the action takes the LAST value for the name. Without it an
              // unchecked box sends nothing, the service merges onto the existing
              // value, and the field could never be turned back off.
              <span className="flex items-center gap-2">
                {/* The "false" input comes FIRST so it is overridden by the "true"
                    one when checked — this is how a boolean custom field clears. */}
                <input type="hidden" name={name} value="false" />
                <CheckboxField
                  name={name}
                  value="true"
                  defaultChecked={raw === true || raw === "true"}
                  label={<span className="text-sm text-muted-foreground">Enabled</span>}
                />
              </span>
            ) : d.data_type === "enum" ? (
              <SelectField
                name={name}
                defaultValue={asStr}
                ariaLabel={d.label ?? name}
                className="max-w-xs"
                options={[
                  // Blank clears the field — omitted when required, which cannot be cleared.
                  ...(d.required ? [] : [{ value: "", label: "—" }]),
                  ...(d.enum_options ?? []).map((o) => ({ value: o, label: o })),
                ]}
              />
            ) : d.data_type === "long_text" ? (
              <Textarea
                name={name}
                defaultValue={asStr}
                required={d.required}
                className="max-w-md"
                rows={3}
              />
            ) : (
              <Input
                name={name}
                type={
                  d.data_type === "number"
                    ? "number"
                    : d.data_type === "date"
                      ? "date"
                      : d.data_type === "email"
                        ? "email"
                        : "text"
                }
                step={d.data_type === "number" ? "any" : undefined}
                defaultValue={asStr}
                required={d.required}
                className={
                  d.data_type === "string" || d.data_type === "email" ? "max-w-md" : "max-w-xs"
                }
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}
