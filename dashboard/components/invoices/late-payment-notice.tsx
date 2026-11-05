import Link from "next/link";
import type { Transaction } from "@/lib/api/payments";
import { Alert } from "@/components/ui/alert";
import { money, fmtDateTime } from "@/lib/format";

/**
 * A charge that completed after its invoice was voided. The engine books it as the
 * customer's excess balance, but the transaction keeps its invoice link, so the payments
 * card shows a succeeded payment with no word on where the money went. This says it, and
 * names the refund when there is one.
 *
 * Voided invoices only. A paid invoice may have been open when the money landed and taken
 * part of it through the excess balance, and "did not pay this invoice" would be wrong.
 */
export function LatePaymentNotice({
  biz,
  tz,
  customer,
  transactions,
}: {
  biz: string;
  tz: string | null;
  customer: string | null;
  transactions: Transaction[];
}) {
  const late = transactions.filter(
    (t) => t.type === "payment" && t.status === "succeeded" && t.unapplied_reason,
  );
  if (late.length === 0) return null;
  return (
    <>
      {late.map((pay) => {
        const refunds = transactions.filter(
          (t) => t.type === "refund" && t.reference_payment === pay.reference_payment,
        );
        const done = refunds.filter((r) => r.status === "succeeded");
        const running = refunds.filter((r) => r.status === "in_progress");
        const covered = [...done, ...running].reduce((n, r) => n + r.amount_minor, 0);
        const rest = pay.amount_minor - covered;
        const when = pay.settled_at ?? pay.occurred_at;
        const refundLink = (r: Transaction) => (
          <Link href={`/businesses/${biz}/transactions/${r.id}`}>{r.id}</Link>
        );
        return (
          <Alert key={pay.id} tone="info" title="This payment did not pay this invoice">
            <p>
              The charge of {money(pay.amount_minor, pay.currency)} (
              <Link href={`/businesses/${biz}/transactions/${pay.id}`}>{pay.id}</Link>) started
              before this invoice was voided and completed after it
              {when ? <>, on {fmtDateTime(when, tz)}</> : null}. We added the money to the
              customer&apos;s excess balance.
            </p>
            {done.map((r) => (
              <p key={r.id}>
                We refunded {money(r.amount_minor, r.currency)} on{" "}
                {fmtDateTime(r.occurred_at ?? r.created_at, tz)} ({refundLink(r)}).
              </p>
            ))}
            {running.map((r) => (
              <p key={r.id}>
                A refund of {money(r.amount_minor, r.currency)} is in progress ({refundLink(r)}).
              </p>
            ))}
            {rest > 0 ? (
              <p>
                {covered > 0
                  ? `${money(rest, pay.currency)} is not refunded. `
                  : "We did not refund it. "}
                {customer ? (
                  <Link href={`/businesses/${biz}/customers/${customer}`}>
                    View the customer&apos;s balances
                  </Link>
                ) : (
                  "View the customer's balances"
                )}{" "}
                to refund it or use it.
              </p>
            ) : null}
          </Alert>
        );
      })}
    </>
  );
}
