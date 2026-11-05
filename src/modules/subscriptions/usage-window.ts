import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import {
  businesses,
  invoiceLineItems,
  invoices,
  subscriptionItems,
  subscriptions,
} from "@db/schema";

/**
 * The usage windows, in one place. Billing, settlement, ingestion and the usage views
 * read them from here; nothing computes a usage window inline.
 */

/** A half-open usage window `[start, end)`. */
export interface UsageWindow {
  start: Date;
  end: Date;
}

/**
 * The window a period invoice bills usage for: the term that just closed, `[start, end)`.
 * None without a term (trial), or when a pending invoice already owns it (`priorCovered`).
 *
 * Monthly usage billing: the window starts at the usage cursor (`current_sub_period_start`)
 * when it lies inside the term, and `until` closes it at a sub-period boundary instead of
 * the term end.
 */
export function termUsageWindow(
  term: {
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    currentSubPeriodStart?: Date | null;
  },
  opts: { priorCovered?: boolean; until?: Date } = {},
): UsageWindow | undefined {
  if (opts.priorCovered || !term.currentPeriodStart || !term.currentPeriodEnd) return undefined;
  const cursor = term.currentSubPeriodStart;
  const start =
    cursor && cursor > term.currentPeriodStart && cursor < term.currentPeriodEnd
      ? cursor
      : term.currentPeriodStart;
  return { start, end: opts.until ?? term.currentPeriodEnd };
}

/**
 * The window a pending invoice re-bills at close: the `usage_window` stored at draft time
 * (it can also hold the period that ended at the move into pending mode), else its period.
 */
export function pendingInvoiceUsageWindow(inv: {
  metadata: unknown;
  periodStart: Date | null;
  periodEnd: Date | null;
}): UsageWindow {
  const win = (inv.metadata as { usage_window?: { start?: string; end?: string } } | null)
    ?.usage_window;
  return win?.start && win.end
    ? { start: new Date(win.start), end: new Date(win.end) }
    : { start: inv.periodStart!, end: inv.periodEnd! };
}

/**
 * The earliest usage timestamp a future invoice still bills for this item's subscription.
 *
 * - The renewal bills `[current_period_start, current_period_end)` in arrears; with monthly
 *   usage billing, from the usage cursor (`termUsageWindow`).
 * - An open `pending` invoice bills its `usage_window` at close. At the move into pending
 *   mode that window also holds the period that just ended, so it can start earlier.
 * - A closed pending invoice billed its whole window, and the renewal skips a window its
 *   own invoice covered (`priorCovered`). Usage inside it is never billed.
 * - A finalized `usage` line locks its window (see `ratedOnInvoice`), except on an interim
 *   (threshold) invoice: the period's final invoice re-rates the whole window.
 * - Without a term (trial, future start) the window starts at the subscription start.
 */
export async function usageWindowStart(
  tx: Tx,
  subscriptionItemId: string,
): Promise<{ start: Date; subscriptionStart: Date } | null> {
  const [sub] = await tx
    .select({
      id: subscriptions.id,
      currentPeriodStart: subscriptions.currentPeriodStart,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      currentSubPeriodStart: subscriptions.currentSubPeriodStart,
      startedAt: subscriptions.startedAt,
      startDate: subscriptions.startDate,
      trialStart: subscriptions.trialStart,
      createdAt: subscriptions.createdAt,
    })
    .from(subscriptionItems)
    .innerJoin(subscriptions, eq(subscriptionItems.subscriptionId, subscriptions.id))
    .where(eq(subscriptionItems.id, subscriptionItemId))
    .limit(1);
  if (!sub) return null;
  // Earliest known start. The term is included: an imported subscription can carry a
  // term that began before its `started_at`.
  const starts = [sub.startedAt, sub.startDate, sub.trialStart, sub.currentPeriodStart].filter(
    (d): d is Date => d != null,
  );
  const subscriptionStart = starts.length
    ? new Date(Math.min(...starts.map((d) => d.getTime())))
    : sub.createdAt;
  // A billed sub-period moves the start to the usage cursor.
  let start = (
    termUsageWindow(sub)?.start ??
    sub.currentPeriodStart ??
    subscriptionStart
  ).getTime();

  const invs = await tx
    .select({
      status: invoices.status,
      periodStart: invoices.periodStart,
      metadata: invoices.metadata,
    })
    .from(invoices)
    .where(eq(invoices.subscriptionId, sub.id));
  const closedEnds: number[] = [];
  for (const inv of invs) {
    const win = (inv.metadata as { usage_window?: { start?: string; end?: string } } | null)
      ?.usage_window;
    if (inv.status === "pending") {
      const s = win?.start ? new Date(win.start) : inv.periodStart;
      if (s) start = Math.min(start, s.getTime());
    } else if (win?.end) {
      closedEnds.push(new Date(win.end).getTime());
    }
  }
  const [line] = await tx
    .select({ end: sql<string | null>`max(${invoiceLineItems.periodEnd})` })
    .from(invoiceLineItems)
    .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
    .where(
      and(
        eq(invoices.subscriptionId, sub.id),
        sql`${invoices.status} <> 'pending'`,
        // An interim invoice bills inside the open window; late usage there still bills.
        sql`${invoices.purpose} is distinct from 'usage_interim'`,
        eq(invoiceLineItems.kind, "usage"),
      ),
    );
  if (line?.end) closedEnds.push(new Date(line.end).getTime());
  start = Math.max(start, ...closedEnds, subscriptionStart.getTime());
  return { start: new Date(start), subscriptionStart };
}

