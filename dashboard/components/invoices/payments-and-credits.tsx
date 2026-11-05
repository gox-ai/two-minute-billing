import { listTransactions, listPaymentIntents } from "@/lib/api/payments";
import type { Transaction, PaymentIntentRow } from "@/lib/api/payments";

/**
 * "Payments and Credits" — every money movement against one invoice, which is
 * the first question anyone opening an invoice asks and the page could not
 * answer. The data was already available via `GET /transactions?invoice=`, it
 * had simply never been wired up.
 *
 * Failures are shown, not filtered: a declined charge with its gateway reason is
 * the most useful row on a payment-due invoice.
 *
 * The fetch only. The view lives in `payments-and-credits-view.tsx` because this file
 * reaches `next/headers` through `@/lib/api/payments` and a client component may not
 * import it — see that file's note.
 *
 * ── OPEN INTENTS SIT ABOVE THE MONEY, not among it ──────────────────────────
 * A buyer part-way through "Pay now" — or one who walked away from it — writes NO
 * transaction and no `payments` row, because nothing has been answered yet. So this
 * list could not see one, and an operator reading a payment-due invoice had no way to
 * know a checkout was already open at the gateway for it.
 *
 * Shown as its own group, read-only, and deliberately NOT folded into
 * `payment_in_flight`: that flag takes "Collect now" away and its banner says a debit
 * "has been accepted by the gateway", neither of which is true of an open intent —
 * pressing Collect now RESUMES it, which is the correct next step. See
 * `pendingPaymentsForInvoices`' note on why the union is opt-in.
 */
export async function fetchPaymentsAndCredits(
  biz: string,
  invoiceId: string,
): Promise<{ transactions: Transaction[]; openIntents: PaymentIntentRow[] } | null> {
  let page;
  try {
    page = await listTransactions(biz, { invoice: invoiceId, limit: 100 });
  } catch {
    return null;
  }
  // Best-effort: an invoice's money is the point of this card, and losing it because the
  // intents list errored would be the worse trade.
  let openIntents: PaymentIntentRow[] = [];
  try {
    const intents = await listPaymentIntents(biz, { invoice: invoiceId, limit: 20 });
    openIntents = intents.data.filter(
      (i) => !i.voided_at && (i.status === "in_progress" || i.status === "authorized"),
    );
  } catch {
    openIntents = [];
  }
  const refunds = await unappliedRefunds(biz, page.data);
  // Newest first, as the list itself is ordered.
  const transactions = refunds.length
    ? [...page.data, ...refunds].sort((a, b) => b.created_at.localeCompare(a.created_at))
    : page.data;
  return { transactions, openIntents };
}

/**
 * Refunds of payments that settled too late to pay this invoice. The engine detaches such
 * a payment and books it as excess, so its refund carries no invoice and the `?invoice=`
 * list cannot see it — the invoice showed the money arriving and never leaving.
 */
async function unappliedRefunds(biz: string, rows: Transaction[]): Promise<Transaction[]> {
  const seen = new Set(rows.map((t) => t.id));
  const pays = [
    ...new Set(
      rows
        .filter((t) => t.type === "payment" && t.unapplied_reason && t.reference_payment)
        .map((t) => t.reference_payment!),
    ),
  ];
  const pages = await Promise.all(
    pays.map((pay) =>
      listTransactions(biz, {
        type: "refund",
        filters: [{ field: "reference_payment", op: "is", value: pay }],
        limit: 20,
      }).catch(() => null),
    ),
  );
  return pages.flatMap((p) => p?.data ?? []).filter((t) => !seen.has(t.id));
}
