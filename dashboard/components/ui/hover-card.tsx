"use client";

import * as React from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Hover card — a peek panel that opens on hover AND on keyboard focus, and whose
 * contents can be clicked. That last part is why this is not a `Tooltip`: tooltip
 * text is supplementary and unreachable, and these panels carry links.
 *
 * It still may only ever hold a preview of something reachable elsewhere. Anything
 * a user needs in order to act belongs in the visible row.
 */
function HoverCard({
  openDelay = 150,
  closeDelay = 100,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return (
    <HoverCardPrimitive.Root
      data-slot="hover-card"
      openDelay={openDelay}
      closeDelay={closeDelay}
      {...props}
    />
  );
}

function HoverCardTrigger({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />;
}

function HoverCardContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit max-w-sm origin-(--radix-hover-card-content-transform-origin) rounded-lg border bg-popover p-3 text-popover-foreground shadow-md outline-none",
          "max-h-(--radix-hover-card-content-available-height) overflow-y-auto",
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
