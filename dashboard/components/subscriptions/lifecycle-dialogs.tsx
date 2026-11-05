"use client";

// Lifecycle dialogs for the subscription detail: Cancel (full
// option set + reason code), Pause (immediately / end_of_term / specific_date /
// N billing cycles with auto-resume), Resume (charges + unpaid-invoice
// handling) and Change-term-end (date + prorate + invoice_immediately). Each is
// a trigger button + <Dialog> wrapping an <ActionForm> to the rich actions in
// app/businesses/[biz]/subscriptions/actions.ts.
//
// House rule: no control ever offers a vague "business default"
// choice. Every select/menu is preselected with the value that WILL apply — the
// business billing-rule default where one exists (SET-1: default_cancel_option,
// default_credit_option_for_cancel), otherwise the engine's own fallback spelled
// out in words — so the dialog reads as a preview of the outcome.

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ActionForm } from "@/components/form/action-form";
import { DateTimeField } from "@/components/form/datetime-field";
import { Field } from "@/components/form/field";
import { MoneyInput } from "@/components/form/money-input";
import { SubmitButton } from "@/components/form/submit-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmtDateTime, money } from "@/lib/format";
import { useDisplayTz } from "@/components/business-tz";
import { ChevronDown } from "lucide-react";
import { cn, fieldClass } from "@/lib/utils";
import {
  cancelSubscriptionFullAction,
  estimateSubscriptionCancelAction,
  pauseSubscriptionFullAction,
  resumeSubscriptionFullAction,
  changeTermEndAction,
  editTrialEndAction,
  applyManualDiscountAction,
} from "@/app/(dashboard)/businesses/[biz]/subscriptions/actions";
import { Alert } from "@/components/ui/alert";
import type { CancelEstimate } from "@/lib/api/subscriptions";
import { SelectField } from "@/components/ui/select-field";
import { CheckboxField } from "@/components/ui/checkbox";
import { useDefaultState } from "@/lib/use-default-state";
import {
  CREDIT_CANCEL_LABELS,
  CREDIT_PAUSE_LABELS,
  FINAL_PERIOD_LABELS,
  type PlanCreditResets,
  type SpecificDateFinalPeriod,
} from "@/lib/billing-rules";

