import { createdThroughLabel } from "@/lib/created-through";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileDown } from "lucide-react";
import {
  fmtDate,
  fmtDateTime,
  getCustomer,
  getInvoice,
  isApiNotFound,
  listBusinesses,
  listCreditNotes,
  money,
} from "@/lib/api";
import { getOrder } from "@/lib/api/orders";
import { getGatewayCatalogOrEmpty, invoiceRefundAccount } from "@/lib/api/gateways";
import {
  addressLines,
  invoiceCapabilities,
  newCreditNoteHref,
  splitInvoiceLines,
  type InvoiceDetail as InvoiceDetailType,
} from "@/lib/api/invoices";
import { billingRules } from "@/lib/billing-rules";
import { invoiceCreditableMinor } from "@/lib/credit-allocation";
import { instrumentLabel } from "@/lib/instrument-label";
import { lineQuantity, lineUnitPrice } from "@/lib/meters";
import { invoiceContactName } from "@/lib/names";
import { allows, requirePermission } from "@/lib/session";
import { creditNoteChipStatus } from "@/lib/credit-note-status";
import { gatewayDisplayName } from "@/components/gateways/gateway-meta";
import { OrderStatusChip } from "@/components/orders/order-status";
import {
  CreateCreditNoteDialog,
  IssueRefundDialog,
  RecordInvoiceOfflineRefundDialog,
} from "@/components/invoices/invoice-credit-actions";
import { ActivityLogCard } from "@/components/activity-log-card";
import { CommentsCard } from "@/components/comments/comments-card";
import { SendEmailDialog } from "@/components/emails/send-email-dialog";
import { ADHOC_TYPES_FOR } from "@/lib/email-types";
import { sendAdhocEmailAction } from "../../emails/actions";
import { StatusChip, IdChip } from "@/components/patterns/chip";
import { MiddleEllipsis } from "@/components/patterns/id-text";
import { MoreMenu, MoreSection } from "@/components/patterns/more-menu";
import { RailLink } from "@/components/patterns/action-rail";
import {
  Facts,
  RecordCard,
  RecordCrumbs,
  RecordHeader,
  Row,
  Zone,
} from "@/components/patterns/record-page";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/states";

export const dynamic = "force-dynamic";

