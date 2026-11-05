"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/patterns/chip";
import { money } from "@/lib/format";
import { creditLegSentences, type CreditDestinationEntry } from "@/lib/credit-legs";
import { cn } from "@/lib/utils";

/** One diff row in the summary (plan/addon change). */
export interface SummaryDiffRow {
  kind: "modified" | "added" | "removed";
  text: React.ReactNode;
}

/** One immediate-charge line. `units`/`unitPriceMinor` are optional (shown when present). */
export interface SummaryChargeLine {
  description: string;
  period?: string | null;
  units?: number | null;
  unitPriceMinor?: number | null;
  amountMinor: number;
}

const DIFF_STYLE: Record<SummaryDiffRow["kind"], string> = {
  modified: "bg-warning-soft text-warning",
  added: "bg-success-soft text-success",
  removed: "bg-destructive-soft text-destructive",
};

/**
 * One `<tfoot>` row.
 *
 * `credit`   — success, printed with a leading minus: it is SUBTRACTED to reach the total.
 * `muted`    — a subtotal or a tax row.
 * `total`    — emphasised.
 *
 * ── TWO KINDS WERE REMOVED, 2026-08-31, AND THIS IS WHY ──────────────────────────────
 * `returned` (success, no minus — money handed back BELOW a total it does not reduce) and
 * `redirected` (muted, leading PLUS — a slice of a credit above that this document never
 * received, added back so the column could reach its own total) both existed to keep a
 * ladder that stated the credit note GROSS from contradicting itself. Their existence was
 * the argument against that shape: a column about one invoice needed a row that moved "the
 * other way" and a row that had to be added back.
 *
 * The charges table stays pure and the note is stated in prose, so the ladder now
 * subtracts only `credits_applied` and every other leg is a sentence in the Credits
 * section. Both kinds lost their last producer with those rows.
 *
 * The lesson they were introduced for still stands and is now enforced elsewhere: the same
 * ₹887.36 must never print as `−₹887.36` on one surface and `₹887.36` on another. That is
 * what `creditLegSentences` is for — one wording, three surfaces.
 */
interface FooterRow {
  label: string;
  /** Always a POSITIVE magnitude — `kind` decides the sign that is printed. */
  amountMinor: number;
  kind?: "muted" | "credit" | "total";
}

/**
 * The charges table, shared by the immediate and renewal panes so the two can never
 * drift into different shapes. Column layout is `Items | Units | Unit Price |
 * Amount (CUR)` — currency in the HEADER not the cells, units and unit price muted,
 * amount bold.
 *
 * `showUnits` is derived per-table: the renewal pane always has units, while an immediate
 * pane can be a single unstructured proration line, and forcing empty Units/Unit Price
 * columns onto it printed two rows of em-dashes.
 */
