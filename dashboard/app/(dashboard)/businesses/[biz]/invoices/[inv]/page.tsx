import { invoiceRefundAccount } from "@/lib/api/gateways";
import { VoidInvoiceDialog } from "@/components/invoices/void-invoice-dialog";
import { billingRules, shortfallWriteOffLimit } from "@/lib/billing-rules";
import { RecordVisit } from "@/components/record-visit";
import {
  listBusinesses,
  getInvoice,
  getDunningJourney,
  listCreditNotes,
  getSubscription,
  getCustomer,
  listPaymentMethods,
  money,
  fmtDate,
  fmtDateTime,
} from "@/lib/api";
import { invoiceContactName } from "@/lib/names";
import Link from "next/link";
import { invoiceOpAction, recordOfflinePaymentAction } from "@/app/actions";
import {
  invoiceCapabilities,
  newCreditNoteHref,
  splitInvoiceLines,
  addressLines,
  addressName,
  type InvoiceDetail as InvoiceDetailType,
} from "@/lib/api/invoices";
import { fetchPaymentsAndCredits } from "@/components/invoices/payments-and-credits";
import { LatePaymentNotice } from "@/components/invoices/late-payment-notice";
import {
  InvoiceVolatileProvider,
  InvoiceRefreshButton,
  InvoiceStatusChips,
  InvoiceAmountDueValue,
  InvoiceAmountLadderTail,
  InvoiceAttention,
  PaymentsAndCreditsClient,
} from "./invoice-refresh-panel";
import { computeAmounts } from "./invoice-volatile";
import type { InvoiceVolatileData } from "./refresh-action";
import {
  CreateCreditNoteDialog,
  IssueRefundDialog,
  RecordInvoiceOfflineRefundDialog,
  RecordInvoiceOfflinePaymentDialog,
} from "@/components/invoices/invoice-credit-actions";
import { invoiceCreditableMinor } from "@/lib/credit-allocation";
import { ActivityLogCard } from "@/components/activity-log-card";
import { CommentsCard } from "@/components/comments/comments-card";
import {
  UpdatePoNumberButton,
  SetExpectedPaymentDateButton,
  UpdateAddressButton,
} from "@/components/invoices/invoice-operator-fields";
import {
  CloseInvoiceButton,
  RegenerateInvoiceButton,
  StopDunningButton,
  PauseDunningButton,
} from "@/components/invoices/invoice-lifecycle-actions";
import { requirePermission, allows } from "@/lib/session";
import { CollectInvoiceDialog } from "@/components/invoices/collect-invoice-dialog";
import { Chip, StatusChip, IdChip } from "@/components/patterns/chip";
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
import { Paged, PagedItems, PagedFooter } from "@/components/patterns/pager";
import { SendEmailDialog } from "@/components/emails/send-email-dialog";
import { ADHOC_TYPES_FOR } from "@/lib/email-types";
import { sendAdhocEmailAction } from "../../emails/actions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/action-button";
import { ErrorState, EmptyState } from "@/components/states";
import { FileDown } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { TREATMENT_SHORT } from "@/lib/tax-format";
import { lineQuantity, lineUnitPrice } from "@/lib/meters";
import { PriceSourcePopover } from "@/components/invoices/price-source-popover";
import { ratingRows } from "@/lib/usage-aggregation";

export const dynamic = "force-dynamic";

