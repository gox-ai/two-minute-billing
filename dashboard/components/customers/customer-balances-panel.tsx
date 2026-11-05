import { money } from "@/lib/format";
import type { Customer, CustomerBalance } from "@/lib/api";

/**
 * The three credit buckets, per currency (plan §D1).
 *
 * Read-only by design. Credits are added from the right rail ("Manage Credits",
 * "Record an Offline Payment"): `PromoCreditRailButton` / `ExcessPaymentRailButton`.
 * The inline
 * "Wallet top-up" form that used to live here was a third surface duplicating
 * both, under a "Wallet balance" figure that summed promotional + excess into one
 * number — which read as refundable when half of it wasn't.
 *
 * Refundable credits have no WRITE control, here or in the rail: they're issued by
 * credit notes (`createCreditNoteAction`) and cancellation prorations, never granted
 * directly, so there is no endpoint to point a button at. They do now have a READ
 * one — the figure links to the credit notes backing it (see the cell below).
 */
export function CustomerBalancesPanel({
  biz,
  customer,
  defaultCurrency,
}: {
  /** Business id — only needed to build the refundable-credits deep link. */
  biz: string;
  customer: Customer;
  /**
   * The currency this customer actually transacts in, resolved once by the page
   * (`txnCurrency`) — used only to render an all-zero row when the customer has no
   * balances yet, so the table shows the shape rather than an empty state.
   */
  defaultCurrency: string;
}) {
  const balances: CustomerBalance[] = customer.balances ?? [];
  const rows: CustomerBalance[] = balances.length
    ? balances
    : [
        {
          currency_code: defaultCurrency,
          promotional_credits: 0,
          refundable_credits: 0,
          excess_payments: 0,
        },
      ];

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="pr-4 pb-2 text-left font-medium">Currency</th>
              <th className="pr-4 pb-2 text-right font-medium">Promotional credits</th>
              <th className="pr-4 pb-2 text-right font-medium">Refundable credits</th>
              <th className="pb-2 text-right font-medium">Excess payments</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.currency_code} className="border-b last:border-0">
                <td className="py-2 pr-4 font-mono text-xs font-semibold">{b.currency_code}</td>
                <Amount value={b.promotional_credits} currency={b.currency_code} className="pr-4" />
                {/* Deep-links to the credit notes backing this figure, filtered to
                    customer + type + status. Refundable credit is only ever issued by a
                    credit note, so the balance always has documents behind it; without
                    this the number was a dead end, because the credit-note list has no
                    customer filter in its UI and the customer page's History tab lists
                    ALL kinds. */}
                <Amount
                  value={b.refundable_credits}
                  currency={b.currency_code}
                  className="pr-4"
                  href={`/businesses/${biz}/credit_notes?customer=${customer.id}&kind=refundable&status=refund_due`}
                />
                <Amount value={b.excess_payments} currency={b.currency_code} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        We apply credit automatically when we generate an invoice. Promotional credit applies first,
        before tax. It cannot be more than the discounted subtotal. Refundable credit and excess
        payments apply next, after tax. We never refund promotional credit. You can refund the other
        two. Add credit from <b className="text-foreground">Manage credits</b> or{" "}
        <b className="text-foreground">Record excess payment</b> under More. Refundable credit comes
        from credit notes.
      </p>
    </div>
  );
}

/** Right-aligned tabular money; zero renders as an em dash, not ₹0.00. */
function Amount({
  value,
  currency,
  className,
  href,
}: {
  value: number;
  currency: string;
  className?: string;
  /** When set AND the figure is non-zero, the amount links to its backing records. */
  href?: string;
}) {
  return (
    <td className={`py-2 text-right tabular-nums ${className ?? ""}`}>
      {value > 0 ? (
        href ? (
          <a href={href} className="figure-link font-medium">
            {money(value, currency)}
          </a>
        ) : (
          <span className="font-medium text-foreground">{money(value, currency)}</span>
        )
      ) : (
        <span className="text-muted-foreground">—</span>
      )}
    </td>
  );
}
