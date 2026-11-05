import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusChip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import { fmtDate, money } from "@/lib/format";
import type { SegmentCustomer } from "@/lib/api/segments";

/**
 * The customers a segment matches.
 *
 * ── WHAT THE APPROVED DESIGN HAS AND THIS DOES NOT, AND WHY ──────────────────
 * Two columns are deliberately absent rather than filled with a plausible number:
 *
 *  · **LTV.** No per-customer lifetime value is stored. `customer_lifetime_value` is a
 *    book-level ratio (average revenue ÷ churn rate), so the column could only repeat
 *    one figure on every row and label it that customer's. A money column that is
 *    wrong per row is worse than a missing one, because an operator would act on it.
 *  · **Plan.** A plan belongs to the subscription, not the customer, and a customer
 *    with three subscriptions has three. The honest per-customer figure is how many
 *    subscriptions are live and what they earn, which is what the two columns beside
 *    the name say instead.
 *
 * Everything rendered comes from the engine: `segment_facts` is one grouped query per
 * page, and its statuses are the API statuses, so a row reading "Non-renewing" reads
 * the same here as on the subscriptions list.
 *
 * Country and Signed up hide at xl only, where the table shares its row with the rail.
 */
export function SegmentCustomerTable({
  biz,
  customers,
  fallbackCurrency,
  tz,
}: {
  biz: string;
  customers: SegmentCustomer[];
  /** Printed when a customer earns nothing, so a zero still carries a currency. */
  fallbackCurrency: string;
  /** Business timezone: a server component cannot read the provider. */
  tz: string | null;
}) {
  if (customers.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          title="No customers match"
          description="Remove a filter or make one wider. The figures above are for these exact filters."
        />
      </div>
    );
  }

  return (
    // Sits flush in its card, so the outer columns take the card's 20px gutter.
    <div className="[&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead className="xl:hidden 2xl:table-cell">Country</TableHead>
            <TableHead className="text-right">Subscriptions</TableHead>
            <TableHead className="text-right">MRR</TableHead>
            <TableHead className="xl:hidden 2xl:table-cell">Signed up</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {customers.map((c) => {
            const facts = c.segment_facts ?? { statuses: {}, mrr: {} };
            const live =
              (facts.statuses.active ?? 0) +
              (facts.statuses.in_trial ?? 0) +
              (facts.statuses.non_renewing ?? 0);
            const currencies = Object.keys(facts.mrr);
            return (
              <TableRow key={c.id}>
                <TableCell className="max-w-56">
                  <Link
                    href={`/businesses/${biz}/customers/${c.id}`}
                    title={c.name || c.company || c.email || c.id}
                    className="block truncate font-medium"
                  >
                    {c.name || c.company || c.email || c.id}
                  </Link>
                </TableCell>
                <TableCell className="xl:hidden 2xl:table-cell">
                  {c.address?.country ?? "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">{live}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {currencies.length === 0
                    ? money(0, c.effective_currency || fallbackCurrency)
                    : // A customer billing in two currencies has two figures. Printing
                      // both is the only honest answer; summing them is not.
                      currencies
                        .sort()
                        .map((cur) => money(facts.mrr[cur]!, cur))
                        .join(" · ")}
                </TableCell>
                <TableCell className="xl:hidden 2xl:table-cell">
                  {fmtDate(c.created_at, tz)}
                </TableCell>
                <TableCell>
                  {/* A buyer with no subscription: when they last bought says more than "none". */}
                  {!dominantStatus(facts.statuses) && facts.last_order_at ? (
                    <span className="text-sm text-muted-foreground">
                      Last order {fmtDate(facts.last_order_at, tz)}
                    </span>
                  ) : (
                    <StatusChip status={dominantStatus(facts.statuses)} />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * One chip for an account that can hold several subscriptions.
 *
 * Ordered by what an operator needs to see FIRST, not by count: one trial among four
 * active subscriptions is not the headline, but one payment-due among four active ones
 * is. A customer with nothing at all reads "No subscription" rather than borrowing a
 * terminal state they never reached.
 */
function dominantStatus(statuses: Record<string, number>): string {
  for (const s of ["active", "in_trial", "non_renewing", "paused", "future", "cancelled"]) {
    if ((statuses[s] ?? 0) > 0) return s;
  }
  return "";
}