// Invoice detail (record-page layout): header with Download PDF + More, Needs
// attention (state + next step + dunning stepper), then Invoice,
// Payments and Records zones and a Danger zone. Every op is offered
// only when legal for the invoice's status (`invoiceCapabilities` mirrors the
// backend guards in src/modules/invoicing/{ops,pending}.ts + dunning.ts):
//   pending     → Close (finalize; usage keeps accruing until then)
//   open        → Collect, Record payment, Void, Write off, Credit note
//   payment_due → + Retry now, Stop dunning, Pause dunning
//   voided      → Regenerate (subscription invoices only)
//   paid        → Credit note (archival imported invoices: Credit note only)
export default async function InvoiceDetail({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string; inv: string }>;
  searchParams: Promise<{ error?: string; msg?: string }>;
}) {
  const { biz, inv: invId } = await params;
  const { error, msg } = await searchParams;
  const user = await requirePermission("invoices:view", "ops");
  const isManager = allows(user, "invoices:void", "manager");
  const canSeeCost = allows(user, "usage_margin:view", "manager");

  let businesses, inv: InvoiceDetailType, creditNotes;
  try {
    inv = await getInvoice(biz, invId);
    [businesses, creditNotes] = await Promise.all([listBusinesses(), listCreditNotes(biz, invId)]);
  } catch (e) {
    return (
      <ErrorState
        title="We could not load the invoice"
        description={<span className="font-mono text-xs">{(e as Error).message}</span>}
      />
    );
  }

  // Next Billing Date comes from the subscription's current term end. Best-effort:
  // a manual invoice has no subscription, and a failed lookup must not take the
  // invoice page down.
  const sub = inv.subscription
    ? await getSubscription(biz, inv.subscription).catch(() => null)
    : null;

  // Payments-and-credits, fetched here (not inside the card) so it can seed the
  // Refresh control's client state — see invoice-refresh-panel.tsx.
  const payments = await fetchPaymentsAndCredits(biz, inv.id);
  // Best-effort: a failed journey lookup must not take the invoice page down.
  const journey = await getDunningJourney(biz, inv.id).catch(() => null);
  // Money that can still land after a void: a pending debit, or a checkout still open.
  const voidRacesPayment =
    Boolean(inv.payment_in_flight) || (payments?.openIntents.length ?? 0) > 0;

  /**
   * `inv.customer_name` is now resolved server-side through `accountHolderName`
   * (invoicing/serialize.ts), so the account-holder label below no longer needs a
   * client-side fetch — unlike its siblings on the credit-note and transaction
   * detail pages, THIS fetch still earns its place: `billedToName` (below) needs
   * the customer row's BILLING contact as the fallback for a `billing_address`
   * SNAPSHOT that has street lines but no contact of its own (verified against
   * `customerBillingAddress` in src/modules/invoicing/serialize.ts — a
   * non-snapshot address is fallback-applied through `billingContact` and so
   * never needs this; a snapshot's contact is stored raw and can be empty).
   * `customer_name` cannot serve that fallback — it is the account holder, and
   * the bill-to must mirror `billToName` in src/modules/invoicing/document.ts
   * (what the PDF prints), which prefers the billing contact. A deleted or
   * unreadable customer must not take the invoice page down.
   */
  const customer = inv.customer ? await getCustomer(biz, inv.customer).catch(() => null) : null;
  // The cards "Collect payment" can choose from; best-effort, like the customer read.
  const collectPms = inv.customer
    ? (await listPaymentMethods(biz, inv.customer).catch(() => ({ data: [] }))).data
    : [];
  // The card collection tries first: the subscription's own, else the primary.
  const collectFirst =
    (sub?.default_payment_method
      ? collectPms.find((p) => p.id === sub.default_payment_method)
      : undefined) ?? null;
  /** Who this invoice's ACCOUNT is — never the billing contact. */
  const holderName = inv.customer_name ?? null;
  /**
   * The BILL-TO name, resolved exactly as `billToName` in src/modules/invoicing/document.ts
   * resolves it for the PDF: the document's own billing-address contact, and only when
   * that address carries no contact at all does the customer answer. Correct for both
   * shapes the serializer can hand us — when `billing_address_is_snapshot` is false the
   * address IS the customer's, and `addressName(addr) ?? invoiceContactName(customer)`
   * collapses to `invoiceContactName(customer)`, its first two steps being the same.
   */
  const billedToName =
    addressName(inv.billing_address) ?? (customer ? invoiceContactName(customer) : null);

  const name = businesses.data.find((b) => b.id === biz)?.name ?? "Business";
  // Dates render in the business timezone, not UTC — the engine's term
  // boundaries are midnight in this zone (see components/business-tz).
  const tz = businesses.data.find((b) => b.id === biz)?.timezone ?? null;
  const bizRules = billingRules(businesses.data.find((b) => b.id === biz));
  const requiredReasons = bizRules.required_reasons;
  // A short offline payment within this is written off by the business rule.
  const writeOffLimitMinor = shortfallWriteOffLimit(bizRules, inv);
  // The refund dialogs create a credit note first, so they need its reason code too.
  const refundReasons = {
    code: requiredReasons.create_credit_note,
    note: requiredReasons.refund,
  };
  const caps = invoiceCapabilities(inv);
  const pdfHref = `/businesses/${biz}/invoices/${inv.id}/pdf`;
  // `print=1` = the "View / print" tab: the invoice on a paper sheet with the
  // browser print dialog already open. Same document as the plain HTML view.
  const htmlHref = `/businesses/${biz}/invoices/${inv.id}/html?print=1`;
  // Cash collected comes from the serializer's `amount_paid_minor` (the sum of
  // succeeded payments), NEVER from the status: deriving it as
  // `status === 'paid' ? total : 0` hid every PARTIAL payment, so an invoice with
  // some money against it showed no "Amount paid" row and Total/Amount due did
  // not reconcile on screen. (Shared with the Refresh panel via computeAmounts.)
  const { amountDue, amountPaid } = computeAmounts(inv, caps.open);
  // Initial state for the Refresh control — status/amounts/dunning fields plus
  // the payments-and-credits lists fetched above.
  const initialVolatile: InvoiceVolatileData = {
    status: inv.status,
    written_off: Boolean(inv.written_off),
    paid_at: inv.paid_at ?? null,
    next_attempt_at: inv.next_attempt_at ?? null,
    dunning_status: inv.dunning_status ?? null,
    attempt_count: inv.attempt_count ?? 0,
    dunning_period_ends_at: inv.dunning_period_ends_at ?? null,
    payment_in_flight: Boolean(inv.payment_in_flight),
    awaiting_authentication: Boolean(inv.awaiting_authentication),
    amount_due_minor: inv.amount_due_minor ?? null,
    amount_paid_minor: inv.amount_paid_minor ?? null,
    total_minor: inv.total_minor,
    credits_applied_minor: inv.credits_applied_minor ?? null,
    withholding_minor: inv.withholding_minor ?? null,
    currency: inv.currency,
    transactions: payments?.transactions ?? [],
    openIntents: payments?.openIntents ?? [],
    paymentsUnavailable: payments == null,
    journey,
  };
  // POST-tax buckets only (refundable + excess). The promotional bucket is applied
  // pre-tax and is already netted out of `total_minor`, so it renders as a discount row
  // ABOVE the Total instead — see the ladder below. (credits_applied_minor itself now
  // renders via <InvoiceAmountLadderTail>, refreshed with the rest of the volatile state.)
  const promotionalDiscount = inv.promotional_discount_minor ?? 0;
  // Tax / discount / round-off are synthetic lines: they become named totals rows
  // rather than item rows (see splitInvoiceLines).
  const { items, adjustments, hasLineDiscounts } = splitInvoiceLines(inv.lines);
  // Tax inside tax-inclusive lines: on the invoice but not a line of its own.
  const includedTax =
    (inv.tax_minor ?? 0) -
    (inv.lines ?? []).filter((l) => l.kind === "tax").reduce((s, l) => s + l.amount_minor, 0);
  /**
   * The "Discount details" block — the only place an invoice says WHICH coupon
   * discounted it, and the answer to "discount from coupon is not clear here".
   *
   * The Amount column nets the item-level stage and the ladder carries the document-level
   * one, so between them every rupee is accounted for — but neither names its cause. An
   * item-level coupon was the worst case: netted into a line and into `subtotal_minor`,
   * with its code recorded in `invoice_line_discounts.label` and printed nowhere.
   *
   * All three sources land here, because all three are things an operator has to explain
   * to a customer: a catalog COUPON, a hand-entered MANUAL discount (which reaches the
   * invoice as a document-level `applied_coupons` row with no coupon behind it), and the
   * customer's own PROMOTIONAL CREDITS. `source` is what separates them — `label` cannot,
   * since the engine's default invoice name for a manual discount is the word "Discount".
   */
  const lineNumberOf = new Map(items.map((l, i) => [l.id, i + 1]));
  const discountDetails = (inv.discounts ?? []).map((d) => {
    const lineNos = (d.line_item_ids ?? [])
      .map((id) => lineNumberOf.get(id))
      .filter((n): n is number => n != null)
      .sort((x, y) => x - y);
    // The EFFECTIVE percentage, against what those lines actually cost before this
    // discount — not the coupon's configured percent once a fixed-amount coupon or a
    // second coupon in the waterfall is involved.
    const base = items
      .filter((l) => (d.line_item_ids ?? []).includes(l.id))
      .reduce((sum, l) => sum + l.amount_minor, 0);
    return {
      ...d,
      lineNos,
      percent: base > 0 ? (d.amount_minor / base) * 100 : null,
    };
  });
  // ── WHAT "STILL HAS MONEY ON IT" ACTUALLY IS (corrected 2026-08-31) ─────────────
  // This read `status === 'refund_due'` and drove both a warning banner claiming a card
  // refund "is pending or failed and will be retried" and a rail link reading "Finish
  // refund on cn_…". Neither was true: `refund_due` is the BIRTH status of every
  // refundable credit note (`credit-notes/service.ts`: `status: total > 0n ? 'refund_due'
  // : 'refunded'`) and it means "credits yet to be used, or partially used". It
  // carries no information about a payout.
  //
  // Reported from a real invoice whose note page simultaneously and correctly said "No
  // gateway refund available — this note's invoice has no payment left to reverse":
  // `payout_attempt_at` NULL, refunded 0, paid out 0, and no credit note in the database
  // has ever had a payout attempt. The banner is DELETED rather than reworded — the Credit
  // notes section on this same page already lists the note, its status and its amount, and
  // the note's own page explains the payout situation properly. A third telling of it,
  // in a warning tone, is what trains people to ignore banners.
  //
  // The rail link stays, because "there is credit here you can pay out" is a real action —
  // but keyed on `available_minor`, which is what actually means money is left
  // (`total − allocated − refunded`), and scoped to `refundable`: an `adjustment` note
  // reduced an invoice and can never be paid out. Its destination decides gateway vs
  // offline, so the label must not promise either.
  const refundableCn =
    creditNotes.data.find((cn) => cn.kind === "refundable" && cn.available_minor > 0) ?? null;
  // What is still creditable against this invoice — the prefill rule for all three
  // credit/refund dialogs: the invoice total less the credit notes raised against
  // THIS invoice. Notes booked against other invoices in the same cycle do not
  // reduce it.
  // `total_minor` is NET of the promotional slice, which tightens this cap on a
  // promo-funded invoice — correctly: the engine credits against the TAXED gross
  // (`credit-notes/service.ts`, `taxedGross = total − promo`) and refunds against cash,
  // so the promotional slice was never creditable and the old prefill over-offered it.
  const creditableMinor = invoiceCreditableMinor(inv, creditNotes.data);
  // Refunding needs cash to have actually been collected — reuse `amountPaid` above
  // rather than re-reading the field, so a PARTIAL payment counts here too. This is
  // the honest gate the page can compute; the exact cap
  // (paid − refunded − outstanding refundable credit) is the engine's, and it reports
  // the precise figure when it is lower than what the dialog offered.
  // Archival invoices still take a credit note — a cancellation refund on an imported
  // invoice has nowhere else to go. Cash refunds stay off: those payments came from the
  // source system.
  const canCreditNote = isManager && creditableMinor > 0;
  const canRefundCash = canCreditNote && !caps.archival && amountPaid > 0;
  const refundAccount = canRefundCash ? await invoiceRefundAccount(biz, inv.id) : null;
  const anyAction =
    caps.canClose ||
    caps.canCollect ||
    caps.canRecordPayment ||
    caps.canVoid ||
    caps.canWriteOff ||
    caps.canRegenerate ||
    caps.canStopDunning ||
    caps.canPauseDunning ||
    // Crediting and refunding are real actions on a settled invoice — without these
    // the rail rendered three working dialogs beside "no further lifecycle actions".
    canCreditNote ||
    canRefundCash ||
    !!refundableCn;

  const collectInvoice = {
    id: inv.id,
    number: inv.number ?? null,
    created_at: inv.created_at ?? null,
    due_date: inv.due_date ?? null,
    currency: inv.currency,
  };

  // While money is owed the payments card leads: it is what the invoice needs next.
  const owedNow = inv.status === "payment_due" || inv.status === "not_paid";
  const paymentsZone = (
    <Zone title="Payments">
      <Row span="12">
        {/* The invoice's money and dunning history. */}
        <PaymentsAndCreditsClient
          biz={biz}
          tz={tz}
          open={caps.open}
          currency={inv.currency}
          dunningActions={
            caps.canPauseDunning || caps.canStopDunning ? (
              <>
                {caps.canPauseDunning ? (
                  <PauseDunningButton biz={biz} inv={inv.id} variant="button" />
                ) : null}
                {caps.canStopDunning ? (
                  <StopDunningButton biz={biz} inv={inv.id} variant="button" />
                ) : null}
              </>
            ) : undefined
          }
        />
      </Row>

      <Row span="12">
        <RecordCard
          id="credit-notes"
          title="Credit notes"
          flush={creditNotes.data.length > 0}
          actions={
            isManager && (!caps.archival || canCreditNote) ? (
              <Link href={newCreditNoteHref(biz, inv.id)} className="text-primary hover:underline">
                Create credit note
              </Link>
            ) : null
          }
        >
          {creditNotes.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No credit notes against this invoice.</p>
          ) : (
            <Paged
              size={10}
              items={creditNotes.data.map((cn) => (
                <TableRow key={cn.id}>
                  <TableCell className="pl-5">
                    <Link
                      href={`/businesses/${biz}/credit_notes/${cn.id}`}
                      className="font-mono text-xs wrap-anywhere text-primary hover:underline"
                    >
                      {cn.id}
                    </Link>
                  </TableCell>
                  <TableCell className="capitalize">{cn.credit_method}</TableCell>
                  <TableCell>
                    <StatusChip status={creditNoteChipStatus(cn)} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(cn.total_minor, cn.currency)}
                  </TableCell>
                  <TableCell
                    className="truncate text-muted-foreground"
                    title={cn.reason ?? undefined}
                  >
                    {cn.reason ?? "—"}
                  </TableCell>
                  <TableCell className="pr-5 text-muted-foreground">
                    {fmtDate(cn.created_at, tz)}
                  </TableCell>
                </TableRow>
              ))}
            >
              <Table className="table-fixed max-lg:min-w-2xl">
                <colgroup>
                  {/* At the 672px floor a status chip and a date still fit whole. */}
                  <col className="w-[20%]" />
                  <col className="w-[12%]" />
                  <col className="w-[16%]" />
                  <col className="w-[15%]" />
                  <col />
                  <col className="w-[21%]" />
                </colgroup>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">ID</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="pr-5">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <PagedItems />
                </TableBody>
              </Table>
              <PagedFooter />
            </Paged>
          )}
        </RecordCard>
      </Row>
    </Zone>
  );

  return (
    <InvoiceVolatileProvider biz={biz} invId={inv.id} initial={initialVolatile}>
      <div className="flex flex-col gap-4">
        <RecordVisit
          biz={biz}
          kind="invoice"
          id={inv.id}
          label={inv.number ?? inv.id}
          detail={holderName ?? inv.customer ?? ""}
        />
        <RecordCrumbs
          items={[
            { label: name, href: `/businesses/${biz}` },
            { label: "Invoices", href: `/businesses/${biz}/invoices` },
            { label: inv.number ?? inv.id },
          ]}
          right={<InvoiceRefreshButton />}
        />

        <RecordHeader
          title={
            <span className="flex flex-wrap items-baseline gap-2">
              Invoice for{" "}
              <span className="tabular-nums">{money(inv.total_minor, inv.currency)}</span>
              <span className="text-base font-normal text-muted-foreground">{inv.currency}</span>
            </span>
          }
          chips={
            <>
              <InvoiceStatusChips archival={caps.archival} />
              {inv.purpose === "usage_interim" ? (
                <Chip tone="blue">Interim usage invoice</Chip>
              ) : null}
            </>
          }
          facts={[
            inv.number ? <IdChip key="no" label="№" id={inv.number} /> : null,
            <IdChip key="id" id={inv.id} />,
            // The ACCOUNT HOLDER, not the bill-to contact (that is the Addresses card).
            inv.customer ? (
              <Link
                key="cus"
                href={`/businesses/${biz}/customers/${inv.customer}`}
                className="text-primary hover:underline"
              >
                {holderName ?? inv.customer}
              </Link>
            ) : null,
          ]}
          actions={
            <>
              <Button asChild>
                <a href={pdfHref}>
                  <FileDown className="size-4" /> Download PDF
                </a>
              </Button>
              <MoreMenu>
                <MoreSection heading="Invoice actions">
                  <a href={htmlHref} target="_blank" rel="noopener noreferrer">
                    View / print
                  </a>
                  <RailLink href={`/businesses/${biz}/receipts?invoice=${inv.id}`}>
                    View receipts
                  </RailLink>
                  {caps.canClose ? <CloseInvoiceButton biz={biz} inv={inv.id} /> : null}
                  {caps.canRetry ? (
                    <ActionButton
                      resultAction={invoiceOpAction}
                      fields={{ biz, inv: inv.id, op: "retry" }}
                      label="Retry now"
                      variant="link"
                      size="sm"
                    />
                  ) : null}
                  {caps.canRegenerate ? <RegenerateInvoiceButton biz={biz} inv={inv.id} /> : null}
                  {/* Offered only with an address to prefill; without one the send fails. */}
                  {inv.customer_email ? (
                    <SendEmailDialog
                      types={ADHOC_TYPES_FOR.invoice}
                      defaultTo={inv.customer_email}
                      recordLabel={`Invoice ${inv.number ?? inv.id}`}
                      onSend={async ({ type, to, note }) => {
                        "use server";
                        return sendAdhocEmailAction(biz, {
                          type,
                          invoice: inv.id,
                          to,
                          note: note || undefined,
                        });
                      }}
                      trigger={<button type="button">Send email</button>}
                    />
                  ) : null}
                  {/* Operator fields are legal in ANY status; only archival rows are read-only. */}
                  {!caps.archival ? (
                    <>
                      <UpdatePoNumberButton
                        biz={biz}
                        inv={inv.id}
                        current={inv.po_number ?? null}
                      />
                      <UpdateAddressButton
                        biz={biz}
                        inv={inv.id}
                        billing={inv.billing_address ?? null}
                        shipping={inv.shipping_address ?? null}
                      />
                      {caps.open ? (
                        <SetExpectedPaymentDateButton
                          biz={biz}
                          inv={inv.id}
                          current={inv.expected_payment_date ?? null}
                        />
                      ) : null}
                    </>
                  ) : null}
                  {!anyAction ? (
                    <span className="px-2.5 py-1.5 text-xs text-muted-foreground">
                      {caps.archival
                        ? "Archival record. Lifecycle actions are disabled."
                        : `This invoice is ${inv.status.replace(/_/g, " ")}. No more lifecycle actions are available.`}
                    </span>
                  ) : null}
                </MoreSection>
                {caps.canRecordPayment || canCreditNote || refundableCn ? (
                  <MoreSection heading="Payment and credit">
                    {/* Not due yet, so no attention card — early payment stays reachable here. */}
                    {inv.status === "posted" && caps.canCollect ? (
                      <CollectInvoiceDialog
                        biz={biz}
                        invoice={{
                          id: inv.id,
                          number: inv.number ?? null,
                          dueMinor: amountDue,
                          currency: inv.currency,
                        }}
                        pms={collectPms}
                        firstTried={collectFirst}
                        trigger="link"
                      />
                    ) : null}
                    {caps.canRecordPayment ? (
                      <>
                        <RecordInvoiceOfflinePaymentDialog
                          biz={biz}
                          invoice={inv.id}
                          dueMinor={amountDue}
                          currency={inv.currency}
                          writeOffLimitMinor={writeOffLimitMinor}
                        />
                        <ActionButton
                          resultAction={recordOfflinePaymentAction}
                          fields={{ biz, inv: inv.id }}
                          label="Mark paid (full)"
                          variant="link"
                          size="sm"
                          confirm={{
                            title: "Mark invoice paid?",
                            description: "We record full payment offline. We do not charge a card.",
                            confirmLabel: "Mark paid",
                          }}
                        />
                      </>
                    ) : null}
                    {/* `creditable` is the prefill rule; the tighter refundable-CASH cap is
                        the engine's and its message comes back through the dialog. */}
                    {canCreditNote ? (
                      <>
                        <CreateCreditNoteDialog
                          biz={biz}
                          invoice={inv.id}
                          creditableMinor={creditableMinor}
                          currency={inv.currency}
                          advancedHref={newCreditNoteHref(biz, inv.id)}
                          defaultKind={
                            amountPaid > 0 || inv.status === "paid" ? "refundable" : "adjustment"
                          }
                          requiredReasons={{ code: requiredReasons.create_credit_note }}
                        />
                        {canRefundCash ? (
                          <>
                            <RecordInvoiceOfflineRefundDialog
                              biz={biz}
                              invoice={inv.id}
                              refundableMinor={creditableMinor}
                              currency={inv.currency}
                              requiredReasons={refundReasons}
                            />
                            <IssueRefundDialog
                              biz={biz}
                              gatewayAccount={refundAccount}
                              invoice={inv.id}
                              refundableMinor={creditableMinor}
                              currency={inv.currency}
                              requiredReasons={refundReasons}
                            />
                          </>
                        ) : null}
                      </>
                    ) : null}
                    {/* Paid out from the note's own page, which picks gateway vs offline —
                        so this names the destination, not a method. */}
                    {refundableCn ? (
                      <RailLink href={`/businesses/${biz}/credit_notes/${refundableCn.id}`}>
                        Pay out credit note {refundableCn.id}
                      </RailLink>
                    ) : null}
                  </MoreSection>
                ) : null}
              </MoreMenu>
            </>
          }
        />

        {error ? <ErrorState description={error} /> : null}
        {msg ? <Alert tone="success">{msg}</Alert> : null}

        <InvoiceAttention
          biz={biz}
          tz={tz}
          invoice={collectInvoice}
          open={caps.open}
          canClose={caps.canClose}
          canCollect={caps.canCollect}
          canRegenerate={caps.canRegenerate}
          pms={collectPms}
          firstTried={collectFirst}
        />

        {inv.status === "voided" ? (
          <LatePaymentNotice
            biz={biz}
            tz={tz}
            customer={inv.customer ?? null}
            transactions={payments?.transactions ?? []}
          />
        ) : null}

        {owedNow ? paymentsZone : null}

        <Zone title="Invoice">
          <Row span="8/4">
            <RecordCard id="lines" title="Line items" flush={items.length > 0}>
              {/* The reverse-charge / SEZ / export note as frozen onto the invoice. */}
              {inv.tax_note ? (
                <Alert tone="info" className={items.length > 0 ? "m-5 mb-0" : "mb-4"}>
                  {inv.tax_note}
                </Alert>
              ) : null}
              {items.length === 0 ? (
                <EmptyState
                  title="No line items"
                  description={
                    caps.pending
                      ? "Recurring lines show here as the period accrues. We add usage when you close the invoice."
                      : undefined
                  }
                />
              ) : (
                <>
                  {/* Below sm only Items and Amount stay; the per-unit figures move under
                      the description. */}
                  <Table className="table-fixed max-lg:min-w-0">
                    <colgroup>
                      <col />
                      <col className="hidden w-20 sm:table-column" />
                      <col className="hidden w-28 sm:table-column" />
                      {hasLineDiscounts ? <col className="hidden w-28 sm:table-column" /> : null}
                      <col className="w-32 sm:w-36" />
                    </colgroup>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-5">Items</TableHead>
                        <TableHead className="hidden text-right sm:table-cell">Units</TableHead>
                        <TableHead className="hidden text-right sm:table-cell">
                          Unit price
                        </TableHead>
                        {/* Only when a line was discounted: Subtotal is NET of these, so
                            without the column the items would outsum it unexplained. */}
                        {hasLineDiscounts ? (
                          <TableHead className="hidden text-right sm:table-cell">
                            Discount
                          </TableHead>
                        ) : null}
                        <TableHead className="pr-5 text-right">
                          Amount<span className="hidden sm:inline"> ({inv.currency})</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((l) => (
                        <TableRow key={l.id}>
                          <TableCell className="pl-5 whitespace-normal">
                            <span className="flex flex-col gap-0.5">
                              {/* No link to the line's price: its route needs the product
                                  id, which `lines[]` does not carry. */}
                              <span className="text-sm font-medium wrap-anywhere">
                                {l.description}
                              </span>
                              <span className="text-xs text-muted-foreground capitalize">
                                {l.kind.replace(/_/g, " ")}
                                {l.period_start
                                  ? ` · ${fmtDate(l.period_start, tz)} – ${fmtDate(l.period_end, tz)}`
                                  : ""}
                              </span>
                              {ratingRows(l.rating, (m) => money(m, inv.currency)).map((row) => (
                                <span
                                  key={row}
                                  className="text-xs text-muted-foreground tabular-nums"
                                >
                                  {row}
                                </span>
                              ))}
                              {l.cumulative_minor != null && l.billed_before_minor != null ? (
                                <span className="text-xs text-muted-foreground tabular-nums">
                                  Usage to date {money(l.cumulative_minor, inv.currency)} · billed
                                  before {money(l.billed_before_minor, inv.currency)} · this invoice{" "}
                                  {money(l.amount_minor, inv.currency)}
                                </span>
                              ) : null}
                              {l.rating?.meter ? (
                                <PriceSourcePopover
                                  line={l}
                                  currency={inv.currency}
                                  tz={tz}
                                  showCost={canSeeCost}
                                />
                              ) : null}
                              <span className="text-xs text-muted-foreground tabular-nums sm:hidden">
                                {lineQuantity(l)} × {lineUnitPrice(l, inv.currency)}
                                {(l.item_level_discount_minor ?? 0) > 0
                                  ? ` · −${money(l.item_level_discount_minor ?? 0, inv.currency)} discount`
                                  : ""}
                              </span>
                            </span>
                          </TableCell>
                          {/* The decimal fields carry a meter line's truth; older rows fall back. */}
                          <TableCell className="hidden text-right tabular-nums sm:table-cell">
                            {lineQuantity(l)}
                          </TableCell>
                          <TableCell className="hidden text-right tabular-nums sm:table-cell">
                            {lineUnitPrice(l, inv.currency)}
                          </TableCell>
                          {hasLineDiscounts ? (
                            <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
                              {/* A dash, not a zero: not discounted at all. Same as the PDF. */}
                              {(l.item_level_discount_minor ?? 0) === 0
                                ? "—"
                                : `−${money(l.item_level_discount_minor ?? 0, inv.currency)}`}
                            </TableCell>
                          ) : null}
                          {/* NET of the item-level discount, as on the PDF, so Σ Amount IS
                              Subtotal. The document-level part has its own ladder row. */}
                          <TableCell className="pr-5 text-right font-medium tabular-nums">
                            {money(
                              l.amount_minor - (l.item_level_discount_minor ?? 0),
                              inv.currency,
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {/* Totals ladder: Subtotal → each named adjustment → Total → what reduced
                      the collectible → Amount due. Every row is a real engine figure. */}
                  <div className="ml-auto max-w-xs space-y-1 px-5 py-4 text-sm">
                    <div className="flex justify-between gap-8">
                      <span className="text-muted-foreground">Subtotal</span>
                      <span className="tabular-nums">
                        {money(inv.subtotal_minor ?? 0, inv.currency)}
                      </span>
                    </div>
                    {/* Promotional credit is applied BEFORE tax, so it sits above Total. */}
                    {promotionalDiscount > 0 ? (
                      <div className="flex justify-between gap-8">
                        <span className="text-muted-foreground">Promotional Credits</span>
                        <span className="tabular-nums">
                          {money(-promotionalDiscount, inv.currency)}
                        </span>
                      </div>
                    ) : null}
                    {/* Credit grants applied before tax lower the tax base, so they sit above Total too. */}
                    {(inv.grant_credits_pre_tax_minor ?? 0) > 0 ? (
                      <div className="flex justify-between gap-8">
                        <span className="text-muted-foreground">Credit grants, before tax</span>
                        <span className="tabular-nums">
                          {money(-(inv.grant_credits_pre_tax_minor ?? 0), inv.currency)}
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
                      <span className="tabular-nums">{money(inv.total_minor, inv.currency)}</span>
                    </div>
                    {includedTax > 0 ? (
                      <div className="flex justify-between gap-8 text-muted-foreground">
                        <span>Tax included in the total</span>
                        <span className="tabular-nums">{money(includedTax, inv.currency)}</span>
                      </div>
                    ) : null}
                    {/* Below Total: these reduce what is COLLECTIBLE (volatile). */}
                    <InvoiceAmountLadderTail
                      currency={inv.currency}
                      open={caps.open}
                      grantPostTaxMinor={inv.grant_credits_post_tax_minor ?? 0}
                    />
                  </div>
                </>
              )}
            </RecordCard>

            <RecordCard id="details" title="Invoice details">
              <Facts
                rows={[
                  {
                    label: "Customer",
                    value: inv.customer ? (
                      <Link
                        href={`/businesses/${biz}/customers/${inv.customer}`}
                        className="text-primary hover:underline"
                      >
                        <span className="block">{holderName ?? inv.customer}</span>
                        {holderName ? (
                          <span className="block font-mono text-xs text-muted-foreground">
                            {inv.customer}
                          </span>
                        ) : null}
                      </Link>
                    ) : (
                      "—"
                    ),
                  },
                  {
                    label: "Subscription",
                    value: inv.subscription ? (
                      <Link
                        href={`/businesses/${biz}/subscriptions/${inv.subscription}`}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {inv.subscription}
                      </Link>
                    ) : (
                      "—"
                    ),
                  },
                  { label: "Invoiced on", value: fmtDateTime(inv.created_at, tz) },
                  {
                    label: "Billing period",
                    value:
                      inv.period_start || inv.period_end
                        ? `${fmtDate(inv.period_start, tz)} → ${fmtDate(inv.period_end, tz)}`
                        : "—",
                  },
                  inv.due_date ? { label: "Due date", value: fmtDate(inv.due_date, tz) } : null,
                  inv.expected_payment_date
                    ? { label: "Expected payment", value: fmtDate(inv.expected_payment_date, tz) }
                    : null,
                  {
                    label: "Amount due",
                    value: <InvoiceAmountDueValue currency={inv.currency} open={caps.open} />,
                  },
                  inv.paid_at ? { label: "Paid at", value: fmtDateTime(inv.paid_at, tz) } : null,
                  inv.voided_at
                    ? { label: "Voided at", value: fmtDateTime(inv.voided_at, tz) }
                    : null,
                  inv.po_number ? { label: "PO number", value: inv.po_number } : null,
                  sub?.next_billing_at
                    ? { label: "Next billing date", value: fmtDate(sub.next_billing_at, tz) }
                    : null,
                  inv.channel
                    ? { label: "Channel", value: <span className="capitalize">{inv.channel}</span> }
                    : null,
                  // From the invoice's own SNAPSHOT, so a historical invoice keeps explaining
                  // its tax; absent on rows predating place-of-supply tax.
                  inv.seller_state_code || inv.place_of_supply_code
                    ? {
                        label: "Place of supply",
                        value: (
                          <span>
                            {inv.seller_state_code ?? "—"} → {inv.place_of_supply_code ?? "—"}
                            {inv.seller_state_code && inv.place_of_supply_code ? (
                              <span className="ml-2 text-xs text-muted-foreground">
                                {inv.seller_state_code === inv.place_of_supply_code
                                  ? "intra-state"
                                  : "inter-state"}
                              </span>
                            ) : null}
                          </span>
                        ),
                      }
                    : null,
                  inv.tax_treatment && inv.tax_treatment !== "default"
                    ? { label: "Tax treatment", value: TREATMENT_SHORT[inv.tax_treatment] }
                    : null,
                  // The FX snapshot at finalization; only for a currency other than the
                  // base, and never faked as "1" on invoices raised before it existed.
                  inv.exchange_rate &&
                  inv.exchange_rate_base &&
                  inv.exchange_rate_base !== inv.currency
                    ? {
                        label: "Exchange rate",
                        value: (
                          <span className="tabular-nums">
                            1 {inv.exchange_rate_base} = {inv.exchange_rate} {inv.currency}
                            <span className="ml-2 text-xs text-muted-foreground">at issue</span>
                          </span>
                        ),
                      }
                    : null,
                ]}
              />
            </RecordCard>
          </Row>

          <Row span={discountDetails.length > 0 ? "6/6" : "12"}>
            {/* Which coupon, manual discount or promotional credit discounted this
                invoice — the only place that names it. */}
            {discountDetails.length > 0 ? (
              <RecordCard id="discounts" title="Discount details" flush>
                <Table className="table-fixed max-lg:min-w-0">
                  <colgroup>
                    <col />
                    <col className="w-[34%]" />
                    <col className="w-28" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-5">Discount</TableHead>
                      <TableHead>Applied on</TableHead>
                      <TableHead className="pr-5 text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {discountDetails.map((d, i) => {
                      // A manual discount's default name is the word "Discount", which the
                      // kind chip already says — print a name only when it names something.
                      const named =
                        d.source === "credit_grants"
                          ? null
                          : (d.coupon_code ?? (d.label && d.label !== "Discount" ? d.label : null));
                      return (
                        <TableRow
                          key={`${d.applied_coupon ?? d.label ?? "discount"}-${d.scope}-${i}`}
                        >
                          <TableCell className="pl-5 whitespace-normal">
                            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                              <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tracking-wide uppercase">
                                {d.source === "manual"
                                  ? "Manual"
                                  : d.source === "promotional_credits"
                                    ? "Credits"
                                    : d.source === "credit_grants"
                                      ? "Credit grants"
                                      : "Coupon"}
                              </span>
                              {named ? (
                                <span className="font-medium wrap-anywhere">{named}</span>
                              ) : null}
                              {d.coupon_code && d.label && d.label !== d.coupon_code ? (
                                <span className="text-muted-foreground">({d.label})</span>
                              ) : null}
                            </span>
                          </TableCell>
                          <TableCell className="whitespace-normal text-muted-foreground">
                            {d.lineNos.length > 0
                              ? `Line item${d.lineNos.length > 1 ? "s" : ""} ${d.lineNos
                                  .map((n) => `#${n}`)
                                  .join(", ")}`
                              : "The invoice"}
                            {/* Which stage it hit decides where the money already is. */}
                            <span className="block text-xs">
                              {d.scope === "item_level" ? "Inside Subtotal" : "Applied to Subtotal"}
                            </span>
                          </TableCell>
                          <TableCell className="pr-5 text-right tabular-nums">
                            {money(d.amount_minor, inv.currency)}
                            {d.percent != null ? (
                              <span className="block text-xs text-muted-foreground">
                                {d.percent.toFixed(2)}%
                              </span>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </RecordCard>
            ) : null}

            {/* The invoice's own snapshot when it has one, else the customer's current
                address (the serializer says which via *_is_snapshot). */}
            <RecordCard
              id="addresses"
              title="Addresses"
              actions={
                !caps.archival ? (
                  <UpdateAddressButton
                    biz={biz}
                    inv={inv.id}
                    billing={inv.billing_address ?? null}
                    shipping={inv.shipping_address ?? null}
                  />
                ) : null
              }
            >
              <div className="grid gap-4 sm:grid-cols-2">
                {/* BILLING's head line is `billedToName` (the PDF's rule); SHIPPING uses
                    only its own contact — a ship-to must not borrow the payer's name. */}
                {(
                  [
                    ["Billing", inv.billing_address, inv.billing_address_is_snapshot, billedToName],
                    [
                      "Shipping",
                      inv.shipping_address,
                      inv.shipping_address_is_snapshot,
                      addressName(inv.shipping_address),
                    ],
                  ] as const
                ).map(([label, addr, isSnapshot, contactName]) => {
                  const lines = addressLines(addr);
                  // "Not set." only when there is nothing to print — no lines and no name.
                  const empty = lines.length === 0 && !contactName;
                  return (
                    // Each address in its own well, so the two read as a pair of panels.
                    <div key={label} className="min-w-0 rounded-lg border bg-muted/30 px-4 py-3.5">
                      <div className="mb-1.5 flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-muted-foreground">{label}</span>
                        {!empty && !isSnapshot ? (
                          <span className="text-xs text-muted-foreground">(from customer)</span>
                        ) : null}
                      </div>
                      {empty ? (
                        <p className="text-sm text-muted-foreground">Not set.</p>
                      ) : (
                        <div className="text-sm wrap-anywhere">
                          {contactName ? <div className="font-medium">{contactName}</div> : null}
                          {/* The company, like the PDF — dropped only when it IS the name. */}
                          {addr?.company && addr.company !== contactName ? (
                            <div>{addr.company}</div>
                          ) : null}
                          {addr?.email ? (
                            <div className="text-muted-foreground">{addr.email}</div>
                          ) : null}
                          {lines.map((l) => (
                            <div key={l}>{l}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </RecordCard>
          </Row>
        </Zone>

        {owedNow ? null : paymentsZone}

        <Zone title="Records">
          <Row span="8/4">
            <ActivityLogCard
              biz={biz}
              resourceType="invoice"
              resourceId={inv.id}
              tz={tz}
              layout="card"
              previewRows={5}
            />
            <CommentsCard
              biz={biz}
              resourceType="invoice"
              resourceId={inv.id}
              backPath={`/businesses/${biz}/invoices/${inv.id}`}
              layout="card"
            />
          </Row>
        </Zone>

        {caps.canVoid || caps.canWriteOff ? (
          <section
            id="danger"
            className="mt-4 flex flex-col gap-3 rounded-xl border border-destructive/30 bg-card px-5 py-4 sm:flex-row sm:items-center"
          >
            <div className="flex-1">
              <p className="text-sm font-semibold text-destructive">
                Danger zone ·{" "}
                {caps.canVoid && caps.canWriteOff
                  ? "Void or write off"
                  : caps.canVoid
                    ? "Void"
                    : "Write off"}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {caps.canVoid
                  ? "Void reverses revenue, tax and AR and restores any applied credit. "
                  : ""}
                {caps.canWriteOff ? "Write off records the amount due as bad debt. " : ""}
                You cannot undo this.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {caps.canVoid && requiredReasons.void_invoice ? (
                <VoidInvoiceDialog
                  biz={biz}
                  invoice={inv.id}
                  confirmLabel={voidRacesPayment && !inv.payment_in_flight ? "Void anyway" : "Void"}
                  warning={
                    voidRacesPayment ? (
                      <span className="mb-1 block font-medium text-warning">
                        {inv.payment_in_flight
                          ? "A debit for this invoice is still in progress at the gateway. We ask the gateway to cancel it before we void the invoice."
                          : "A checkout for this invoice is still open at the gateway. If it succeeds after you void, the money stays as unapplied credit."}
                      </span>
                    ) : undefined
                  }
                />
              ) : caps.canVoid ? (
                <ActionButton
                  resultAction={invoiceOpAction}
                  fields={{ biz, inv: inv.id, op: "void" }}
                  label="Void invoice"
                  variant="destructive"
                  size="sm"
                  confirm={{
                    title: "Void invoice?",
                    // A pending debit or open checkout can still succeed after the void:
                    // the money lands as unapplied credit and a replacement charges twice.
                    description: voidRacesPayment ? (
                      <>
                        <span className="block font-medium text-warning">
                          {inv.payment_in_flight
                            ? "A debit for this invoice is still in progress at the gateway."
                            : "A checkout for this invoice is still open at the gateway."}
                        </span>
                        {/* The engine cancels a pending debit before the void, or refuses it. */}
                        <span className="mt-1 block">
                          {inv.payment_in_flight
                            ? "We ask the gateway to cancel the debit before we void the invoice. If the gateway does not cancel it, the invoice stays open."
                            : "If it succeeds after you void, we charge the customer and the money stays as unapplied credit. If they pay a replacement invoice, they pay twice. Wait for it to settle, or refund it when it arrives."}
                        </span>
                        <span className="mt-2 block">
                          Voiding reverses revenue, tax and AR and restores any applied credit. You
                          cannot undo this.
                        </span>
                      </>
                    ) : (
                      "This reverses revenue, tax and AR and restores any applied credit. You cannot undo this."
                    ),
                    confirmLabel:
                      voidRacesPayment && !inv.payment_in_flight ? "Void anyway" : "Void",
                    destructive: true,
                  }}
                />
              ) : null}
              {caps.canWriteOff ? (
                <ActionButton
                  resultAction={invoiceOpAction}
                  fields={{ biz, inv: inv.id, op: "write_off" }}
                  label="Write off as bad debt"
                  variant="destructive"
                  size="sm"
                  confirm={{
                    title: "Write off as bad debt?",
                    description:
                      "This marks the invoice as uncollectible. AR moves to bad-debt expense. You cannot undo this.",
                    confirmLabel: "Write off",
                    destructive: true,
                  }}
                />
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </InvoiceVolatileProvider>
  );
}
