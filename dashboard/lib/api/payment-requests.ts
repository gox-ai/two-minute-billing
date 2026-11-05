// Typed fetchers for payment requests. Server-only.
// Shapes mirror src/modules/payment-requests/service.ts `serializePaymentRequest`.
import { apiGet, apiGetOrNull, apiWrite, listQuery } from "@/lib/api";
import type { ListParams, PagedList } from "@/lib/api";

export type PaymentRequestStatus = "open" | "processing" | "paid" | "canceled" | "expired";
export type PaymentRequestLineState = "open" | "paid" | "settled_elsewhere" | "removed";

export interface PaymentRequestLine {
  invoice: string;
  invoice_number: string | null;
  invoice_status: string;
  due_date: string | null;
  position: number;
  state: PaymentRequestLineState;
  created_outstanding_minor: number;
  /** What is still due on this invoice now. */
  amount_due_minor: number;
}

export interface PaymentRequest {
  object: "payment_request";
  id: string;
  status: PaymentRequestStatus;
  mode: "charge" | "link";
  customer: string;
  currency: string;
  /** The LIVE total still due across the open lines. */
  amount_minor: number;
  created_amount_minor: number;
  payment_method: string | null;
  email: string | null;
  attempt_count: number;
  last_payment_error: { code: string | null; message: string | null } | null;
  cancel_reason: string | null;
  expires_at: string | null;
  paid_at: string | null;
  lines: PaymentRequestLine[];
  created_at: string;
  updated_at: string;
  resource_version?: number;
}

export function listPaymentRequests(
  biz: string,
  params: ListParams & { scope?: { customer?: string; status?: string } } = {},
) {
  const q = listQuery({ ...params, scope: { ...params.scope } });
  return apiGet<PagedList<PaymentRequest>>(
    `/v1/businesses/${biz}/payment_requests${q ? `?${q}` : ""}`,
  );
}

export function getPaymentRequest(biz: string, preq: string) {
  return apiGetOrNull<PaymentRequest>(`/v1/businesses/${biz}/payment_requests/${preq}`);
}

export function createPaymentRequest(
  biz: string,
  cus: string,
  body: {
    invoices: string[];
    mode: "charge" | "link";
    payment_method?: string;
    email?: string;
  },
) {
  return apiWrite(`/v1/businesses/${biz}/customers/${cus}/payment_requests`, body, "POST");
}

export function chargePaymentRequest(biz: string, preq: string, body: { payment_method?: string }) {
  return apiWrite(`/v1/businesses/${biz}/payment_requests/${preq}/charge`, body, "POST");
}

export function recordPaymentRequestPayment(
  biz: string,
  preq: string,
  body: {
    amount_minor: number;
    method?: "cash" | "cheque" | "bank_transfer" | "other";
    reference?: string;
    /** Unix seconds. */
    date?: number;
  },
) {
  return apiWrite(`/v1/businesses/${biz}/payment_requests/${preq}/record_payment`, body, "POST");
}

export function cancelPaymentRequest(biz: string, preq: string, body: { reason?: string }) {
  return apiWrite(`/v1/businesses/${biz}/payment_requests/${preq}/cancel`, body, "POST");
}

export function sendPaymentRequest(
  biz: string,
  preq: string,
  body: { to?: string; note?: string },
) {
  return apiWrite(`/v1/businesses/${biz}/payment_requests/${preq}/send`, body, "POST");
}
