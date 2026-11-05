"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/settings/settings-layout";

/** Auto-close window; runAutoClosePending counts it from the invoice's period end. */
export function AutoCloseRow({ defaultValue }: { defaultValue: number | null }) {
  const [text, setText] = useDefaultState(defaultValue == null ? "" : String(defaultValue));
  const n = Number(text);
  const days = text.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : null;
  return (
    <SettingRow
      label="Auto-close pending invoices after"
      htmlFor="auto_close_pending_after_days"
      help="Leave blank to keep them open until a person or an API call closes them."
      errorFor="auto_close_pending_after_days"
      control={
        <span className="inline-flex items-center gap-2">
          <Input
            id="auto_close_pending_after_days"
            name="auto_close_pending_after_days"
            type="number"
            inputMode="numeric"
            min={0}
            max={365}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="never"
            className="w-24 text-right tabular-nums"
          />
          <span className="text-sm text-muted-foreground">days</span>
        </span>
      }
      consequence={
        days == null
          ? "Pending invoices stay open until someone closes them."
          : days === 0
            ? "We close a pending invoice as soon as its period ends."
            : `We close a pending invoice ${days} day${days === 1 ? "" : "s"} after its period ends.`
      }
    />
  );
}