// ── The window the next invoice bills (the usage views) ─────────────────────

/** Who bills the open usage window. */
export type UsageBilledBy = "renewal" | "pending_invoice" | "term_end_invoice";

export interface NextInvoiceUsageWindow extends UsageWindow {
  billedBy: UsageBilledBy;
  /** The open pending invoice that bills the window at close, if one exists. */
  invoiceId: string | null;
}

type WindowSub = Pick<
  typeof subscriptions.$inferSelect,
  | "id"
  | "businessId"
  | "status"
  | "currentPeriodStart"
  | "currentPeriodEnd"
  | "cancelAtPeriodEnd"
  | "remainingBillingCycles"
  | "createPendingInvoices"
>;

/**
 * The term's own invoice already billed the term's window: a pending draft stores the
 * window it bills at close, so the renewal after it bills no usage.
 */
export async function termCoveredByPriorInvoice(
  tx: Tx,
  sub: Pick<WindowSub, "id" | "currentPeriodStart" | "currentPeriodEnd">,
): Promise<boolean> {
  if (!sub.currentPeriodStart || !sub.currentPeriodEnd) return false;
  const [prev] = await tx
    .select({ metadata: invoices.metadata })
    .from(invoices)
    .where(
      and(eq(invoices.subscriptionId, sub.id), eq(invoices.periodStart, sub.currentPeriodStart)),
    )
    .orderBy(desc(invoices.createdAt))
    .limit(1);
  const win = (prev?.metadata as { usage_window?: { end?: string } } | null)?.usage_window;
  return !!win?.end && new Date(win.end) >= sub.currentPeriodEnd;
}

/**
 * The usage window the subscription's next invoice bills, as the billing paths decide it:
 * an open pending draft's stored window, else the term (`termUsageWindow`), billed at term
 * end, by a pending draft, or by the renewal. Null when no invoice will bill usage
 * (trial, no term, cancelled, or the term's own invoice already covered it).
 */
export async function usageWindowForNextInvoice(
  tx: Tx,
  sub: WindowSub,
): Promise<NextInvoiceUsageWindow | null> {
  if (sub.status === "cancelled" || sub.status === "in_trial" || sub.status === "future")
    return null;
  const [open] = await tx
    .select({
      publicId: invoices.publicId,
      metadata: invoices.metadata,
      periodStart: invoices.periodStart,
      periodEnd: invoices.periodEnd,
    })
    .from(invoices)
    .where(and(eq(invoices.subscriptionId, sub.id), eq(invoices.status, "pending")))
    .orderBy(desc(invoices.createdAt))
    .limit(1);
  if (open)
    return {
      ...pendingInvoiceUsageWindow(open),
      billedBy: "pending_invoice",
      invoiceId: open.publicId,
    };

  const w = termUsageWindow(sub, { priorCovered: await termCoveredByPriorInvoice(tx, sub) });
  if (!w) return null;
  if (sub.cancelAtPeriodEnd || sub.remainingBillingCycles === 0)
    return { ...w, billedBy: "term_end_invoice", invoiceId: null };
  // Same rule as `usesPendingInvoices`: the subscription's flag, else the business default.
  let pending = sub.createPendingInvoices;
  if (pending == null) {
    const [biz] = await tx
      .select({ pending: businesses.createPendingInvoices })
      .from(businesses)
      .where(eq(businesses.id, sub.businessId))
      .limit(1);
    pending = biz?.pending ?? false;
  }
  return { ...w, billedBy: pending ? "pending_invoice" : "renewal", invoiceId: null };
}