function DialogShell({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* key on open: remounts the form on reopen so stale selections/errors from a
          previous (possibly failed) attempt don't leak into the next one. */}
      {/* The BODY scrolls, not the dialog: `overflow-y-auto` on DialogContent takes
          the close button with it (see the note on DialogClose). */}
      <DialogContent
        key={String(open)}
        className="flex max-h-[85vh] max-w-lg flex-col overflow-hidden"
      >
        <DialogHeader className="pr-12">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

function FooterButtons({
  onCancel,
  submitLabel,
  destructive,
  submitDisabled,
}: {
  onCancel: () => void;
  submitLabel: string;
  destructive?: boolean;
  submitDisabled?: boolean;
}) {
  return (
    <DialogFooter className="mt-4">
      <Button type="button" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
      <SubmitButton variant={destructive ? "destructive" : "default"} disabled={submitDisabled}>
        {submitLabel}
      </SubmitButton>
    </DialogFooter>
  );
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

/**
 * Cancellation reasons (label shown; code persisted as `cancel_reason_code`).
 *
 * These used to be hard-coded here. They are now merchant-managed under
 * Settings → Reason codes and passed in by the page; the constant survives only
 * as the fallback the backend also serves when a business has configured none,
 * so a caller that doesn't pass `reasons` behaves exactly as before.
 * Keep in sync with DEFAULT_CANCELLATION_REASONS (src/modules/reason-codes/service.ts).
 */
const CANCEL_REASONS: Array<{ code: string; label: string }> = [
  { code: "pricing_high", label: "Pricing was high" },
  { code: "pausing_will_return", label: "Pausing, will come back" },
  { code: "complicated_to_use", label: "Complicated to use" },
  { code: "product_has_issues", label: "Product has issues" },
  { code: "product_unsatisfactory", label: "Product was unsatisfactory" },
  { code: "trying_out", label: "Was just trying out" },
  { code: "other", label: "Other" },
];

/**
 * One row of an {@link InlineMenu}. `label` is the menu row's title; `short`
 * overrides what the trigger shows once picked (the menu row is title-cased,
 * the collapsed trigger sentence-cased) and `description` renders the grey
 * explainer line under the credit/refund choices.
 */
type MenuOption = { value: string; label: string; short?: string; description?: string };

/**
 * Inline picker: the trigger reads as a right-aligned blue link with a caret
 * (long labels wrap under it), and the menu is a portalled card whose rows can
 * carry a description line. Portalled so a menu opened near the dialog's bottom
 * edge isn't clipped by its scroll container.
 */
function InlineMenu({
  value,
  options,
  onChange,
  placeholder = "Select",
  scrollable,
  "aria-label": ariaLabel,
}: {
  value: string;
  options: MenuOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  /** Cap the menu height + scroll (for the long reason list). */
  scrollable?: boolean;
  "aria-label": string;
}) {
  const current = options.find((o) => o.value === value);
  const described = options.some((o) => o.description);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className="flex w-52 items-start justify-end gap-1 text-right text-sm font-medium text-primary hover:underline focus:outline-none focus-visible:underline"
        >
          <span>{current ? (current.short ?? current.label) : placeholder}</span>
          <ChevronDown className="mt-0.5 size-4 shrink-0" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={cn("p-0 py-1", described ? "w-64" : "w-56")}
        // Inline, not a max-h-* class: the primitive already sets a max-height
        // (Radix's available-height var) and utility order wouldn't reliably win.
        style={scrollable ? { maxHeight: "11rem" } : undefined}
      >
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value}
            onSelect={() => onChange(o.value)}
            className={cn(
              "flex-col items-start gap-0 rounded-none px-4 py-2 whitespace-normal",
              o.value === value && "bg-muted",
            )}
          >
            <span className={cn("text-sm text-foreground", o.description && "font-medium")}>
              {o.label}
            </span>
            {o.description ? (
              <span className="text-xs text-muted-foreground">{o.description}</span>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The cancellation OUTCOME rail — `POST …/cancel_estimate`, re-run whenever an option
 * changes.
 *
 * The five money-handling options each trigger an irreversible posting on an
 * append-only ledger (a mistaken cancel needs compensating entries, not an undo), and
 * until this existed the operator picked all five and confirmed blind. So the rail
 * leads with the three figures that answer "what does pressing this cost": cash taken,
 * cash returned, credit granted. Everything else is detail beneath them.
 *
 * `warnings` is rendered in full and never summarised: it is where the estimate says
 * what will NOT happen the way the options imply — an already-credited term, options an
 * end_of_term cancel silently drops, unbilled charges left stranded.
 */
function CancelOutcome({
  biz,
  sub,
  currency,
  options,
  onEstimate,
}: {
  biz: string;
  sub: string;
  currency: string;
  /**
   * Reports each settled estimate to the parent. It exists for ONE decision the parent
   * cannot make alone: whether to offer the refundable-credits row. That row used to be
   * gated on the customer's CURRENT refundable balance, so a cancellation that CREATES
   * refundable credit hid the only control that decides whether it goes back as cash —
   * measured on the real book at ₹26,484.00 of credit with the row absent, while the
   * engine was perfectly willing to refund it (`refund_minor` = the same figure).
   *
   * Safe against a render loop: the parent uses this only to SHOW the row, and
   * `refundable_credits_handling` is already in `options` whether or not it is shown, so
   * revealing the row changes nothing about the request that produced the estimate.
   */
  onEstimate?: (estimate: CancelEstimate | null) => void;
  options: {
    cancel_option: string;
    cancel_at: string;
    credit_option_for_current_term_charges: string;
    unbilled_charges_option: string;
    account_receivables_handling: string;
    refundable_credits_handling: string;
    final_period: string;
    plan_credits_on_cancel_at_period_end: string;
  };
}) {
  const tz = useDisplayTz();
  const [estimate, setEstimate] = React.useState<CancelEstimate | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(true);
  // Serialised so the effect re-runs on a VALUE change, not on every parent render
  // (a fresh object literal every keystroke would refetch forever).
  const key = JSON.stringify(options);
  /**
   * The callback lives in a REF, deliberately. Listing it as an effect dependency would
   * refetch whenever the parent re-rendered — and the parent re-renders BECAUSE of what
   * this reports, which is a refetch loop that only shows up as a spinning estimate.
   */
  const onEstimateRef = React.useRef(onEstimate);
  onEstimateRef.current = onEstimate;

  React.useEffect(() => {
    // A specific_date cancel with no date yet would 400 on the guard the estimate
    // deliberately mirrors — that is not an error worth showing, just an incomplete form.
    const parsed = JSON.parse(key) as typeof options;
    if (parsed.cancel_option === "specific_date" && !parsed.cancel_at) {
      setPending(false);
      setEstimate(null);
      setError(null);
      return;
    }
    let live = true;
    setPending(true);
    // Debounced: the date field emits per keystroke, and each estimate is a real
    // round trip that reads invoices, credit notes and the ledger.
    const t = setTimeout(async () => {
      const res = await estimateSubscriptionCancelAction(biz, sub, parsed);
      if (!live) return;
      setPending(false);
      if (res.ok) {
        setEstimate(res.estimate);
        setError(null);
        onEstimateRef.current?.(res.estimate);
      } else {
        setEstimate(null);
        setError(res.error);
        onEstimateRef.current?.(null);
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [biz, sub, key]);

  const rows: Array<{ label: string; amount: number; tone: "charge" | "credit" }> = [];
  if (estimate) {
    // Same convention as the proration screens: a charge is destructive, a credit is
    // success. Deliberately not flattened onto one neutral token.
    if (estimate.net_collect_minor > 0)
      rows.push({
        label: "Collected from the customer",
        amount: estimate.net_collect_minor,
        tone: "charge",
      });
    if (estimate.net_refund_minor > 0)
      rows.push({
        label: "Refunded to the customer",
        amount: estimate.net_refund_minor,
        tone: "credit",
      });
    /**
     * "Credited to the account" was stating the WHOLE credit, and most of it never reaches
     * the account.
     *
     * `net_credit_minor` is `cancellation_credit.delivered_minor` (estimate.ts:3984), which
     * sums two things that land in different places: the ADJUSTMENT cancels debt on an open
     * invoice — money the customer never pays, and never receives either — while the
     * RESTORES are balance they can actually spend or have refunded. Measured 2026-09-03 on
     * INV-7826: the row read "Credited to the account ₹32,943.24" when ₹10,759.24 was
     * credited and ₹22,184.00 was debt we stopped collecting. Vinay called it misleading and
     * it was: a customer reading that headline would expect ₹32,943.24 of spendable credit.
     *
     * So the row is split by WHERE THE MONEY GOES, and the detail lines below say which
     * invoice and which instrument. If the two parts ever fail to sum to the engine's own
     * total, fall back to the single undecomposed row rather than print a breakdown that
     * does not add up — stating a total we cannot justify is the defect being fixed here.
     */
    const cc = estimate.cancellation_credit;
    /**
     * ⚠️ A THIRD PLACE THE GRANTED CREDIT CAN GO: straight back out as CASH.
     *
     * `refundable_credits_handling: schedule_refund` refunds the credit note this
     * cancellation just minted, so the same money appeared TWICE in this rail — once as
     * "Credited to the account" and again as "Refunded to the customer". Measured
     * 2026-09-07 on the real book: both rows read ₹27,397.24, implying ₹54,794.48 of
     * movement when ₹27,397.24 leaves and the account ends with NOTHING credited.
     *
     * The engine exposes `includes_cancellation_credit_minor` for exactly this — how much
     * of the refund is the credit above — and its docblock says the double count is
     * deliberate at the API ("one is what is granted, the other is what leaves as cash").
     * Deliberate in the payload, wrong in a rail whose job is "what does pressing this
     * cost". So the granted credit decomposes THREE ways now: what stays on the account,
     * what stops being owed, and what goes out as cash — and the cash part is already its
     * own row above.
     */
    const refundedFromCreditMinor = estimate.refundable_credits.includes_cancellation_credit_minor;
    const restoredGross =
      cc.refundable_credit_note_minor + cc.promotional_restore_minor + cc.excess_restore_minor;
    const restoredMinor = Math.max(0, restoredGross - refundedFromCreditMinor);
    const relievedMinor = cc.delivery === "adjustment" ? cc.adjustment_minor : 0;
    if (estimate.net_credit_minor > 0) {
      // The parts must still account for the engine's own total — now including the slice
      // that left as cash. If they do not, fall back to the undecomposed row rather than
      // print a breakdown that does not add up.
      if (restoredMinor + relievedMinor + refundedFromCreditMinor === estimate.net_credit_minor) {
        if (restoredMinor > 0)
          rows.push({ label: "Credited to the account", amount: restoredMinor, tone: "credit" });
        if (relievedMinor > 0)
          rows.push({ label: "No longer owed", amount: relievedMinor, tone: "credit" });
      } else {
        rows.push({
          label: "Credited to the account",
          amount: estimate.net_credit_minor,
          tone: "credit",
        });
      }
    }
  }

  const details: React.ReactNode[] = [];
  if (estimate) {
    const u = estimate.unbilled_charges;
    if (u.action === "invoice" && u.count > 0) {
      details.push(
        <>
          Invoices {u.count} unbilled charge{u.count === 1 ? "" : "s"} of{" "}
          {money(u.subtotal_minor, currency)}
          {/* Named BEFORE tax, and named at all: promotional credit is applied pre-tax, so
              without this the sentence read "of X plus Y tax — Z due" where Z was smaller
              than X + Y by an amount nothing on screen accounted for. */}
          {u.promotional_discount_minor > 0 ? (
            <> less {money(u.promotional_discount_minor, currency)} promotional credit</>
          ) : null}
          {u.tax_minor > 0 ? <> plus {money(u.tax_minor, currency)} tax</> : null}. The invoice
          stays open with {money(u.amount_due_minor, currency)} due
        </>,
      );
    } else if (u.action === "delete" && u.count > 0) {
      details.push(
        <>
          Discards {u.count} unbilled charge{u.count === 1 ? "" : "s"} worth{" "}
          {money(u.discarded_minor, currency)}. We do not bill them
        </>,
      );
    }
    const c = estimate.cancellation_credit;
    /**
     * The two deliveries are NOT mutually exclusive in what they hand back, and treating
     * them as if they were dropped money out of the explanation.
     *
     * `delivery` says how the credit REACHES the customer, and an `adjustment` delivery can
     * carry a refundable slice as well: an invoice that is part-funded by credit and part
     * unpaid owes back both — the unpaid part as debt relief, the funded part as a note.
     * Measured 2026-09-03 on INV-7826 right after the #19 selection fix landed: the headline
     * read "Credited to the account ₹32,943.24" while the only line explaining it said
     * "Reduces what is owed … by ₹22,184.00", leaving ₹10,759.24 unaccounted for on screen.
     * It was invisible before only because the wrongly-selected primary invoice was `paid`,
     * so the `split` branch ran; fixing the selection moved it to `adjustment` and exposed
     * this. The restores are therefore listed for BOTH deliveries, and the adjustment line
     * says what it is — otherwise the panel states a total it cannot justify.
     */
    const restores = [
      c.refundable_credit_note_minor > 0
        ? `${money(c.refundable_credit_note_minor, currency)} as a refundable credit note`
        : null,
      c.promotional_restore_minor > 0
        ? `${money(c.promotional_restore_minor, currency)} back to promotional credit`
        : null,
      c.excess_restore_minor > 0
        ? `${money(c.excess_restore_minor, currency)} back to excess payments`
        : null,
    ].filter(Boolean);
    if (!c.already_credited) {
      if (c.delivery === "adjustment" && c.adjustment_minor > 0) {
        details.push(
          <>
            Reduces what is owed on {c.invoice_number ?? c.invoice} by{" "}
            {money(c.adjustment_minor, currency)} (unpaid term)
          </>,
        );
      }
      if (restores.length > 0) details.push(<>Credits the unused term ({restores.join(", ")})</>);
    }
    const o = estimate.open_invoices;
    if (o.handling === "write_off" && o.write_off_minor > 0) {
      details.push(
        <>
          Writes off {o.invoices.length} invoice{o.invoices.length === 1 ? "" : "s"} totaling{" "}
          {money(o.write_off_minor, currency)}
        </>,
      );
    } else if (o.handling === "void" && o.invoices.length > 0) {
      // Gated on the COUNT, not the amount: voiding a fully-settled open invoice still
      // withdraws it, and `void_minor` is legitimately 0 in that case. Gating on the
      // money would have hidden the one line saying what confirming does.
      const voidable = o.invoices.filter((i) => !i.void_blocked);
      if (voidable.length > 0)
        details.push(
          <>
            Voids {voidable.length} invoice{voidable.length === 1 ? "" : "s"}
            {o.void_minor > 0 ? <> totaling {money(o.void_minor, currency)}</> : null}
          </>,
        );
      for (const k of o.invoices.filter((i) => i.void_blocked))
        details.push(
          <>
            Leaves {k.invoice ?? "an invoice"} open: {k.void_blocked}
          </>,
        );
    } else if (o.handling === "schedule_payment_collection" && o.collect_minor > 0) {
      details.push(
        <>
          Attempts to collect {money(o.collect_minor, currency)} across {o.invoices.length} invoice
          {o.invoices.length === 1 ? "" : "s"}
        </>,
      );
    }
    const r = estimate.refundable_credits;
    if (r.handling === "schedule_refund" && r.refund_minor > 0) {
      details.push(
        <>
          Refunds {money(r.refund_minor, currency)} of refundable credit
          {r.includes_cancellation_credit_minor > 0 ? (
            <>
              , including the {money(r.includes_cancellation_credit_minor, currency)} credit above
            </>
          ) : null}
        </>,
      );
    }
  }

  const nothingMoves =
    estimate != null &&
    rows.length === 0 &&
    estimate.unbilled_charges.discarded_minor === 0 &&
    details.length === 0;

  /**
   * #27: `debits_in_flight` now carries TWO risk shapes (see the engine field's
   * docblock) and no field on the entries themselves says which — the engine
   * deliberately reused `DebitInFlight` rather than add a second query or a second
   * type. `open_invoices` already says which invoices `schedule_payment_collection`
   * would collect, so that is the cross-reference: an in-flight invoice that is ALSO
   * a payable AR invoice under that handling is a double-charge risk; every other
   * in-flight invoice is the #22 stranded-credit risk C3 already covers below.
   */
  const debitsInFlight = estimate?.debits_in_flight ?? [];
  const collectingInvoices = new Set(
    estimate?.open_invoices.handling === "schedule_payment_collection"
      ? estimate.open_invoices.invoices
          .filter((i) => i.amount_due_minor > 0 && i.invoice != null)
          .map((i) => i.invoice as string)
      : [],
  );
  const collectionDebits = debitsInFlight.filter((d) => collectingInvoices.has(d.invoice));
  const reliefDebits = debitsInFlight.filter((d) => !collectingInvoices.has(d.invoice));

  return (
    <div className="mt-3 rounded-md bg-muted/50 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          What this cancellation does
        </span>
        {pending ? <span className="text-xs text-muted-foreground">Estimating…</span> : null}
      </div>

      {error ? (
        <p className="mt-1.5 text-sm text-destructive">{error}</p>
      ) : estimate == null ? (
        <p className="mt-1.5 text-sm text-muted-foreground">
          {pending ? "Pricing this option set…" : "Select a cancellation date to price this."}
        </p>
      ) : (
        <div className={cn("mt-1.5", pending && "opacity-60")}>
          {rows.length > 0 ? (
            <dl className="space-y-1 tabular-nums">
              {rows.map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-sm">{row.label}</dt>
                  <dd
                    className={cn(
                      "text-sm font-semibold",
                      row.tone === "charge" ? "text-destructive" : "text-success",
                    )}
                  >
                    {money(row.amount, currency)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}

          {nothingMoves ? (
            <p className="text-sm text-muted-foreground">
              No money moves. The subscription is cancelled
              {estimate.immediate ? "" : ` on ${fmtDateTime(estimate.effective_at, tz)}`}.
            </p>
          ) : null}

          {details.length > 0 ? (
            <ul className="mt-2 space-y-1 border-t border-border pt-2">
              {details.map((d, i) => (
                <li key={i} className="text-xs text-muted-foreground">
                  {d}
                </li>
              ))}
            </ul>
          ) : null}

          {/*
            A debit is still live at the gateway on an invoice this cancellation is about
            to clear. Clearing it does not cancel the debit, so the money can still arrive
            for a debt that no longer exists — it is then booked as excess and refunded
            automatically, which is a round trip through the customer's bank that the
            operator can avoid by waiting. Measured 2026-09-03 17:47 (#22): a ₹22,184.00
            checkout was live on INV-7826 throughout the cancellation and nothing said so.

            A warning and never a block: waiting on a customer's bank is not a reason to
            refuse an operator a cancellation. The branch on `kind` is the load-bearing
            part — the portal's release control keys on an in-progress TRANSACTION, and a
            buyer's checkout has none, so "they can release it from their portal" is true
            of a debit we dispatched and false of a checkout they opened.
          */}
          {reliefDebits.length ? (
            <Alert
              tone="warning"
              className="mt-2"
              title="A payment is not settled on an invoice that this cancellation clears"
            >
              {reliefDebits.map((d) => d.invoice).join(", ")}
              {reliefDebits.length === 1 ? " has " : " have "}
              {reliefDebits.some((d) => d.kind === "intent")
                ? "a payment the customer started at the gateway"
                : "a debit the gateway has accepted"}{" "}
              and it has not settled. The cancellation clears the debt now, but the money can still
              arrive after it. If it arrives, we book it as an excess payment on the account and
              refund it automatically.
              {reliefDebits.some((d) => d.kind === "intent")
                ? reliefDebits.some((d) => d.awaiting_buyer)
                  ? " Only the customer can complete or stop their own checkout. The release control in their portal cannot stop a checkout. To prevent the refund, cancel after the payment clears."
                  : " The gateway already holds their money, and the customer has no more steps to do. To prevent the refund, cancel after the payment clears."
                : reliefDebits.some((d) => d.awaiting_buyer)
                  ? " Their bank is waiting for the customer, so the customer can release the debit from their billing portal. If they do that first, no refund is necessary."
                  : " It should settle soon without action. To prevent the refund, cancel after it settles."}
            </Alert>
          ) : null}

          {/*
            #27: `schedule_payment_collection` is the OPPOSITE of the warning above — this
            cancellation is about to DISPATCH a collection attempt against an invoice that
            already has a debit live, so the risk is a double charge, not a stranded credit.
            #22's copy ("cancelling clears the debt … refunded automatically") is false of
            this shape, which is exactly why C3 left it uncovered rather than show it here.

            Kind still decides the advice: a buyer-opened checkout (`intent`) has no
            release control reachable from here at all, so the only lever is waiting —
            naming a specific gateway button would claim a capability this estimate
            carries no field to verify. A dispatched debit (`payment`) may settle on its
            own, or the customer can release it from their portal when they are the one
            being waited on.
          */}
          {collectionDebits.length ? (
            <Alert
              tone="warning"
              className="mt-2"
              title="A payment is not settled on an invoice that this would also collect"
            >
              {collectionDebits.map((d) => d.invoice).join(", ")}
              {collectionDebits.length === 1 ? " has " : " have "}
              {collectionDebits.some((d) => d.kind === "intent")
                ? "a payment the customer started at the gateway"
                : "a debit the gateway has accepted"}{" "}
              that has not settled. If you schedule collection now, we send a SECOND charge for the
              same invoice. If the customer&apos;s own payment also arrives, we charge the customer
              twice.
              {collectionDebits.some((d) => d.kind === "intent")
                ? collectionDebits.some((d) => d.awaiting_buyer)
                  ? " Only the customer can complete or stop their own checkout. No control here can stop it. Wait for it to clear before you collect."
                  : " The gateway already holds their money, and the customer has no more steps to do. Wait for it to clear before you collect."
                : collectionDebits.some((d) => d.awaiting_buyer)
                  ? " Their bank is waiting for the customer. The customer can release the debit from their billing portal. Or wait for it to settle before you collect."
                  : " It should settle soon without action. Wait for it to settle before you collect."}
            </Alert>
          ) : null}

          {estimate.open_invoices.mandate_shortfall ? (
            <Alert tone="warning" className="mt-2" title="This charge exceeds the mandate ceiling">
              The customer authorised a maximum of{" "}
              {money(estimate.open_invoices.mandate_shortfall.ceiling_minor, currency)} per debit.
              We would refuse the collection before it reaches the gateway. A new authorization
              would register{" "}
              {money(estimate.open_invoices.mandate_shortfall.reauthorized_ceiling_minor, currency)}
              .
            </Alert>
          ) : null}

          {estimate.warnings.map((w) => (
            <Alert tone="warning" className="mt-2" key={w}>
              {w}
            </Alert>
          ))}
        </div>
      )}
    </div>
  );
}

/** A two-column cancellation row: label (+ help) left, control right. */
function CancelRow({
  label,
  help,
  children,
}: {
  label: React.ReactNode;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        {help ? <div className="mt-0.5 text-xs text-muted-foreground">{help}</div> : null}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

/**
 * Credit handling for the unused part of the current term. `short` is the
 * collapsed-trigger form.
 */
const CREDIT_OPTIONS: MenuOption[] = [
  {
    value: "none",
    label: "Do Not Issue Credits",
    short: "Do not issue credits",
    description: "We do not create credit notes.",
  },
  {
    value: "prorate",
    label: "Issue Prorated Credits",
    short: "Issue prorated credits",
    description: "We issue prorated credits.",
  },
  {
    value: "full",
    label: "Issue Full Credits",
    short: "Issue full credits",
    description: "We issue credits for the full value of the current term charges.",
  },
];

/**
 * Pending unbilled charges at an immediate cancel (`unbilled_charges_option`).
 *
 * The route's enum is `invoice | delete` only — "leave them pending" is expressed by
 * OMITTING the field, which the service then fills from the business's
 * `default_unbilled_on_cancel` (`no_action | invoice | delete`, NOT NULL DEFAULT
 * `no_action`). So the third row is offered ONLY when that business default really is
 * `no_action`; on a business defaulting to invoice/delete an omitted field resolves to
 * that value, so a "leave them" row there would post one thing and do another.
 */
const UNBILLED_OPTIONS: MenuOption[] = [
  {
    value: "invoice",
    label: "Invoice Them Now",
    short: "Invoice them now",
    description: "Raises one final invoice for the pending charges.",
  },
  {
    value: "delete",
    label: "Delete Them",
    short: "Delete them",
    description: "Voids the pending charges. We never bill them.",
  },
];

const UNBILLED_LEAVE_OPTION: MenuOption = {
  value: "",
  label: "Leave Them Pending",
  short: "Leave them pending",
  description: "The charges stay unbilled and are never invoiced.",
};

/**
 * Open invoices at an immediate cancel (`account_receivables_handling`). The engine
 * fallback is `no_action` (service.ts `applyCancelMoneyHandling`); there is no business
 * default for this one, so `no_action` is the value that genuinely applies.
 */
const AR_OPTIONS: MenuOption[] = [
  {
    value: "no_action",
    label: "Leave Them As Is",
    short: "Leave them as is",
    description: "Open invoices stay open and keep dunning.",
  },
  {
    value: "schedule_payment_collection",
    label: "Collect Them Now",
    short: "Collect them now",
    description: "Tries to collect each open invoice immediately.",
  },
  {
    value: "void",
    label: "Void Them",
    short: "Void them",
    description: "Withdraws each open invoice, as if it never existed.",
  },
  {
    value: "write_off",
    label: "Write Them Off",
    short: "Write them off",
    description: "Writes off the outstanding balance on each open invoice.",
  },
];

const REFUNDABLE_OPTIONS: MenuOption[] = [
  {
    value: "no_action",
    label: "Retain Credits",
    short: "Keep credits",
    description: "The credits stay on the account.",
  },
  {
    value: "schedule_refund",
    label: "Initiate Refund",
    short: "Initiate refund",
    description: "Starts a refund of the remaining credits.",
  },
];

type CreditsOnCancel = PlanCreditResets["on_cancel_at_period_end"];
type CreditsOnPause = PlanCreditResets["on_pause"];

const FINAL_PERIOD_OPTIONS: MenuOption[] = [
  {
    value: "full_period",
    label: FINAL_PERIOD_LABELS.full_period,
    description: "The customer pays for the whole term. We issue no credit.",
  },
  {
    value: "prorated",
    label: FINAL_PERIOD_LABELS.prorated,
    description: "We issue a credit note for the time after the cancellation date.",
  },
  {
    value: "nothing",
    label: FINAL_PERIOD_LABELS.nothing,
    description: "We issue a credit note for the whole term.",
  },
];

const CREDITS_ON_CANCEL_OPTIONS: MenuOption[] = [
  {
    value: "grant_started_window",
    label: CREDIT_CANCEL_LABELS.grant_started_window,
    description: "Each window that starts before the subscription ends gives credits.",
  },
  {
    value: "stop_at_request",
    label: CREDIT_CANCEL_LABELS.stop_at_request,
    description: "No window gives credits after this cancellation is scheduled.",
  },
];

/** The help line under a per-call choice: it names the business setting it replaces. */
const thisCallOnly = (what: string, setting: string) =>
  `Applies to this ${what} only. The business setting is "${setting}".`;

export function CancelSubscriptionDialog({
  biz,
  sub,
  customerName,
  currency,
  refundableCreditsMinor = 0,
  unbilledChargesMinor = 0,
  openInvoicesMinor = 0,
  openInvoicesCount = 0,
  periodEnd,
  unusedDays,
  defaultCancelOption,
  defaultCreditOption,
  defaultUnbilledOption,
  reasons,
  reasonRequired = false,
  defaultFinalPeriod = "full_period",
  defaultCreditsOnCancel,
  trigger = "rail",
}: {
  biz: string;
  sub: string;
  customerName?: string;
  currency?: string;
  refundableCreditsMinor?: number;
  /** Total of this subscription's PENDING unbilled charges — the rows the option acts on. */
  unbilledChargesMinor?: number;
  /** Outstanding total + count of this subscription's OPEN invoices (the AR the option acts on). */
  openInvoicesMinor?: number;
  openInvoicesCount?: number;
  periodEnd?: string;
  /**
   * Cancellation reasons offered in the picker, from Settings → Reason codes.
   * Omitted (or empty) falls back to the built-in list, which is also what the
   * backend serves for a business that has configured none.
   */
  reasons?: Array<{ code: string; label: string }>;
  /** `required_reasons.cancel_subscription`: the API refuses a cancel without a code. */
  reasonRequired?: boolean;
  /** Whole days left in the current term — shown in the credit-handling label. */
  unusedDays?: number;
  /**
   * The business's billing-rule defaults (SET-1). We preselect the ACTUAL default
   * rather than offering a vague "business default" choice, so the dialog shows
   * what will happen — and we always post the option explicitly.
   * Engine fallbacks when a business leaves them unset: cancel `immediately`,
   * credits `none` (src/modules/subscriptions/service.ts cancelSubscriptionWithOptions).
   */
  defaultCancelOption?: "immediately" | "end_of_term";
  defaultCreditOption?: "none" | "prorate" | "full";
  /**
   * `businesses.default_unbilled_on_cancel` (SET-1). NOT NULL DEFAULT `no_action`, so an
   * unresolved business falls back to the same value the column would have held.
   */
  defaultUnbilledOption?: "no_action" | "invoice" | "delete";
  /** `specific_date_cancel_final_period`, resolved: the last-term choice's preselection. */
  defaultFinalPeriod?: SpecificDateFinalPeriod;
  /**
   * `plan_credits.on_cancel_at_period_end`, resolved. Set only when the subscription has
   * plan credits on a reset window; otherwise the choice has no effect and is not shown.
   */
  defaultCreditsOnCancel?: CreditsOnCancel;
  /** `button`: an outline header button instead of the rail text link. */
  trigger?: "rail" | "button";
}) {
  const initialWhen = defaultCancelOption ?? "immediately";
  const initialCredit = defaultCreditOption ?? "none";
  const resolvedUnbilledDefault = defaultUnbilledOption ?? "no_action";
  // '' posts nothing, which the service resolves back to this business's `no_action`.
  const initialUnbilled = resolvedUnbilledDefault === "no_action" ? "" : resolvedUnbilledDefault;
  const [open, setOpen] = React.useState(false);
  const [when, setWhen] = React.useState<string>(initialWhen);
  const [reasonCode, setReasonCode] = React.useState("");
  const [creditOption, setCreditOption] = React.useState<string>(initialCredit);
  const [refundHandling, setRefundHandling] = React.useState("no_action");
  const [unbilledOption, setUnbilledOption] = React.useState<string>(initialUnbilled);
  const [arHandling, setArHandling] = React.useState("no_action");
  const [cancelAt, setCancelAt] = React.useState("");
  const [finalPeriod, setFinalPeriod] = useDefaultState<string>(defaultFinalPeriod);
  const [creditsOnCancel, setCreditsOnCancel] = useDefaultState<string>(
    defaultCreditsOnCancel ?? "",
  );
  /**
   * Refundable credit THIS cancellation would create, reported by the estimate.
   *
   * The refundable-credits row was gated on the customer's CURRENT balance alone, so a
   * cancellation that mints a refundable credit note hid the row that decides whether it
   * leaves as cash — the option was live in the engine the whole time. Measured on the
   * real book: ₹26,484.00 of credit to be issued, row absent, and
   * `refundable_credits_handling: schedule_refund` returning `refund_minor` of exactly
   * that. A control that does nothing is a bug; so is withholding one that does.
   */
  const [estimatedNewRefundableMinor, setEstimatedNewRefundableMinor] = React.useState(0);

  const immediate = when === "immediately";
  // The 4th choice. tmbilling never raises advance invoices, so the subscription
  // billing term always ends with the current term — it posts as end_of_term and
  // the note below says so.
  const billingTerm = when === "end_of_billing_term";
  // What would be refundable AFTER this cancellation: what the customer already holds,
  // plus what the cancellation itself is about to mint.
  const refundableAfterCancel = refundableCreditsMinor + estimatedNewRefundableMinor;
  const hasRefundable = refundableAfterCancel > 0;
  const hasUnbilled = unbilledChargesMinor > 0;
  const hasOpenInvoices = openInvoicesCount > 0;
  const unbilledOptions = React.useMemo(
    () =>
      resolvedUnbilledDefault === "no_action"
        ? [...UNBILLED_OPTIONS, UNBILLED_LEAVE_OPTION]
        : UNBILLED_OPTIONS,
    [resolvedUnbilledDefault],
  );
  const cancelReasons = reasons?.length ? reasons : CANCEL_REASONS;
  const reasonLabel = cancelReasons.find((r) => r.code === reasonCode)?.label ?? "";
  const actionLabel = immediate ? "Cancel Now" : "Schedule Cancellation";

  // ONE source for what gets posted and what gets priced. The hidden inputs below and
  // the outcome rail both read this, so the preview cannot describe a different
  // cancellation from the one the button submits — which is the only way a preview of
  // an irreversible action is worth anything.
  const posted = {
    cancel_option: billingTerm ? "end_of_term" : when,
    cancel_at: when === "specific_date" ? cancelAt : "",
    credit_option_for_current_term_charges: immediate ? creditOption : "",
    unbilled_charges_option: immediate && hasUnbilled ? unbilledOption : "",
    account_receivables_handling: immediate && hasOpenInvoices ? arHandling : "",
    refundable_credits_handling: immediate && hasRefundable ? refundHandling : "",
    // Per-call overrides: sent only when they differ, so the business rule stays the default.
    final_period: when === "specific_date" && finalPeriod !== defaultFinalPeriod ? finalPeriod : "",
    plan_credits_on_cancel_at_period_end:
      !immediate && defaultCreditsOnCancel && creditsOnCancel !== defaultCreditsOnCancel
        ? creditsOnCancel
        : "",
  };

  const whenOptions: MenuOption[] = [
    { value: "immediately", label: "Cancel immediately" },
    {
      value: "end_of_term",
      label: `Cancel at end of current term${periodEnd ? ` (${periodEnd})` : ""}`,
    },
    { value: "specific_date", label: "Cancel on a specific date" },
    { value: "end_of_billing_term", label: "Cancel at end of subscription billing term" },
  ];

  const handleOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) {
      setWhen(initialWhen);
      setReasonCode("");
      setCreditOption(initialCredit);
      setRefundHandling("no_action");
      setUnbilledOption(initialUnbilled);
      setArHandling("no_action");
      setCancelAt("");
      setFinalPeriod(defaultFinalPeriod);
      setCreditsOnCancel(defaultCreditsOnCancel ?? "");
    }
  };

  return (
    <>
      {trigger === "button" ? (
        <Button
          type="button"
          variant="outline"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          className="text-destructive hover:text-destructive"
        >
          Cancel subscription
        </Button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded px-1 py-0.5 text-left text-sm font-medium text-destructive hover:underline"
        >
          Cancel Subscription ▶
        </button>
      )}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          key={String(open)}
          size="xl"
          className="flex max-h-[85vh] flex-col overflow-hidden"
        >
          <ActionForm
            action={cancelSubscriptionFullAction}
            /* The form is the scroll body, so the close button — a sibling of this,
               outside the scroller — stays where it is. */
            className="-mx-6 min-h-0 flex-1 space-y-1 overflow-y-auto px-6"
            onSuccess={() => setOpen(false)}
          >
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="sub" value={sub} />
            <input type="hidden" name="cancel_option" value={posted.cancel_option} />
            {when === "specific_date" ? (
              <input type="hidden" name="cancel_at" value={posted.cancel_at} />
            ) : null}
            <input type="hidden" name="cancel_reason_code" value={reasonCode} />
            <input type="hidden" name="cancel_reason" value={reasonLabel} />
            <input
              type="hidden"
              name="credit_option_for_current_term_charges"
              value={posted.credit_option_for_current_term_charges}
            />
            <input
              type="hidden"
              name="refundable_credits_handling"
              value={posted.refundable_credits_handling}
            />
            {/* Money handling is posted for an IMMEDIATE cancel only, matching the two
                rows above. A specific_date cancel carries all four options into the
                scheduled row (scheduled-changes.ts ScheduledCancelOptions) but this
                dialog has never offered them there; end_of_term ignores them entirely
                (service.ts returns before the money steps). Change all four together. */}
            <input
              type="hidden"
              name="unbilled_charges_option"
              value={posted.unbilled_charges_option}
            />
            <input
              type="hidden"
              name="account_receivables_handling"
              value={posted.account_receivables_handling}
            />
            <input type="hidden" name="final_period" value={posted.final_period} />
            <input
              type="hidden"
              name="plan_credits_on_cancel_at_period_end"
              value={posted.plan_credits_on_cancel_at_period_end}
            />

            {/* Header: title left, red action + Dismiss right.
                `pr-12` reserves the close button's corner — the × is positioned
                against the dialog box and landed on the action without it. */}
            <div className="flex items-start justify-between gap-4 pr-12 pb-2">
              <DialogHeader className="space-y-0 text-left">
                <DialogTitle className="text-lg font-bold">
                  Cancel Subscription{customerName ? ` for ${customerName}` : ""}
                </DialogTitle>
              </DialogHeader>
              <div className="flex flex-col items-center gap-1.5">
                <SubmitButton variant="destructive" disabled={reasonRequired && !reasonCode}>
                  {actionLabel}
                </SubmitButton>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  Keep subscription
                </button>
              </div>
            </div>

            <div>
              <CancelRow label="When do you want to cancel the subscription?">
                <InlineMenu
                  value={when}
                  options={whenOptions}
                  onChange={setWhen}
                  aria-label="When to cancel"
                />
              </CancelRow>

              {when === "specific_date" ? (
                <CancelRow label="Cancellation date">
                  <DateTimeField
                    onUtcChange={setCancelAt}
                    required
                    className="w-56"
                    aria-label="Cancellation date"
                  />
                </CancelRow>
              ) : null}

              {when === "specific_date" ? (
                <CancelRow
                  label="How do you want to bill the last term?"
                  help={thisCallOnly("cancellation", FINAL_PERIOD_LABELS[defaultFinalPeriod])}
                >
                  <InlineMenu
                    value={finalPeriod}
                    options={FINAL_PERIOD_OPTIONS}
                    onChange={setFinalPeriod}
                    aria-label="Last term billing"
                  />
                </CancelRow>
              ) : null}

              {/* Only for plan credits on a reset window: other credits ignore this rule. */}
              {!immediate && defaultCreditsOnCancel ? (
                <CancelRow
                  label="What do you want to do with plan credits until the subscription ends?"
                  help={thisCallOnly("cancellation", CREDIT_CANCEL_LABELS[defaultCreditsOnCancel])}
                >
                  <InlineMenu
                    value={creditsOnCancel}
                    options={CREDITS_ON_CANCEL_OPTIONS}
                    onChange={setCreditsOnCancel}
                    aria-label="Plan credits until the end"
                  />
                </CancelRow>
              ) : null}

              <CancelRow
                label={reasonRequired ? "Cancellation reason (required)" : "Cancellation reason"}
                help={
                  reasonRequired
                    ? "This business requires a reason for each cancellation."
                    : "Record why a customer is cancelling their subscription."
                }
              >
                <InlineMenu
                  value={reasonCode}
                  options={cancelReasons.map((r) => ({ value: r.code, label: r.label }))}
                  onChange={setReasonCode}
                  placeholder="Select"
                  scrollable
                  aria-label="Cancellation reason"
                />
              </CancelRow>

              {/* No "Decommission this subscription" row: there is no decommission
                  flag. No "Include cancellation date in the billing period" row under
                  prorated credits either — the inclusive-day boundary is decided by the
                  business's billing mode (Settings → Billing rules → Billing mode), not
                  per cancel. Add either row WITH the backend, never before. */}
              {immediate ? (
                <CancelRow
                  label={`How do you want to handle credits for the unused period${
                    typeof unusedDays === "number" && unusedDays > 0
                      ? ` (${unusedDays} ${unusedDays === 1 ? "day" : "days"})`
                      : ""
                  }?`}
                >
                  <InlineMenu
                    value={creditOption}
                    options={CREDIT_OPTIONS}
                    onChange={setCreditOption}
                    aria-label="Credit handling"
                  />
                </CancelRow>
              ) : null}

              {/* Both rows render only when there is something for them to act on —
                  the engine's unbilled step only touches `pending` rows and the AR step
                  only touches OPEN invoices (posted / payment_due / not_paid, the same
                  set behind `due_invoices_count`). With none of either, the option would
                  be a choice about nothing. */}
              {immediate && hasUnbilled ? (
                <CancelRow
                  label={
                    <>
                      What do you want to do with the unbilled charges of{" "}
                      <span className="font-semibold">
                        {money(unbilledChargesMinor, currency ?? "USD")}
                      </span>
                      ?
                    </>
                  }
                >
                  <InlineMenu
                    value={unbilledOption}
                    options={unbilledOptions}
                    onChange={setUnbilledOption}
                    aria-label="Unbilled charges handling"
                  />
                </CancelRow>
              ) : null}

              {immediate && hasOpenInvoices ? (
                <CancelRow
                  label={
                    <>
                      How do you want to handle the {openInvoicesCount} open invoice
                      {openInvoicesCount === 1 ? "" : "s"} totaling{" "}
                      <span className="font-semibold">
                        {money(openInvoicesMinor, currency ?? "USD")}
                      </span>
                      ?
                    </>
                  }
                >
                  <InlineMenu
                    value={arHandling}
                    options={AR_OPTIONS}
                    onChange={setArHandling}
                    aria-label="Open invoices handling"
                  />
                </CancelRow>
              ) : null}

              {immediate && hasRefundable ? (
                <CancelRow
                  label={
                    <>
                      What do you want to do with the remaining refundable credits of{" "}
                      <span className="font-semibold">
                        {money(refundableAfterCancel, currency ?? "USD")}
                      </span>
                      ?
                    </>
                  }
                >
                  <InlineMenu
                    value={refundHandling}
                    options={REFUNDABLE_OPTIONS}
                    onChange={setRefundHandling}
                    aria-label="Refundable credits handling"
                  />
                </CancelRow>
              ) : null}
            </div>

            <CancelOutcome
              biz={biz}
              sub={sub}
              currency={currency ?? "USD"}
              options={posted}
              onEstimate={(e) =>
                setEstimatedNewRefundableMinor(
                  e?.cancellation_credit.refundable_credit_note_minor ?? 0,
                )
              }
            />

            {billingTerm ? (
              <div className="mt-2 rounded border border-warning/25 bg-warning-soft px-3 py-2 text-xs text-warning">
                The subscription is canceled at the end of the current term, because no advance
                invoice exists.
              </div>
            ) : null}
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Pause ───────────────────────────────────────────────────────────────────

const LOCKED_HELP = "Locked in Settings → Billing rules → Pause and resume.";

export function PauseSubscriptionDialog({
  biz,
  sub,
  periodEnd,
  defaults,
  defaultCreditsOnPause,
}: {
  biz: string;
  sub: string;
  periodEnd?: string;
  /**
   * `plan_credits.on_pause`, resolved. Set only when the subscription has plan credits on
   * a reset window; otherwise the choice has no effect and is not shown.
   */
  defaultCreditsOnPause?: CreditsOnPause;
  /** The business's resolved `pause_config` (resolveResumeDefaults). */
  defaults: {
    pauseOption: "immediately" | "end_of_term";
    unbilledOnPause: "retain" | "invoice";
    dunningOnPause: "continue" | "stop";
    locked: string[];
  };
}) {
  const [open, setOpen] = React.useState(false);
  const [option, setOption] = useDefaultState<string>(defaults.pauseOption);
  const [creditsOnPause, setCreditsOnPause] = useDefaultState<string>(defaultCreditsOnPause ?? "");
  const handleOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) {
      setOption(defaults.pauseOption);
      setCreditsOnPause(defaultCreditsOnPause ?? "");
    }
  };
  const isLocked = (k: string) => defaults.locked.includes(k);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded px-1 py-0.5 text-left text-sm text-primary hover:underline"
      >
        Pause subscription
      </button>
      <DialogShell
        open={open}
        onOpenChange={handleOpenChange}
        title="Pause subscription"
        description="We do not raise renewal invoices while the subscription is paused. To resume automatically, pause for N billing cycles."
      >
        <ActionForm
          action={pauseSubscriptionFullAction}
          className="space-y-3"
          onSuccess={() => setOpen(false)}
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="sub" value={sub} />
          <Field
            name="pause_option"
            label="Pause"
            help={isLocked("pause_option") ? LOCKED_HELP : undefined}
          >
            <SelectField
              name="pause_option"
              value={option}
              onValueChange={setOption}
              disabled={isLocked("pause_option")}
              ariaLabel="When to pause"
              options={[
                { value: "immediately", label: "Immediately" },
                {
                  value: "end_of_term",
                  label: `At the end of the current term${periodEnd ? ` (${periodEnd})` : ""}`,
                },
                { value: "specific_date", label: "On a specific date…" },
                { value: "billing_cycles", label: "For N billing cycles (auto-resume)" },
              ]}
            />
          </Field>
          {option === "specific_date" ? (
            <Field name="pause_date" label="Pause on" required>
              <DateTimeField name="pause_date" required />
            </Field>
          ) : null}
          {option === "billing_cycles" ? (
            <Field
              name="skip_billing_cycles"
              label="Skip billing cycles"
              required
              help="The subscription pauses at term end and resumes automatically after skipping this many cycles."
            >
              <Input
                name="skip_billing_cycles"
                type="number"
                min={1}
                required
                className="w-32 tabular-nums"
              />
            </Field>
          ) : null}
          {/* Preselect the business's pause_config defaults. "no_action" is sent explicitly,
              so "Leave them" means leave them even where the business default invoices. */}
          <Field
            name="unbilled_charges_handling"
            label="Unbilled charges"
            help={isLocked("unbilled_on_pause") ? LOCKED_HELP : undefined}
          >
            <SelectField
              name="unbilled_charges_handling"
              defaultValue={defaults.unbilledOnPause === "invoice" ? "invoice" : "no_action"}
              disabled={isLocked("unbilled_on_pause")}
              ariaLabel="Unbilled charges"
              options={[
                { value: "no_action", label: "Leave them as unbilled charges" },
                { value: "invoice", label: "Invoice them now" },
                { value: "delete", label: "Delete them" },
              ]}
            />
          </Field>
          <Field
            name="dunning_handling"
            label="Dunning (payment retries)"
            help={isLocked("dunning_on_pause") ? LOCKED_HELP : undefined}
          >
            <SelectField
              name="dunning_handling"
              defaultValue={defaults.dunningOnPause}
              disabled={isLocked("dunning_on_pause")}
              ariaLabel="Dunning handling"
              options={[
                { value: "continue", label: "Continue retries while paused" },
                { value: "stop", label: "Stop retries" },
              ]}
            />
          </Field>
          {/* Only for plan credits on a reset window: other credits ignore this rule. Sent
              only when it differs, so the business rule stays the default. */}
          {defaultCreditsOnPause ? (
            <input
              type="hidden"
              name="plan_credits_on_pause"
              value={creditsOnPause !== defaultCreditsOnPause ? creditsOnPause : ""}
            />
          ) : null}
          {defaultCreditsOnPause ? (
            <Field
              name="plan_credits_on_pause"
              label="Plan credits while paused"
              help={thisCallOnly("pause", CREDIT_PAUSE_LABELS[defaultCreditsOnPause])}
            >
              <SelectField
                value={creditsOnPause}
                onValueChange={setCreditsOnPause}
                ariaLabel="Plan credits while paused"
                options={(Object.keys(CREDIT_PAUSE_LABELS) as CreditsOnPause[]).map((v) => ({
                  value: v,
                  label: CREDIT_PAUSE_LABELS[v],
                }))}
              />
            </Field>
          ) : null}
          <FooterButtons onCancel={() => setOpen(false)} submitLabel="Pause subscription" />
        </ActionForm>
      </DialogShell>
    </>
  );
}

// ─── Resume ──────────────────────────────────────────────────────────────────

const RESUME_CHARGE_LABELS: Record<ResumeCharges, string> = {
  invoice_immediately: "Invoice immediately",
  add_to_unbilled_charges: "Add to unbilled charges",
};
const UNPAID_ON_RESUME_LABELS: Record<UnpaidOnResume, string> = {
  no_action: "No action",
  schedule_payment_collection: "Attempt collection",
};
type ResumeCharges = "invoice_immediately" | "add_to_unbilled_charges";
type UnpaidOnResume = "no_action" | "schedule_payment_collection";

export function ResumeSubscriptionDialog({
  biz,
  sub,
  inTerm,
  termEnd,
  defaultCharges,
  defaultUnpaid,
  locked = [],
}: {
  biz: string;
  sub: string;
  /** The paid term is still running, so the resume continues it and charges nothing. */
  inTerm: boolean;
  /** Formatted end of the current term, when there is one. */
  termEnd?: string;
  /** The business's resolved `pause_config` defaults. */
  defaultCharges: ResumeCharges;
  defaultUnpaid: UnpaidOnResume;
  /** Locked `pause_config` keys; a locked field is read-only. */
  locked?: string[];
}) {
  const [open, setOpen] = React.useState(false);
  const withDefault = <T extends string>(labels: Record<T, string>, def: T) =>
    (Object.keys(labels) as T[]).map((value) => ({
      value,
      label: value === def ? `${labels[value]} (business default)` : labels[value],
    }));
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded px-1 py-0.5 text-left text-sm text-primary hover:underline"
      >
        Resume subscription
      </button>
      <DialogShell
        open={open}
        onOpenChange={setOpen}
        title="Resume subscription"
        description={
          inTerm
            ? `The paid term${termEnd ? ` (ends ${termEnd})` : ""} is still running. If you resume, the term continues and we charge nothing new.`
            : "The paid term ended. A new term starts today, and we bill it."
        }
      >
        <ActionForm
          action={resumeSubscriptionFullAction}
          className="space-y-3"
          onSuccess={() => setOpen(false)}
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="sub" value={sub} />
          {/* An in-term resume ignores charges_handling, so the control is omitted there. */}
          {inTerm ? null : (
            <Field
              name="charges_handling"
              label="New term's charge"
              help={
                locked.includes("charges_on_resume")
                  ? LOCKED_HELP
                  : "If you invoice immediately, we collect the charge now. If you add it to unbilled charges, the full amount waits for the next invoice."
              }
            >
              <SelectField
                name="charges_handling"
                defaultValue={defaultCharges}
                disabled={locked.includes("charges_on_resume")}
                ariaLabel="Charges handling"
                options={withDefault(RESUME_CHARGE_LABELS, defaultCharges)}
              />
            </Field>
          )}
          <Field
            name="unpaid_invoices_handling"
            label="Unpaid invoices"
            help={locked.includes("unpaid_invoices_on_resume") ? LOCKED_HELP : undefined}
          >
            <SelectField
              name="unpaid_invoices_handling"
              defaultValue={defaultUnpaid}
              disabled={locked.includes("unpaid_invoices_on_resume")}
              ariaLabel="Unpaid invoices"
              options={withDefault(UNPAID_ON_RESUME_LABELS, defaultUnpaid)}
            />
          </Field>
          <FooterButtons onCancel={() => setOpen(false)} submitLabel="Resume subscription" />
        </ActionForm>
      </DialogShell>
    </>
  );
}

// ─── Change term end ─────────────────────────────────────────────────────────

export function ChangeTermEndDialog({
  biz,
  sub,
  currentTermEnd,
  className,
}: {
  biz: string;
  sub: string;
  /** ISO string of the current period end (pre-fills the picker). */
  currentTermEnd?: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "rounded px-1 py-0.5 text-left text-sm text-primary hover:underline",
          className,
        )}
      >
        Change term end
      </button>
      <DialogShell
        open={open}
        onOpenChange={setOpen}
        title="Change term end"
        description="Change the end of the current term. A shorter prepaid term can give a prorated credit. A longer term can raise a charge."
      >
        <ActionForm
          action={changeTermEndAction}
          className="space-y-3"
          onSuccess={() => setOpen(false)}
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="sub" value={sub} />
          <Field name="term_ends_at" label="Term ends at" required>
            <DateTimeField name="term_ends_at" defaultValue={currentTermEnd} required />
          </Field>
          <CheckboxField name="prorate" defaultChecked label="Prorate the difference" />
          <CheckboxField name="invoice_immediately" label="Invoice the proration immediately" />
          <FooterButtons onCancel={() => setOpen(false)} submitLabel="Change term end" />
        </ActionForm>
      </DialogShell>
    </>
  );
}

// ─── Edit trial end date ─────────────────────────────────────────────────────

export function EditTrialEndDialog({
  biz,
  sub,
  currentTrialEnd,
  endTrialNowBlocked,
  className,
}: {
  biz: string;
  sub: string;
  /** ISO string of the current trial end (pre-fills the picker). */
  currentTrialEnd?: string;
  /**
   * The subscription auto-collects and the customer has no payment method at all, which
   * the engine REFUSES for `immediately` (converting would cancel it for `no_card`).
   * Said here rather than let the operator submit into a 400. Moving the DATE is
   * unaffected and stays available.
   */
  endTrialNowBlocked?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [immediately, setImmediately] = React.useState(false);
  const handleOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) setImmediately(false);
  };
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "rounded px-1 py-0.5 text-left text-sm text-primary hover:underline",
          className,
        )}
      >
        Edit trial end date
      </button>
      <DialogShell
        open={open}
        onOpenChange={handleOpenChange}
        title="Edit trial end date"
        description="Make the trial longer or shorter. Or end it immediately to activate the subscription and bill the first term now."
      >
        <ActionForm
          action={editTrialEndAction}
          className="space-y-3"
          onSuccess={() => setOpen(false)}
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="sub" value={sub} />
          <Field name="trial_end" label="New trial end date" required={!immediately}>
            <DateTimeField
              name="trial_end"
              defaultValue={currentTrialEnd}
              disabled={immediately}
              required={!immediately}
            />
          </Field>
          <CheckboxField
            name="immediately"
            checked={immediately}
            onCheckedChange={setImmediately}
            label="End trial immediately. This activates the subscription and bills the first term now."
          />
          {immediately && endTrialNowBlocked ? (
            <Alert tone="warning">
              This subscription auto-collects, and the customer has no payment method on file. You
              cannot end the trial now, because the conversion would cancel the subscription for no
              card. Add a payment method. Or disable auto-collection, so that we send the first
              invoice instead.
            </Alert>
          ) : null}
          <FooterButtons
            onCancel={() => setOpen(false)}
            submitLabel="Save"
            submitDisabled={immediately && endTrialNowBlocked}
          />
        </ActionForm>
      </DialogShell>
    </>
  );
}

// ─── Add manual discount (%/amount, no coupon object) ────

export function AddManualDiscountDialog({
  biz,
  sub,
  currency,
  className,
}: {
  biz: string;
  sub: string;
  /** The subscription's currency — the fixed-amount field is denominated in it. */
  currency: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [type, setType] = React.useState<"percent" | "amount">("percent");
  const handleOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) setType("percent");
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "rounded px-1 py-0.5 text-left text-sm text-primary hover:underline",
          className,
        )}
      >
        Add manual discount
      </button>
      <DialogShell
        open={open}
        onOpenChange={handleOpenChange}
        title="Add manual discount"
        description="Apply a percent or fixed-amount discount directly to this subscription, without a coupon."
      >
        <ActionForm
          action={applyManualDiscountAction}
          className="space-y-3"
          onSuccess={() => setOpen(false)}
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="sub" value={sub} />
          <Field name="type" label="Discount type">
            <SelectField
              name="type"
              value={type}
              onValueChange={(v) => setType(v as "percent" | "amount")}
              ariaLabel="Discount type"
              options={[
                { value: "percent", label: "Percent off" },
                { value: "amount", label: "Fixed amount off" },
              ]}
            />
          </Field>
          {/* One `value` field, two units. A percent is a plain integer; a fixed
              amount is money, so it gets `MoneyInput` — typed in major units and
              posted as integer minor under the same `value` name the action reads.
              Keyed on `type` so switching discards the previous number instead of
              reinterpreting "20" as ₹0.20. */}
          <Field
            name="value"
            label={type === "percent" ? "Percent (1-100)" : "Amount off"}
            required
          >
            {type === "percent" ? (
              <Input key="percent" name="value" type="number" min={1} max={100} step={1} required />
            ) : (
              <MoneyInput key="amount" name="value" currency={currency} required />
            )}
          </Field>
          <Field name="duration" label="Duration">
            <SelectField
              name="duration"
              defaultValue="one_time"
              ariaLabel="Discount duration"
              options={[
                { value: "one_time", label: "Next invoice only" },
                { value: "forever", label: "Forever (until removed)" },
              ]}
            />
          </Field>
          <Field name="note" label="Note (optional)">
            <Input name="note" type="text" maxLength={500} />
          </Field>
          <FooterButtons onCancel={() => setOpen(false)} submitLabel="Add discount" />
        </ActionForm>
      </DialogShell>
    </>
  );
}
