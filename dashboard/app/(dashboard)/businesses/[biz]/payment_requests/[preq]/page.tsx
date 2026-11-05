import Link from "next/link";
import {
  listBusinesses,
  getCustomer,
  listPaymentMethods,
  money,
  fmtDate,
  fmtDateTime,
} from "@/lib/api";
import type { PaymentMethod } from "@/lib/api";
import { getPaymentRequest, type PaymentRequestLine } from "@/lib/api/payment-requests";
import { listReceipts } from "@/lib/api/receipts";
import { requirePermission } from "@/lib/session";
import { accountHolderName } from "@/lib/names";
import { StatusChip, IdChip, Chip } from "@/components/patterns/chip";
import {
  RecordCrumbs,
  RecordHeader,
  Zone,
  Row,
  RecordCard,
  Facts,
} from "@/components/patterns/record-page";
import { MoreMenu, MoreSection } from "@/components/patterns/more-menu";
import { RailLink } from "@/components/patterns/action-rail";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Alert } from "@/components/ui/alert";
import { ErrorState } from "@/components/states";
import { ReceiptsCard } from "@/components/receipts/receipts-card";
import {
  CancelRequestButton,
  ChargeRequestButton,
  RecordRequestPaymentButton,
  SendRequestButton,
} from "@/components/payment-requests/payment-request-actions";

export const dynamic = "force-dynamic";

const LINE_STATE_TITLE: Partial<Record<PaymentRequestLine["state"], string>> = {
  settled_elsewhere: "The invoice was paid or closed outside this request.",
  removed: "The invoice is no longer part of this request.",
};

const pmName = (pm: PaymentMethod | undefined, id: string | null) =>
  pm
    ? `${pm.brand ? pm.brand[0]!.toUpperCase() + pm.brand.slice(1) : pm.type}${pm.last4 ? ` ···${pm.last4}` : ""}`
    : id;

