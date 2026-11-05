"use client";

import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { saveUsageWidgetOriginsAction } from "@/app/(dashboard)/businesses/[biz]/usage-controls-actions";

/** The origins that may call the usage widget: one per line, replaced as a whole. */
export function WidgetOriginsForm({ biz, origins }: { biz: string; origins: string[] }) {
  return (
    <ActionForm action={saveUsageWidgetOriginsAction} className="flex flex-col gap-3">
      <input type="hidden" name="biz" value={biz} />
      <Field
        name="origins"
        label="Allowed origins"
        help="One per line, for example https://app.example.com. https only, except http://localhost. At most 20."
      >
        <Textarea
          name="origins"
          rows={4}
          defaultValue={origins.join("\n")}
          className="font-mono text-sm"
        />
      </Field>
      <div className="flex justify-end">
        <SubmitButton>Save origins</SubmitButton>
      </div>
    </ActionForm>
  );
}
