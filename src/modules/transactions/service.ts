/**
 * Transactions module (C5 / GW-4) — the gateway-facing transaction log.
 *
 * A transaction records one attempt against a gateway: its type, gateway-side id,
 * outcome (incl. timeout / needs_attention / late_failed), and links back to the
 * payment / invoice / refund it belongs to. The collection & refund services
 * write these alongside `payments`/`refunds` rows (wired in C10). `reconcile`
 * resolves an unsettled transaction (operator verdict or gateway query).
 */
import { stampNow } from "@/platform/clock";
import { and, desc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import {
  clampLimit,
  filterConditions,
  keysetCondition,
  kindsFromSpecs,
  opsFromSpecs,
  pageOrder,
  parseCursor,
  searchCondition,
  toPage,
  type FilterSpec,
  type ListFilter,
  type ListPage,
  cappedTotal,
} from "@/platform/list-query";
import { businessTimezone } from "@/platform/business-tz";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { settleTransactionOutcome, bookedPaymentForCharge } from "@/modules/payments/settlement";
import { UNAPPLIED_CAPTURE_KEY } from "@/modules/payments/unapplied-capture-key";
import { getSpanId, getTraceId } from "@/platform/trace";
import {
  transactions,
  invoices,
  payments,
  customers,
  creditNotes,
  paymentMethods,
  subscriptions,
  gatewayAccounts,
  paymentIntents,
  paymentAttempts,
  // Platform-global (no RLS): the normalized copies of gateway deliveries we accepted.
  // Read here for one reason — it is the only place that names a gateway ORDER and the
  // CHARGE it produced in the same row, which is how a transaction with no
  // `id_at_gateway` can still be tied to its money (#17).
  providerEvents,
  settlementPollSchedule,
} from "@db/schema";
import { accountHolderName } from "@/modules/customers/names";
// The SQL mirror of `accountHolderName` — the `customer_name` filter must match the
// name the money log PRINTS, not the deprecated `customers.name` column.
import { accountHolderNameSql } from "@/modules/customers/name-sql";
// `serializeTransaction` moved to `./serialize` (events/content.ts needs it and
// must never import this file — it imports `emitEvent`). Re-exported here so
// existing importers of `transactions/service` are unaffected.
import { serializeTransaction } from "./serialize";
import { gatewayCancelsPendingDebits } from "@/providers/gateway-catalog";
import {
  TRANSACTION_STATUS_ALIASES,
  normalizeTransactionStatus,
  type TransactionStatus,
} from "./status";
import { createLogger } from "@/platform/logger";

const log = createLogger("transactions");
export { serializeTransaction };

export type Transaction = typeof transactions.$inferSelect;
export type { TransactionStatus } from "./status";
export { TRANSACTION_STATUS_ALIASES, normalizeTransactionStatus } from "./status";
/**
 * Statuses a transaction can no longer move away from on its own. `timeout` and
 * `needs_attention` are absent BY DESIGN: they are exactly the two the dashboard offers a
 * reconcile form for (`RECONCILABLE_STATUSES`), so a human is still expected to resolve
 * them and the row is not finished.
 */
const TERMINAL_TRANSACTION_STATUSES: ReadonlySet<TransactionStatus> = new Set([
  "succeeded",
  "failed",
  "voided",
  "late_failed",
]);

export type TransactionType = "authorization" | "payment" | "refund" | "payment_reversal";

export class TransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionError";
  }
}

export interface RecordTransactionInput {
  organizationId: string;
  businessId: string;
  customerId?: string | null;
  type: TransactionType;
  status: TransactionStatus;
  amountMinor: bigint;
  currency: string;
  gatewayAccountId?: string | null;
  gatewayKey?: string | null;
  idAtGateway?: string | null;
  /** A lost-answer charge only: what the gateway can find it by (0396). */
  ownershipRef?: string | null;
  idempotencyKey?: string | null;
  paymentMethodId?: string | null;
  errorCode?: string | null;
  errorText?: string | null;
  /**
   * Whether the gateway said this failure was worth retrying (from the provider's
   * `FailureResult.retriable`). Leave undefined for non-failures — null means
   * "not applicable", not "hard decline".
   */
  retriable?: boolean | null;
  /**
   * The intent/attempt that produced this transaction (0172). Both nullable — most
   * transactions have no intent at all (an off-session renewal against a vaulted
   * card never creates one). `paymentIntentId` is redundant through the attempt and
   * stamped anyway: the intent-level failure metrics group by intent over a large
   * table and must not join through a child to do it.
   */
  paymentIntentId?: string | null;
  paymentAttemptId?: string | null;
  invoiceId?: string | null;
  /** Only where no invoice reaches it: a charge refused before its invoice existed. */
  subscriptionId?: string | null;
  paymentId?: string | null;
  /** The payment request whose single charge this is (0388); `paymentId` is null then. */
  paymentRequestId?: string | null;
  refundId?: string | null;
  creditNoteId?: string | null;
  occurredAt?: Date;
  settledAt?: Date | null;
}

/**
 * Record a transaction. Emits `payment.initiated` for a newly-created attempt and
 * `transaction.needs_attention` when the gateway outcome is unknown. Pass `tx` to
 * join the caller's transaction (collection path); otherwise it opens its own.
 */