// Order detail. An order IS an invoice for one-time products, so the page reads the order
// (`GET /orders/:id`: 404 for any other invoice) and the invoice (lines, discounts, address)
// and reuses the invoice page's refund dialogs, email dialog, PDF route and activity log.
// An order has no custom fields of its own; the customer's show on the customer page.
export default async function OrderDetail({
  params,
}: {
  params: Promise<{ biz: string; order: string }>;
}) {
  const { biz, order: orderId } = await params;
  const user = await requirePermission("invoices:view", "ops");
  const isManager = allows(user, "invoices:void", "manager");

  let order, inv: InvoiceDetailType, businesses, creditNotes;
  try {
    order = await getOrder(biz, orderId);
    [inv, businesses, creditNotes] = await Promise.all([
      getInvoice(biz, order.id),
      listBusinesses(),
      listCreditNotes(biz, order.id),
    ]);
  } catch (e) {
    if (isApiNotFound(e)) notFound();
    return (
      <ErrorState
        error={e}
        thing="order"
        back={{ label: "View orders", href: `/businesses/${biz}/orders` }}
        retry
      />
    );
  }

  const biz_ = businesses.data.find((b) => b.id === biz);
  const bizName = biz_?.name ?? "Business";
  const tz = biz_?.timezone ?? null;
  const gatewayCatalog = await getGatewayCatalogOrEmpty();
  const customer = order.customer.id
    ? await getCustomer(biz, order.customer.id).catch(() => null)
    : null;

  const label = order.number ?? order.id;
  const invoiceHref = `/businesses/${biz}/invoices/${order.id}`;
  const pdfHref = `${invoiceHref}/pdf`;
  const htmlHref = `${invoiceHref}/html?print=1`;

  // Refund rules: the same as the invoice page.
  const caps = invoiceCapabilities(inv);
  const requiredReasons = billingRules(biz_).required_reasons;
  const refundReasons = { code: requiredReasons.create_credit_note, note: requiredReasons.refund };
  const amountPaid = inv.amount_paid_minor ?? 0;
  const creditableMinor = invoiceCreditableMinor(inv, creditNotes.data);
  const canCreditNote = isManager && creditableMinor > 0;
  const canRefundCash = canCreditNote && !caps.archival && amountPaid > 0;
  const refundAccount = canRefundCash ? await invoiceRefundAccount(biz, inv.id) : null;

  const refundActions = canCreditNote ? (
    <>
      {canRefundCash ? (
        <>
          <IssueRefundDialog
            biz={biz}
            gatewayAccount={refundAccount}
            invoice={inv.id}
            refundableMinor={creditableMinor}
            currency={inv.currency}
            requiredReasons={refundReasons}
          />
          <RecordInvoiceOfflineRefundDialog
            biz={biz}
            invoice={inv.id}
            refundableMinor={creditableMinor}
            currency={inv.currency}
            requiredReasons={refundReasons}
          />
        </>
      ) : null}
      <CreateCreditNoteDialog
        biz={biz}
        invoice={inv.id}
        creditableMinor={creditableMinor}
        currency={inv.currency}
        advancedHref={newCreditNoteHref(biz, inv.id)}
        defaultKind={amountPaid > 0 || inv.status === "paid" ? "refundable" : "adjustment"}
        requiredReasons={{ code: requiredReasons.create_credit_note }}
      />
    </>
  ) : null;

  const { items, adjustments, hasLineDiscounts } = splitInvoiceLines(inv.lines);
  const taxOf = (l: unknown) => (l as { tax_amount_minor?: number }).tax_amount_minor ?? 0;
  const hasLineTax = items.some((l) => taxOf(l) > 0);
  const discounts = (inv.discounts ?? []).filter((d) => d.amount_minor !== 0);
  const holderName = inv.customer_name ?? order.customer.name ?? null;
  const billing = inv.billing_address;
  const billedTo =
    (billing?.first_name || billing?.last_name || billing?.company
      ? [billing.first_name, billing.last_name].filter(Boolean).join(" ") || billing.company
      : null) ?? (customer ? invoiceContactName(customer) : null);
  const lines = addressLines(billing);
  const metadata = inv.metadata && Object.keys(inv.metadata).length > 0 ? inv.metadata : null;
  const method = (m: { type: string; brand: string | null; last4: string | null } | null) =>
    m ? instrumentLabel(m) : "—";
  const total = order.total_minor;

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs
        items={[
          { label: bizName, href: `/businesses/${biz}` },
          { label: "Orders", href: `/businesses/${biz}/orders` },
          { label },
        ]}
      />

      <RecordHeader
        title={
          <span className="flex flex-wrap items-baseline gap-2">
            Order for <span className="tabular-nums">{money(total, order.currency)}</span>
            <span className="text-base font-normal text-muted-foreground">{order.currency}</span>
          </span>
        }
        chips={<OrderStatusChip status={order.status} />}
        facts={[
          order.number ? <IdChip key="no" label="№" id={order.number} /> : null,
          <IdChip key="id" id={order.id} />,
          order.customer.id ? (
            <Link
              key="cus"
              href={`/businesses/${biz}/customers/${order.customer.id}`}
              className="text-primary hover:underline"
            >
              {holderName ?? order.customer.id}
            </Link>
          ) : null,
          fmtDateTime(order.created_at, tz),
        ]}
        actions={
          <>
            <Button asChild>
              <a data-document-link href={pdfHref}>
                <FileDown className="size-4" /> Download invoice
              </a>
            </Button>
            <Button asChild variant="outline">
              <Link href={invoiceHref}>View invoice</Link>
            </Button>
            <MoreMenu>
              <MoreSection heading="Order actions">
                <a href={htmlHref} target="_blank" rel="noopener noreferrer">
                  View / print
                </a>
                <RailLink href={`/businesses/${biz}/receipts?invoice=${order.id}`}>
                  View receipts
                </RailLink>
                {inv.customer_email ? (
                  <SendEmailDialog
                    types={ADHOC_TYPES_FOR.invoice}
                    defaultTo={inv.customer_email}
                    recordLabel={`Invoice ${label}`}
                    onSend={async ({ type, to, note }) => {
                      "use server";
                      return sendAdhocEmailAction(biz, {
                        type,
                        invoice: order.id,
                        to,
                        note: note || undefined,
                      });
                    }}
                    trigger={<button type="button">Send email</button>}
                  />
                ) : null}
              </MoreSection>
              {refundActions ? (
                <MoreSection heading="Refund and credit">{refundActions}</MoreSection>
              ) : null}
            </MoreMenu>
          </>
        }
      />

      <Zone title="Order">
        <Row span="8/4">
          <RecordCard id="items" title="Items" flush={items.length > 0}>
            {items.length === 0 ? (
              <EmptyState title="No line items" />
            ) : (
              <>
                <Table phone="stack" fit>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-5">Product</TableHead>
                      <TableHead className="hidden text-right unstacked:table-cell">
                        Units
                      </TableHead>
                      <TableHead className="hidden text-right unstacked:table-cell">
                        Unit price
                      </TableHead>
                      {hasLineDiscounts ? (
                        <TableHead className="hidden text-right unstacked:table-cell">
                          Discount
                        </TableHead>
                      ) : null}
                      {hasLineTax ? (
                        <TableHead className="hidden text-right unstacked:table-cell">
                          Tax
                        </TableHead>
                      ) : null}
                      <TableHead className="pr-5 text-right">Line total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell className="pl-5 whitespace-normal">
                          <span className="flex flex-col gap-0.5">
                            <span className="text-sm font-medium wrap-anywhere">
                              {l.description}
                            </span>
                            <span className="text-xs text-muted-foreground tabular-nums unstacked:hidden">
                              {lineQuantity(l)} ×{" "}
                              <span className="whitespace-nowrap">
                                {lineUnitPrice(l, inv.currency)}
                              </span>
                            </span>
                          </span>
                        </TableCell>
                        <TableCell className="hidden text-right tabular-nums unstacked:table-cell">
                          {lineQuantity(l)}
                        </TableCell>
                        <TableCell className="hidden text-right tabular-nums unstacked:table-cell">
                          {lineUnitPrice(l, inv.currency)}
                        </TableCell>
                        {hasLineDiscounts ? (
                          <TableCell className="hidden text-right text-muted-foreground tabular-nums unstacked:table-cell">
                            {(l.item_level_discount_minor ?? 0) === 0
                              ? "—"
                              : `−${money(l.item_level_discount_minor ?? 0, inv.currency)}`}
                          </TableCell>
                        ) : null}
                        {hasLineTax ? (
                          <TableCell className="hidden text-right text-muted-foreground tabular-nums unstacked:table-cell">
                            {taxOf(l) > 0 ? money(taxOf(l), inv.currency) : "—"}
                          </TableCell>
                        ) : null}
                        <TableCell className="pr-5 text-right font-medium tabular-nums">
                          {money(l.amount_minor - (l.item_level_discount_minor ?? 0), inv.currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="ml-auto w-fit max-w-full min-w-xs space-y-1 px-5 py-4 text-sm [&_.tabular-nums]:whitespace-nowrap">
                  <div className="flex justify-between gap-8">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span className="tabular-nums">
                      {money(inv.subtotal_minor ?? 0, inv.currency)}
                    </span>
                  </div>
                  {(inv.promotional_discount_minor ?? 0) > 0 ? (
                    <div className="flex justify-between gap-8">
                      <span className="text-muted-foreground">Promotional Credits</span>
                      <span className="tabular-nums">
                        {money(-(inv.promotional_discount_minor ?? 0), inv.currency)}
                      </span>
                    </div>
                  ) : null}
                  {adjustments.map((a) => (
                    <div key={a.id} className="flex justify-between gap-8">
                      <span className="text-muted-foreground">{a.label}</span>
                      <span className="tabular-nums">{money(a.amountMinor, inv.currency)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between gap-8 border-t pt-1 font-semibold">
                    <span>Total</span>
                    <span className="tabular-nums">{money(total, order.currency)}</span>
                  </div>
                  {order.tax_minor > 0 ? (
                    <div className="flex justify-between gap-8 text-muted-foreground">
                      <span>Tax in the total</span>
                      <span className="tabular-nums">{money(order.tax_minor, order.currency)}</span>
                    </div>
                  ) : null}
                  {order.refunded_minor > 0 ? (
                    <div className="flex justify-between gap-8">
                      <span className="text-muted-foreground">Refunded</span>
                      <span className="tabular-nums">
                        {money(-order.refunded_minor, order.currency)}
                      </span>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </RecordCard>

          <RecordCard id="details" title="Order details">
            <Facts
              rows={[
                { label: "Status", value: <OrderStatusChip status={order.status} /> },
                { label: "Ordered on", value: fmtDateTime(order.created_at, tz) },
                { label: "Created through", value: createdThroughLabel(order.created_through) },
                order.paid_at ? { label: "Paid on", value: fmtDateTime(order.paid_at, tz) } : null,
                order.due_date ? { label: "Due date", value: fmtDate(order.due_date, tz) } : null,
                order.channel
                  ? { label: "Channel", value: <span className="capitalize">{order.channel}</span> }
                  : null,
                {
                  label: "Invoice status",
                  value: (
                    <span className="capitalize">{order.invoice_status.replace(/_/g, " ")}</span>
                  ),
                },
              ]}
            />
          </RecordCard>
        </Row>
      </Zone>

      <Zone title="Payment">
        <Row span="6/6">
          <RecordCard id="payment" title="Payment" flush={order.payments.length > 0}>
            {order.payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No payment attempt yet.</p>
            ) : (
              <Table phone="stack" fit>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Method</TableHead>
                    <TableHead>Gateway</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead phone="aside" className="text-right">
                      Amount
                    </TableHead>
                    <TableHead className="pr-5">Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {order.payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="pl-5 whitespace-normal">
                        <span className="flex flex-col gap-0.5">
                          {method(p.payment_method)}
                          {p.failure_message || p.failure_code ? (
                            <span className="text-xs wrap-anywhere text-destructive">
                              {p.failure_message ?? p.failure_code}
                            </span>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell>{gatewayDisplayName(p.gateway, gatewayCatalog)}</TableCell>
                      <TableCell>
                        <StatusChip status={p.status} className="shrink whitespace-normal" />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(p.amount_minor, p.currency)}
                      </TableCell>
                      <TableCell className="pr-5 text-muted-foreground">
                        {fmtDateTime(p.created_at, tz)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </RecordCard>

          <RecordCard
            id="refunds"
            title="Refunds"
            flush={order.refunds.length > 0}
            actions={refundActions}
          >
            {order.refunds.length === 0 ? (
              <p className="text-sm text-muted-foreground">No refunds on this order.</p>
            ) : (
              <Table phone="stack" fit>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Refund</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead phone="aside" className="text-right">
                      Amount
                    </TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="pr-5">Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {order.refunds.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="pl-5">
                        <MiddleEllipsis value={r.id} className="max-w-40 font-mono text-xs" />
                      </TableCell>
                      <TableCell>
                        <StatusChip status={r.status} className="shrink whitespace-normal" />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(r.amount_minor, r.currency)}
                      </TableCell>
                      <TableCell className="wrap-anywhere whitespace-normal text-muted-foreground">
                        {r.reason ?? "—"}
                      </TableCell>
                      <TableCell className="pr-5 text-muted-foreground">
                        {fmtDateTime(r.created_at, tz)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </RecordCard>
        </Row>
      </Zone>

      <Zone title="Customer">
        <Row span="6/6">
          <RecordCard id="customer" title="Customer">
            <Facts
              rows={[
                {
                  label: "Customer",
                  value: order.customer.id ? (
                    <Link
                      href={`/businesses/${biz}/customers/${order.customer.id}`}
                      className="text-primary hover:underline"
                    >
                      {holderName ?? order.customer.id}
                    </Link>
                  ) : (
                    "—"
                  ),
                },
                { label: "Email", value: order.customer.email ?? "—" },
                billedTo ? { label: "Billed to", value: billedTo } : null,
                {
                  label: "Billing address",
                  value:
                    lines.length > 0 ? (
                      <span className="flex flex-col">
                        {lines.map((l) => (
                          <span key={l}>{l}</span>
                        ))}
                      </span>
                    ) : (
                      "Not set."
                    ),
                },
              ]}
            />
          </RecordCard>

          <RecordCard id="coupon" title="Coupon">
            {discounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No coupon or discount on this order.</p>
            ) : (
              <Facts
                rows={discounts.map((d) => ({
                  label: d.coupon_code ?? d.label ?? "Discount",
                  value: money(-d.amount_minor, inv.currency),
                }))}
              />
            )}
          </RecordCard>
        </Row>
      </Zone>

      <Zone title="Documents">
        <Row span="12">
          <RecordCard id="documents" title="Documents" flush={creditNotes.data.length > 0}>
            <Table phone="stack" fit>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Document</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead phone="aside" className="text-right">
                    Total
                  </TableHead>
                  <TableHead className="pr-5">Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="pl-5">
                    <a data-document-link href={pdfHref} className="text-primary hover:underline">
                      Invoice {order.number ?? order.id}
                    </a>
                  </TableCell>
                  <TableCell>
                    <StatusChip
                      status={order.invoice_status}
                      className="shrink whitespace-normal"
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(total, order.currency)}
                  </TableCell>
                  <TableCell className="pr-5 text-muted-foreground">
                    {fmtDate(order.created_at, tz)}
                  </TableCell>
                </TableRow>
                {creditNotes.data.map((cn) => (
                  <TableRow key={cn.id}>
                    <TableCell className="pl-5">
                      <Link
                        href={`/businesses/${biz}/credit_notes/${cn.id}`}
                        className="text-primary hover:underline"
                      >
                        Credit note {cn.number ?? cn.id}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusChip
                        status={creditNoteChipStatus(cn)}
                        className="shrink whitespace-normal"
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(cn.total_minor, cn.currency)}
                    </TableCell>
                    <TableCell className="pr-5 text-muted-foreground">
                      {fmtDate(cn.created_at, tz)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="px-5 pb-4 text-sm text-muted-foreground">
              <Link
                href={`/businesses/${biz}/receipts?invoice=${order.id}`}
                className="text-primary hover:underline"
              >
                View receipts for this order
              </Link>
            </p>
          </RecordCard>
        </Row>
      </Zone>

      <Zone title="Records">
        <Row span="8/4">
          <ActivityLogCard
            biz={biz}
            resourceType="invoice"
            resourceId={order.id}
            tz={tz}
            layout="card"
            previewRows={5}
          />
          <CommentsCard
            biz={biz}
            resourceType="invoice"
            resourceId={order.id}
            backPath={`/businesses/${biz}/orders/${order.id}`}
            layout="card"
          />
        </Row>
      </Zone>

      <RecordCard id="metadata" title="JSON metadata">
        {metadata ? (
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
            {JSON.stringify(metadata, null, 2)}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">
            No metadata. Metadata holds your own key-value pairs for this order. We store them but
            do not interpret them.
          </p>
        )}
      </RecordCard>
    </div>
  );
}
