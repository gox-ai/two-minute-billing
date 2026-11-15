import * as React from "react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/patterns/copy-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const TAIL = 6;

/**
 * A mono id on one line, always. When the box is narrow the middle of the id
 * collapses to an ellipsis and the last characters stay visible, so two ids that
 * share a prefix still differ. The full id sits in a tooltip.
 */
export function MiddleEllipsis({ value, className }: { value: string; className?: string }) {
  const split = value.length > TAIL * 2 ? value.length - TAIL : value.length;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-id-text
          className={cn(
            "inline-flex max-w-full min-w-0 items-baseline font-mono whitespace-nowrap",
            className,
          )}
        >
          <span className="min-w-0 truncate">{value.slice(0, split)}</span>
          {split < value.length ? <span className="shrink-0">{value.slice(split)}</span> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent className="font-mono break-all">{value}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Inline id for a cell or a key-value row: one line, middle ellipsis, optional copy. With
 * `href` (a gateway's own page, `gatewayObjectUrl`) the id opens it in a new tab.
 */
export function IdText({
  id,
  copy = true,
  href,
  className,
}: {
  id: string;
  copy?: boolean;
  href?: string | null;
  className?: string;
}) {
  const text = <MiddleEllipsis value={id} className="text-xs" />;
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center gap-0.5", className)}>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 text-primary hover:underline"
        >
          {text}
        </a>
      ) : (
        text
      )}
      {copy ? <CopyButton value={id} className="shrink-0" /> : null}
    </span>
  );
}
