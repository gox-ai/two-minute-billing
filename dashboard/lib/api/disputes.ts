// Typed fetchers for the disputes / chargebacks log, and the two hand-recorded writes. Server-only.
import { apiGet, apiWrite } from "@/lib/api";
import type { PagedList } from "@/lib/api";
import type { DisputeReason } from "@/lib/dispute-vocab";

export interface Dispute {
  object: "dispute";
  id: string;
  status: string;
  reason: string | null;
  amount_minor: number;
  currency: string;
  funds_withdrawn: boolean;
  provider_key: string;
  /** Null on a dispute that a person recorded: the gateway never named the case. */
  provider_dispute_id: string | null;
  /** `gateway` (its dispute events) or `operator` (recorded by hand). */
  source: "gateway" | "operator";
  /** The processor's case number, on a hand-recorded dispute. */
  processor_reference: string | null;
  /**
   * The engine accepts an outcome from a person now: the dispute is open, and a person
   * recorded it or its gateway never sends a final state. Drives "Mark as won / lost".
   */
  outcome_settable_by_operator: boolean;
  provider_charge_id: string | null;
  payment_id: string | null;
  invoice_id: string | null;
  customer_id: string | null;
  evidence_due_by: string | null;
  opened_at: string;
  closed_at: string | null;
  created_at: string;
}

/**
 * `PagedList`, not `List` — and that distinction is the whole point.
 *
 * This wrapper typed a bare `{object,data}` while the endpoint capped at fifty rows, so the
 * compiler could not see the page discarding pagination and a business past fifty chargebacks
 * had no way to reach the rest. Exactly the `listGatewayRequests` defect, where the same
 * missing flag hid 61 of 111 rows. The rule is in the `ui` skill § 6: if the endpoint
 * paginates, the wrapper returns `PagedList<T>`.
 */
export function listDisputes(
  biz: string,
  filters: {
    limit?: number;
    status?: string;
    startingAfter?: string;
    /** Only disputes still awaiting a response or under review. */
    open?: boolean;
    /** `evidence_due_by`: soonest deadline first, undated last. Default: newest first. */
    sort?: "evidence_due_by";
    /** Only the disputes on this payment (`pay_…`). */
    payment?: string;
  } = {},
) {
  const qs = new URLSearchParams();
  if (filters.limit != null) qs.set("limit", String(filters.limit));
  if (filters.status) qs.set("status", filters.status);
  if (filters.startingAfter) qs.set("starting_after", filters.startingAfter);
  if (filters.open) qs.set("open", "true");
  if (filters.sort) qs.set("sort", filters.sort);
  if (filters.payment) qs.set("payment", filters.payment);
  const q = qs.toString();
  return apiGet<PagedList<Dispute>>(`/v1/businesses/${biz}/disputes${q ? `?${q}` : ""}`);
}

/** Record a chargeback that the payment's gateway cannot report. */
export function recordDispute(
  biz: string,
  pay: string,
  body: {
    amount_minor: number;
    reason: DisputeReason;
    processor_reference?: string;
    /** Unix seconds. */
    opened_at?: number;
  },
) {
  return apiWrite(`/v1/businesses/${biz}/payments/${pay}/disputes`, body, "POST");
}

/** The processor's decision on a hand-recorded dispute. */
export function setDisputeOutcome(biz: string, dsp: string, outcome: "won" | "lost") {
  return apiWrite(`/v1/businesses/${biz}/disputes/${dsp}/outcome`, { outcome }, "POST");
}
