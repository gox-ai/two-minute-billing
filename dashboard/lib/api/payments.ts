// Typed fetchers for the Payments surface. Server-only — imports the frozen
// api client ({ apiGet, apiWrite }); never pull this into a client component
// (it would ship the API key). Route shapes mirror the backend serializers:
//   - transactions:     src/modules/transactions/service.ts  serializeTransaction
//   - payment_intents:  src/modules/payment-intents/service.ts serializePaymentIntent
//   - gateway_webhooks: src/modules/gateway/inbound.ts        serializeGatewayWebhook
import { apiGet, apiWrite, listQuery, type ListParams, type PagedList } from "@/lib/api";

// --- Transactions (C5) ---------------------------------------------------

export type TransactionStatus =
  | "in_progress"
  | "succeeded"
  | "failed"
  | "voided"
  | "timeout"
  | "needs_attention"
  | "late_failed";
export type TransactionType = "authorization" | "payment" | "refund" | "payment_reversal";

export interface Transaction {
  object: "transaction";
  id: string;
  type: TransactionType;
  status: TransactionStatus;
  amount_minor: number;
  currency: string;
  gateway_key: string | null;
  id_at_gateway: string | null;
  /** WHICH account on that gateway — reconciliation happens per account, not per provider. */
  gateway_account: { id: string; name: string | null } | null;
  /** For a refund: the payment it reverses. Null on a payment. */
  reference_payment: string | null;
  /**
   * Set when this payment settled after its invoice could take it, so the money went to
   * the customer's excess balance. `invoice` still names the invoice; it was not paid by it.
   */
  unapplied_reason?:
    | "async_overpay"
    | "abandoned_debit"
    | "second_checkout"
    | "late_authorization"
    | null;
  /**
   * The on-session authorization ceremony behind this charge. `null` is the NORMAL case —
   * a renewal is off-session, so no intent ever existed for it.
   */
  payment_intent: string | null;
  /**
   * The gateway's newest fraud / manual-review callback for this charge. Deliberately NOT
   * a `status` value: a flag must not erase whether the money settled. Single read only;
   * `null` means nothing was reported.
   */
  fraud_signal?: {
    type: string;
    gateway_key: string;
    received_at: string;
  } | null;
  /**
   * Correlates with `gateway_request_logs` — the only key there is, since that table is
   * platform-global with no FK. Null on rows written before it existed.
   */
  trace_id: string | null;
  /** The collection inside that trace; narrows the gateway log to this charge. Null on older rows. */
  span_id: string | null;
  error_code: string | null;
  error_text: string | null;
  /**
   * Money on this row that the gateway has ALREADY returned (#17) — the fact the
   * Reconcile panel was missing when it claimed "the gateway outcome is unknown" over a
   * charge we had refunded ourselves. Served only on the single-transaction read of a
   * reconcilable row (the only place a verdict is offered); `null` means nothing came
   * back that the engine can see, NOT that nothing came back.
   */
  /**
   * The clock's schedule for an in-progress charge. Present only on the single read of an
   * `in_progress` row; `null` means no poll is scheduled, NOT that none will happen — a row
   * the pass has never deferred is picked up on age alone.
   */
  settlement_poll?: {
    last_polled_at: string;
    next_poll_at: string;
    attempts: number;
  } | null;
  /**
   * Set on the single read of a succeeded payment whose gateway sends no dispute events:
   * a person may record a chargeback on `payment`, up to `available_minor`.
   */
  dispute_recording?: { payment: string; available_minor: number } | null;
  /** Set on the single read of an in-progress debit its gateway can cancel. */
  pending_debit_cancel?: { payment: string } | null;
  settled_refund?: {
    charge_at_gateway: string;
    payment: string | null;
    refund: string | null;
    /** The gateway's own refund id — what the gateway's dashboard shows. */
    provider_refund_id: string | null;
    refunded_minor: number;
    fully_returned: boolean;
    currency: string | null;
  } | null;
  invoice: string | null;
  customer: string | null;
  customer_email: string | null;
  customer_name: string | null;
  credit_note: string | null;
  subscription: string | null;
  payment_method: { brand: string | null; last4: string | null } | null;
  /**
   * Which method type paid (`card`, `upi`, `sepa_debit`, …): the gateway's answer, else the
   * saved method that was charged. Null when not known.
   */
  method_type?: string | null;
  /**
   * An `in_progress` attempt that is waiting on the CUSTOMER's bank approval
   * rather than on a settlement network — at any amount, since an issuer may ask.
   * Always false once
   * the attempt resolves — what happened to it is then the answer.
   */
  awaiting_authentication?: boolean;
  occurred_at: string | null;
  settled_at: string | null;
  /**
   * When the row reached a terminal status. `settled_at` cannot answer that — it means
   * cash moved, so it is null on every failure, which is why the timeline's terminal entry
   * never rendered for one. Null on rows that finalised before migration 0230, so absence
   * means "unknown", not "still running".
   */
  finalised_at?: string | null;
  created_at: string;
  resource_version?: number;
}