export async function recordTransaction(
  input: RecordTransactionInput,
  tx?: Tx,
): Promise<Transaction> {
  const run = async (t: Tx): Promise<Transaction> => {
    const now = input.occurredAt ?? stampNow();
    const [row] = await t
      .insert(transactions)
      .values({
        // Stamped HERE because this is the single write point for every transaction — a
        // per-call-site field would drift, and 20+ callers would each have to remember it.
        // Null outside a trace context, which is honest: the gateway log can only be reached
        // by a trace that actually exists.
        traceId: getTraceId() ?? null,
        spanId: getSpanId() ?? null,
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customerId ?? null,
        publicId: publicId("txn"),
        type: input.type,
        status: input.status,
        /**
         * A transaction BORN TERMINAL gets its `finalisedAt` here, not from
         * `setTransactionStatus` — which only fires on a TRANSITION.
         *
         * That was the gap in the first cut of migration 0230 (2026-09-03): a synchronous
         * refusal is recorded once, already `failed`, and never transitions at all. So the
         * majority of declines — `mandate_ceiling_exceeded`, `no_payment_method`, every
         * pre-flight refusal — kept a null `finalisedAt` and the detail page's terminal
         * timeline entry stayed as unreachable as before the column existed. Found by
         * driving a real refusal through the dashboard, having asserted only the
         * transition path in the unit test.
         */
        finalisedAt: TERMINAL_TRANSACTION_STATUSES.has(input.status) ? stampNow() : null,
        amountMinor: input.amountMinor,
        currency: input.currency.toUpperCase(),
        gatewayAccountId: input.gatewayAccountId ?? null,
        gatewayKey: input.gatewayKey ?? null,
        idAtGateway: input.idAtGateway ?? null,
        ownershipRef: input.ownershipRef ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        paymentMethodId: input.paymentMethodId ?? null,
        errorCode: input.errorCode ?? null,
        errorText: input.errorText ?? null,
        retriable: input.retriable ?? null,
        paymentIntentId: input.paymentIntentId ?? null,
        paymentAttemptId: input.paymentAttemptId ?? null,
        invoiceId: input.invoiceId ?? null,
        subscriptionId: input.subscriptionId ?? null,
        paymentId: input.paymentId ?? null,
        paymentRequestId: input.paymentRequestId ?? null,
        refundId: input.refundId ?? null,
        creditNoteId: input.creditNoteId ?? null,
        occurredAt: now,
        settledAt: input.settledAt ?? (input.status === "succeeded" ? now : null),
      })
      .returning();
    // A freshly-opened attempt (payment/authorization) → payment.initiated.
    if (input.type === "payment" || input.type === "authorization") {
      await emitEvent(t, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "payment_initiated",
        data: buildEventData(
          "payment_initiated",
          {
            id: row!.publicId,
            amount_minor: Number(row!.amountMinor),
            currency: row!.currency,
            status: row!.status,
            invoice: input.invoiceId ?? undefined,
          },
          row!.resourceVersion,
        ),
      });
    }
    if (input.status === "needs_attention") {
      await emitEvent(t, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "transaction_needs_attention",
        data: buildEventData(
          "transaction_needs_attention",
          {
            id: row!.publicId,
            amount_minor: Number(row!.amountMinor),
            currency: row!.currency,
            error_code: row!.errorCode,
          },
          row!.resourceVersion,
        ),
      });
    }
    return row!;
  };
  return tx ? run(tx) : withTenant(input.organizationId, run);
}

/** Update a transaction's status/settlement in the caller's tx (used by C8 reconciliation). */
export async function setTransactionStatus(
  tx: Tx,
  organizationId: string,
  transactionId: string,
  status: TransactionStatus,
  opts?: {
    errorCode?: string | null;
    errorText?: string | null;
    settledAt?: Date | null;
    idAtGateway?: string | null;
    /**
     * The failure's retriable classification.
     *
     * `recordTransaction` writes this at charge time, but until now no UPDATE path
     * could set it — so a failure discovered LATER (the stale-pending sweep polling
     * a webhook that never came) left the column null, and null means "not a
     * failure, or predates the column". The Retries screen reads it for its
     * Hard/Soft column, so every swept failure rendered as neither.
     */
    retriable?: boolean | null;
  },
): Promise<Transaction | null> {
  const set: Partial<typeof transactions.$inferInsert> = { status };
  if (opts?.errorCode !== undefined) set.errorCode = opts.errorCode;
  if (opts?.errorText !== undefined) set.errorText = opts.errorText;
  if (opts?.retriable !== undefined) set.retriable = opts.retriable;
  if (opts?.settledAt !== undefined) set.settledAt = opts.settledAt;
  else if (status === "succeeded") set.settledAt = stampNow();
  /**
   * `finalisedAt` records reaching a terminal status, which `settledAt` cannot: it means
   * cash moved, so it is null on every failure and the detail page's terminal timeline
   * entry never rendered for one (migration 0230).
   *
   * `timeout` and `needs_attention` are excluded deliberately — they are the RECONCILABLE
   * statuses, so the row can still change and is not finished. Set on each terminal
   * transition rather than only the first: a `succeeded` that later becomes `late_failed`
   * has genuinely finalised again, and the newer instant is the true one.
   */
  if (TERMINAL_TRANSACTION_STATUSES.has(status)) set.finalisedAt = stampNow();
  if (opts?.idAtGateway !== undefined) set.idAtGateway = opts.idAtGateway;
  const [row] = await tx
    .update(transactions)
    .set(set)
    .where(and(eq(transactions.organizationId, organizationId), eq(transactions.id, transactionId)))
    .returning();
  return row ?? null;
}

export async function getTransactionByPublicId(
  organizationId: string,
  businessId: string,
  txnPublicId: string,
): Promise<Transaction | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.businessId, businessId), eq(transactions.publicId, txnPublicId)))
      .limit(1);
    return row ?? null;
  });
}

export async function findTransactionByGatewayCharge(
  tx: Tx,
  idAtGateway: string,
): Promise<Transaction | null> {
  const [row] = await tx
    .select()
    .from(transactions)
    .where(eq(transactions.idAtGateway, idAtGateway))
    .limit(1);
  return row ?? null;
}

export interface ListTransactionsFilter {
  type?: string;
  status?: string;
  customerId?: string;
  invoiceId?: string;
  gatewayKey?: string;
  limit?: number;
  before?: Date;
}

export async function listTransactions(
  organizationId: string,
  businessId: string,
  filter?: ListTransactionsFilter,
): Promise<Transaction[]> {
  return withTenant(organizationId, async (tx) => {
    const conds = [eq(transactions.businessId, businessId)];
    if (filter?.type) conds.push(eq(transactions.type, filter.type));
    if (filter?.status)
      conds.push(eq(transactions.status, normalizeTransactionStatus(filter.status)));
    if (filter?.customerId) conds.push(eq(transactions.customerId, filter.customerId));
    if (filter?.invoiceId) conds.push(eq(transactions.invoiceId, filter.invoiceId));
    if (filter?.gatewayKey) conds.push(eq(transactions.gatewayKey, filter.gatewayKey));
    if (filter?.before) conds.push(lt(transactions.createdAt, filter.before));
    return tx
      .select()
      .from(transactions)
      .where(and(...conds))
      .orderBy(desc(transactions.createdAt))
      .limit(Math.min(filter?.limit ?? 50, 200));
  });
}

