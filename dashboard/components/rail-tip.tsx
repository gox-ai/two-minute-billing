"use client";

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNavCollapse } from "@/components/nav-collapse";

/** The 3px focus ring of the form primitives, for a rail row. */
export const NAV_FOCUS =
  "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

/**
 * Names a rail row on hover and focus. Only while the rail is collapsed, because an open
 * rail already shows the label; `always` is for text that can be cut short.
 */
export function RailTip({
  label,
  always = false,
  children,
}: {
  label: string;
  always?: boolean;
  children: React.ReactElement;
}) {
  const { collapsed } = useNavCollapse();
  if (!collapsed && !always) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
