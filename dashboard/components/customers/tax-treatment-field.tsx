import { SelectField } from "@/components/ui/select-field";
import { Field } from "@/components/form/field";
import { Input } from "@/components/ui/input";
import { TREATMENT_LABEL } from "@/lib/tax-format";
import type { TaxRegion, TaxTreatment } from "@/lib/api";

/**
 * The customer's tax treatment, offered ONLY where the region enables it.
 *
 * `allowed_tax_treatments` is derived server-side from the region's own gates, so this
 * renders exactly the choices the engine will honour — never a dropdown option that
 * resolves to nothing. When the customer's country has no region, or the region enables
 * no special treatment, the whole select is omitted and a line of prose says why. That
 * is deliberate: a disabled select showing one option implies a choice exists.
 */
export function TaxTreatmentField({
  region,
  value,
  registrationNumber,
}: {
  /** The region matching the customer's billing country, if any. */
  region: TaxRegion | null;
  value?: TaxTreatment;
  registrationNumber?: string | null;
}) {
  const allowed = region?.allowed_tax_treatments ?? [];
  const hasChoice = allowed.length > 1;
  const current: TaxTreatment = value ?? "default";

  return (
    <>
      {hasChoice ? (
        <Field
          name="tax_treatment"
          label="Tax treatment"
          help={`Select the treatment that applies to this customer in ${region!.country}. Standard uses the customer's state.`}
        >
          <SelectField
            name="tax_treatment"
            defaultValue={current}
            ariaLabel="Tax treatment"
            className="max-w-sm"
            options={allowed.map((t) => ({ value: t, label: TREATMENT_LABEL[t] }))}
          />
        </Field>
      ) : (
        <>
          {/* Keep the saved value: omitting the input entirely would leave the field
              unmentioned in the PATCH, which correctly preserves it. But if this
              customer already carries a non-standard treatment that the region no longer
              offers, say so rather than hiding it. */}
          {current !== "default" ? (
            <div className="rounded-md bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              This customer uses{" "}
              <span className="font-medium text-foreground">{TREATMENT_LABEL[current]}</span>, but{" "}
              {region ? `${region.country} no longer offers it` : "their country has no tax region"}
              . It continues to apply until you change it. Enable the treatment on the region to
              edit it here.
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {region
                ? `No special tax treatments are enabled for ${region.country}. Enable SEZ, export or reverse charge on the region to show them here.`
                : "Tax treatment is available when a tax region exists for this customer’s country."}
            </p>
          )}
        </>
      )}

      {/* Always offered: it is a plain column on the customer and stores whatever is
          entered. The region's `collect_registration_number` switch is about asking the
          customer in the storefront, not about whether an operator may record it. */}
      <Field
        name="tax_registration_number"
        label={region?.registration_label === "gstin" ? "GSTIN" : "Tax registration number"}
        help="The customer's registration number. We print it on the customer's invoices."
      >
        <Input
          name="tax_registration_number"
          defaultValue={registrationNumber ?? ""}
          maxLength={50}
          className="max-w-sm font-mono"
        />
      </Field>
    </>
  );
}