/**
 * List with display context joined in — the transactions surface is the
 * user-facing money log, so each row carries the public
 * ids of its invoice / customer / credit note and the card used.
 */
export interface TransactionDetailed {
  txn: Transaction;
  invoicePublicId: string | null;
  customerPublicId: string | null;
  customerEmail: string | null;
  /** RESOLVED account-holder name (`customers/names.ts`), not a single column. */
  customerName: string | null;
  creditNotePublicId: string | null;
  subscriptionPublicId: string | null;
  pmBrand: string | null;
  pmLast4: string | null;
  pmMandateRail: string | null;
  pmType: string | null;
  gatewayAccountPublicId: string | null;
  gatewayAccountName: string | null;
  refPaymentPublicId: string | null;
  /** `payments.method_type` of that payment: which method type paid. */
  refPaymentMethodType: string | null;
  paymentIntentPublicId: string | null;
  /** Why the payment behind this row was detached from its invoice (`markUnapplied`). */
  unappliedReason: string | null;
  /**
   * The gateway's own fraud/manual-review signal for this charge, newest first (single
   * read only, same reasoning as `settledReturn`). `null` means nothing was reported —
   * which is the overwhelmingly normal case, not an unknown.
   */
  fraudSignal?: FraudSignal | null;
  /**
   * Money this row would book that has already gone back to the payer (#17). Resolved by
   * the SINGLE read only (`getTransactionDetailed`) and only for a reconcilable row: it
   * costs extra queries per transaction, and it is the operator Reconcile panel — one row
   * at a time — that must not assert "the gateway outcome is unknown" when we hold the
   * gateway's own refund id for that amount. Absent on list rows, which offer no verdict.
   */
  settledReturn?: SettledReturn | null;
  /**
   * When the billing clock last asked the gateway about this charge, and when it will ask
   * next — the difference between "nothing is happening" and "something is happening on a
   * schedule you can see".
   *
   * Single read only and only while `in_progress`, for the reason `settledReturn` gives:
   * it costs an extra query per transaction and a settled row has nothing to poll.
   * `null` means no poll is scheduled — the pass has never deferred this row, so the next
   * tick will pick it up on age alone.
   */
  pollSchedule?: { nextAt: Date; lastPolledAt: Date; attempts: number } | null;
  /**
   * A person may record a chargeback on this payment (its gateway sends no dispute events).
   * Single read of a succeeded payment only; absent or `null` means the action is not offered.
   */
  disputeRecording?: { paymentPublicId: string; availableMinor: bigint } | null;
  /**
   * A person may ask the gateway to cancel this debit (`cancel_pending_debit`). Single read
   * of an `in_progress` payment on a gateway that supports it; `null` means not offered.
   */
  pendingDebitCancel?: { paymentPublicId: string } | null;
}

const detailedSelect = {
  txn: transactions,
  invoicePublicId: invoices.publicId,
  customerPublicId: customers.publicId,
  customerEmail: customers.email,
  // Four columns for one name, resolved by `toDetailed` — the money log named the
  // payer from the legacy `name` column alone, so every customer created through the
  // API with first/last was an anonymous row in the one place money is audited.
  cusFirstName: customers.firstName,
  cusLastName: customers.lastName,
  cusCompany: customers.company,
  creditNotePublicId: creditNotes.publicId,
  subscriptionPublicId: subscriptions.publicId,
  // The gateway ACCOUNT, and the payment this transaction reverses — both already
  // stored on every refund (1,663 and 1,666 of 1,780 rows), both invisible until now.
  // "Which account did this move through" and "what is it a refund OF" are the first
  // two questions asked of a refund, so the refund page leads with them.
  gatewayAccountPublicId: gatewayAccounts.publicId,
  gatewayAccountName: gatewayAccounts.label,
  refPaymentPublicId: payments.publicId,
  refPaymentMethodType: payments.methodType,
  pmBrand: paymentMethods.brand,
  pmLast4: paymentMethods.last4,
  // The rail, so the serializer can tell an ordinary slow settlement apart from a
  // debit paused for the buyer's bank approval. Both are `in_progress` here and both
  // are `created` at the gateway; only the amount + rail distinguish them.
  pmMandateRail: paymentMethods.mandateRail,
  pmType: paymentMethods.type,
  // The intent this charge came out of. Only an ON-SESSION charge has one: a renewal
  // is off-session, so null here is "nobody was present to authenticate", not a gap.
  paymentIntentPublicId: paymentIntents.publicId,
  // Set when the money settled after its invoice could take it and went to excess
  // instead; the row keeps its invoice link, so without this it reads as paying it.
  unappliedReason: sql<string | null>`${payments.metadata} ->> ${UNAPPLIED_CAPTURE_KEY}`,
};

type DetailedRow = {
  [K in keyof typeof detailedSelect]: K extends "txn" ? Transaction : string | null;
};

/**
 * One joined row → the shape callers consume. Exists only to resolve the customer's
 * display name once, for the paginated list, the capped list and the single read
 * alike: three copies of the precedence rule is how a transaction shows a name on
 * one screen and a blank on another.
 */
const toDetailed = (r: DetailedRow): TransactionDetailed => ({
  txn: r.txn,
  invoicePublicId: r.invoicePublicId,
  customerPublicId: r.customerPublicId,
  customerEmail: r.customerEmail,
  customerName: accountHolderName({
    firstName: r.cusFirstName,
    lastName: r.cusLastName,
    company: r.cusCompany,
    email: r.customerEmail,
  }),
  creditNotePublicId: r.creditNotePublicId,
  subscriptionPublicId: r.subscriptionPublicId,
  pmBrand: r.pmBrand,
  pmLast4: r.pmLast4,
  pmMandateRail: r.pmMandateRail,
  pmType: r.pmType,
  gatewayAccountPublicId: r.gatewayAccountPublicId,
  gatewayAccountName: r.gatewayAccountName,
  refPaymentPublicId: r.refPaymentPublicId,
  refPaymentMethodType: r.refPaymentMethodType,
  paymentIntentPublicId: r.paymentIntentPublicId,
  unappliedReason: r.unappliedReason,
});

// ── Paginated list (see docs/GUIDE.md §3.4 for the shared contract) ────────────

/**
 * A transaction's subscription: the invoice's, or the row's own where no invoice exists
 * (a charge refused before its invoice was committed). Joins `subscriptions` after `invoices`.
 */
