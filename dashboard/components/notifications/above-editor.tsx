"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MoneyInput } from "@/components/form/money-input";
import { toMajorInput } from "@/lib/money";
import { cn } from "@/lib/utils";
import { aboveText } from "@/lib/notifications-view";
import type { AboveLimits } from "@/lib/api/notifications";

/**
 * "Only above": one amount per currency. It edits the form's state only; Save in the save bar
 * keeps it. A currency with no amount gets every event.
 */
export function AboveEditor({
  label,
  currencies,
  value,
  onChange,
  disabled,
}: {
  /** The event's name: the popover title and the accessible names. */
  label: string;
  currencies: string[];
  value: AboveLimits | undefined;
  onChange: (next: AboveLimits) => void;
  disabled?: boolean;
}) {
  if (currencies.length === 0) return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        aria-label={`Only above for ${label}: ${aboveText(value)}`}
        className={cn(
          "inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm font-medium whitespace-nowrap text-primary transition-colors",
          "hover:bg-muted/40 disabled:pointer-events-none disabled:opacity-50",
        )}
      >
        {aboveText(value)}
        <ChevronDown aria-hidden className="size-4" />
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="m-0 text-sm font-medium">{label}</p>
          <p className="m-0 text-xs text-muted-foreground">
            Notify only at or above this amount. A currency with no amount gets every event.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {currencies.map((cur) => (
            <MoneyInput
              key={cur}
              currency={cur}
              aria-label={`Only above for ${label} in ${cur}`}
              defaultMajor={value?.[cur] ? toMajorInput(value[cur], cur) : undefined}
              onMinorChange={(minor) => {
                const next = { ...value };
                const n = minor === "" ? 0 : Number(minor);
                if (n > 0) next[cur] = n;
                else delete next[cur];
                if (JSON.stringify(next) !== JSON.stringify(value ?? {})) onChange(next);
              }}
              className="w-full"
            />
          ))}
        </div>
        <p className="m-0 text-xs text-muted-foreground">
          Save in the save bar keeps the changes. Press Esc to close this box.
        </p>
      </PopoverContent>
    </Popover>
  );
}
