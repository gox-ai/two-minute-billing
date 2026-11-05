"use server";

import { getInvoice, getDunningJourney, type DunningJourney } from "@/lib/api";
import type { InvoiceDetail } from "@/lib/api/invoices";
import type { Transaction, PaymentIntentRow } from "@/lib/api/payments";
import { fetchPaymentsAndCredits } from "@/components/invoices/payments-and-credits";
import { requirePermission } from "@/lib/session";

/**
 * The invoice fields that move on their own (status/dunning/collected-cash) plus
 * the payments-and-credits lists — everything the Refresh control on the invoice
 * detail page reloads. Mirrors `estimateNewSubscriptionAction`'s data-returning
 * shape: a server action, not a route, since there is no per-entity REST handler.
 */
export interface InvoiceVolatileData {
  status: string;
  written_off: boolean;
  paid_at: string | null;
  next_attempt_at: string | null;
  dunning_status: string | null;
  attempt_count: number;
  /**
   * From the engine (`dunningPeriodEndsAt`), null when the business sets no period. Volatile
   * because the period is anchored on the due date, which an operator can move.
   */
  dunning_period_ends_at: string | null;
  payment_in_flight: boolean;
  awaiting_authentication: boolean;
  amount_due_minor: number | null;
  amount_paid_minor: number | null;
  total_minor: number;
  credits_applied_minor: number | null;
  withholding_minor: number | null;
  currency: string;
  transactions: Transaction[];
  openIntents: PaymentIntentRow[];
  /** True only when the transactions fetch itself failed — hides the whole card. */
  paymentsUnavailable: boolean;
  /** Attempts, dunning events and the forecast; null when it could not be loaded. */
  journey: DunningJourney | null;
}

export async function refreshInvoiceVolatileAction(
  biz: string,
  inv: string,
): Promise<{ ok: true; data: InvoiceVolatileData } | { ok: false; error: string }> {
  // Same tenant guard the page and the neighbouring invoice actions use
  // (invoiceOpAction, recordOfflinePaymentAction) — this returns invoice money
  // and payment data, so it is not a lesser gate than a real page load.
  await requirePermission("invoices:manage", "ops");
  if (!biz || !inv)
    return { ok: false, error: "The business or invoice ID is missing. Reload the page." };
  try {
    const invoice: InvoiceDetail = await getInvoice(biz, inv);
    const [payments, journey] = await Promise.all([
      fetchPaymentsAndCredits(biz, inv),
      getDunningJourney(biz, inv).catch(() => null),
    ]);

    return {
      ok: true,
      data: {
        status: invoice.status,
        written_off: Boolean(invoice.written_off),
        paid_at: invoice.paid_at ?? null,
        next_attempt_at: invoice.next_attempt_at ?? null,
        dunning_status: invoice.dunning_status ?? null,
        attempt_count: invoice.attempt_count ?? 0,
        dunning_period_ends_at: invoice.dunning_period_ends_at ?? null,
        payment_in_flight: Boolean(invoice.payment_in_flight),
        awaiting_authentication: Boolean(invoice.awaiting_authentication),
        amount_due_minor: invoice.amount_due_minor ?? null,
        amount_paid_minor: invoice.amount_paid_minor ?? null,
        total_minor: invoice.total_minor,
        credits_applied_minor: invoice.credits_applied_minor ?? null,
        withholding_minor: invoice.withholding_minor ?? null,
        currency: invoice.currency,
        transactions: payments?.transactions ?? [],
        openIntents: payments?.openIntents ?? [],
        paymentsUnavailable: payments == null,
        journey,
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