const subscriptionOfTransaction = eq(
  subscriptions.id,
  sql`coalesce(${transactions.subscriptionId}, ${invoices.subscriptionId})`,
);

const LIST_FILTERS: Record<string, FilterSpec> = {
  id: { column: transactions.publicId, kind: "text" },
  type: { column: transactions.type, kind: "enum" },
  // Old spellings (`success`, `failure`, `late_failure`) still match, as deprecated aliases.
  status: { column: transactions.status, kind: "enum", aliases: TRANSACTION_STATUS_ALIASES },
  currency: { column: transactions.currency, kind: "enum" },
  gateway: { column: transactions.gatewayKey, kind: "enum" },
  // The same column under the name the response actually prints (`gateway_key`).
  // `gateway` above is the legacy flat param the dashboard and SDK still send and
  // cannot be renamed; a saved view naming the serialized field has to work too.
  gateway_key: { column: transactions.gatewayKey, kind: "enum" },
  // WHICH account on that provider (a business can have several), and the payment a
  // refund reverses. Both are printed — `gateway_account.id` / `reference_payment` —
  // and reconciliation happens per ACCOUNT, so "everything through this account that
  // failed" is the first question asked of a settlement mismatch.
  gateway_account: { column: gatewayAccounts.publicId, kind: "text" },
  reference_payment: { column: payments.publicId, kind: "text" },
  // The gateway's own id for the charge (`transactions_gateway_charge_idx`) — how a
  // row is found from a provider dashboard, a bank statement or a customer email.
  id_at_gateway: { column: transactions.idAtGateway, kind: "text" },
  error_code: { column: transactions.errorCode, kind: "text" },
  // The decline TEXT, not just its code: gateways collapse whole families of refusals
  // onto one code, and the sentence is what distinguishes them.
  error_text: { column: transactions.errorText, kind: "text" },
  // The gateway's retriable classification. `retriable[is]=false` is exactly the
  // hard-decline list dunning must stop chasing. Null = not a failure (or predates the
  // column), and a bool filter only has `is`, so a null row matches neither value —
  // which is right here: an unclassified row is not evidence either way.
  retriable: { column: transactions.retriable, kind: "bool" },
  // The key that reaches `gateway_request_logs` — the platform-global request/response
  // log has no FK to anything, so this is the only join there is.
  trace_id: { column: transactions.traceId, kind: "text" },
  amount_minor: { column: transactions.amountMinor, kind: "number" },
  created_at: { column: transactions.createdAt, kind: "date" },
  // When the money actually moved, as distinct from when we wrote the row. They
  // diverge by the whole backfill on an IMPORTED book — every migrated payment
  // carries the import's `created_at` — and every revenue figure in
  // `metrics/analytics.ts` sums `occurred_at`. Without this spec the Business
  // Home strip had no date field it could deep-link to that agreed with its own
  // arithmetic: a "today's revenue" link cut on `created_at` opens an import's
  // whole history under a one-day heading.
  occurred_at: { column: transactions.occurredAt, kind: "date" },
  // When the money SETTLED, which is what a payout reconciliation cuts on — and null
  // for everything still in flight, so `settled_at[is_present]=false` is the unsettled
  // list without having to enumerate the four non-terminal statuses.
  settled_at: { column: transactions.settledAt, kind: "date" },
  // Not printed by the envelope (`serialize.ts` reports `resource_version` instead),
  // but it is the only column that dates a LATE flip — a webhook that arrived days
  // after the attempt, or an operator reconcile — and those are what get audited.
  updated_at: { column: transactions.updatedAt, kind: "date" },
  customer: { column: customers.publicId, kind: "text" },
  // Against the bare legacy `customers.name` this answered "no transactions" for every
  // customer created through the API with first/last names — most of them (name-sql.ts).
  customer_name: { column: accountHolderNameSql, kind: "text" },
  customer_email: { column: customers.email, kind: "text" },
  invoice: { column: invoices.publicId, kind: "text" },
  // The transaction's subscription (`subscriptionOfTransaction`), and the credit note a refund
  // discharges — both already joined and printed, neither was filterable.
  subscription: { column: subscriptions.publicId, kind: "text" },
  credit_note: { column: creditNotes.publicId, kind: "text" },
  // The INSTRUMENT. `payment_method.brand` / `.last4` are printed (flattened here,
  // because a filter field id is one snake_case token); `payment_method_type` is not,
  // and is the one field that separates a card decline from a UPI mandate failure —
  // two things with the same status, the same code and completely different handling.
  payment_method_brand: { column: paymentMethods.brand, kind: "enum" },
  payment_method_last4: { column: paymentMethods.last4, kind: "text" },
  payment_method_type: { column: paymentMethods.type, kind: "enum" },
  // The instrument's own id (`pm_…`), for "every attempt against this card".
  payment_method: { column: paymentMethods.publicId, kind: "text" },
  // The intent this attempt belongs to (0172). Names the intent's PUBLIC id (`pi_…`),
  // which is what the Payment Intents screen shows and what the envelope now emits,
  // never the raw uuid column.
  payment_intent: { column: paymentIntents.publicId, kind: "text" },
};

export const TRANSACTION_FILTER_OPS = opsFromSpecs(LIST_FILTERS);
export const TRANSACTION_FILTER_KINDS = kindsFromSpecs(LIST_FILTERS);

const LIST_SORTS = {
  created_at: transactions.createdAt,
  amount_minor: transactions.amountMinor,
  status: transactions.status,
  // Single-column sorts over one business's rows — the same cost class as `status`.
  // `occurred_at` is the one the revenue figures in `metrics/analytics.ts` sum, so a
  // money log ordered by `created_at` disagreed with its own totals on an imported book.
  occurred_at: transactions.occurredAt,
  settled_at: transactions.settledAt,
  type: transactions.type,
  // Bumped by `bump_row_version` on every write, so it orders late flips last.
  updated_at: transactions.updatedAt,
} as const;

export type TransactionSortField = keyof typeof LIST_SORTS;
export const TRANSACTION_SORT_FIELDS = Object.keys(LIST_SORTS) as TransactionSortField[];

export interface TransactionListFilters {
  customerId?: string;
  invoiceId?: string;
  search?: string;
  filters?: ListFilter[];
  sortField?: string;
  sortDesc?: boolean;
  startingAfter?: string;
  limit?: number;
}

