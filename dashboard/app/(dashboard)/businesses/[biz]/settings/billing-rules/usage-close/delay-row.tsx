"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/settings/settings-layout";

/** The extra wait, with its consequence following what is typed. */
export function UsageCloseDelayRow({ defaultValue }: { defaultValue: number }) {
  const [text, setText] = useDefaultState(String(defaultValue));
  const n = Number(text);
  const minutes = text.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 24 ? n : null;

  return (
    <SettingRow
      label="Extra wait before usage closes"
      htmlFor="usage_close_delay_minutes"
      help="We close usage about 6 minutes after the period ends, plus this wait. The total wait is never more than 30 minutes."
      errorFor="usage_close_delay_minutes"
      control={
        <span className="inline-flex items-center gap-2">
          <Input
            id="usage_close_delay_minutes"
            name="usage_close_delay_minutes"
            type="number"
            inputMode="numeric"
            min={0}
            max={24}
            step={1}
            required
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-24 text-right tabular-nums"
          />
          <span className="text-sm text-muted-foreground">minutes</span>
        </span>
      }
      consequence={
        minutes == null
          ? "Enter a whole number from 0 to 24."
          : minutes === 0
            ? "A subscription that bills a meter renews about 6 minutes after its period ends."
            : `A subscription that bills a meter renews about ${6 + minutes} minutes after its period ends.`
      }
      more="Use a wait if your app keeps events for some minutes before it sends them. An event that arrives after usage closes is not lost: it goes on the next invoice as usage from its own period."
    />
  );
}
