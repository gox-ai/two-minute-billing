"use client";

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * One line with an ellipsis. The full value is in a tooltip, which opens only when the
 * text is cut, so a short value never repeats itself on hover.
 */
export function TruncatedText({ value, className }: { value: string; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        const el = ref.current;
        setOpen(next && !!el && el.scrollWidth > el.clientWidth);
      }}
    >
      <TooltipTrigger asChild>
        <div ref={ref} className={cn("truncate", className)}>
          {value}
        </div>
      </TooltipTrigger>
      <TooltipContent className="wrap-break-word">{value}</TooltipContent>
    </Tooltip>
  );
}