/**
 * One page of the money log, newest-first.
 *
 * This list was capped at 50 rows with no way to reach the rest — a toolbar that
 * says "50 Transactions" over 40,000 is worse than a slow page, because the
 * missing money is invisible. Keyset on `(created_at DESC, public_id DESC)` via
 * `transactions_business_created_idx`.
 */
export async function listTransactionsPage(
  organizationId: string,
  businessId: string,
  f: TransactionListFilters = {},
): Promise<ListPage<TransactionDetailed>> {
  const limit = clampLimit(f.limit);
  const sortField = (f.sortField ?? "created_at") as TransactionSortField;
  const descending = f.sortDesc ?? true;
  const keyset = sortField === "created_at";

  return withTenant(organizationId, async (tx) => {
    const conds: SQL[] = [eq(transactions.businessId, businessId)];
    if (f.customerId) conds.push(eq(transactions.customerId, f.customerId));
    if (f.invoiceId) conds.push(eq(transactions.invoiceId, f.invoiceId));
    const search = searchCondition(
      // Every DISPLAYED name column: searching the money log for the payer by the name
      // the log itself prints has to find them — and must not match on the deprecated
      // `customers.name`, which the log no longer prints.
      [
        transactions.publicId,
        transactions.gatewayKey,
        transactions.errorCode,
        customers.publicId,
        customers.firstName,
        customers.lastName,
        customers.company,
        customers.email,
        invoices.publicId,
      ],
      f.search,
    );
    if (search) conds.push(search);
    // Date filters bucket by the BUSINESS day, not the UTC day (business-tz.ts).
    conds.push(
      ...filterConditions(LIST_FILTERS, f.filters, await businessTimezone(tx, businessId)),
    );

    let total: number | null = null;
    if (!f.startingAfter) {
      total = await cappedTotal(
        tx,
        tx
          .select({ one: sql`1` })
          .from(transactions)
          // The SAME join set as the page read below. `LIST_FILTERS` reaches all eight
          // tables, and a filter field the count query cannot see is not a wrong total —
          // it is a 500 ("missing FROM-clause entry for table payment_methods"). Free
          // when unused: every one is a LEFT JOIN on a unique PK, which Postgres drops
          // out of a COUNT that references no column of it.
          .leftJoin(invoices, eq(transactions.invoiceId, invoices.id))
          .leftJoin(subscriptions, subscriptionOfTransaction)
          .leftJoin(customers, eq(transactions.customerId, customers.id))
          .leftJoin(creditNotes, eq(transactions.creditNoteId, creditNotes.id))
          .leftJoin(paymentMethods, eq(transactions.paymentMethodId, paymentMethods.id))
          .leftJoin(gatewayAccounts, eq(transactions.gatewayAccountId, gatewayAccounts.id))
          .leftJoin(payments, eq(transactions.paymentId, payments.id))
          .leftJoin(paymentIntents, eq(transactions.paymentIntentId, paymentIntents.id))
          .where(and(...conds)),
      );
    }

    const { keysetId, offset } = parseCursor(f.startingAfter);
    const pageConds = [...conds];
    if (keyset && keysetId) {
      const [cursor] = await tx
        .select({
          createdAt: sql<string>`${transactions.createdAt}::text`,
          publicId: transactions.publicId,
        })
        .from(transactions)
        .where(and(eq(transactions.businessId, businessId), eq(transactions.publicId, keysetId)))
        .limit(1);
      const seek = keysetCondition(
        transactions.createdAt,
        transactions.publicId,
        cursor ? { sortValue: cursor.createdAt, tiebreak: cursor.publicId } : undefined,
        descending,
      );
      if (seek) pageConds.push(seek);
    }

    const rows = await tx
      .select(detailedSelect)
      .from(transactions)
      .leftJoin(invoices, eq(transactions.invoiceId, invoices.id))
      .leftJoin(subscriptions, subscriptionOfTransaction)
      .leftJoin(customers, eq(transactions.customerId, customers.id))
      .leftJoin(creditNotes, eq(transactions.creditNoteId, creditNotes.id))
      .leftJoin(paymentMethods, eq(transactions.paymentMethodId, paymentMethods.id))
      .leftJoin(gatewayAccounts, eq(transactions.gatewayAccountId, gatewayAccounts.id))
      .leftJoin(payments, eq(transactions.paymentId, payments.id))
      .leftJoin(paymentIntents, eq(transactions.paymentIntentId, paymentIntents.id))
      .where(and(...pageConds))
      .orderBy(...pageOrder(LIST_SORTS[sortField], transactions.publicId, descending, keyset))
      .limit(limit + 1)
      .offset(keyset ? 0 : offset);

    const page = toPage(rows, limit, { keyset, offset, keyOf: (r) => r.txn.publicId, total });
    return { ...page, data: page.data.map(toDetailed) };
  });
}

/**
 * Capped, unpaginated money log (default 50, max 200). **Internal use only** —
 * API routes use `listTransactionsPage`.
 */
export async function listTransactionsDetailed(
  organizationId: string,
  businessId: string,
  filter?: ListTransactionsFilter,
): Promise<TransactionDetailed[]> {
  return withTenant(organizationId, async (tx) => {
    const conds = [eq(transactions.businessId, businessId)];
    if (filter?.type) conds.push(eq(transactions.type, filter.type));
    if (filter?.status)
      conds.push(eq(transactions.status, normalizeTransactionStatus(filter.status)));
    if (filter?.customerId) conds.push(eq(transactions.customerId, filter.customerId));
    if (filter?.invoiceId) conds.push(eq(transactions.invoiceId, filter.invoiceId));
    if (filter?.gatewayKey) conds.push(eq(transactions.gatewayKey, filter.gatewayKey));
    if (filter?.before) conds.push(lt(transactions.createdAt, filter.before));
    const rows = await tx
      .select(detailedSelect)
      .from(transactions)
      .leftJoin(invoices, eq(transactions.invoiceId, invoices.id))
      .leftJoin(subscriptions, subscriptionOfTransaction)
      .leftJoin(customers, eq(transactions.customerId, customers.id))
      .leftJoin(creditNotes, eq(transactions.creditNoteId, creditNotes.id))
      .leftJoin(paymentMethods, eq(transactions.paymentMethodId, paymentMethods.id))
      .leftJoin(gatewayAccounts, eq(transactions.gatewayAccountId, gatewayAccounts.id))
      .leftJoin(payments, eq(transactions.paymentId, payments.id))
      .leftJoin(paymentIntents, eq(transactions.paymentIntentId, paymentIntents.id))
      .where(and(...conds))
      .orderBy(desc(transactions.createdAt))
      .limit(Math.min(filter?.limit ?? 50, 200));
    return rows.map(toDetailed);
  });
}

