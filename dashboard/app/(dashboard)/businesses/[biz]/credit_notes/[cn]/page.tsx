import { billingRules } from "@/lib/billing-rules";
import Link from "next/link";
import { listBusinesses } from "@/lib/api";
import { getCreditNote } from "@/lib/api/credit-notes";
import { invoiceRefundAccount } from "@/lib/api/gateways";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { StatusChip, IdChip } from "@/components/patterns/chip";
import { creditNoteChipStatus } from "@/lib/credit-note-status";
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
import { ErrorState, EmptyState } from "@/components/states";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { ActivityLogCard } from "@/components/activity-log-card";
import { CommentsCard } from "@/components/comments/comments-card";
import { Button } from "@/components/ui/button";
import { FileDown } from "lucide-react";
import { KindBadge, reasonLabel } from "@/components/credit-notes/chips";
import { Badge } from "@/components/ui/badge";
import {
  RefundCreditNoteButton,
  RecordOfflineRefundButton,
  VoidCreditNoteButton,
} from "@/components/credit-notes/credit-note-actions";
import { SendEmailDialog } from "@/components/emails/send-email-dialog";
import { UnconfirmedPayoutAlert } from "@/components/credit-notes/unconfirmed-payout";
import { Alert } from "@/components/ui/alert";
import { ADHOC_TYPES_FOR } from "@/lib/email-types";
import { sendAdhocEmailAction } from "../../emails/actions";

export const dynamic = "force-dynamic";

// Credit-note detail (record-page layout): header with Refund as the primary + More,
// line items | details, Refunds and allocations, Records and a
// Danger zone. Refund (gateway or offline) is offered only for
// refundable notes with unrefunded credit; void only while nothing is
// refunded/allocated.

const OFFLINE_METHOD_LABELS: Record<string, string> = {
  cash: "Cash",
  check: "Check",
  bank_transfer: "Bank transfer",
  other: "Other",
};

// `note.refunds` comes from a query with NO status filter
// (src/modules/credit-notes/service.ts:~1900) — it selects every transaction of
// type `refund`, whatever its TransactionStatus. A binary "was refunded" /
// "refund failed" reported `in_progress`, `timeout`, `needs_attention` and
// `voided` refunds as completed. Phrase and badge tone per status instead —
// "completed" is claimed only for `succeeded`.
function refundStatusPhrase(status: string): React.ReactNode {
  switch (status) {
    case "succeeded":
      return "was refunded";
    case "failed":
    case "late_failed":
      return (
        <>
          refund <span className="font-medium">failed</span>
        </>
      );
    case "voided":
      return "refund was voided";
    case "in_progress":
      return "refund is in progress";
    case "timeout":
      return "refund timed out and its status is not confirmed";
    case "needs_attention":
      return "refund needs attention";
    default:
      return "refund status is unknown";
  }
}

