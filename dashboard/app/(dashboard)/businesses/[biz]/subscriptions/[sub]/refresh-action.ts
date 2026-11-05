"use server";

// Data-returning refresh for the volatile strip on the subscription detail page — status,
// current term/next billing, next billing amount, scheduled changes, dunning/dues. Mirrors
// estimateNewSubscriptionAction's shape (server action returning data, called under
// useTransition — no router.refresh(), which would re-run the whole detail tree).

import { requirePermission } from "@/lib/session";
import { getSubscriptionDetail } from "@/lib/api/subscriptions";
import { listScheduledChanges, getRenewalEstimate } from "@/lib/api";

export interface SubscriptionVolatileState {
  status: string;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  cancel_reason_code: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  next_billing_at: string | null;
  mrr: number;
  /** Dues snapshot — the dunning/retry-adjacent state this page shows. */
  due_invoices_count: number;
  total_dues_minor: number;
  due_since: string | null;
  /** Next billing amount — engine renewal estimate, tax/coupons included. */
  next_billing_amount_minor: number | null;
  /** pending | scheduled | failed — same filter the page's own table uses. */
  pending_scheduled_count: number;
  /** Collected on this subscription's invoices, net of refunds. */
  revenue_to_date_minor: number;
  revenue_paid_invoices_count: number;
  revenue_since: string | null;
}

export async function refreshSubscriptionVolatileAction(
  biz: string,
  subId: string,
): Promise<{ ok: true; state: SubscriptionVolatileState } | { ok: false; error: string }> {
  // Same gate as the page itself — this returns nothing the viewer couldn't already see.
  await requirePermission("subscriptions:manage", "ops");
  try {
    const [sub, scheduled, estimate] = await Promise.all([
      getSubscriptionDetail(biz, subId),
      listScheduledChanges(biz, subId),
      getRenewalEstimate(biz, subId)
        .then((r) => r.estimate)
        .catch(() => null),
    ]);
    const pendingScheduled = scheduled.data.filter(
      (s) => s.status === "pending" || s.status === "scheduled" || s.status === "failed",
    );
    return {
      ok: true,
      state: {
        status: sub.status,
        cancel_at_period_end: sub.cancel_at_period_end ?? false,
        canceled_at: sub.canceled_at ?? null,
        cancel_reason_code: sub.cancel_reason_code ?? null,
        current_period_start: sub.current_period_start ?? null,
        current_period_end: sub.current_period_end ?? null,
        next_billing_at: sub.next_billing_at ?? null,
        mrr: sub.mrr ?? 0,
        due_invoices_count: sub.due_invoices_count ?? 0,
        total_dues_minor: sub.total_dues_minor ?? 0,
        due_since: sub.due_since ?? null,
        next_billing_amount_minor: estimate?.total_minor ?? null,
        pending_scheduled_count: pendingScheduled.length,
        revenue_to_date_minor: sub.revenue_to_date_minor ?? 0,
        revenue_paid_invoices_count: sub.revenue_paid_invoices_count ?? 0,
        revenue_since: sub.revenue_since ?? null,
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