/** Single transaction with the same display context (the detail page). */
export async function getTransactionDetailed(
  organizationId: string,
  businessId: string,
  txnPublicId: string,
): Promise<TransactionDetailed | null> {
  const detailed = await withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select(detailedSelect)
      .from(transactions)
      .leftJoin(invoices, eq(transactions.invoiceId, invoices.id))
      .leftJoin(subscriptions, subscriptionOfTransaction)
      .leftJoin(customers, eq(transactions.customerId, customers.id))
      .leftJoin(creditNotes, eq(transactions.creditNoteId, creditNotes.id))
      .leftJoin(paymentMethods, eq(transactions.paymentMethodId, paymentMethods.id))
      // Same two joins as the list query — `detailedSelect` is shared, so a column added
      // there must be reachable from BOTH or the query throws at runtime rather than at
      // compile time. That is exactly what happened when only the list side was extended.
      .leftJoin(gatewayAccounts, eq(transactions.gatewayAccountId, gatewayAccounts.id))
      .leftJoin(payments, eq(transactions.paymentId, payments.id))
      .leftJoin(paymentIntents, eq(transactions.paymentIntentId, paymentIntents.id))
      .where(and(eq(transactions.businessId, businessId), eq(transactions.publicId, txnPublicId)))
      .limit(1);
    return row ? toDetailed(row) : null;
  });
  if (!detailed) return null;
  // Applies to every status: a settled success can be flagged days later, so this is not
  // gated the way the verdict-bearing extras below are.
  const fraudSignal = await fraudSignalForTransaction(detailed.txn);
  // Only where a verdict is actually on offer — see `settledReturn`'s note above.
  if (detailed.txn.status === "in_progress") {
    const [poll] = await withTenant(organizationId, (tx) =>
      tx
        .select({
          nextAt: settlementPollSchedule.nextAt,
          lastPolledAt: settlementPollSchedule.updatedAt,
          attempts: settlementPollSchedule.attempts,
        })
        .from(settlementPollSchedule)
        .where(eq(settlementPollSchedule.transactionId, detailed.txn.id))
        .orderBy(desc(settlementPollSchedule.nextAt))
        .limit(1),
    );
    const { txn, refPaymentPublicId } = detailed;
    const pendingDebitCancel =
      txn.type === "payment" &&
      refPaymentPublicId &&
      !txn.paymentRequestId &&
      gatewayCancelsPendingDebits(txn.gatewayKey)
        ? { paymentPublicId: refPaymentPublicId }
        : null;
    return { ...detailed, fraudSignal, pollSchedule: poll ?? null, pendingDebitCancel };
  }
  if (!RECONCILABLE_STATUSES.includes(detailed.txn.status)) {
    const { txn } = detailed;
    const disputeRecording =
      txn.type === "payment" && txn.status === "succeeded" && txn.paymentId
        ? await (
            await import("@/modules/disputes/operator")
          ).disputeRecordingFor(organizationId, businessId, txn.paymentId)
        : null;
    return { ...detailed, fraudSignal, disputeRecording };
  }
  return {
    ...detailed,
    fraudSignal,
    settledReturn: await settledReturnForTransaction(organizationId, detailed.txn),
  };
}

/**
 * The two statuses an operator verdict can still resolve. `in_progress` is deliberately
 * absent — a verdict must not race a live attempt — and so are the four terminal ones.
 */
const RECONCILABLE_STATUSES: readonly string[] = ["needs_attention", "timeout"];

/**
 * What the gateway said about fraud on this charge. Kept OUT of `status` deliberately:
 * status is the money's outcome, and overwriting a `succeeded` with a fraud flag would
 * destroy the only record of whether the charge settled.
 */
export interface FraudSignal {
  /** `fraud_warning.created` · `review.opened` · `review.closed`. */
  type: string;
  providerKey: string;
  receivedAt: Date;
}

const FRAUD_SIGNAL_TYPES = ["fraud_warning.created", "review.opened", "review.closed"];

/**
 * The newest fraud/review callback naming this charge.
 *
 * These arrive persist-only (`providers/types.ts`) — the engine takes no action, because
 * refunding on a warning is a commercial call. They were reachable ONLY through the
 * `early_fraud_warning` ops alert, which counts them across the whole platform and cannot
 * say which charge. This is the same fact where the operator is already looking.
 *
 * ⚠️ **Read on the PLATFORM connection, never `withTenant`** — `provider_events` is
 * platform-global and the tenant role has no grant on it (`permission denied for table
 * provider_events`, measured 2026-09-09 when this shipped inside `withTenant` and 500'd
 * the whole transaction detail page). Scoping is therefore MANUAL: `businessId` comes off
 * a transaction the caller already read under RLS, so the row is proven to be the
 * tenant's before it is used here. Correlation is `normalized->>'providerChargeId'`, which
 * the Stripe adapter fills from the warning's `payment_intent` or `charge`; a row with no
 * `id_at_gateway` has nothing to join on and gets `null` without a query.
 */
async function fraudSignalForTransaction(txn: Transaction): Promise<FraudSignal | null> {
  if (!txn.idAtGateway) return null;
  const [row] = await systemDb
    .select({
      type: providerEvents.type,
      providerKey: providerEvents.providerKey,
      receivedAt: providerEvents.receivedAt,
    })
    .from(providerEvents)
    .where(
      and(
        eq(providerEvents.businessId, txn.businessId),
        inArray(providerEvents.type, FRAUD_SIGNAL_TYPES),
        sql`${providerEvents.normalized}->>'providerChargeId' = ${txn.idAtGateway}`,
      ),
    )
    .orderBy(desc(providerEvents.receivedAt))
    .limit(1);
  return row ?? null;
}

/** Money this transaction would book that has ALREADY been returned to the payer. */
export interface SettledReturn {
  /** The gateway charge the money moved on. */
  chargeAtGateway: string;
  paymentPublicId: string | null;
  refundPublicId: string | null;
  /** The gateway's own refund id — what the gateway's dashboard shows. */
  providerRefundId: string | null;
  refundedMinor: bigint;
  fullyReturned: boolean;
  currency: string | null;
  /** Where the charge id came from: the row named it, or the intent chain did. */
  via: "transaction" | "payment_intent";
}

