import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { createLogger } from "@/platform/logger";
import { withTenant } from "@/platform/db";
import { invalidateSeriesCache } from "./daily/series-cache";

const log = createLogger("metrics.reportable");

/**
 * Customers flagged `exclude_from_reporting` (0482) — internal and test accounts — are left out
 * of every metric. This is the ONE predicate for that: every source read in this module (rows of
 * subscriptions, invoices, transactions, payments, credit notes, refunds, movements, customers)
 * passes its customer-id column through it.
 *
 * Applied at read and at derivation, never by deleting anything: `mrr_movements` is append-only
 * and filtered when read; `metric_daily` and `metric_windows` are restated on a flag change
 * (`restateReportingForBusiness`). Turning the flag off brings the customer back the same way.
 *
 * NOT EXISTS against the partial index, so a book with no excluded customer pays one empty
 * index probe. A NULL customer id (a row with no customer) stays reportable.
 */
export function reportableCustomer(customerIdCol: SQL | AnyColumn): SQL {
  return sql`not exists (select 1 from customers rx where rx.id = ${customerIdCol} and rx.exclude_from_reporting)`;
}

/** A `subscription_id` column whose subscription's customer is reportable. */
export function reportableSubscription(subscriptionIdCol: SQL | AnyColumn): SQL {
  return sql`not exists (select 1 from subscriptions rxs join customers rx on rx.id = rxs.customer_id where rxs.id = ${subscriptionIdCol} and rx.exclude_from_reporting)`;
}

/** A `payment_id` column (refunds carry no customer) whose payment's customer is reportable. */
export function reportablePayment(paymentIdCol: SQL | AnyColumn): SQL {
  return sql`not exists (select 1 from payments rxp join customers rx on rx.id = rxp.customer_id where rxp.id = ${paymentIdCol} and rx.exclude_from_reporting)`;
}

/** An `invoice_id` column (line items, allocations) whose invoice's customer is reportable. */
export function reportableInvoice(invoiceIdCol: SQL | AnyColumn): SQL {
  return sql`not exists (select 1 from invoices rxi join customers rx on rx.id = rxi.customer_id where rxi.id = ${invoiceIdCol} and rx.exclude_from_reporting)`;
}

/** Whether the business has any excluded customer — one probe of the partial index. */
export const hasExcludedCustomer = (businessId: string): SQL =>
  sql`exists (select 1 from customers rx where rx.business_id = ${businessId}::uuid and rx.exclude_from_reporting)`;

/**
 * The first business-local day a customer's rows touch: its own creation, its subscriptions,
 * documents, money and movements. Stored figures before that day cannot include it, so a
 * restatement starts there. Null = nothing of theirs is stored.
 */
export async function reportingSpanStart(
  organizationId: string,
  businessId: string,
  customerId: string,
): Promise<string | null> {
  const [row] = (await withTenant(organizationId, (tx) =>
    tx.execute(sql`
      select to_char(least(
               (select created_at from customers where id = ${customerId}::uuid),
               (select min(least(created_at, coalesce(start_date, created_at))) from subscriptions where customer_id = ${customerId}::uuid),
               (select min(created_at) from invoices where customer_id = ${customerId}::uuid),
               (select min(occurred_at) from transactions where customer_id = ${customerId}::uuid),
               (select min(created_at) from payments where customer_id = ${customerId}::uuid),
               (select min(created_at) from credit_notes where customer_id = ${customerId}::uuid),
               (select min(opened_at) from disputes where customer_id = ${customerId}::uuid),
               (select min(occurred_at) from mrr_movements where customer_id = ${customerId}::uuid)
             ) at time zone coalesce(b.timezone, 'UTC'), 'YYYY-MM-DD') as since
        from businesses b where b.id = ${businessId}::uuid`),
  )) as unknown as Array<{ since: string | null }>;
  return row?.since ?? null;
}

/**
 * Restate the stored figures after a customer's `exclude_from_reporting` changed, from the
 * first day that customer touches (`reportingSpanStart`) to today: days, then their coarse
 * periods. Rows are rewritten in place (`writeMetricDay` replaces per period), so a report
 * never reads an empty grain while this runs. Live reads filter at once; `metric_windows`
 * refreshes on its own cron. Never throws: a settings save must not fail on a queue.
 */
export async function restateReportingForBusiness(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
}): Promise<void> {
  invalidateSeriesCache(input.businessId);
  try {
    const since = await reportingSpanStart(
      input.organizationId,
      input.businessId,
      input.customerId,
    );
    if (!since) return;
    const { enqueue } = await import("@/platform/jobs");
    await enqueue("metric_daily_recompute", { businessId: input.businessId, since });
  } catch (e) {
    log.warn("could not queue an analytics restatement after a reporting exclusion changed", {
      event: "reporting_restate_enqueue_failed",
      businessId: input.businessId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
