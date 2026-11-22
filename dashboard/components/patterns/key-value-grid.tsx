import * as React from "react";
import { cn } from "@/lib/utils";
import { NoWrapDates } from "@/components/patterns/nowrap-dates";
import { CopyButton } from "@/components/patterns/copy-button";

export interface KeyValueRow {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Render a copy button next to the value (pass the raw string to copy). */
  copy?: string;
}

/**
 * Striped key/value grid: shaded label cell + value cell.
 * `columns=2` pairs rows into two side-by-side grids on wide screens (the
 * customer-detail header layout).
 */
export function KeyValueGrid({
  rows,
  columns = 1,
  className,
}: {
  rows: Array<KeyValueRow | null | undefined | false>;
  columns?: 1 | 2;
  className?: string;
}) {
  const items = rows.filter(Boolean) as KeyValueRow[];
  if (items.length === 0) return null;
  if (columns === 2) {
    const mid = Math.ceil(items.length / 2);
    return (
      <div className={cn("grid grid-cols-1 gap-x-6 lg:grid-cols-2", className)}>
        <KeyValueGrid rows={items.slice(0, mid)} />
        <KeyValueGrid rows={items.slice(mid)} />
      </div>
    );
  }
  return (
    <dl className={cn("divide-y divide-border/70 text-sm", className)}>
      {items.map((r, i) => (
        // On a phone a value too long for the label's line takes the full width under it; the
        // label band then fills its own line.
        <div
          key={i}
          className="grid grid-cols-[minmax(7rem,2fr)_minmax(0,5fr)] max-sm:flex max-sm:flex-wrap"
        >
          <dt className="bg-muted/50 px-3 py-2 font-medium text-foreground/70 max-sm:flex-[1_0_7rem]">
            {r.label}
          </dt>
          <dd className="flex min-w-0 items-center gap-1 px-3 py-2 max-sm:flex-[999_1_auto]">
            <span className="min-w-0 wrap-break-word">
              <NoWrapDates>{r.value ?? "—"}</NoWrapDates>
            </span>
            {r.copy ? <CopyButton value={r.copy} /> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
