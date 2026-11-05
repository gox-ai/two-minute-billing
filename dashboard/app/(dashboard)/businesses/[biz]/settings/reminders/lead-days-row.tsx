"use client";

import { useDefaultState } from "@/lib/use-default-state";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/settings/settings-layout";
import { leadDaysLine } from "./copy";

/** One reminder kind's lead days, typed as "15, 3"; the consequence previews the result. */
export function LeadDaysRow({
  kind,
  label,
  help,
  target,
  value,
}: {
  kind: string;
  label: string;
  help: string;
  /** What the reminder comes before, for the consequence line ("the trial ends"). */
  target: string;
  value: number[];
}) {
  const name = `lead_days_${kind}`;
  const [text, setText] = useDefaultState(value.join(", "));
  const days = text
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 90);
  return (
    <SettingRow
      label={label}
      htmlFor={name}
      help={help}
      errorFor={name}
      control={
        <span className="inline-flex items-center gap-2">
          <Input
            id={name}
            name={name}
            inputMode="numeric"
            required
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-32 tabular-nums"
          />
          <span className="text-sm text-muted-foreground">days before</span>
        </span>
      }
      consequence={
        days.length ? `We send a reminder ${leadDaysLine(days)} before ${target}.` : undefined
      }
    />
  );
}
