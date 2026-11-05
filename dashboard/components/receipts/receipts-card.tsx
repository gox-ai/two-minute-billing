import Link from "next/link";
import { RecordCard } from "@/components/patterns/record-page";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { money, fmtDate } from "@/lib/format";
import { receiptPdfHref } from "@/lib/receipt-links";
import type { Receipt } from "@/lib/api/receipts";

/**
 * The latest receipts of one record (a customer, a payment request), with a link to the
 * full list scoped the same way. Server component: no hooks.
 */
export function ReceiptsCard({
  biz,
  receipts,
  total,
  viewAllHref,
  tz,
  emptyText,
}: {
  biz: string;
  /** Null when the read failed: the card says so instead of claiming there are none. */
  receipts: Receipt[] | null;
  total: number | null;
  viewAllHref: string;
  tz: string | null;
  emptyText: string;
}) {
  const rows = receipts ?? [];
  return (
    <RecordCard
      id="receipts"
      title="Receipts"
      meta={total != null && total > rows.length ? `${rows.length} of ${total}` : undefined}
      actions={
        <Link href={viewAllHref} className="text-primary hover:underline">
          View all
        </Link>
      }
      flush={rows.length > 0}
    >
      {receipts == null ? (
        <p className="m-0 text-sm text-muted-foreground">We could not load the receipts.</p>
      ) : rows.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">Number</TableHead>
              <TableHead>Method</TableHead>
              <TableHead>Paid</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="pr-5 text-right">PDF</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="pl-5 font-mono text-xs">
                  {r.number ?? (
                    <span className="font-sans text-muted-foreground">Not numbered yet</span>
                  )}
                </TableCell>
                <TableCell className="text-sm">{r.method}</TableCell>
                <TableCell className="text-sm">{fmtDate(r.paid_at, tz)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {money(r.amount_minor, r.currency)}
                </TableCell>
                <TableCell className="pr-5 text-right">
                  {r.number ? (
                    <a href={receiptPdfHref(biz, r.id)} className="text-primary hover:underline">
                      Download
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </RecordCard>
  );
}
