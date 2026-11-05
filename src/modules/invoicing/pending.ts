/**
 * Pending invoices (E2 / INV-1) — open metered invoices.
 *
 * A subscription with `create_pending_invoices` renews into a `pending` invoice
 * (recurring lines only, NO ledger yet — see `billSubscriptionPeriod`'s pending
 * branch). Usage accretes over the period; `closeInvoice` finalizes it by
 * re-billing the same period (recurring + usage in arrears) into the SAME invoice
 * row via `billSubscriptionPeriod(existingInvoiceId)`, so the exact discount → tax
 * → credit → collect money math runs once, at close (pre-tax discounts/promo see
 * the complete line set). Transitions: pending → paid | posted | payment_due.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { billSubscriptionPeriod } from "./service";
import { InvoiceOpsError } from "./ops";
import { invoices, subscriptions, businesses, payments } from "@db/schema";
import { scanBusinessFilter } from "@/platform/clock";
import { createLogger } from "@/platform/logger";
import type { TickError } from "@/modules/subscriptions/renewal";
import { pendingInvoiceUsageWindow } from "@/modules/subscriptions/usage-window";

const log = createLogger("invoicing.pending");

type Invoice = typeof invoices.$inferSelect;
type Payment = typeof payments.$inferSelect;

/** Resolve whether a subscription bills into pending invoices (sub → business default). */
export function usesPendingInvoices(
  subFlag: boolean | null | undefined,
  bizDefault: boolean,
): boolean {
  return subFlag ?? bizDefault;
}

/**
 * Close a pending invoice: finalize it (discount/tax/credits/collect) and
 * transition pending → paid | posted | payment_due. Idempotent-ish: only a
 * `pending` invoice can be closed.
 */
export async function closeInvoice(
  organizationId: string,
  businessId: string,
  invoicePublicId: string,
): Promise<{ invoice: Invoice; payment: Payment | null }> {
  const inv = await withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, invoicePublicId)))
      .limit(1);
    return row ?? null;
  });
  if (!inv) throw new InvoiceOpsError(`We could not find the invoice ${invoicePublicId}.`);
  if (inv.status !== "pending")
    throw new InvoiceOpsError(
      `You cannot close a ${inv.status} invoice. You can close only pending invoices.`,
    );
  if (!inv.subscriptionId)
    throw new InvoiceOpsError("You cannot close a pending invoice that has no subscription");

  const sub = await withTenant(organizationId, async (tx) => {
    const [s] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, inv.subscriptionId!))
      .limit(1);
    return s ?? null;
  });
  if (!sub) throw new InvoiceOpsError("Pending invoice references a missing subscription");

  // Re-bill the period into the SAME row: recurring in advance + usage in arrears
  // over the window persisted at draft time (metadata.usage_window — it also
  // covers the just-ended period at the transition into pending mode; old drafts
  // without it fall back to the invoice's own period). billSubscriptionPeriod
  // replaces the draft lines and runs the full finalize/collect for the first
  // time; its status='pending' claim makes concurrent closes lose atomically.
  const usagePeriod = pendingInvoiceUsageWindow(inv);
  const { invoice, payment } = await billSubscriptionPeriod({
    organizationId,
    businessId,
    subscription: sub,
    periodStart: inv.periodStart!,
    periodEnd: inv.periodEnd!,
    usagePeriod,
    existingInvoiceId: inv.id,
    emitClosedEvent: true, // invoice.closed inside the finalize tx (outbox invariant)
    // P4: audit the close — an operator finalizing a draft is a money decision
    // ("who closed this pending invoice, from where, and what did it become?").
    // The diff is field-level: the status transition plus the total the finalize
    // computed, which the draft did not have (drafts carry recurring lines only).
    auditWrite: (finalized) => ({
      action: "invoice.close",
      before: { status: inv.status, total_minor: Number(inv.totalMinor) },
      after: { status: finalized.status, total_minor: Number(finalized.totalMinor) },
    }),
  });
  return { invoice, payment };
}

/**
 * Clock pass: auto-close pending invoices whose business set
 * `auto_close_pending_after_days` and whose period ended that many days ago.
 * System-wide; each close runs in its org's RLS context inside `closeInvoice`.
 */
export async function runAutoClosePending(
  now: Date,
): Promise<{ closed: number; errors: TickError[] }> {
  const errors: TickError[] = [];
  const rows = await systemDb
    .select({
      organizationId: invoices.organizationId,
      businessId: invoices.businessId,
      publicId: invoices.publicId,
      periodEnd: invoices.periodEnd,
      afterDays: businesses.autoClosePendingAfterDays,
    })
    .from(invoices)
    .innerJoin(businesses, eq(invoices.businessId, businesses.id))
    .where(
      and(
        eq(invoices.status, "pending"),
        isNotNull(businesses.autoClosePendingAfterDays),
        isNotNull(invoices.periodEnd),
        scanBusinessFilter(invoices.businessId),
      ),
    );

  let closed = 0;
  for (const r of rows) {
    const deadline = new Date(r.periodEnd!.getTime() + r.afterDays! * 86_400_000);
    if (deadline > now) continue;
    try {
      await closeInvoice(r.organizationId, r.businessId, r.publicId);
      closed++;
    } catch (e) {
      // Isolate failures so one invoice can't stall the pass.
      log.recurringError(`pending_close_failed:${r.publicId}`, e, {
        event: "pending_close_failed",
        invoice: r.publicId,
        businessId: r.businessId,
      });
      errors.push({
        organization: r.organizationId,
        business: r.businessId,
        invoice: r.publicId,
        step: "auto_close_pending",
        message: (e as Error)?.message ?? String(e),
      });
    }
  }
  return { closed, errors };
}
