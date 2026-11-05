"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Modal wrapper for create forms: renders a trigger button that opens a dialog
 * containing the form (passed as children — may be server-rendered). The dialog
 * closes itself when the form inside submits (submit events bubble up).
 */
export function CreateDialog({
  triggerLabel,
  triggerVariant = "default",
  triggerSize,
  title,
  description,
  wide,
  defaultOpen,
  children,
}: {
  triggerLabel: string;
  triggerVariant?: React.ComponentProps<typeof Button>["variant"];
  /** Match the row it sits in — a per-row trigger in a 44px table row is `sm`. */
  triggerSize?: React.ComponentProps<typeof Button>["size"];
  title: string;
  description?: React.ReactNode;
  /** widen the dialog for multi-column / line-item forms */
  wide?: boolean;
  /** open on mount (e.g. deep-linked via ?new=1) */
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen ?? false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={triggerVariant} size={triggerSize}>
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className={cn(wide && "sm:max-w-2xl")} onSubmit={() => setOpen(false)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
