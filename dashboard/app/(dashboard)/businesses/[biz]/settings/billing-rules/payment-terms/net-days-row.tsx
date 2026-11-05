"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/settings/settings-layout";

/** Net-D with its consequence following what is typed. */
export function NetDaysRow({ defaultValue }: { defaultValue: number | null }) {
  const [text, setText] = useDefaultState(defaultValue ? String(defaultValue) : "");
  const n = Number(text);
  const days = text.trim() !== "" && Number.isInteger(n) && n > 0 ? n : null;

  return (
    <SettingRow
      label="Default payment terms"
      htmlFor="default_due_days"
      help="The number of days from issue to the due date. Enter 0 or leave blank to make an invoice due on issue."
      errorFor="default_due_days"
      control={
        <span className="inline-flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Net</span>
          <Input
            id="default_due_days"
            name="default_due_days"
            type="number"
            inputMode="numeric"
            min={0}
            max={365}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="—"
            className="w-24 text-right tabular-nums"
          />
          <span className="text-sm text-muted-foreground">days</span>
        </span>
      }
      consequence={
        days == null
          ? "Invoices are due the day they are issued."
          : `An invoice is due ${days} day${days === 1 ? "" : "s"} after it is issued, and shows that due date.`
      }
      more="A subscription's own terms apply first, then the customer's terms. This value applies when neither sets terms. A 0 at either of those levels also uses this value."
    />
  );
}
