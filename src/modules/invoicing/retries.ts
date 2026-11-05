import { resolveStoredErrorId } from "@/providers/decline-codes";
import { and, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import {
  clampLimit,
  documentNumberSortKey,
  keysetCondition,
  pageOrder,
  parseCursor,
  toPage,
  type ListFilter,
  type ListPage,
} from "@/platform/list-query";
import { invoices, customers, transactions, paymentMethods } from "@db/schema";
import { accountHolderName } from "@/modules/customers/names";
import { accountHolderNameSql } from "@/modules/customers/name-sql";

/**
 * "Invoices under retry" — the Retries screen.
 *
 * WHY A DEDICATED READ rather than a filter on the invoices list: every column
 * that makes this screen useful (last error, which gateway refused it, the card
 * that failed, whether it is even worth retrying) lives on the invoice's LATEST
 * FAILED TRANSACTION, not on the invoice. Doing that from the dashboard would be
 * an N+1 across the page.
 *
 * The failed-transaction lookup is batched per page, the same shape `paidTotals`
 * uses in ./service — one extra query regardless of page size, served by
 * `transactions_invoice_failure_idx`.
 */

/**
 * "Under retry" = an unsettled invoice that needs collection attention.
 *
 * NOT simply `dunning_status IS NOT NULL`: that column is written by the dunning
 * PASS, so an invoice that has already failed a charge but not yet been through a
 * dunning cycle has it null. Filtering on it alone showed an EMPTY screen on a
 * business with 22 unpaid invoices and 39 failed attempts — an empty "nothing is
 * failing" claim that was false.
 *
 * Nor is it simply "unsettled": widening it to every `payment_due` invoice pulled
 * in 22 rows that had never been CHARGED at all (attempt_count 0, no failure, no
 * gateway) — invoices merely awaiting a first collection, which is a different
 * screen. A retry row must have a real attempt behind it.
 *
 * So: unsettled AND (already attempted OR a retry armed), plus anything dunning
 * has touched regardless of where it landed — which keeps `exhausted`/`stopped`
 * rows visible, exactly the ones needing a human.
 *
 * …but NOT a VOIDED one. The dunning arm carried no status filter, so an invoice
 * that was dunned and then voided stayed on the screen forever: measured 2026-09-06
 * at **122 of 476 rows on the real book, 25.6%**. The row itself is truthful —
 * `dunning_status` is a historical record and voiding does not erase it — the
 * screen was simply wrong to list something nobody will ever collect. A sweep would
 * have cleared today's and the next void would have re-created them; this predicate
 * is the fix. `paid` deliberately STAYS: a recovered invoice IS a successful retry,
 * and it is the outcome the screen exists to report.
 */
const UNDER_RETRY: SQL = sql`(
  (${inArray(invoices.status, ["payment_due", "not_paid"])}
    and (${invoices.attemptCount} > 0 or ${invoices.nextAttemptAt} is not null))
  or (${isNotNull(invoices.dunningStatus)} and ${invoices.status} <> 'voided')
)`;

/**
 * The subset that is still MOVING — what a call to action should count.
 *
 * `UNDER_RETRY` is the right set for the SCREEN and the wrong one for the nav badge, and
 * the difference is not cosmetic. Its dunning arm matches on `dunning_status IS NOT NULL`,
 * and that column is a historical record: once dunning has touched an invoice the row
 * matches forever. So a business that has ever exhausted a retry carries a permanent badge
 * it cannot drive to zero, which is how a count stops being read — the same failure this
 * codebase already recorded for `unapplied_gateway_money`.
 *
 * Live, and therefore counted:
 *   · `in_progress` — dunning is working the invoice.
 *   · `parked`      — blocked on the merchant's gateway configuration, but it WILL resume
 *                     once that is fixed, so it is work rather than history.
 *   · NULL with a real attempt behind it — a charge failed before any dunning pass ran.
 *
 * Terminal, and therefore not counted:
 *   · `exhausted` — dunning gave up. Needs a decision, but nothing will change it.
 *   · `stopped`   — an operator already decided. Counting it nags them about their own call.
 *   · `succeeded` — recovered. `UNDER_RETRY` keeps these deliberately (a recovered invoice
 *                   IS a successful retry) and they are not work at all.
 *
 * ⚠️ NOT `next_attempt_at IS NOT NULL`. That was the first shape tried and it is wrong: an
 * invoice whose current attempt has not settled yet has no next retry scheduled *because*
 * the outcome is unknown, and it is the most live row on the screen. Measured on a real
 * book — an `in_progress` invoice showing "Waiting for the current attempt to settle" with
 * `attempt_count = 0` and a null `next_attempt_at`. Arming is a symptom; the dunning state
 * is the fact.
 */
const ACTIVE_RETRY: SQL = sql`(
  ${invoices.dunningStatus} is null
  or ${invoices.dunningStatus} in ('in_progress', 'parked')
)`;

/**
 * The three states the SCREEN offers, as a partition of `UNDER_RETRY`.
 *
 * `UNDER_RETRY` deliberately keeps recovered invoices (see its note), and on a real
 * book that is most of the screen: measured 2026-09-10, **2,379 of 6,793 rows — 35% —
 * were `status = 'paid'`**, under a heading that reads "collection has failed or has a
 * retry scheduled". Both statements were defensible and together they misled: an
 * operator asked why a paid invoice was listed under retry. The rows stay reachable;
 * what changes is that the screen can now open on the ones needing a human.
 *
 * Split on `status = 'paid'` rather than `dunning_status = 'succeeded'`: money in is the
 * fact that makes a row not-work, and dunning's own label lags it — `in_progress`,
 * `stopped` and `exhausted` all have paid rows (214 / 161 / 86 here), every one of them
 * already collected.
 *
 * The three are mutually exclusive and together equal `UNDER_RETRY`, so no row can hide
 * from every segment — which is the failure mode of hand-picked "views".
 */
export type RetryState = "attention" | "recovered" | "given_up" | "all";

const PAID = sql`${invoices.status} = 'paid'`;

const RETRY_STATE: Record<Exclude<RetryState, "all">, SQL> = {
  /** Dunning is working it, or a charge failed before any pass ran — and it is unpaid. */
  attention: sql`(not ${PAID} and ${ACTIVE_RETRY})`,
  /** Collected. The outcome the screen reports, whatever dunning still calls it. */
  recovered: sql`${PAID}`,
  /** Dunning gave up, or an operator stopped it. Needs a decision; nothing will move it. */
  given_up: sql`(not ${PAID} and ${invoices.dunningStatus} in ('exhausted', 'stopped'))`,
};

/**
 * Server-side sorts, keyed by the screen's column ids. The columns read off the latest
 * failed transaction (retryable, last error, card, gateway) are resolved per page and
 * cannot be sorted in SQL. `next_attempt_at` ascending is the default and the keyset path.
 */
const RETRY_SORTS = {
  invoice: documentNumberSortKey(invoices.number),
  customer: sql`coalesce(${accountHolderNameSql}, ${customers.email})`,
  amount_due: sql`coalesce(${invoices.amountDueMinor}, ${invoices.totalMinor})`,
  retry_status: sql`coalesce(${invoices.dunningStatus}, ${invoices.status})`,
  next_attempt_at: invoices.nextAttemptAt,
  attempts: invoices.attemptCount,
  retry_started_at: invoices.createdAt,
} as const;

export type RetrySortField = keyof typeof RETRY_SORTS;
export const RETRY_SORT_FIELDS = Object.keys(RETRY_SORTS) as RetrySortField[];

export interface RetryRow {
  invoice: typeof invoices.$inferSelect;
  customerPublicId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  /** The most recent FAILED attempt on this invoice, if any is still on record. */
  lastFailure: {
    publicId: string;
    errorCode: string | null;
    errorText: string | null;
    /**
     * The gateway's own verdict (migration 0139). null means we never recorded
     * one for this attempt — render it as unknown, never as a hard failure.
     */
    retriable: boolean | null;
    gatewayKey: string | null;
    occurredAt: Date | null;
    cardBrand: string | null;
    cardLast4: string | null;
  } | null;
}

export interface RetryFilters {
  search?: string;
  filters?: ListFilter[];
  startingAfter?: string;
  limit?: number;
  /**
   * Narrow to the "Needs attention" segment — unpaid and still MOVING (see
   * {@link RETRY_STATE}), so the nav badge counts exactly what that list shows. An explicit flag
   * rather than a `filters` entry, because it changes what the `total` MEANS and the nav
   * badge is its only caller: a generic filter would let it be set accidentally.
   */
  activeOnly?: boolean;
  /**
   * Which slice of {@link RETRY_STATE} the screen is asking for. Absent or `"all"`
   * keeps the historical behaviour — the whole `UNDER_RETRY` set.
   *
   * Also an explicit field rather than a `filters` entry, and for a stronger reason
   * than `activeOnly`: `/retries` has no column map, so a `filters` row naming
   * `dunning_state` would be silently ignored and the screen would show every row
   * under a narrowed label. That exact "filter that doesn't filter" has shipped here
   * twice (payment intents' `scope.status`, the emails `attempts` filter).
   */
  state?: RetryState;
  sortField?: RetrySortField;
  sortDesc?: boolean;
}

/** Latest failed transaction per invoice, for one page of invoices. */
async function lastFailures(tx: Tx, invoiceIds: string[]) {
  const out = new Map<string, RetryRow["lastFailure"]>();
  if (invoiceIds.length === 0) return out;
  const rows = await tx
    .select({
      invoiceId: transactions.invoiceId,
      publicId: transactions.publicId,
      errorCode: transactions.errorCode,
      errorText: transactions.errorText,
      retriable: transactions.retriable,
      gatewayKey: transactions.gatewayKey,
      occurredAt: transactions.occurredAt,
      cardBrand: paymentMethods.brand,
      cardLast4: paymentMethods.last4,
    })
    .from(transactions)
    .leftJoin(paymentMethods, eq(transactions.paymentMethodId, paymentMethods.id))
    .where(and(inArray(transactions.invoiceId, invoiceIds), eq(transactions.status, "failed")))
    .orderBy(desc(transactions.occurredAt));
  // Newest-first, so the FIRST row seen per invoice is the latest failure.
  for (const r of rows) {
    if (!r.invoiceId || out.has(r.invoiceId)) continue;
    out.set(r.invoiceId, {
      publicId: r.publicId,
      errorCode: r.errorCode,
      errorText: r.errorText,
      retriable: r.retriable,
      gatewayKey: r.gatewayKey,
      occurredAt: r.occurredAt,
      cardBrand: r.cardBrand,
      cardLast4: r.cardLast4,
    });
  }
  return out;
}

/**
 * One page of invoices under retry.
 *
 * Ordered by `next_attempt_at` ASC with NULLS LAST — the operational question is
 * "what gets retried next", and the rows with nothing scheduled (exhausted or
 * stopped) are the ones needing a human, so they sort to the end rather than
 * being hidden. Keyset on `(next_attempt_at, public_id)`.
 */
export async function listRetriesPage(
  organizationId: string,
  businessId: string,
  f: RetryFilters = {},
): Promise<ListPage<RetryRow>> {
  const limit = clampLimit(f.limit);
  const sortField = f.sortField ?? "next_attempt_at";
  const descending = f.sortDesc ?? false;
  const keyset = sortField === "next_attempt_at" && !descending;

  return withTenant(organizationId, async (tx) => {
    const conds: SQL[] = [eq(invoices.businessId, businessId), UNDER_RETRY];
    if (f.activeOnly) conds.push(RETRY_STATE.attention);
    // Narrows the `total` too, because it is pushed before the count below — a
    // segment's row count has to be the segment's, not the whole screen's.
    if (f.state && f.state !== "all") conds.push(RETRY_STATE[f.state]);

    const { keysetId, offset } = parseCursor(f.startingAfter);
    /**
     * FIRST PAGE ONLY, like every other paginated resource.
     *
     * This used to run `count(*)` unconditionally, so retries answered with `total` on every
     * page — an undeclared deviation from the contract in `verify-list-pagination`'s header,
     * which allows it only as an explicit `totalOnEveryPage` exception. Nobody had to notice
     * because retries was not in that suite.
     *
     * It is not a justified exception, and that is measurable rather than a matter of taste:
     * `ListPage`'s `loadMore` appends rows and updates `hasMore`/`cursor` but **never calls
     * `setTotal`** (`patterns/list-page.tsx`), so the count from page one stays in React state and
     * whatever the server sends afterwards is discarded. The extra `count(*)` per scroll had
     * no consumer at all.
     */
    const total =
      keysetId || offset
        ? null
        : ((
            await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(invoices)
              .where(and(...conds))
          )[0]?.n ?? 0);

    const pageConds = [...conds];
    if (keyset && keysetId) {
      const [cursor] = await tx
        .select({
          sortValue: sql<string>`coalesce(${invoices.nextAttemptAt}::text, 'infinity')`,
          publicId: invoices.publicId,
        })
        .from(invoices)
        .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, keysetId)))
        .limit(1);
      const seek = keysetCondition(
        invoices.nextAttemptAt,
        invoices.publicId,
        cursor ? { sortValue: cursor.sortValue, tiebreak: cursor.publicId } : undefined,
        false,
      );
      if (seek) pageConds.push(seek);
    }

    const rows = await tx
      .select({
        inv: invoices,
        cusPid: customers.publicId,
        // The whole name chain, resolved below by `accountHolderName` — the legacy
        // `name` column alone showed nothing for a customer whose name lives in
        // first/last, on the one screen whose job is "call this person".
        cusFirstName: customers.firstName,
        cusLastName: customers.lastName,
        cusCompany: customers.company,
        cusEmail: customers.email,
      })
      .from(invoices)
      .leftJoin(customers, eq(invoices.customerId, customers.id))
      .where(and(...pageConds))
      .orderBy(...pageOrder(RETRY_SORTS[sortField], invoices.publicId, descending, keyset))
      .limit(limit + 1)
      .offset(keyset ? 0 : offset);

    const page = toPage(rows, limit, {
      keyset,
      offset,
      keyOf: (r) => r.inv.publicId,
      total,
    });
    const failures = await lastFailures(
      tx,
      page.data.map((r) => r.inv.id),
    );
    return {
      ...page,
      data: page.data.map((r) => ({
        invoice: r.inv,
        customerPublicId: r.cusPid ?? null,
        customerName: accountHolderName({
          firstName: r.cusFirstName,
          lastName: r.cusLastName,
          company: r.cusCompany,
          email: r.cusEmail,
        }),
        customerEmail: r.cusEmail ?? null,
        lastFailure: failures.get(r.inv.id) ?? null,
      })),
    };
  });
}

