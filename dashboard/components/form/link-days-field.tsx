import { Field } from "@/components/form/field";
import { Input } from "@/components/ui/input";

/** The emailed or copied link's lifetime, preset to the business's email link setting. */
export function LinkDaysField({ defaultDays }: { defaultDays: number }) {
  return (
    <Field name="link_valid_days" label="Days the link works" help="From 1 to 14 days.">
      <Input
        name="link_valid_days"
        type="number"
        min={1}
        max={14}
        required
        defaultValue={defaultDays}
        className="w-20 tabular-nums"
      />
    </Field>
  );
}

/** The business's email link lifetime in days: its setting, else the built-in 5. */
export function emailLinkDays(
  business: { storefront_config?: { portal_email_link_days?: number | null } | null } | undefined,
): number {
  return business?.storefront_config?.portal_email_link_days ?? 5;
}