/** Legacy flat filters (still honoured by the endpoint) + the shared list params. */
export interface TransactionFilters extends ListParams {
  status?: string;
  type?: string;
  customer?: string;
  invoice?: string;
  gateway?: string;
}

/**
 * One page of the money log. **Paginated** — the endpoint used to cap at 50 rows
 * with no way to reach the rest, so pass `limit`/`startingAfter` (or use
 * `ListPage`'s server mode) rather than assuming you got everything.
 */
export function listTransactions(biz: string, filters: TransactionFilters = {}) {
  const { status, type, customer, invoice, gateway, ...list } = filters;
  const flat = Object.entries({ status, type, customer, invoice, gateway }).filter(
    ([, v]) => v,
  ) as Array<[string, string]>;
  const q = listQuery({ ...list, scope: { ...list.scope, ...Object.fromEntries(flat) } });
  return apiGet<PagedList<Transaction>>(`/v1/businesses/${biz}/transactions${q ? `?${q}` : ""}`);
}

export function getTransaction(biz: string, txn: string) {
  return apiGet<Transaction>(`/v1/businesses/${biz}/transactions/${txn}`);
}

/** The engine's intent vocabulary (`PI_STATUSES`). `voided` landed in Phase 4. */
export type PaymentIntentStatusValue =
  | "inited"
  | "in_progress"
  | "authorized"
  | "consumed"
  | "expired"
  | "voided";

/** `payment` captures into an invoice; `setup` only vaults a card (no money). */
export type PaymentIntentPurpose = "payment" | "setup";

/**
 * One page of payment intents. The list route landed 2026-08-01 — before that
 * there was NO list endpoint, only create / get-by-id / authorize / consume,
 * which is why this screen used to be a create-and-inspect form.
 *
 * Mirrors `serializePaymentIntentRow` (src/modules/payment-intents/service.ts):
 * the bare intent PLUS the joined customer / gateway-account / card columns the
 * list needs. `gateway_account_label` is the gateway ACCOUNT ("Stripe-1"), which
 * is what shows under the brand — a business can hold several accounts on one
 * gateway, so `gateway_key` alone names nothing.
 */
export interface PaymentIntentRow {
  object: "payment_intent";
  id: string;
  status: PaymentIntentStatusValue;
  purpose: PaymentIntentPurpose;
  amount_minor: number | null;
  /** The mandate CEILING (migration 0174). `setup` intents only; null elsewhere. */
  max_amount_minor: number | null;
  currency: string | null;
  /** Denormalised count of `payment_attempts` — the "Payment Attempts" figure. */
  attempt_count: number;
  /**
   * Status of the NEWEST attempt (migration 0265). The list needs it because `status`
   * above cannot express a refusal — an intent has no `failed` — so without this a
   * declined intent renders identically to one a buyer is still working through.
   * `null` = no attempt yet. Fed to `displayIntentStatus`.
   */
  last_attempt_status: string | null;
  next_action: unknown;
  expires_at: string | null;
  voided_at: string | null;
  created_at: string;
  customer: string | null;
  customer_name: string | null;
  /** The Customer Information card is First/Last name — a display name cannot be split back into them. */
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  gateway_key: string | null;
  gateway_account: string | null;
  gateway_account_label: string | null;
  payment_method_brand: string | null;
  payment_method_last4: string | null;
}

export function listPaymentIntents(
  biz: string,
  opts?: {
    limit?: number;
    startingAfter?: string;
    status?: string;
    purpose?: string;
    /** Public invoice id — the invoice page shows the intents open against it. */
    invoice?: string;
  },
) {
  const q = new URLSearchParams();
  if (opts?.limit) q.set("limit", String(opts.limit));
  if (opts?.startingAfter) q.set("starting_after", opts.startingAfter);
  if (opts?.status) q.set("status", opts.status);
  if (opts?.purpose) q.set("purpose", opts.purpose);
  if (opts?.invoice) q.set("invoice", opts.invoice);
  const qs = q.toString();
  return apiGet<PagedList<PaymentIntentRow>>(
    `/v1/businesses/${biz}/payment_intents${qs ? `?${qs}` : ""}`,
  );
}

/** POST /v1/transactions/:txn/reconcile — org-level path (no :biz segment). */
export function reconcileTransaction(txn: string, outcome: "succeeded" | "failed") {
  return apiWrite(`/v1/transactions/${txn}/reconcile`, { outcome });
}