export default async function PaymentRequestPage({
  params,
}: {
  params: Promise<{ biz: string; preq: string }>;
}) {
  const { biz, preq } = await params;
  await requirePermission("payments:view", "ops");

  let businesses, r;
  try {
    [businesses, r] = await Promise.all([listBusinesses(), getPaymentRequest(biz, preq)]);
  } catch (e) {
    return (
      <ErrorState description={<span className="font-mono text-xs">{(e as Error).message}</span>} />
    );
  }
  if (!r)
    return (
      <ErrorState
        title="Not found"
        description={`We could not find the payment request ${preq}.`}
      />
    );

  const business = businesses.data.find((b) => b.id === biz);
  const name = business?.name ?? biz;
  const tz = business?.timezone ?? null;

  // Non-critical reads: each degrades to less detail, never to an error page.
  const [customer, pms, receipts] = await Promise.all([
    getCustomer(biz, r.customer).catch(() => null),
    listPaymentMethods(biz, r.customer)
      .then((x) => x.data)
      .catch(() => [] as PaymentMethod[]),
    listReceipts(biz, { limit: 10, scope: { payment_request: r.id } }).catch(() => null),
  ]);
  const customerName = customer ? (accountHolderName(customer) ?? customer.email) : null;
  const open = r.status === "open";
  const ids = { biz, preq: r.id, cus: r.customer };
  const defaultPm =
    r.payment_method ?? pms.find((p) => p.role === "primary")?.id ?? pms[0]?.id ?? null;
  const sendTo = r.email ?? customer?.email ?? null;

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs
        items={[
          { label: name, href: `/businesses/${biz}` },
          { label: "Payment requests", href: `/businesses/${biz}/payment_requests` },
          { label: r.id },
        ]}
      />

      <RecordHeader
        title={
          <span className="flex flex-wrap items-baseline gap-2">
            Payment request for{" "}
            <span className="tabular-nums">{money(r.amount_minor, r.currency)}</span>
            <span className="text-base font-normal text-muted-foreground">{r.currency}</span>
          </span>
        }
        chips={
          <>
            <StatusChip status={r.status} />
            <Chip>{r.mode === "charge" ? "Charge" : "Payment link"}</Chip>
          </>
        }
        facts={[
          <IdChip key="id" id={r.id} />,
          <Link
            key="cus"
            href={`/businesses/${biz}/customers/${r.customer}`}
            className="text-primary hover:underline"
          >
            {customerName ?? r.customer}
          </Link>,
          `Created ${fmtDate(r.created_at, tz)}`,
        ]}
        actions={
          open ? (
            <>
              {pms.length > 0 ? (
                <ChargeRequestButton
                  {...ids}
                  trigger="primary"
                  pms={pms}
                  defaultPm={defaultPm}
                  totalMinor={r.amount_minor}
                  currency={r.currency}
                />
              ) : (
                <SendRequestButton {...ids} trigger="primary" defaultTo={sendTo} />
              )}
              <MoreMenu>
                <MoreSection heading="Payment request">
                  <RecordRequestPaymentButton
                    {...ids}
                    totalMinor={r.amount_minor}
                    currency={r.currency}
                  />
                  {pms.length > 0 ? <SendRequestButton {...ids} defaultTo={sendTo} /> : null}
                  <RailLink href={`/businesses/${biz}/customers/${r.customer}`}>
                    View customer
                  </RailLink>
                  <CancelRequestButton {...ids} />
                </MoreSection>
              </MoreMenu>
            </>
          ) : undefined
        }
      />

      {r.last_payment_error && open ? (
        <Alert tone="error" title="The last charge failed">
          {r.last_payment_error.message ?? "The gateway declined the charge."}
          {r.last_payment_error.code ? (
            <span className="ml-1 font-mono text-xs">({r.last_payment_error.code})</span>
          ) : null}{" "}
          The request stays open. Charge it again, or send it again so that the customer can pay.
        </Alert>
      ) : null}
      {r.status === "processing" ? (
        <Alert tone="info">
          A payment for this request is in progress. We update the request when the payment settles.
        </Alert>
      ) : null}

      <Zone title="Payment request">
        <Row span="8/4">
          <RecordCard id="invoices" title="Invoices" flush={r.lines.length > 0}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Invoice</TableHead>
                  <TableHead>Due date</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Due at request</TableHead>
                  <TableHead className="pr-5 text-right">Due now</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...r.lines]
                  .sort((a, b) => a.position - b.position)
                  .map((l) => (
                    <TableRow key={l.invoice}>
                      <TableCell className="pl-5">
                        <Link
                          href={`/businesses/${biz}/invoices/${l.invoice}`}
                          className="text-primary hover:underline"
                        >
                          {l.invoice_number ?? l.invoice}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm">
                        {l.due_date ? fmtDate(l.due_date, tz) : "—"}
                      </TableCell>
                      <TableCell>
                        <span title={LINE_STATE_TITLE[l.state]}>
                          <StatusChip status={l.state} />
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums">
                        {money(l.created_outstanding_minor, r.currency)}
                      </TableCell>
                      <TableCell className="pr-5 text-right font-medium tabular-nums">
                        {money(l.amount_due_minor, r.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
            <div className="flex justify-end gap-8 border-t px-5 py-3 text-sm">
              <span className="text-muted-foreground">Total due now</span>
              <span className="font-semibold tabular-nums">
                {money(r.amount_minor, r.currency)}
              </span>
            </div>
          </RecordCard>
          <RecordCard id="details" title="Details">
            <Facts
              rows={[
                { label: "Status", value: <StatusChip status={r.status} /> },
                {
                  label: "Type",
                  value: r.mode === "charge" ? "Charge a saved payment method" : "Payment link",
                },
                { label: "Due now", value: money(r.amount_minor, r.currency) },
                { label: "Amount at request", value: money(r.created_amount_minor, r.currency) },
                !!r.payment_method && {
                  label: "Payment method",
                  value: pmName(
                    pms.find((p) => p.id === r.payment_method),
                    r.payment_method,
                  ),
                },
                !!r.email && { label: "Email", value: r.email },
                { label: "Charge attempts", value: String(r.attempt_count) },
                !!r.expires_at && { label: "Expires", value: fmtDateTime(r.expires_at, tz) },
                !!r.paid_at && { label: "Paid", value: fmtDateTime(r.paid_at, tz) },
                !!r.cancel_reason && { label: "Cancel reason", value: r.cancel_reason },
                { label: "Created", value: fmtDateTime(r.created_at, tz) },
              ]}
            />
          </RecordCard>
        </Row>
        <Row span="12">
          <ReceiptsCard
            biz={biz}
            receipts={receipts?.data ?? null}
            total={receipts?.total ?? null}
            viewAllHref={`/businesses/${biz}/receipts?payment_request=${r.id}`}
            tz={tz}
            emptyText="No receipts yet. We create one when this request is paid."
          />
        </Row>
      </Zone>
    </div>
  );
}
