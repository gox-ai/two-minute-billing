// Typed fetchers for receipts (read-only). Server-only.
// Shapes mirror src/modules/receipts/service.ts `serializeReceipt`.
import { apiGet, apiGetOrNull, listQuery } from "@/lib/api";
import type { ListParams, PagedList } from "@/lib/api";

export interface ReceiptAllocation {
  /** Null = the part that went to the customer's credit. */
  invoice: string | null;
  invoice_number: string | null;
  amount_minor: number;
}

export interface Receipt {
  object: "receipt";
  id: string;
  /** Null until the numbering job runs (seconds after the payment). */
  number: string | null;
  customer: string | null;
  payment: string | null;
  payments: string[];
  payment_request: string | null;
  amount_minor: number;
  currency: string;
  paid_at: string;
  /** Words, frozen at payment time: "Visa ···4242", "Cash". */
  method: string;
  allocations: ReceiptAllocation[];
  payer: {
    id: string;
    name: string | null;
    email: string | null;
    address: Record<string, unknown> | null;
    tax_id: string | null;
  };
  numbered_at: string | null;
  created_at: string;
}

/** The bare scoping params the receipts list accepts. */
export type ReceiptScope = {
  customer?: string;
  payment?: string;
  payment_request?: string;
  invoice?: string;
};

export function listReceipts(biz: string, params: ListParams & { scope?: ReceiptScope } = {}) {
  const q = listQuery({ ...params, scope: { ...params.scope } });
  return apiGet<PagedList<Receipt>>(`/v1/businesses/${biz}/receipts${q ? `?${q}` : ""}`);
}

export function getReceipt(biz: string, rcpt: string) {
  return apiGetOrNull<Receipt>(`/v1/businesses/${biz}/receipts/${rcpt}`);
}
