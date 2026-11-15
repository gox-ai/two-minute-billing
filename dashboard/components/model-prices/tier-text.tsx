import * as React from "react";
import { tokenTypeLabel } from "@/lib/model-prices";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** One line, cut at the width `className` gives; the full text is in a tooltip. */
export function Capped({
  text,
  className,
  children,
}: {
  text: React.ReactNode;
  className: string;
  children?: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn("truncate", className)}>{children ?? text}</div>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A quality or resolution value, shown as it is typed. The code font with contextual
 * alternates off: the text font draws the "x" of "1024x1024" as "×", which the field refuses.
 */
export function TierText({ children, className }: { children: string; className?: string }) {
  return (
    <span data-tier-text className={cn("font-mono font-features-['calt'_0]", className)}>
      {children}
    </span>
  );
}

/** "hd · 1024x1024"; nothing when the row has no tier. */
export function Tier({
  quality,
  resolution,
}: {
  quality?: string | null;
  resolution?: string | null;
}) {
  const parts = [quality, resolution].filter((p): p is string => !!p);
  return parts.map((p, i) => (
    <React.Fragment key={i}>
      {i ? " · " : null}
      <TierText>{p}</TierText>
    </React.Fragment>
  ));
}

/** "Output · hd · 1024x1024": the type and its tier (`priceTypeLabel`, for the screen). */
export function PriceType({
  r,
}: {
  r: { token_type: string; quality?: string | null; resolution?: string | null };
}) {
  return (
    <>
      {tokenTypeLabel(r.token_type)}
      {r.quality || r.resolution ? " · " : null}
      <Tier quality={r.quality} resolution={r.resolution} />
    </>
  );
}