/**
 * "Has the money this row would book already gone back?" — the fact the Reconcile panel
 * needs and the verdict must obey.
 *
 * ── WHY (measured 2026-09-03, `txn_XXXXXXXXXXXXXXXXXXXXXX06` · #17) ────────────────
 * That row is a `needs_attention` authorization for ₹22,184.00 whose money we had already
 * refunded (`rfnd_XXXXXXXXXXXX01`). Its panel asserted "The gateway outcome is unknown",
 * PRE-SELECTED "Succeeded — money was captured", and offered "Confirm succeeded" under
 * "This is irreversible". Traced on that exact row: `txn.paymentId` is NULL, so
 * `settleTransactionOutcome` INSERTS a payment, claims it succeeded, finds the invoice
 * already `paid`, and takes the excess branch — `cash` debit ₹22,184.00 /
 * `excess_payment_balance` credit ₹22,184.00. One click books cash that does not exist and
 * hands the customer a credit they are not owed, through an append-only ledger.
 *
 * ── WHY IT NEEDS TWO PATHS TO THE CHARGE ───────────────────────────────────────────
 * `id_at_gateway` is the direct answer, and rows written after this fix carry it. The row
 * that motivated the fix does not: measured, its `id_at_gateway`, `payment_intent_id` and
 * `payment_id` are ALL null and the only link it carries is the invoice. So the fallback
 * walks the relationship that does exist — the intent for that invoice names the gateway
 * ORDER, and the callbacks we already persisted name the order and the charge together in
 * `provider_events.normalized` (measured: `payment.captured_1788437757` carries both
 * `order_XXXXXXXXXXXX03` and `pay_XXXXXXXXXXXX04`). Amount + currency must also match, so
 * an unrelated intent against the same invoice cannot answer for this row.
 *
 * The verdict on "already returned?" itself comes from `refunds/service.chargeAlreadyReturned`
 * — the same one the webhook guard uses, because two implementations that disagreed would
 * be worse than none.
 */
export async function settledReturnForTransaction(
  organizationId: string,
  txn: {
    businessId: string;
    idAtGateway: string | null;
    paymentIntentId: string | null;
    invoiceId: string | null;
    amountMinor: bigint;
    currency: string;
  },
): Promise<SettledReturn | null> {
  const { chargeAlreadyReturned } = await import("@/modules/refunds/service");
  const ask = async (
    chargeId: string,
    via: SettledReturn["via"],
  ): Promise<SettledReturn | null> => {
    const r = await chargeAlreadyReturned(organizationId, chargeId);
    // Money that is genuinely still out there is NOT this function's business: a
    // captured-but-unrefunded charge is exactly the case an operator verdict exists for.
    if (!r.settled || r.refundedMinor <= 0n) return null;
    return {
      chargeAtGateway: chargeId,
      paymentPublicId: r.paymentPublicId,
      refundPublicId: r.refundPublicId,
      providerRefundId: r.providerRefundId,
      refundedMinor: r.refundedMinor,
      fullyReturned: r.fullyReturned,
      currency: r.currency,
      via,
    };
  };

  if (txn.idAtGateway) {
    const direct = await ask(txn.idAtGateway, "transaction");
    if (direct) return direct;
  }
  if (!txn.paymentIntentId && !txn.invoiceId) return null;

  // The gateway ORDER ids this row could have been written about.
  const orderIds = await withTenant(organizationId, async (tx) => {
    const conds = [];
    if (txn.paymentIntentId) conds.push(eq(paymentIntents.id, txn.paymentIntentId));
    if (txn.invoiceId)
      conds.push(
        and(
          eq(paymentIntents.invoiceId, txn.invoiceId),
          eq(paymentIntents.amountMinor, txn.amountMinor),
          eq(paymentIntents.currency, txn.currency),
        )!,
      );
    const intents = await tx
      .select({ id: paymentIntents.id, atGateway: paymentIntents.intentAtGateway })
      .from(paymentIntents)
      .where(and(eq(paymentIntents.businessId, txn.businessId), or(...conds)));
    if (!intents.length) return [];
    // A retry re-points `intent_at_gateway`, so the attempts hold the ids the earlier
    // callbacks were correlated on. Both are the same kind of handle.
    const attempts = await tx
      .select({ atGateway: paymentAttempts.idAtGateway })
      .from(paymentAttempts)
      .where(
        inArray(
          paymentAttempts.paymentIntentId,
          intents.map((i) => i.id),
        ),
      );
    return [...new Set([...intents, ...attempts].map((r) => r.atGateway).filter((v) => !!v))];
  });
  if (!orderIds.length) return null;

  /**
   * `provider_events` is PLATFORM-GLOBAL (no RLS, no org column — a webhook arrives
   * before we know the tenant), so it is read through the base connection and narrowed
   * by `business_id`, which the ingest stamps. Rows are our own normalized copies of
   * deliveries we already accepted, not caller input.
   */
  const chargeIds = await systemDb
    .selectDistinct({ charge: sql<string>`${providerEvents.normalized}->>'providerChargeId'` })
    .from(providerEvents)
    .where(
      and(
        eq(providerEvents.businessId, txn.businessId),
        inArray(sql`${providerEvents.normalized}->>'providerIntentId'`, orderIds),
        sql`${providerEvents.normalized}->>'providerChargeId' is not null`,
      ),
    );
  for (const { charge } of chargeIds) {
    if (!charge) continue;
    const found = await ask(charge, "payment_intent");
    if (found) return found;
  }
  return null;
}

/**
 * Reconcile an unsettled transaction (`needs_attention` / `timeout` / `in_progress`).
 * Accepts an operator verdict; flips the transaction, its linked payment, and the
 * linked invoice accordingly, then emits `transaction.reconciled`.
 */
