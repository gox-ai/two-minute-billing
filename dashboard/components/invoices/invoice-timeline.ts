import { getDunningJourney, money, type DunningJourney, type Invoice } from "@/lib/api";
import type { Transaction } from "@/lib/api/payments";
import { fetchPaymentsAndCredits } from "@/components/invoices/payments-and-credits";

export interface InvoiceTimeline {
  invoice: string;
  number: string;
  due: string;
  /** Null when the journey could not be read: the card then shows no history. */
  journey: DunningJourney | null;
  transactions: Transaction[];
}

/** Unpaid = open and still owing, oldest first. */
export function unpaidInvoices(invoices: Invoice[]): Invoice[] {
  return invoices
    .filter(
      (i) =>
        ["posted", "payment_due", "not_paid"].includes(i.status) &&
        (i.amount_due_minor ?? i.total_minor) > 0,
    )
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
}

/**
 * Each unpaid invoice's journey and transactions, for the attention card's compact copy of
 * the invoice page's "Payments and dunning" card. Read for one or two invoices only; with
 * more, the page points at the invoice list instead, so nothing is fetched.
 *
 * Server-side; what it returns is plain data for the client attention cards.
 */
export async function loadInvoiceTimelines(
  biz: string,
  unpaid: Invoice[],
): Promise<InvoiceTimeline[]> {
  if (unpaid.length === 0 || unpaid.length > 2) return [];
  return Promise.all(
    unpaid.map(async (inv) => {
      const [journey, payments] = await Promise.all([
        getDunningJourney(biz, inv.id).catch(() => null),
        fetchPaymentsAndCredits(biz, inv.id),
      ]);
      return {
        invoice: inv.id,
        number: inv.number ?? inv.id,
        due: money(inv.amount_due_minor ?? inv.total_minor, inv.currency),
        journey,
        transactions: payments?.transactions ?? [],
      };
    }),
  );
}
