"use client";

import { useDefaultState } from "@/lib/use-default-state";
import { Input } from "@/components/ui/input";
import { RadioField } from "@/components/ui/radio-group";
import { SettingRow } from "@/components/settings/settings-layout";
import { leadDaysLine } from "./copy";

/**
 * A reminder kind with a second option beside lead days: Off, or (card expiry) the expiry
 * month. Posts `timing_<kind>` = `other` | `days` and `lead_days_<kind>` = "30, 7".
 */
export function TimingRow({
  kind,
  label,
  help,
  target,
  otherLabel,
  otherConsequence,
  value,
  suggested,
}: {
  kind: string;
  label: string;
  help: string;
  /** What the reminder comes before ("the due date"). */
  target: string;
  /** The option that is not lead days: "Off" or "In the month the card expires". */
  otherLabel: string;
  otherConsequence: string;
  /** The stored lead days; null = the other option is in use. */
  value: number[] | null;
  /** Shown in the field when the other option is in use. */
  suggested: number[];
}) {
  const [mode, setMode] = useDefaultState(value ? "days" : "other");
  const [text, setText] = useDefaultState((value ?? suggested).join(", "));
  const name = `lead_days_${kind}`;
  const days = text
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 90);
  return (
    <SettingRow
      label={label}
      help={help}
      errorFor={name}
      control={
        <div className="flex flex-col gap-3">
          <RadioField
            name={`timing_${kind}`}
            ariaLabel={label}
            value={mode}
            onValueChange={setMode}
            className="grid-cols-1 sm:grid-cols-2"
            options={[
              { value: "other", label: otherLabel },
              { value: "days", label: "Days before" },
            ]}
          />
          {mode === "days" ? (
            <span className="inline-flex items-center gap-2">
              <Input
                id={name}
                name={name}
                aria-label={`${label}: days before`}
                inputMode="numeric"
                required
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="w-32 tabular-nums"
              />
              <span className="text-sm text-muted-foreground">days before</span>
            </span>
          ) : null}
        </div>
      }
      consequence={
        mode === "other"
          ? otherConsequence
          : days.length
            ? `We send a reminder ${leadDaysLine(days)} before ${target}.`
            : undefined
      }
    />
  );
}