/**
 * Ask the GATEWAY what became of an in-progress charge, now.
 *
 * ⚠️ Not `reconcileTransaction`, which sends an `outcome` — an operator ASSERTING what
 * happened. This one asserts nothing and books whatever the gateway reports.
 */
export function syncTransaction(biz: string, txn: string) {
  return apiWrite(`/v1/businesses/${biz}/transactions/${txn}/sync`, {});
}

/**
 * Ask the gateway to stop a debit it has not collected yet. `outcome` is what the gateway
 * did: `cancelled`, or `settled` / `failed` when it had already decided. A refusal is a 409.
 */
export function cancelPendingDebit(biz: string, pay: string) {
  return apiWrite(`/v1/businesses/${biz}/payments/${pay}/cancel_pending_debit`, {});
}

/**
 * Cancel the intent AT THE GATEWAY and mark it voided here.
 *
 * Safe by construction: `voidPaymentIntent` throws unless the gateway confirms the void
 * (`if (!res.voided) throw`), so an intent whose money has actually been taken surfaces
 * as an error rather than a false success — and a released authorization books its
 * reversal. RazorPay advertises `intentVoid: false` and answers a clear "unsupported".
 */
export function voidPaymentIntent(biz: string, pi: string) {
  return apiWrite(`/v1/businesses/${biz}/payment_intents/${pi}/void`, {});
}

// --- Payment intents (C-PI) ---------------------------------------------

export type PaymentIntentStatus = string;

export interface PaymentIntent {
  object: "payment_intent";
  id: string;
  status: PaymentIntentStatusValue;
  purpose: PaymentIntentPurpose;
  amount_minor: number | null;
  /** The mandate CEILING (migration 0174). `setup` intents only; null elsewhere. */
  max_amount_minor: number | null;
  currency: string | null;
  attempt_count: number;
  /** See `PaymentIntentRow.last_attempt_status`. The detail page reads the attempts themselves. */
  last_attempt_status: string | null;
  next_action: unknown | null;
  expires_at: string | null;
  voided_at: string | null;
  created_at: string;
  resource_version?: number;
  /** Present on the consume response only (the resulting charge/payment status). */
  charge_status?: string;
}

/** Mirrors `serializePaymentAttempt` (src/modules/payment-intents/service.ts). */
export interface PaymentAttempt {
  object: "payment_attempt";
  id: string;
  attempt_number: number;
  status: "inited" | "requires_action" | "authorized" | "consumed" | "failed" | "voided";
  /** The gateway's own id for this attempt — the "Gateway transaction Id". */
  id_at_gateway: string | null;
  error_code: string | null;
  error_text: string | null;
  /**
   * The ONLY key correlating this attempt with `gateway_request_logs`: that table
   * is platform-global with no RLS, so there is deliberately no FK. The detail
   * page's "View Request/Response Logs" link filters Gateway Requests on it.
   */
  trace_id: string | null;
  /** This attempt; its calls can cross requests (a later void joins it). Null on older rows. */
  span_id: string | null;
  created_at: string;
  updated_at: string;
  resource_version?: number;
}

/**
 * An attempt WITH the instrument it was tried with — what the RETRIEVE routes
 * return. Per attempt, not per intent: a declined buyer can retry on a different
 * card, so the intent's method would mislabel every attempt but the last.
 *
 * These keys are absent (not null) on the action responses — create / retry /
 * void / consume never join an instrument, and `payment_method: null` there would
 * assert "this attempt used no card" about one that did.
 */
export interface PaymentAttemptWithMethod extends PaymentAttempt {
  /** Null when the attempt named no instrument (a `setup` intent before the buyer supplies one) or the vaulted method was since deleted. */
  payment_method: string | null;
  /** `card` | `upi` | `wallet` | … */
  payment_method_type: string | null;
  payment_method_brand: string | null;
  payment_method_last4: string | null;
}

/**
 * `GET /payment_intents/:pi` — the intent plus every attempt, oldest first.
 *
 * Extends `PaymentIntentRow`, not the bare intent: the route serializes the SAME
 * joined projection the list uses (`serializePaymentIntentRow`), so the customer,
 * the gateway account and the card are all here. It used to return the bare
 * intent, which is why the detail page had to drop the "Customer Information"
 * card, the summary's Gateway row and the per-attempt payment method.
 */
export interface PaymentIntentDetail extends PaymentIntentRow {
  attempts: PaymentAttemptWithMethod[];
  /**
   * The `payment_reversal` transaction the void booked, correlated by
   * `transactions.payment_intent_id`. Null for every intent that was not voided —
   * it is what the "Transaction Voided" timeline node names.
   */
  voided_transaction: { id: string; created_at: string } | null;
  resource_version?: number;
}

