"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface EditDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  /**
   * Kept so the existing call sites keep compiling, and IGNORED — the modal is
   * always centered. Drop the prop from call sites as they are touched.
   */
  side?: "right" | "left" | "top" | "bottom";
  children: React.ReactNode;
  /** Sticky footer (save / cancel actions). */
  footer?: React.ReactNode;
  /** Widen past the default 540px for forms with two-column field groups. */
  wide?: boolean;
}

/**
 * Centered modal for per-action edit forms.
 *
 * This WAS a right-hand slide-over `Sheet` ("Stripe/Linear style"). Core entities are
 * never edited in a drawer here, and the modal archetype is centered — title left,
 * actions top/bottom-right, 540px wide. The component name is kept only so the 8
 * existing call sites keep compiling; it is a modal now.
 *
 * For creating or editing a CORE entity neither this nor a drawer is correct — use a
 * full-page takeover (`components/patterns/takeover.tsx`). This is for the smaller per-action
 * surfaces shown as modals: manage credits, record a payment, edit an address.
 * Body scrolls; the footer stays pinned.
 */
export function EditDrawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: EditDrawerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex max-h-[85vh] flex-col gap-0 p-0",
          wide ? "sm:max-w-2xl" : "sm:max-w-[540px]",
        )}
      >
        <DialogHeader className="border-b px-6 py-4 text-left">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer ? <DialogFooter className="border-t px-6 py-4">{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}
