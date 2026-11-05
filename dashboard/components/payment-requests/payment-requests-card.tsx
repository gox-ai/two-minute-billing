import Link from "next/link";
import { RecordCard } from "@/components/patterns/record-page";
import { StatusChip } from "@/components/patterns/chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { money, fmtDate } from "@/lib/format";
import type { PaymentRequest } from "@/lib/api/payment-requests";

/** A customer's latest payment requests. Server component: no hooks. */
export function PaymentRequestsCard({
  biz,
  cus,
  requests,
  total,
  tz,
}: {
  biz: string;
  cus: string;
  /** Null when the read failed. */
  requests: PaymentRequest[] | null;
  total: number | null;
  tz: string | null;
}) {
  const rows = requests ?? [];
  return (
    <RecordCard
      id="payment-requests"
      title="Payment requests"
      meta={total != null && total > rows.length ? `${rows.length} of ${total}` : undefined}
      actions={
        <Link
          href={`/businesses/${biz}/payment_requests?customer=${cus}`}
          className="text-primary hover:underline"
        >
          View all
        </Link>
      }
      flush={rows.length > 0}
    >
      {requests == null ? (
        <p className="m-0 text-sm text-muted-foreground">We could not load the payment requests.</p>
      ) : rows.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">
          No payment requests. Use Request payment to collect several open invoices at once.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">Request</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="pr-5 text-right">Due now</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="pl-5">
                  <Link
                    href={`/businesses/${biz}/payment_requests/${r.id}`}
                    className="font-mono text-xs text-primary hover:underline"
                  >
                    {r.id}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {r.lines.length} {r.lines.length === 1 ? "invoice" : "invoices"} ·{" "}
                    {r.mode === "charge" ? "Charge" : "Payment link"}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusChip status={r.status} />
                </TableCell>
                <TableCell className="text-sm">{fmtDate(r.created_at, tz)}</TableCell>
                <TableCell className="pr-5 text-right tabular-nums">
                  {money(r.amount_minor, r.currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </RecordCard>
  );
}