export function getPaymentIntent(biz: string, pi: string) {
  return apiGet<PaymentIntentDetail>(`/v1/businesses/${biz}/payment_intents/${pi}`);
}

/** Every attempt of one intent, oldest first. Included in the detail response too. */
export function listPaymentIntentAttempts(biz: string, pi: string) {
  return apiGet<{ object: "list"; data: PaymentAttempt[] }>(
    `/v1/businesses/${biz}/payment_intents/${pi}/attempts`,
  );
}

export function createPaymentIntent(
  biz: string,
  body: { payment_method: string; amount_minor: number; currency: string },
) {
  return apiWrite(`/v1/businesses/${biz}/payment_intents`, body);
}

export function authorizePaymentIntent(biz: string, pi: string) {
  return apiWrite(`/v1/businesses/${biz}/payment_intents/${pi}/authorize`, {});
}

export function consumePaymentIntent(biz: string, pi: string, invoice: string) {
  return apiWrite(`/v1/businesses/${biz}/payment_intents/${pi}/consume`, { invoice });
}

// --- Gateway webhooks (C8 / GW-6) ----------------------------------------

export interface GatewayWebhook {
  object: "gateway_webhook";
  id: string;
  gateway_key: string;
  provider_event_id: string | null;
  type: string | null;
  outcome: string | null;
  error: string | null;
  /**
   * The HTTP exchange (P2). All three are `null` for rows written before migration
   * 0141 and for events not delivered over HTTP (internal replays, verify suites) —
   * render blank, never a placeholder that implies we recorded something.
   */
  response_status: number | null;
  request_url: string | null;
  /** Public id (`txn_…`) of the transaction this callback affected. */
  transaction: string | null;
  payload: unknown | null;
  headers: Record<string, unknown> | null;
  received_at: string;
  processed_at: string | null;
}

/**
 * One page of the inbound gateway-webhook log. **Paginated** — the endpoint
 * used to cap at 200 rows with no way to reach the rest, so pass
 * `limit`/`startingAfter` (or use `ListPage`'s server mode) rather than
 * assuming you got everything.
 */
export function listGatewayWebhooks(biz: string, filters: ListParams & { outcome?: string } = {}) {
  const { outcome, ...list } = filters;
  const q = listQuery({ ...list, scope: { ...list.scope, ...(outcome ? { outcome } : {}) } });
  return apiGet<PagedList<GatewayWebhook>>(
    `/v1/businesses/${biz}/gateway_webhooks${q ? `?${q}` : ""}`,
  );
}

/**
 * Re-run a webhook stuck at `outcome: error`. Only `error` rows replay — the API
 * answers 409 for anything settled, since re-running handlers that book money is how
 * you double-post.
 */
export function replayGatewayWebhook(biz: string, id: string) {
  return apiWrite(`/v1/businesses/${biz}/gateway_webhooks/${id}/replay`, {});
}

export function getGatewayWebhook(biz: string, id: string) {
  return apiGet<GatewayWebhook>(`/v1/businesses/${biz}/gateway_webhooks/${id}`);
}

// --- Gateway requests (outbound request/response log) -------------------
// GET /v1/businesses/:biz/gateway_requests        src/modules/gateway  serializeGatewayRequestLog

export interface GatewayRequestLog {
  object: "gateway_request_log";
  id: string;
  gateway_key: string;
  method: string;
  url: string;
  status: number | null;
  duration_ms: number | null;
  operation: string | null;
  source: string | null;
  actor: string | null;
  request_headers: Record<string, unknown> | null;
  request_body: unknown;
  response_headers: Record<string, unknown> | null;
  response_body: unknown;
  error: string | null;
  /** Correlates this call with the rest of the traced operation; null outside a trace. */
  trace_id: string | null;
  /** The invoice collection inside that trace; null outside one. */
  span_id: string | null;
  created_at: string;
}

/**
 * One page of the outbound gateway request/response log. **Paginated** — the
 * endpoint used to cap at 200 rows with no way to reach the rest, so pass
 * `limit`/`startingAfter` (or use `ListPage`'s server mode) rather than
 * assuming you got everything.
 */
export function listGatewayRequests(
  biz: string,
  filters: ListParams & { gateway?: string; source?: string } = {},
) {
  const { gateway, source, ...list } = filters;
  const flat = Object.entries({ gateway, source }).filter(([, v]) => v) as Array<[string, string]>;
  const q = listQuery({ ...list, scope: { ...list.scope, ...Object.fromEntries(flat) } });
  return apiGet<PagedList<GatewayRequestLog>>(
    `/v1/businesses/${biz}/gateway_requests${q ? `?${q}` : ""}`,
  );
}

export function getGatewayRequest(biz: string, id: string) {
  return apiGet<GatewayRequestLog>(`/v1/businesses/${biz}/gateway_requests/${id}`);
}
