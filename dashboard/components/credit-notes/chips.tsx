import * as React from "react";
import { Chip } from "@/components/patterns/chip";
import type { CreditNoteKind, CreditNoteReasonCode } from "@/lib/api/credit-notes";

const KIND_LABEL: Record<CreditNoteKind, string> = {
  adjustment: "Adjustment",
  refundable: "Refundable",
};

/** Kind pill (adjustment = reduces an unpaid invoice; refundable = cashable credit). */
export function KindBadge({ kind, className }: { kind: CreditNoteKind; className?: string }) {
  return (
    <Chip tone="blue" className={className}>
      {KIND_LABEL[kind] ?? kind}
    </Chip>
  );
}

const REASON_LABEL: Record<string, string> = {
  write_off: "Write-off",
  subscription_change: "Subscription change",
  subscription_cancellation: "Subscription cancellation",
  chargeback: "Chargeback",
  other: "Other",
  refund_restore: "Refund (credit restored)",
};

/** Human label for a reason code. */
export function reasonLabel(code: CreditNoteReasonCode | string | null | undefined): string {
  if (!code) return "—";
  return REASON_LABEL[code] ?? code.replace(/_/g, " ");
}
