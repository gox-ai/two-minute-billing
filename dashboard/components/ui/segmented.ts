import { cn } from "@/lib/utils";

/**
 * The segmented control's look — a rounded track with the selected segment as a raised card
 * pill. Shared by Radix `TabsList` (default variant) and by the URL tab navs, which are links.
 * The navs wrap on a phone rather than scroll: a scrollbar inside the track reads as a fault.
 * Home's five-tab strip is the exception: it scrolls in one row with the scrollbar hidden.
 *
 * Put `<SegmentIndicator />` (`./segment-indicator`) first in the track and the pill slides
 * between segments. `segment-on` marks the selected one for it; `isolate` keeps the pill
 * (z -10) above the track's own ground.
 *
 * A plain module, not `"use client"`: a server component that imported a string from a client
 * module would receive a client reference, not the string.
 */
export const SEGMENT_TRACK =
  "relative isolate inline-flex w-fit max-w-full flex-wrap items-center gap-1 rounded-xl border bg-muted/60 p-1";

export function segmentItem(selected: boolean, className?: string) {
  return cn(
    "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3.5 text-sm whitespace-nowrap transition-colors",
    selected
      ? "segment-on bg-raised font-medium text-foreground shadow-xs"
      : "text-muted-foreground hover:text-foreground",
    className,
  );
}
