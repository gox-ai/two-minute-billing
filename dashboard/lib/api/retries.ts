// Typed fetcher for the Retries screen ("Invoices under retry").
// Server-only. Mirrors src/modules/invoicing/retries.ts.
import { apiGet } from "@/lib/api";
import type { PagedList } from "@/lib/api";

export interface RetryRow {
  object: "retry";
  invoice: string;
  invoice_number: string | null;
  status: string;
  /** in_progress | success | exhausted | stopped | null — the "Retry Status". */
  dunning_status: string | null;
  currency: string;
  amount_due_minor: number;
  attempt_count: number;
  next_attempt_at: string | null;
  retry_started_at: string;
  customer: string | null;
  customer_name: string | null;
  customer_email: string | null;
  last_error_code: string | null;
  last_error_text: string | null;
  /**
   * The gateway's own verdict on the latest failure: true = soft (worth retrying),
   * false = hard, **null = never recorded** — render that as unknown, never as a
   * hard failure. Persisted by migration 0139.
   */
  last_failure_retriable: boolean | null;
  last_failure_at: string | null;
  gateway_key: string | null;
  payment_method_brand: string | null;
  payment_method_last4: string | null;
}

/**
 * The segment vocabulary lives in `lib/retries-format` — the client-safe module —
 * because the table builds its segment list inside `'use client'` and needs the
 * DEFAULT as a value. Re-exported as a TYPE only: types erase, so this import is
 * safe from either side, while the value crossing it drags `next/headers` into the
 * browser bundle.
 */
import type { RetryState } from "@/lib/retries-format";
export type { RetryState };

export function listRetries(
  biz: string,
  opts?: {
    limit?: number;
    startingAfter?: string;
    activeOnly?: boolean;
    state?: RetryState;
    sort?: { field: string; desc: boolean };
  },
) {
  const q = new URLSearchParams();
  if (opts?.limit) q.set("limit", String(opts.limit));
  if (opts?.startingAfter) q.set("starting_after", opts.startingAfter);
  // Only the nav badge sets this — see ACTIVE_RETRY in modules/invoicing/retries.ts.
  if (opts?.activeOnly) q.set("active", "true");
  // Omitted for "all", so the default URL stays what it has always been.
  if (opts?.state && opts.state !== "all") q.set("state", opts.state);
  if (opts?.sort) q.set(`sort_by[${opts.sort.desc ? "desc" : "asc"}]`, opts.sort.field);
  const qs = q.toString();
  return apiGet<PagedList<RetryRow>>(`/v1/businesses/${biz}/retries${qs ? `?${qs}` : ""}`);
}

/**
 * Retry status shown to an operator. `dunning_status` is null until the dunning
 * pass touches the invoice, so fall back to the invoice status rather than
 * printing an empty cell for a row that is demonstrably being retried.
 */
