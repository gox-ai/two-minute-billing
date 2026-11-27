"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { useInModal } from "@/components/ui/in-modal";

/**
 * Popover — the container the app was missing for filter panels, column pickers
 * and inline editors, all of which are currently either a Dialog (too heavy) or
 * a hand-rolled absolutely-positioned div (no focus trap, no collision handling,
 * no escape-to-close).
 */
/**
 * Inside a modal Dialog or Sheet the popover is modal too (unless the caller says otherwise):
 * the dialog's scroll lock covers everything outside it, and the portalled content is outside
 * it, so a non-modal popover's list would not scroll (reported on the segment filter dialog,
 * 2026-11-26). Modal gives the content its own lock, which takes over while it is open.
 */
function Popover({ modal, ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const inModal = useInModal();
  return <PopoverPrimitive.Root data-slot="popover" modal={modal ?? inModal} {...props} />;
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-xl border border-popover-border bg-popover p-3 text-popover-foreground shadow-lg outline-none",
          "max-h-(--radix-popover-content-available-height) overflow-y-auto",
          // Grows from the trigger (Radix's transform origin) on the spring.
          "data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
