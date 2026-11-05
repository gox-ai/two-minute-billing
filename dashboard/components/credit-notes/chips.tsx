import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { CreditNoteKind, CreditNoteReasonCode } from '@/lib/api/credit-notes'

const KIND_CLASS: Record<CreditNoteKind, string> = {
  adjustment: 'border-info/25 bg-info-soft text-info',
  refundable: 'border-info/25 bg-info-soft text-info',
}

const KIND_LABEL: Record<CreditNoteKind, string> = {
  adjustment: 'Adjustment',
  refundable: 'Refundable',
}

/** Kind pill (adjustment = reduces an unpaid invoice; refundable = cashable credit). */
export function KindBadge({ kind, className }: { kind: CreditNoteKind; className?: string }) {
  return (
    <Badge variant="outline" className={cn('font-medium', KIND_CLASS[kind] ?? '', className)}>
      {KIND_LABEL[kind] ?? kind}
    </Badge>
  )
}

const REASON_LABEL: Record<string, string> = {
  write_off: 'Write-off',
  subscription_change: 'Subscription change',
  subscription_cancellation: 'Subscription cancellation',
  chargeback: 'Chargeback',
  other: 'Other',
  refund_restore: 'Refund (credit restored)',
}

/** Human label for a reason code. */
export function reasonLabel(code: CreditNoteReasonCode | string | null | undefined): string {
  if (!code) return '—'
  return REASON_LABEL[code] ?? code.replace(/_/g, ' ')
}
