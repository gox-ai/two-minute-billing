import type { CreditNoteKind } from "@/lib/api/credit-notes";

/** One search result in the credit-note invoice picker. */
export interface InvoiceChoice {
  id: string;
  number: string | null;
  status: string;
  currency: string;
  total_minor: number;
  customer: string | null;
  created_at: string | null;
}

/** The invoice the form credits, with the lines it allocates against. */
export interface PickInvoice {
  id: string;
  number?: string | null;
  status: string;
  currency: string;
  total_minor: number;
  amount_due_minor?: number | null;
  /** Credit grants applied, before and after tax. Their share of a credit goes back to them. */
  grant_credits_minor?: number;
  /** `creditable_minor`: the most a credit note can still credit on the line. */
  lines: Array<{ id: string; description: string; amount_minor: number; creditable_minor: number }>;
}

/**
 * Statuses each kind can credit, mirroring the engine: an adjustment reduces an OPEN
 * invoice's balance, a refundable note returns money on a PAID one.
 */
export const CREDITABLE_STATUSES: Record<CreditNoteKind, readonly string[]> = {
  adjustment: ["posted", "payment_due", "not_paid"],
  refundable: ["paid"],
};