export function serializeRetry(r: RetryRow) {
  const inv = r.invoice;
  return {
    object: "retry",
    invoice: inv.publicId,
    invoice_number: inv.number,
    status: inv.status,
    /** in_progress | success | exhausted | stopped — the retry status. */
    dunning_status: inv.dunningStatus,
    currency: inv.currency,
    amount_due_minor: Number(inv.amountDueMinor ?? inv.totalMinor),
    attempt_count: inv.attemptCount,
    next_attempt_at: inv.nextAttemptAt,
    /** "Retry Started On" — when dunning first touched this invoice. */
    retry_started_at: inv.createdAt,
    customer: r.customerPublicId,
    customer_name: r.customerName,
    customer_email: r.customerEmail,
    last_error_code: r.lastFailure?.errorCode ?? null,
    /** The same code on the taxonomy's axis (stage 4) — additive, `last_error_code` is the contract. */
    last_error_id: r.lastFailure?.errorCode
      ? resolveStoredErrorId(r.lastFailure.errorCode).id
      : null,
    last_error_text: r.lastFailure?.errorText ?? null,
    /** true = soft, false = hard, null = unknown (never recorded). */
    last_failure_retriable: r.lastFailure?.retriable ?? null,
    last_failure_at: r.lastFailure?.occurredAt ?? null,
    gateway_key: r.lastFailure?.gatewayKey ?? null,
    payment_method_brand: r.lastFailure?.cardBrand ?? null,
    payment_method_last4: r.lastFailure?.cardLast4 ?? null,
  };
}
