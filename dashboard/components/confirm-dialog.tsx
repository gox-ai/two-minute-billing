'use client'

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Use the destructive button styling (delete/archive flows). */
  destructive?: boolean
  /** Invoked on confirm. May be async; the button shows a pending state. */
  onConfirm: () => void | Promise<void>
  /**
   * Paint this dialog with the STOREFRONT's tenant brand.
   *
   * Opt-in rather than automatic: Radix portals a dialog to `<body>`, outside the
   * storefront's `[data-brand]` wrapper, so a buyer-facing confirm would otherwise
   * drop the merchant's colour that the page behind it is painted with. It must stay
   * opt-in because the operator dashboard renders `brandCss` too — on the Brand Styles
   * previews — and a tenant colour must never leak into our own chrome.
   */
  brand?: boolean
}

/**
 * Reusable confirmation dialog for destructive / irreversible actions. The
 * design bar requires a confirm step on destructive actions; pair with a toast +
 * undo where the action is reversible.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive,
  onConfirm,
  brand,
}: ConfirmDialogProps) {
  const [pending, setPending] = React.useState(false)

  async function handleConfirm() {
    try {
      setPending(true)
      await onConfirm()
      onOpenChange(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent {...(brand ? { 'data-brand': true } : {})}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={pending}
          >
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
