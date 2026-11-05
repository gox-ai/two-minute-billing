"use client";

import { Field } from "@/components/form/field";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { RadioField } from "@/components/ui/radio-group";
import { everyOptions, hasCount, type ResetDraft, type ResetEvery } from "@/lib/reset";

/**
 * "Renews": every N hours … years, each billing term, or never; anchored at the subscription
 * start or on the calendar (the business time zone). Controlled; the caller posts the value.
 */
export function RenewsField({
  name,
  target,
  value,
  onChange,
  help,
}: {
  name: string;
  target: "credits" | "allowance";
  value: ResetDraft;
  onChange: (v: ResetDraft) => void;
  help?: string;
}) {
  const set = <K extends keyof ResetDraft>(k: K, v: ResetDraft[K]) =>
    onChange({ ...value, [k]: v });
  return (
    <>
      <Field name={`${name}_every`} label="Renews" help={help}>
        <div className="flex items-center gap-2">
          {hasCount(value.every) ? (
            <>
              <span className="text-sm text-muted-foreground">Every</span>
              <Input
                id={`${name}_count`}
                aria-label="How many"
                type="number"
                min={1}
                max={1000}
                value={value.count}
                onChange={(e) => set("count", e.target.value)}
                className="w-20 tabular-nums"
              />
            </>
          ) : null}
          <SelectField
            id={`${name}_every`}
            value={value.every}
            onValueChange={(e) => set("every", e as ResetEvery)}
            ariaLabel="Renews"
            options={everyOptions(target, value.count)}
          />
        </div>
      </Field>
      {hasCount(value.every) ? (
        <Field name={`${name}_anchor`} label="Windows start">
          <RadioField
            value={value.anchor}
            onValueChange={(a) => set("anchor", a as ResetDraft["anchor"])}
            ariaLabel="Windows start"
            options={[
              {
                value: "subscription",
                label: "From the subscription start",
                hint: "Each window starts at the start of the billing term.",
              },
              {
                value: "calendar",
                label: "On the calendar",
                hint: "On the hour, at midnight, on Monday, or on the 1st of the month, in the business time zone.",
              },
            ]}
          />
        </Field>
      ) : null}
    </>
  );
}