export async function reconcileTransaction(input: {
  organizationId: string;
  txnPublicId: string;
  outcome: "succeeded" | "failed";
}): Promise<Transaction | null> {
  /**
   * ── THE BRAKE (#17): never book money that has already been given back ──────────
   *
   * Read and refused BEFORE the write transaction opens, deliberately: the check reaches
   * `payments`/`refunds` through `chargeAlreadyReturned`, which opens its own tenant
   * transaction, and nothing must be written at all on the refused path. "No ledger
   * entries" is the assertion that matters — the ledger is append-only, so the panel's
   * "irreversible" is literal and a wrong posting can only be answered with a
   * compensating one.
   *
   * `failed` is untouched: it is the HONEST verdict on a charge whose money came back,
   * and blocking the whole form would leave the row un-resolvable forever.
   */
  /**
   * ONE read of the row, above BOTH brakes. #17's read was inside its own
   * `outcome === "succeeded"` branch; #20 added a second brake on the other verdict and
   * needs the same row, so hoisting it keeps one query rather than two and keeps the two
   * refusals visibly the same shape. Nothing is reordered by it: the read cannot throw,
   * and a row that does not exist still falls through to the `null` return below.
   */
  const [existing] = await withTenant(input.organizationId, (tx) =>
    tx.select().from(transactions).where(eq(transactions.publicId, input.txnPublicId)).limit(1),
  );
  if (input.outcome === "succeeded") {
    if (existing) {
      const returned = await settledReturnForTransaction(input.organizationId, existing);
      if (returned)
        throw new TransactionError(
          `You cannot confirm transaction ${existing.publicId} as succeeded. Gateway charge ` +
            `${returned.chargeAtGateway} was refunded: ${returned.refundedMinor} ` +
            `${returned.currency ?? existing.currency} went back on refund ` +
            `${returned.refundPublicId ?? "(unknown)"} (${returned.providerRefundId ?? "no gateway id"})` +
            `${returned.paymentPublicId ? `, booked on payment ${returned.paymentPublicId}` : ""}. ` +
            `A confirmation would post cash that does not exist. Reconcile it as failed instead.`,
        );
    }
  }
  /**
   * ── THE OTHER BRAKE (#20): never mark FAILED what a succeeded payment already books ──
   *
   * Same place and same reasons as #17's: read before the write transaction opens, so no
   * ledger entry is reachable on the refused path, and refused as a `TransactionError` an
   * operator can act on rather than the **500** this used to be. Until now this verdict
   * did not refuse at all — it crashed on `payments_provider_charge_uq` while
   * `settleTransactionOutcome` tried to mint a SECOND payment for a charge that already
   * had one, which made "mark this failed" unavailable on precisely the rows an operator
   * reaches for it (docs/PROGRESS.md #20, measured 2026-09-03).
   *
   * That collision is fixed in `settleTransactionOutcome`, which now settles the payment
   * that exists. But settling it is not always honest, and this is the case where it is
   * not: `settlePaymentFailed` claims a `pending` row only, so over a `succeeded` payment
   * it would post nothing, return false — and leave the `status = 'failed'` this
   * function writes standing anyway. The result is a transaction reading failed over
   * money that demonstrably moved, in a status no longer in `RECONCILABLE_STATUSES`, so
   * nobody could ever put it right. Refusing is the smaller harm, and it is the only one
   * that tells the operator something true.
   *
   * Scoped to a reconcilable status deliberately: on a terminal row the existing
   * "`is ${status}` and cannot be reconciled" refusal is the right one and must keep
   * coming first, so this brake does not reword an error anyone has already seen.
   *
   * The payment is resolved BY THE SAME RULE the settlement will use — the row's own
   * `payment_id` when it has one, otherwise the payment that holds its gateway charge —
   * because a brake that only saw one of the two doors would refuse a verdict on one row
   * and silently lie on the identical row that happens to name its payment instead.
   */
  if (existing && input.outcome === "failed" && RECONCILABLE_STATUSES.includes(existing.status)) {
    const booked = await withTenant(input.organizationId, async (tx) => {
      if (existing.paymentId) {
        const [row] = await tx
          .select()
          .from(payments)
          .where(eq(payments.id, existing.paymentId))
          .limit(1);
        return row ?? null;
      }
      return bookedPaymentForCharge(tx, {
        businessId: existing.businessId,
        providerChargeId: existing.idAtGateway,
        providerKey: existing.gatewayKey,
      });
    });
    if (booked?.status === "succeeded")
      throw new TransactionError(
        `You cannot reconcile transaction ${existing.publicId} as failed. ` +
          (existing.idAtGateway
            ? `Gateway charge ${existing.idAtGateway} is already booked on payment ${booked.publicId}. `
            : "") +
          `Payment ${booked.publicId} shows succeeded (${booked.amountMinor} ${booked.currency}). ` +
          `If you mark this transaction failed, it settles nothing, and its final status ` +
          `contradicts money that moved. Reconcile it as succeeded. Or refund payment ` +
          `${booked.publicId} if the money must go back.`,
      );
  }
  return withTenant(input.organizationId, async (tx) => {
    const [txn] = await tx
      .select()
      .from(transactions)
      .where(eq(transactions.publicId, input.txnPublicId))
      .limit(1);
    if (!txn) return null;
    // Plan §C5: only unknown-outcome transactions are reconcilable. `in_progress`
    // is deliberately excluded — an operator verdict must not race a live attempt.
    if (!RECONCILABLE_STATUSES.includes(txn.status))
      throw new TransactionError(
        `Transaction ${txn.publicId} is ${txn.status}, so you cannot reconcile it`,
      );

    const succeeded = input.outcome === "succeeded";
    // An operator is declaring the outcome of a transaction the gateway never
    // confirmed — money moves on their word, so the line records whose word it was
    // (the actor rides on every entry via the event context).
    log.info("transaction reconciled by operator verdict", {
      transaction: txn.publicId,
      from: txn.status,
      outcome: input.outcome,
      amountMinor: txn.amountMinor?.toString(),
      currency: txn.currency,
    });
    const [updated] = await tx
      .update(transactions)
      .set({ status: succeeded ? "succeeded" : "failed", settledAt: succeeded ? stampNow() : null })
      .where(eq(transactions.id, txn.id))
      .returning();

    // Settle the money: ledger posting + payment/invoice flips + events live in
    // ONE place (payments/settlement) shared with the inbound-webhook reconciler.
    await settleTransactionOutcome(tx, {
      organizationId: input.organizationId,
      businessId: txn.businessId,
      outcome: input.outcome,
      txn,
    });
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: txn.businessId,
      type: "transaction_reconciled",
      data: buildEventData(
        "transaction_reconciled",
        { id: updated!.publicId, outcome: input.outcome, status: updated!.status },
        updated!.resourceVersion,
      ),
    });
    return updated!;
  });
}
