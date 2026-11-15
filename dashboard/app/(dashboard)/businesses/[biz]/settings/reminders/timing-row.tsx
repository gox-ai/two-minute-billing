"use client";

import { useDefaultState } from "@/lib/use-default-state";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/settings/settings-layout";
import { SelectAnswer } from "@/components/patterns/settings-page";

/**
 * A reminder kind with a second option beside lead days: Off, or (card expiry) the expiry
 * month. Posts `timing_<kind>` = `other` | `days` and `lead_days_<kind>` = "30, 7".
 */
export function TimingRow({
  kind,
  label,
  help,
  otherLabel,
  otherConsequence,
  value,
  suggested,
}: {
  kind: string;
  label: string;
  help: string;
  /** The option that is not lead days: "Off" or "In the month the card expires". */
  otherLabel: string;
  /** Only where it adds to the label. */
  otherConsequence?: string;
  /** The stored lead days; null = the other option is in use. */
  value: number[] | null;
  /** Shown in the field when the other option is in use. */
  suggested: number[];
}) {
  const [mode, setMode] = useDefaultState(value ? "days" : "other");
  const [text, setText] = useDefaultState((value ?? suggested).join(", "));
  const name = `lead_days_${kind}`;
  return (
    <SettingRow
      label={label}
      htmlFor={`timing_${kind}`}
      help={help}
      errorFor={name}
      placement="end"
      control={
        <div className="flex flex-col items-end gap-2">
          <SelectAnswer
            name={`timing_${kind}`}
            ariaLabel={label}
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "other", label: otherLabel },
              { value: "days", label: "Days before" },
            ]}
          />
          {mode === "days" ? (
            <Input
              id={name}
              name={name}
              aria-label={`${label}: days before`}
              inputMode="numeric"
              required
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-30 tabular-nums"
            />
          ) : null}
        </div>
      }
      consequence={mode === "other" ? otherConsequence : undefined}
    />
  );
}
