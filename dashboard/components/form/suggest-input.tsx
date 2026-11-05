"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface Suggestion {
  value: string;
  /** Shown on the right, e.g. "4,660 records · string". */
  detail?: string;
}

/**
 * A free-text input with a list of suggestions under it. Typing filters the list; a click or
 * Enter on a suggestion fills the input. The input never loses focus to the list.
 */
export function SuggestInput({
  value,
  onChange,
  suggestions,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  suggestions: Suggestion[];
}) {
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const q = value.trim().toLowerCase();
  const shown = suggestions
    .filter((s) => s.value !== value && (!q || s.value.toLowerCase().includes(q)))
    .slice(0, 12);
  const pick = (s: Suggestion) => {
    onChange(s.value);
    setOpen(false);
  };

  return (
    <Popover open={open && shown.length > 0} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Input
          {...props}
          value={value}
          autoComplete="off"
          className={className}
          aria-autocomplete="list"
          aria-expanded={open && shown.length > 0}
          onFocus={(e) => {
            setOpen(true);
            props.onFocus?.(e);
          }}
          onBlur={(e) => {
            setOpen(false);
            props.onBlur?.(e);
          }}
          onChange={(e) => {
            onChange(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (!shown.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((i) => (i + 1) % shown.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => (i - 1 + shown.length) % shown.length);
            } else if (e.key === "Enter" && open) {
              e.preventDefault();
              pick(shown[Math.min(active, shown.length - 1)]!);
            } else if (e.key === "Escape") setOpen(false);
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        className="w-(--radix-popover-trigger-width) min-w-56 p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <ul role="listbox" aria-label="Suggestions" className="flex flex-col">
          {shown.map((s, i) => (
            <li key={s.value} role="option" aria-selected={i === active}>
              <button
                type="button"
                // Before the input's blur, so the click lands while the list is open.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm",
                  i === active ? "bg-muted" : "hover:bg-muted",
                )}
              >
                <span className="truncate font-mono">{s.value}</span>
                {s.detail ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{s.detail}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