// Label for a `discounts[]` row whose `description` is null — only an imported row
// whose source system said nothing. MIRRORS `DISCOUNT_LABELS` in
// src/modules/credit-notes/document.ts so this page and the PDF name the same row the
// same way; each label states the row's recorded TYPE rather than inventing one.
const CN_DISCOUNT_LABELS: Record<string, string> = {
  promotional_credits: "Promotional Credits Returned",
  excess_payments: "Excess Payments Returned",
  credit_grants: "Credit Grants Returned",
  prorated_credits: "Prorated Credits",
  item_level_coupon: "Discount",
  document_level_coupon: "Discount",
};
export default async function CreditNoteDetail({
  params,
}: {
  params: Promise<{ biz: string; cn: string }>;
}) {
  const { biz, cn: cnId } = await params;
  await requirePermission("credit_notes:view", "ops");

  let businesses, note;
  try {
    [businesses, note] = await Promise.all([listBusinesses(), getCreditNote(biz, cnId)]);
  } catch (e) {
    return (
      <>
        <PageHeader
          title="Credit Note"
          breadcrumbs={[
            { label: "Businesses", href: "/" },
            { label: biz, href: `/businesses/${biz}` },
            { label: "Credit Notes", href: `/businesses/${biz}/credit_notes` },
            { label: "Credit Note" },
          ]}
        />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const business = businesses.data.find((b) => b.id === biz);
  const refundReasonRequired = billingRules(business).required_reasons.refund;
  // Dates render in the business timezone, not UTC — the engine's term
  // boundaries are midnight in this zone (see components/business-tz).
  const tz = businesses.data.find((b) => b.id === biz)?.timezone ?? null;
  const name = business?.name ?? biz;

  if (!note) {
    return (
      <>
        <PageHeader
          title="Credit Note"
          breadcrumbs={[
            { label: "Businesses", href: "/" },
            { label: name, href: `/businesses/${biz}` },
            { label: "Credit Notes", href: `/businesses/${biz}/credit_notes` },
            { label: cnId },
          ]}
        />
        <ErrorState
          title="Credit note not found"
          description={<span className="font-mono text-xs">{cnId}</span>}
        />
      </>
    );
  }

  // The payer row. `note.customer_name` is now resolved server-side through
  // `accountHolderName` (credit-notes/service.ts), so it already IS the account
  // holder — no client-side fetch needed. This page has NO bill-to block — a
  // credit note detail shows no address — so the account holder is the only
  // identity on the screen.
  const holderName = note.customer_name ?? null;

  const voided = note.status === "voided";
  const refundable = note.kind === "refundable";
  const canRefund = refundable && !voided && note.available_minor > 0;
  // A GATEWAY refund additionally needs a charge to reverse. `available_minor > 0`
  // is not enough and the two genuinely diverge: a cancellation credit is issued
  // against RECYCLED refundable credit (cancellation-credit.ts caps at
  // `cashPaid + refundableApplied`), so a note can be fully available while its
  // invoice was settled without a single rupee reaching the provider. Offering the
  // control anyway burned a real session — it earmarked, found no funding payment,
  // reversed itself, and reported "the gateway declined the payout" about a gateway
  // it never called.
  const canRefundViaGateway = canRefund && note.gateway_refundable_minor > 0;
  // Cap the gateway dialog at what the gateway can actually send, not at the note's
  // full availability — a larger request only part-pays and silently un-earmarks
  // the rest.
  const gatewayCapMinor = Math.min(note.available_minor, note.gateway_refundable_minor);
  const refundAccount = canRefundViaGateway ? await invoiceRefundAccount(biz, note.invoice) : null;
  // `status === 'refunded'` does NOT mean the customer was paid: allocateRefundableDraw
  // flips a fully-CONSUMED note to `refunded`. Saying "fully refunded" when
  // refunded_minor is 0 tells the operator money went back when it was actually spent
  // against an invoice.
  const fullyApplied = note.refunded_minor === 0 && note.allocated_minor > 0;
  // Void is forbidden by the backend once any credit is refunded, or (refundable)
  // allocated to invoices. Mirror those guards so the UI only offers what works.
  const canVoid = !voided && note.refunded_minor === 0 && !(refundable && note.allocated_minor > 0);
  const voidBlockedReason = voided
    ? "This credit note is already voided."
    : note.refunded_minor > 0
      ? "You cannot void this credit note. Part of it is already refunded to the customer."
      : refundable && note.allocated_minor > 0
        ? "You cannot void this credit note. Its refundable credit is already applied to invoices."
        : null;

  // ── The totals ladder (0186 phase 4b) ─────────────────────────────────────
  // The identity the PDF prints:
  //
  //     total = sub_total − Σ discounts + tax
  //
  // TAX IS DERIVED, never stored — a credit note has no tax column, so rearranging the
  // identity is the only source of truth. `assembleCreditNoteDocument` derives it the
  // same way from the same three numbers, so the page and the printed memo cannot
  // disagree about a rupee.
  const discountTotalMinor = note.discounts.reduce((s, d) => s + d.amount_minor, 0);
  const taxMinor = note.total_minor - note.subtotal_minor + discountTotalMinor;
  // …and it is NAMED after the components the credited invoice booked — "IGST (18.00%)",
  // the same spelling that invoice prints, so a customer holding both documents does not
  // see two spellings of one tax. The engine does the split (it is the only side that can
  // read the invoice's tax snapshot) and Σ `taxes[].amount_minor` is exactly `taxMinor`,
  // so this renders what the PDF renders rather than re-deriving anything.
  //
  // The flat row is the fallback, not the norm: `taxes` is absent only against an engine
  // predating it, and empty either when the note carries no tax or when the credited
  // invoice recorded no per-line tax — in the latter case the engine sends one unnamed
  // "Tax" row itself, which is why an empty array with a non-zero `taxMinor` cannot
  // happen and the `taxMinor !== 0` arm below is purely the older-engine path.
  const taxRows: Array<{ description: string; amount_minor: number }> =
    note.taxes ?? (taxMinor !== 0 ? [{ description: "Tax", amount_minor: taxMinor }] : []);
  // `subtotal_minor` is never null in the API: the serializer reports `total_minor`
  // when the column is NULL ("gross not recorded; it equals the total"). So the gross
  // is only worth PRINTING when it says something the Total does not — i.e. when a
  // slice went back to a bucket, or the note carries tax. Most notes in the system are
  // in the other state, and a "Subtotal" row identical to "Total" on every one of them
  // is noise, so they keep exactly the ladder this page has always drawn.
  const showGrossLadder = note.discounts.length > 0 || taxRows.length > 0;
  const headlineMinor = note.total_minor > 0 ? note.total_minor : discountTotalMinor;

  const pdfHref = `/businesses/${biz}/credit_notes/${note.id}/pdf`;
  // The header's one primary: the gateway refund when there is a charge to reverse,
  // else the offline refund, else the PDF.
  const primary = canRefundViaGateway ? "gateway" : canRefund ? "offline" : "pdf";
  // Why nothing is refundable, when it is a refundable note — shown under Available.
  const nothingLeft =
    refundable && !voided && !canRefund
      ? fullyApplied
        ? "Fully applied to invoices. Nothing is left to refund."
        : "Fully refunded. Nothing is left to refund."
      : null;

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs
        items={[
          { label: name, href: `/businesses/${biz}` },
          { label: "Credit Notes", href: `/businesses/${biz}/credit_notes` },
          { label: note.number ?? note.id },
        ]}
      />

      <RecordHeader
        title={
          <span className="flex flex-wrap items-baseline gap-2">
            {/* A zero total whose credit went back to a bucket names the credited amount;
                with nothing credited, no amount: "for ₹0.00" is true and useless. */}
            Credit note for{" "}
            {headlineMinor > 0 ? (
              <span className="tabular-nums">{money(headlineMinor, note.currency)}</span>
            ) : null}
            <span className="text-base font-normal text-muted-foreground">{note.currency}</span>
          </span>
        }
        chips={
          <>
            <StatusChip status={creditNoteChipStatus(note)} />
            <KindBadge kind={note.kind} />
          </>
        }
        facts={[
          note.number ? <IdChip key="no" label="№" id={note.number} /> : null,
          <IdChip key="id" id={note.id} />,
          note.customer ? (
            <Link
              key="cus"
              href={`/businesses/${biz}/customers/${note.customer}`}
              className="text-primary hover:underline"
            >
              {holderName ?? note.customer}
            </Link>
          ) : null,
          <Link
            key="inv"
            href={`/businesses/${biz}/invoices/${note.invoice}`}
            className="font-mono text-xs text-primary hover:underline"
          >
            {note.invoice}
          </Link>,
        ]}
        actions={
          <>
            {primary === "gateway" ? (
              <RefundCreditNoteButton
                biz={biz}
                cn={note.id}
                availableMinor={gatewayCapMinor}
                gatewayAccount={refundAccount}
                currency={note.currency}
                trigger="primary"
                label="Refund credit note"
                reasonRequired={refundReasonRequired}
              />
            ) : primary === "offline" ? (
              <RecordOfflineRefundButton
                biz={biz}
                cn={note.id}
                availableMinor={note.available_minor}
                currency={note.currency}
                trigger="primary"
                reasonRequired={refundReasonRequired}
              />
            ) : (
              <Button asChild>
                <a href={pdfHref}>
                  <FileDown className="size-4" /> Download PDF
                </a>
              </Button>
            )}
            <MoreMenu>
              <MoreSection heading="Credit note actions">
                <RailLink href={`/businesses/${biz}/invoices/${note.invoice}`}>
                  View invoice
                </RailLink>
                {primary === "gateway" ? (
                  <RecordOfflineRefundButton
                    biz={biz}
                    cn={note.id}
                    availableMinor={note.available_minor}
                    currency={note.currency}
                    reasonRequired={refundReasonRequired}
                  />
                ) : null}
                {/* Per-record email; needs an address to prefill or the send fails. */}
                {note.customer_email ? (
                  <SendEmailDialog
                    types={ADHOC_TYPES_FOR.credit_note}
                    defaultTo={note.customer_email}
                    recordLabel={`Credit note ${note.number ?? note.id}`}
                    onSend={async ({ type, to, note: message }) => {
                      "use server";
                      return sendAdhocEmailAction(biz, {
                        type,
                        credit_note: note.id,
                        to,
                        note: message || undefined,
                      });
                    }}
                    trigger={<button type="button">Send email</button>}
                  />
                ) : null}
                {primary !== "pdf" ? <a href={pdfHref}>Download PDF</a> : null}
                {primary === "offline" ? (
                  <span className="px-2.5 py-1.5 text-xs text-muted-foreground">
                    No gateway refund is available. The invoice of this note has no payment left to
                    reverse. Use an offline refund to return this credit to the customer.
                  </span>
                ) : null}
              </MoreSection>
            </MoreMenu>
          </>
        }
      />

      {(note.payout_unconfirmed_minor ?? 0) > 0 ? (
        <UnconfirmedPayoutAlert
          biz={biz}
          cn={note.id}
          amount={money(note.payout_unconfirmed_minor ?? 0, note.currency)}
        />
      ) : null}
      {(note.payout_duplicated_minor ?? 0) > 0 ? (
        <Alert
          tone="error"
          title={`The customer got ${money(note.payout_duplicated_minor ?? 0, note.currency)} twice`}
        >
          We returned a refund as credit, and then the payment gateway confirmed that the refund was
          paid. The customer has this amount as money and as credit. We did not remove the credit.
          Contact the customer, then correct the credit by hand.
        </Alert>
      ) : null}
      {(note.payout_out_of_order_minor ?? 0) > 0 ? (
        <Alert
          tone="warning"
          title={`The payment gateway reported a refund of ${money(note.payout_out_of_order_minor ?? 0, note.currency)} failed, then paid`}
        >
          The gateway sent its answers out of order. We returned the amount as credit when the
          refund failed, and then recorded the refund as paid. Check the refund at the gateway. If
          the customer received the money, correct the credit by hand.
        </Alert>
      ) : null}

      <Zone title="Credit note">
        <Row span="8/4">
          <RecordCard id="lines" title="Line items" flush>
            <>
              {note.items.length === 0 ? (
                <EmptyState title="No line items" />
              ) : (
                <Table className="table-fixed max-lg:min-w-0">
                  <colgroup>
                    <col />
                    <col className="w-40" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-5">Line item</TableHead>
                      <TableHead className="pr-5 text-right">Amount ({note.currency})</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {note.items.map((it) => (
                      <TableRow key={it.id}>
                        <TableCell className="pl-5 whitespace-normal">
                          <div className="text-sm font-medium wrap-anywhere">{it.description}</div>
                          {/* Service period credited, inherited from the invoice line. */}
                          {it.period_start ? (
                            <div className="text-xs text-muted-foreground">
                              {fmtDate(it.period_start, tz)} – {fmtDate(it.period_end, tz)}
                            </div>
                          ) : null}
                          <div className="font-mono text-xs text-muted-foreground">{it.id}</div>
                        </TableCell>
                        <TableCell className="pr-5 text-right font-medium tabular-nums">
                          {money(it.amount_minor, note.currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {/* The PDF's ladder, in its order: gross, bucket returns, tax, Total, then
                    what was drawn against it and what remains. The top rows only on a note
                    that records a gross of its own (`showGrossLadder`). */}
              <div className="ml-auto max-w-xs space-y-1 px-5 py-4 text-sm">
                {showGrossLadder ? (
                  <>
                    <div className="flex justify-between gap-8">
                      <span className="text-muted-foreground">Subtotal</span>
                      <span className="tabular-nums">
                        {money(note.subtotal_minor, note.currency)}
                      </span>
                    </div>
                    {/* Each row names itself — a note may carry several types. */}
                    {note.discounts.map((d, i) => (
                      <div key={`${d.type}-${i}`} className="flex justify-between gap-8">
                        <span className="text-muted-foreground">
                          {d.description || CN_DISCOUNT_LABELS[d.type] || "Discount"}
                        </span>
                        <span className="tabular-nums">
                          −{money(d.amount_minor, note.currency)}
                        </span>
                      </div>
                    ))}
                    {/* One row per tax component, named as the credited invoice names it. */}
                    {taxRows.map((t, i) => (
                      <div key={`${t.description}-${i}`} className="flex justify-between gap-8">
                        <span className="text-muted-foreground">{t.description}</span>
                        <span className="tabular-nums">{money(t.amount_minor, note.currency)}</span>
                      </div>
                    ))}
                  </>
                ) : null}
                <div className="flex justify-between gap-8 border-t pt-1 font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">{money(note.total_minor, note.currency)}</span>
                </div>
                {note.allocated_minor > 0 ? (
                  <div className="flex justify-between gap-8">
                    <span className="text-muted-foreground">Allocations</span>
                    <span className="tabular-nums">
                      −{money(note.allocated_minor, note.currency)}
                    </span>
                  </div>
                ) : null}
                {note.refunded_minor > 0 ? (
                  <div className="flex justify-between gap-8">
                    <span className="text-muted-foreground">Refunded</span>
                    <span className="tabular-nums">
                      −{money(note.refunded_minor, note.currency)}
                    </span>
                  </div>
                ) : null}
                <div className="flex justify-between gap-8 border-t pt-1 font-semibold">
                  <span>Amount Available ({note.currency})</span>
                  <span className="tabular-nums">{money(note.available_minor, note.currency)}</span>
                </div>
                {nothingLeft ? (
                  <p className="text-xs text-muted-foreground">{nothingLeft}</p>
                ) : null}
              </div>
            </>
          </RecordCard>

          <RecordCard id="details" title="Details">
            <Facts
              rows={[
                { label: "Status", value: <StatusChip status={creditNoteChipStatus(note)} /> },
                { label: "Type", value: <KindBadge kind={note.kind} /> },
                {
                  label: "Customer",
                  // Lead with the customer: the invoice alone gives no way to the payer.
                  value: note.customer ? (
                    <Link
                      href={`/businesses/${biz}/customers/${note.customer}`}
                      className="text-primary hover:underline"
                    >
                      <span className="block">{holderName ?? note.customer}</span>
                      {holderName ? (
                        <span className="block font-mono text-xs text-muted-foreground">
                          {note.customer}
                        </span>
                      ) : null}
                    </Link>
                  ) : (
                    "—"
                  ),
                },
                {
                  label: "Invoice",
                  value: (
                    <Link
                      href={`/businesses/${biz}/invoices/${note.invoice}`}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {note.invoice}
                    </Link>
                  ),
                },
                { label: "Reason", value: reasonLabel(note.reason_code) },
                note.reason ? { label: "Note", value: note.reason } : null,
                { label: "Created", value: fmtDateTime(note.created_at, tz) },
                note.voided_at
                  ? { label: "Voided at", value: fmtDateTime(note.voided_at, tz) }
                  : null,
                note.channel
                  ? { label: "Channel", value: <span className="capitalize">{note.channel}</span> }
                  : null,
              ]}
            />
          </RecordCard>
        </Row>

        {/* Gateway payouts, offline refunds and invoice allocations. */}
        <Row span="12">
          <RecordCard id="refunds" title="Refunds and allocations">
            {note.refunds.length === 0 && note.allocations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No refunds or invoice allocations yet.
              </p>
            ) : (
              <ul className="space-y-3">
                {note.refunds.map((r) => (
                  <li key={r.transaction} className="flex flex-wrap items-center gap-2 text-sm">
                    <StatusChip status={r.status} />
                    <span className="min-w-0 flex-1 wrap-anywhere">
                      <span className="font-medium tabular-nums">
                        {money(r.amount_minor, r.currency)}
                      </span>{" "}
                      {refundStatusPhrase(r.status)}{" "}
                      {r.offline ? (
                        <>
                          offline via{" "}
                          <span className="font-medium">
                            {OFFLINE_METHOD_LABELS[r.method ?? "other"] ?? r.method}
                          </span>
                          {r.reference ? (
                            <>
                              {" "}
                              (ref <span className="font-mono text-xs">{r.reference}</span>)
                            </>
                          ) : null}
                        </>
                      ) : (
                        <>
                          via{" "}
                          <span className="font-medium capitalize">
                            {r.gateway_key ?? "gateway"}
                          </span>
                          {r.id_at_gateway ? (
                            <>
                              {" "}
                              (<span className="font-mono text-xs">{r.id_at_gateway}</span>)
                            </>
                          ) : null}
                        </>
                      )}{" "}
                      on {fmtDateTime(r.occurred_at, tz)}
                      {" — "}
                      <Link
                        href={`/businesses/${biz}/transactions/${r.transaction}`}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {r.transaction}
                      </Link>
                      {(r.status === "failed" || r.status === "late_failed") && r.error_text ? (
                        <span className="block text-xs text-destructive">
                          <span className="block">{r.error_text}</span>
                          <span className="block">
                            We returned the amount to the available balance of this credit note.
                          </span>
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
                {note.allocations.map((a, i) => (
                  <li
                    key={`${a.invoice}-${i}`}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <Badge variant="secondary" className="uppercase">
                      Allocated
                    </Badge>
                    <span className="min-w-0 flex-1 wrap-anywhere">
                      <span className="font-medium tabular-nums">
                        {money(a.amount_minor, note.currency)}
                      </span>{" "}
                      was allocated to invoice{" "}
                      <Link
                        href={`/businesses/${biz}/invoices/${a.invoice}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {a.invoice}
                      </Link>{" "}
                      on {fmtDateTime(a.allocated_at, tz)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </RecordCard>
        </Row>
      </Zone>

      <Zone title="Records">
        <Row span="8/4">
          <ActivityLogCard
            biz={biz}
            resourceType="credit_note"
            resourceId={note.id}
            tz={tz}
            layout="card"
            previewRows={5}
          />
          <CommentsCard
            biz={biz}
            resourceType="credit_note"
            resourceId={note.id}
            backPath={`/businesses/${biz}/credit_notes/${note.id}`}
            layout="card"
          />
        </Row>
      </Zone>

      <section
        id="danger"
        className="mt-4 flex flex-col gap-3 rounded-xl border border-destructive/30 bg-card px-5 py-4 sm:flex-row sm:items-center"
      >
        <div className="flex-1">
          <p className="text-sm font-semibold text-destructive">Danger zone · Void credit note</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {canVoid
              ? note.kind === "adjustment"
                ? "Voids the note and reopens the invoice that it reduced. You cannot undo this."
                : "Voids the note and removes the refundable credit that it gave. You cannot undo this."
              : voidBlockedReason}
          </p>
        </div>
        {canVoid ? (
          <VoidCreditNoteButton
            biz={biz}
            cn={note.id}
            kind={note.kind}
            trigger="danger"
            label="Void"
          />
        ) : null}
      </section>
    </div>
  );
}
