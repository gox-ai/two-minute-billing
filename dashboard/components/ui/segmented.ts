import { cn } from "@/lib/utils";

/**
 * The segmented control's look — a rounded track with the selected segment as a raised card
 * pill. Shared by Radix `TabsList` (default variant) and by the URL tab navs, which are links.
 * The navs wrap on a phone rather than scroll: a scrollbar inside the track reads as a fault.
 *
 * A plain module, not `"use client"`: a server component that imported a string from a client
 * module would receive a client reference, not the string.
 */
export const SEGMENT_TRACK =
  "inline-flex w-fit max-w-full flex-wrap items-center gap-1 rounded-xl border bg-muted/60 p-1";

export function segmentItem(selected: boolean, className?: string) {
  return cn(
    "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3.5 text-sm whitespace-nowrap transition-colors",
    selected
      ? "bg-raised font-medium text-foreground shadow-xs"
      : "text-muted-foreground hover:text-foreground",
    className,
  );
}