function ChargesTable({
  charges,
  currency,
  footerRows,
}: {
  charges: SummaryChargeLine[];
  currency: string;
  footerRows: FooterRow[];
}) {
  const showUnits = charges.some((c) => c.units != null || c.unitPriceMinor != null);
  const span = showUnits ? 3 : 1;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className="py-1.5 text-left font-medium">Items</th>
            {showUnits ? (
              <th className="hidden py-1.5 text-right font-medium sm:table-cell">Units</th>
            ) : null}
            {showUnits ? (
              <th className="hidden py-1.5 text-right font-medium sm:table-cell">Unit price</th>
            ) : null}
            <th className="py-1.5 text-right font-medium">Amount ({currency})</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {charges.map((c, i) => (
            <tr key={i}>
              <td className="py-2 pr-4">
                <div className="wrap-anywhere">{c.description}</div>
                {/* Phone: units × unit price under the name instead of two columns. */}
                {showUnits && (c.units != null || c.unitPriceMinor != null) ? (
                  <div className="text-xs text-muted-foreground tabular-nums sm:hidden">
                    {c.units ?? "—"} ×{" "}
                    {c.unitPriceMinor != null ? money(c.unitPriceMinor, currency) : "—"}
                  </div>
                ) : null}
                {c.period ? <div className="text-xs text-muted-foreground">{c.period}</div> : null}
              </td>
              {showUnits ? (
                <td className="hidden py-2 text-right tabular-nums sm:table-cell">
                  {c.units ?? "—"}
                </td>
              ) : null}
              {showUnits ? (
                <td className="hidden py-2 text-right whitespace-nowrap tabular-nums sm:table-cell">
                  {c.unitPriceMinor != null ? money(c.unitPriceMinor, currency) : "—"}
                </td>
              ) : null}
              <td className="py-2 text-right font-medium whitespace-nowrap tabular-nums">
                {money(c.amountMinor, currency)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {footerRows.map((r) => (
            <tr
              key={r.label}
              className={cn(
                "border-t",
                // Credits are `success` and charges neutral — on a money screen the
                // direction IS the information, and it is never flattened onto one token.
                r.kind === "credit"
                  ? "text-success"
                  : r.kind === "total"
                    ? "font-semibold"
                    : "text-muted-foreground",
              )}
            >
              {/* Two label cells: the hidden columns must not count toward the span. */}
              <td
                className={cn(r.kind === "total" ? "py-2" : "py-1.5", "hidden sm:table-cell")}
                colSpan={span}
              >
                {r.label}
              </td>
              <td className={cn(r.kind === "total" ? "py-2" : "py-1.5", "pr-4 sm:hidden")}>
                {r.label}
              </td>
              <td
                className={cn(
                  "text-right whitespace-nowrap tabular-nums",
                  r.kind === "total" ? "py-2" : "py-1.5",
                )}
              >
                {r.kind === "credit" ? "−" : ""}
                {money(r.amountMinor, currency)}
              </td>
            </tr>
          ))}
        </tfoot>
      </table>
    </div>
  );
}

/**
 * "Change subscription?" confirmation. Presentational — the caller
 * owns the form and passes `onProceed` (which should call `form.requestSubmit()`,
 * because this dialog portals outside the form and a nested submit button would
 * not submit it). Shows the status transition, a MODIFIED/ADDED/REMOVED diff, and
 * an immediate-charges table with a total.
 */
export function ChangeSummaryDialog({
  open,
  onOpenChange,
  title = "Change subscription?",
  fromStatus,
  toStatus,
  diff = [],
  charges = [],
  currency,
  headlineMinor,
  headlineLabel,
  taxMinor,
  taxLines,
  invoiceTotalMinor,
  creditNoteTotalMinor,
  creditAppliedToThisInvoiceMinor,
  creditDestinations,
  creditedPeriodStart,
  creditedPeriodEnd,
  fmtWhen,
  creditsMinor,
  balanceCreditsMinor,
  promotionalDiscountMinor,
  couponDiscountMinor,
  totalMinor,
  totalLabel = "Total",
  loading = false,
  emptyNote,
  note,
  chargesLabel = "Immediate charges",
  headlineTone = "warning",
  renewal,
  proceedLabel = "Proceed",
  proceedDisabled = false,
  onProceed,
  pending,
  paymentMethodLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  /** When set and different from `toStatus`, renders a from → to transition. */
  fromStatus?: string | null;
  toStatus: string;
  diff?: SummaryDiffRow[];
  charges?: SummaryChargeLine[];
  currency: string;
  /** Headline amount (chargeable now / on activation). */
  headlineMinor: number;
  headlineLabel: string;
  taxMinor?: number;
  /**
   * `taxMinor` split into the rows the INVOICE will print — `CGST (9.00%)` + `SGST (9.00%)`,
   * or `IGST (18.00%)`. Sums exactly to `taxMinor`. Given them, the footer prints them
   * instead of one row called "Tax": on an Indian invoice a single row is not what the
   * document says, and the buyer meets the split later with nothing tying it to this quote.
   */
  taxLines?: Array<{ label: string; amount_minor: number }>;
  /**
   * The PRORATION INVOICE's own total — charges − promotional discount + tax. Pass it with
   * `creditNoteTotalMinor` to get the two-document footer.
   *
   * A change raises TWO documents, and the footer used to describe them as one: a credit
   * row carrying the credit's PRE-tax amount, then a tax row carrying the charges' GROSS
   * tax, then a total. The credit note's own tax appeared in neither, so the rows did not
   * reconcile and the total was overstated by exactly that amount — "₹7,234.24" on a
   * downgrade that owed ₹887.36 back.
   */
  invoiceTotalMinor?: number;
  /**
   * Face value of the credit note this change issues — the unused time AND the tax
   * originally charged on it, which is why it is larger than `creditsMinor`. Given it, the
   * footer states `invoiceTotalMinor` then subtracts THIS, which is what actually happens.
   */
  creditNoteTotalMinor?: number;
  /**
   * The slice of that note which offsets THIS invoice — `invoice_estimate.credits_applied`,
   * and the footer's ONLY credit row: `invoiceTotalMinor − this = total`.
   *
   * ⚠ Not `creditNoteTotalMinor − creditAppliedToOpenInvoicesMinor`. That subtraction is
   * right only where every other leg is zero, and the engine reports this one from the
   * routing (`credit-routing.ts`) precisely so no surface has to guess.
   */
  creditAppliedToThisInvoiceMinor?: number;
  /**
   * ⚠ `refundableCreditAddedMinor` and `creditAppliedToOpenInvoicesMinor` USED TO BE PROPS
   * here, as a footer row each: the first after the total "because it moves the other way",
   * the second a `+` added back under the gross credit so the column could reach its own
   * figure. Both are destinations of the credit note rather than movements on this invoice,
   * and both are now sentences built from `creditDestinations` below — which reports them
   * TYPED and summing to the note, so neither the caller nor this component has to know
   * which scalar means what. They were removed rather than left unread: a prop a component
   * accepts and ignores is a lie to its next caller.
   *
   * What replaced them: where every slice of the note went, TYPED — the Credits section
   * iterates this rather than reconstructing destinations from scalars. The entries sum to
   * `creditNoteTotalMinor` by construction, so the prose cannot leave an unnamed remainder.
   */
  creditDestinations?: CreditDestinationEntry[];
  /** The unused window the credit is for, ISO instants. Rendered through `fmtWhen`. */
  creditedPeriodStart?: string;
  creditedPeriodEnd?: string;
  /**
   * Renders an ISO instant in the BUSINESS timezone. Passed in rather than imported so this
   * presentational component keeps taking no opinion on the viewer's locale — omit it and the
   * period clause is dropped rather than printed raw.
   */
  fmtWhen?: (iso: string) => string;
  /**
   * Prorated credit for time already paid for, as a POSITIVE magnitude — rendered as
   * its own signed row. PRE-TAX: prefer `creditNoteTotalMinor` where the caller has it.
   * Credits are always stated explicitly: a negative line folded into the items list
   * hides that money is coming BACK, and a footer that sums only charges reads as the
   * amount due while the headline nets the credits — the two then disagree with nothing
   * on screen reconciling them.
   */
  creditsMinor?: number;
  /** Customer account balance applied POST-tax (refundable + excess), positive magnitude.
   *  Separate from `creditsMinor` because it is existing money spent, not new credit
   *  issued by this change — and separate from `promotionalDiscountMinor`, which is the
   *  same balance's PRE-tax bucket and lands above the tax row. */
  balanceCreditsMinor?: number;
  /**
   * Promotional credit funding this change, positive magnitude. It is a PRE-TAX
   * discount — it shrinks the taxable base — so it renders above tax and is already
   * netted out of the estimate's `total_minor`. Reporting it inside
   * `balanceCreditsMinor` would subtract it twice (30fcbd6).
   */
  promotionalDiscountMinor?: number;
  /**
   * Coupons and manual discounts off the charges — `discount_minor` LESS the promotional
   * slice, which has its own row above.
   *
   * It sits between `Subtotal` and the tax rows, and tax is charged on what is left: a
   * 10% coupon on a ₹752 proration shows `−₹75.20`, then `CGST @ 9% ₹60.91` — 9% of
   * 676.80, not of 752.00. Without this row the column jumps from a subtotal to tax rows
   * that are a percentage of neither number on screen.
   */
  couponDiscountMinor?: number;
  /**
   * Authoritative amount due, when the caller has an estimate that already nets
   * credits, discounts and tax. Given it, the footer shows THIS instead of a locally
   * summed total, which is what keeps the footer and the headline agreeing by
   * construction. Omit it and the footer falls back to Σ charges + tax.
   */
  totalMinor?: number;
  /** Footer label — pass "Amount due" when `totalMinor` is the real payable. */
  totalLabel?: string;
  loading?: boolean;
  /** Shown in place of the charges table when there are no immediate charges. */
  emptyNote?: React.ReactNode;
  note?: React.ReactNode;
  /**
   * Heading over the charges table. Defaults to "Immediate charges" — an in-trial
   * change overrides it, because those lines are billed at trial end, not now.
   */
  chargesLabel?: string;
  /**
   * Tone of the headline box. `warning` = money is about to leave the card;
   * `info` = nothing is due now (in-trial change), which must not read as an alert.
   */
  headlineTone?: "warning" | "info";
  proceedLabel?: string;
  proceedDisabled?: boolean;
  /**
   * The NEXT RENEWAL invoice after this change (the estimate's `next_renewal`). Given it,
   * the charges area becomes a tab strip.
   *
   * ⚠ The immediate tab is NOT hidden on a net credit. Our engine raises BOTH a proration
   * invoice and a credit note for a downgrade, so hiding that tab would hide a document
   * the operator can go and find in the invoice list. Emphasis carries it instead —
   * renewal is the default tab when nothing is collectible today — and the truth stays
   * reachable.
   */
  renewal?: {
    charges: SummaryChargeLine[];
    subtotalMinor: number;
    discountMinor?: number;
    taxMinor: number;
    taxLines?: Array<{ label: string; amount_minor: number }>;
    /** subtotal − discount + tax. */
    totalMinor: number;
    /** The credit THIS change hands forward, spent against that invoice. */
    creditsAppliedMinor: number;
    amountDueMinor: number;
    /** Preformatted in the caller's timezone — this component does no date work. */
    dateLabel: string;
  } | null;
  onProceed: () => void;
  /** The submit in flight, when the caller tracks it; otherwise Proceed latches until unmount. */
  pending?: boolean;
  /**
   * The card this charge lands on ("Visa ending 4242"). Pass it only when the caller has
   * fetched the payer's default payment method; omitted, the headline names none.
   */
  paymentMethodLabel?: string;
}) {
  const [submittingLocal, setSubmitting] = React.useState(false);
  // A caller that can be refused without navigating owns the pending state, so a reopened
  // dialog is not stuck on "Processing…".
  const submitting = pending ?? submittingLocal;
  const showTransition = fromStatus && fromStatus !== toStatus;
  const lineTotal = charges.reduce((s, c) => s + c.amountMinor, 0);
  // ⚠ The fallback sums ONE document. It is right only when nothing is credited — a
  // change that issues a credit note has a second total the lines cannot see. Callers
  // holding an estimate pass `totalMinor` (its `total_minor`, already the difference of
  // the two), which is what keeps this footer and the headline equal by construction.
  const total = totalMinor ?? lineTotal + (taxMinor ?? 0);
  const hasCredits =
    (creditsMinor ?? 0) > 0 ||
    (balanceCreditsMinor ?? 0) > 0 ||
    (promotionalDiscountMinor ?? 0) > 0;
  const showImmediate = charges.length > 0 || hasCredits;

  /** `taxLines` when the engine named the components, else one plain row. */
  const taxRows = (
    minor: number | undefined,
    lines: Array<{ label: string; amount_minor: number }> | undefined,
  ): FooterRow[] =>
    !minor || minor <= 0
      ? []
      : lines?.length
        ? lines.map((t) => ({
            label: t.label,
            amountMinor: t.amount_minor,
            kind: "muted" as const,
          }))
        : [{ label: "Tax", amountMinor: minor, kind: "muted" as const }];

  // Footer order — subtotal → tax rows → total → credits — with the second document named
  // for what it is rather than folded into a single "Tax" and a single total.
  const immediateFooter: FooterRow[] = [
    ...((taxMinor ?? 0) > 0
      ? [{ label: "Subtotal", amountMinor: lineTotal, kind: "muted" as const }]
      : []),
    // Only for callers with no credit-NOTE figure (the create form issues none). Where the
    // note is known it is stated below at its real, tax-inclusive face value instead.
    ...(creditNoteTotalMinor == null && (creditsMinor ?? 0) > 0
      ? [{ label: "Credit for unused time", amountMinor: creditsMinor!, kind: "credit" as const }]
      : []),
    // ABOVE tax: promotional credit shrinks the taxable base, so the tax below is charged
    // on what is left after this row — the placement the invoice itself uses.
    ...((couponDiscountMinor ?? 0) > 0
      ? [{ label: "Discounts", amountMinor: couponDiscountMinor!, kind: "credit" as const }]
      : []),
    ...((promotionalDiscountMinor ?? 0) > 0
      ? [
          {
            label: "Promotional credits",
            amountMinor: promotionalDiscountMinor!,
            kind: "credit" as const,
          },
        ]
      : []),
    ...taxRows(taxMinor, taxLines),
    ...(creditNoteTotalMinor != null && creditNoteTotalMinor > 0 && invoiceTotalMinor != null
      ? [{ label: "Invoice total", amountMinor: invoiceTotalMinor, kind: "muted" as const }]
      : []),
    // THE ONLY CREDIT ROW — `credits_applied`, the slice that offsets THIS invoice.
    //
    // Replaces a pair: the gross note (`Credit for unused time (incl. tax)`) followed by a
    // `+` row (`Cleared unpaid invoices`) adding back the slice spent on the term's own
    // outstanding invoice. The pair reconciled, but it described two documents in one column.
    // The charges table stays pure and the note is stated in prose, so both rows moved
    // into the Credits section below. Every leg is still on screen — see
    // `creditLegSentences`.
    ...((creditAppliedToThisInvoiceMinor ?? 0) > 0
      ? [
          {
            label: "Credit applied",
            amountMinor: creditAppliedToThisInvoiceMinor!,
            kind: "credit" as const,
          },
        ]
      : []),
    // BELOW tax: the refundable/excess buckets are applied to the taxed total, not the base.
    ...((balanceCreditsMinor ?? 0) > 0
      ? [
          {
            label: "Account credits applied",
            amountMinor: balanceCreditsMinor!,
            kind: "credit" as const,
          },
        ]
      : []),
    { label: totalLabel, amountMinor: total, kind: "total" as const },
    // `Refundable credit added back` used to sit here, after the total, "because it moves the
    // other way" — which was the tell that it never belonged in a column about this invoice.
    // It is a destination of the credit note, so it is now one of the Credits sentences.
  ];

  // ── CREDITS ──────────────────────────────────────────────────────────────────────────
  // A `Credits` heading under the charges table explains the note in sentences
  // ("Prorated Adjustment Credits (525,00 €) will be created for the unused period … and
  // will be adjusted against the due amount"). One node, used by both the tabbed and
  // untabbed panes below, so the two cannot drift.
  const creditSentences = creditLegSentences(
    {
      grossMinor: creditNoteTotalMinor ?? 0,
      destinations: creditDestinations ?? [],
      periodStart: creditedPeriodStart,
      periodEnd: creditedPeriodEnd,
    },
    (m) => money(m, currency),
    { audience: "operator", fmtWhen },
  );
  const creditsSection =
    creditSentences.length > 0 ? (
      <div className="mt-4 border-t pt-3">
        <div className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Credits
        </div>
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          {creditSentences.map((s, i) => (
            <p key={i}>{s}</p>
          ))}
        </div>
      </div>
    ) : null;

  const renewalFooter: FooterRow[] = renewal
    ? [
        { label: "Subtotal", amountMinor: renewal.subtotalMinor, kind: "muted" },
        ...((renewal.discountMinor ?? 0) > 0
          ? [{ label: "Discounts", amountMinor: renewal.discountMinor!, kind: "credit" as const }]
          : []),
        ...taxRows(renewal.taxMinor, renewal.taxLines),
        {
          label: "Total",
          amountMinor: renewal.totalMinor,
          kind: renewal.creditsAppliedMinor > 0 ? "muted" : "total",
        },
        ...(renewal.creditsAppliedMinor > 0
          ? [
              {
                label: "Credits",
                amountMinor: renewal.creditsAppliedMinor,
                kind: "credit" as const,
              },
              { label: "Amount due", amountMinor: renewal.amountDueMinor, kind: "total" as const },
            ]
          : []),
      ]
    : [];

  const proceed = () => {
    setSubmitting(true);
    onProceed();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!submitting) onOpenChange(o);
      }}
    >
      {/* Fixed header and footer, the body scrolls between them — never the content box
          itself, or the × scrolls away. A full-height sheet on a phone. */}
      <DialogContent
        size="lg"
        className={cn(
          "z-50 flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0",
          "max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:max-w-none",
          "max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0",
        )}
      >
        {/* `pr-12` keeps the ×'s corner clear. */}
        <div className="shrink-0 border-b p-5 pr-12">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle className="text-lg">{title}</DialogTitle>
            <DialogDescription>
              Here is a summary of what happens when you confirm.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {/* Status transition */}
          <div className="flex flex-wrap items-center gap-3">
            {showTransition ? (
              <>
                <StatusChip status={fromStatus!} />
                <span className="text-muted-foreground">→</span>
                <StatusChip status={toStatus} />
              </>
            ) : (
              <StatusChip status={toStatus} />
            )}
            <span className="text-sm text-muted-foreground">Subscription</span>
          </div>

          {/* Headline amount */}
          <div
            className={cn(
              "rounded-lg border p-4",
              headlineTone === "info"
                ? "border-info/25 bg-info-soft"
                : "border-warning/25 bg-warning-soft",
            )}
          >
            <div className="text-2xl font-semibold tracking-tight wrap-anywhere tabular-nums">
              {money(headlineMinor, currency)}{" "}
              <span className="text-sm font-normal text-muted-foreground">{currency}</span>
            </div>
            <p className="text-xs wrap-break-word text-muted-foreground">
              {headlineLabel}
              {paymentMethodLabel && headlineTone === "warning" ? (
                <> · charged to {paymentMethodLabel}</>
              ) : null}
            </p>
          </div>

          {/* Diff */}
          {diff.length > 0 ? (
            <div className="divide-y rounded-lg border">
              {diff.map((d, i) => (
                <div key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                  <span
                    className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold tracking-wide uppercase ${DIFF_STYLE[d.kind]}`}
                  >
                    {d.kind}
                  </span>
                  <span className="min-w-0 wrap-anywhere">{d.text}</span>
                </div>
              ))}
            </div>
          ) : null}

          {/* ── CHARGES ─────────────────────────────────────────────────────────
              A TAB STRIP, where which tabs exist is decided by the money, not by
              preference:
                · net charge  → `Immediate Charges` + `Renewal Charges`, immediate active
                · net credit  → `Renewal Charges` ONLY
              A downgrade collects nothing today, so leading with an immediate-charges
              table answers a question nobody asked; the operator wants to know what the
              customer now pays. */}
          {loading ? (
            <p className="text-sm text-muted-foreground">Estimating charges…</p>
          ) : showImmediate || renewal ? (
            renewal ? (
              <Tabs defaultValue={showImmediate && total > 0 ? "immediate" : "renewal"}>
                <TabsList>
                  {showImmediate ? (
                    <TabsTrigger value="immediate">{chargesLabel}</TabsTrigger>
                  ) : null}
                  <TabsTrigger value="renewal">Renewal charges</TabsTrigger>
                </TabsList>
                {showImmediate ? (
                  <TabsContent value="immediate">
                    <ChargesTable
                      charges={charges}
                      currency={currency}
                      footerRows={immediateFooter}
                    />
                    {creditsSection}
                  </TabsContent>
                ) : null}
                <TabsContent value="renewal">
                  <ChargesTable
                    charges={renewal.charges}
                    currency={currency}
                    footerRows={renewalFooter}
                  />
                  <p className="pt-2 text-xs text-muted-foreground">
                    This is what the subscription bills each period after the change. We raise this
                    invoice on <b>{renewal.dateLabel}</b>.
                  </p>
                </TabsContent>
              </Tabs>
            ) : (
              <div className="rounded-lg border p-4">
                <div className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {chargesLabel}
                </div>
                <ChargesTable charges={charges} currency={currency} footerRows={immediateFooter} />
                {creditsSection}
              </div>
            )
          ) : emptyNote ? (
            <p className="text-sm text-muted-foreground">{emptyNote}</p>
          ) : null}

          {note ? <div className="text-xs text-muted-foreground">{note}</div> : null}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t px-5 py-3">
          <p className="hidden text-xs text-muted-foreground sm:block">
            Nothing happens until you confirm
          </p>
          <div className="ml-auto flex flex-1 gap-2 sm:flex-none sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="flex-1 sm:flex-none"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Close
            </Button>
            <Button
              type="button"
              className="flex-1 sm:flex-none"
              onClick={proceed}
              disabled={proceedDisabled || submitting}
            >
              {submitting ? "Processing…" : proceedLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
