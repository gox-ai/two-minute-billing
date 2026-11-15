"use client";

import { useDefaultState } from "@/lib/use-default-state";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/settings/settings-layout";
/** One reminder kind's lead days, typed as "15, 3". */
export function LeadDaysRow({
  kind,
  label,
  help,
  value,
}: {
  kind: string;
  label: string;
  help: string;
  value: number[];
}) {
  const name = `lead_days_${kind}`;
  const [text, setText] = useDefaultState(value.join(", "));
  return (
    <SettingRow
      label={label}
      htmlFor={name}
      help={help}
      errorFor={name}
      placement="end"
      control={
        <Input
          id={name}
          name={name}
          inputMode="numeric"
          required
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-30 tabular-nums"
        />
      }
    />
  );
}
