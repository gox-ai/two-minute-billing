"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The one Refresh control. Presentational on purpose — the caller owns the fetch, because
 * what "refresh" means differs by page: a list re-runs its `fetchPage` query, a detail page
 * calls a server action for its volatile fields, a monitoring page re-runs the whole route.
 *
 * `pending` drives both the spinner and the disabled state. Without it the button looks dead
 * on exactly the slow pages that need it most, which is a control that does nothing.
 */
export function RefreshButton({
  onRefresh,
  pending = false,
  label = "Refresh",
  variant = "ghost",
  className,
}: {
  onRefresh: () => void;
  pending?: boolean;
  label?: string;
  variant?: "ghost" | "outline";
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      className={cn("text-muted-foreground", className)}
      onClick={onRefresh}
      disabled={pending}
      aria-busy={pending}
    >
      <RefreshCw className={cn("size-3.5", pending && "animate-spin")} />
      {label}
    </Button>
  );
}
