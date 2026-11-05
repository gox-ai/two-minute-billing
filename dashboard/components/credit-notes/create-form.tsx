"use client";

import { useDisplayTz } from "@/components/business-tz";
import * as React from "react";
import { useRouter } from "next/navigation";
import { useDefaultState } from "@/lib/use-default-state";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/money-input";
import { money, toMajor, fmtDateShort } from "@/lib/format";
import {
  createCreditNoteAction,
  loadCreditableInvoiceAction,
  searchCreditableInvoicesAction,
} from "@/app/(dashboard)/businesses/[biz]/credit_notes/actions";
import type { CreditNoteKind } from "@/lib/api/credit-notes";
import { SelectField } from "@/components/ui/select-field";
import { Combobox } from "@/components/ui/combobox";
import { CREDITABLE_STATUSES, type InvoiceChoice, type PickInvoice } from "./invoice-choice";
import { creditReasonOptions } from "@/lib/credit-reason-codes";
import { RecordCard } from "@/components/patterns/record-page";
import type { Crumb } from "@/components/page-header";
import { SummaryCard } from "@/components/catalog/form-kit";
import {
  ChoiceCardsField,
  FieldBlock,
  FooterFigure,
  SubFormFrame,
} from "@/components/subscriptions/sub-form-frame";

const MAX_NOTE =
  "The maximum includes the tax on the line. Earlier credit notes on the line decrease it.";

/**
 * Create-credit-note form. Picks an invoice (or pre-selects one via `?invoice=`),
 * chooses a kind + reason, then allocates a credit amount against each invoice
 * line. The CN total is the sum of the per-line allocations, shown live and
 * validated (each ≤ that line's `creditable_minor`, the engine's own cap). Line rows are
 * posted as the parallel `item_line[]` / `item_description[]` / `item_amount_minor[]`
 * arrays the server action reads.
 */
export function CreateCreditNoteForm({
  biz,
  preselected,
  crumbs,
  reasonCodeRequired = false,
}: {
  biz: string;
  crumbs: Crumb[];
  /** `required_reasons.create_credit_note`: the API refuses a credit note without a code. */
  reasonCodeRequired?: boolean;
  /** From `?invoice=`, loaded with its lines by the page. */
  preselected?: PickInvoice | null;
}) {
  const router = useRouter();
  const tz = useDisplayTz();
  const [invoice, setInvoice] = useDefaultState<PickInvoice | null>(
    preselected ?? null,
    (value) => value?.id ?? "",
  );
  const invoiceId = invoice?.id ?? "";
  // The kind must follow the PRESELECTED invoice, not a fixed default. Hardcoding
  // 'adjustment' here silently discarded every deep link from a PAID invoice: a paid
  // invoice is not adjustment-eligible, so the reconcile effect below cleared the
  // selection and the picker did not even list it. Since the invoice rail offers
  // "Issue credit note" on paid invoices — which is exactly what a refundable credit
  // note is for — that broke the form's main entry point.
  const [kind, setKind] = React.useState<CreditNoteKind>(
    preselected?.status === "paid" ? "refundable" : "adjustment",
  );

  // Per-line allocation amounts, keyed by line id (minor units, as strings).
  const [alloc, setAlloc] = React.useState<Record<string, string>>({});

  // Server search: the engine matches number, id and customer name/email, and returns
  // only invoices this kind can credit. `seq` drops answers to superseded keystrokes.
  const [choices, setChoices] = React.useState<InvoiceChoice[]>([]);
  const [searching, setSearching] = React.useState(false);
  const seq = React.useRef(0);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const search = React.useCallback(
    (q: string, delay = 250) => {
      if (timer.current) clearTimeout(timer.current);
      const mine = ++seq.current;
      timer.current = setTimeout(async () => {
        setSearching(true);
        const found = await searchCreditableInvoicesAction(biz, kind, q);
        if (mine !== seq.current) return;
        setChoices(found);
        setSearching(false);
      }, delay);
    },
    [biz, kind],
  );
  React.useEffect(() => {
    search("", 0);
  }, [search]);

  const [loadingInvoice, setLoadingInvoice] = React.useState(false);
  const select = async (id: string) => {
    setAlloc({});
    if (!id) return setInvoice(null);
    setLoadingInvoice(true);
    const loaded = await loadCreditableInvoiceAction(biz, id);
    setLoadingInvoice(false);
    setInvoice(loaded);
  };

  const lines = invoice?.lines ?? [];
  const currency = invoice?.currency ?? "USD";

  // `alloc` still holds MINOR units — that is what gets posted and what the totals
  // are summed in. The inputs are `MoneyInput`s, so the operator types major units
  // and the component reports back the integer minor value; a sub-minor amount is
  // therefore impossible here (it was previously a validation case, "Whole minor
  // units only", because the field itself took raw minor units).
  const rows = lines.map((l) => {
    const raw = alloc[l.id] ?? "";
    const amount = raw === "" ? 0 : Number(raw);
    const over = Number.isFinite(amount) && amount > l.creditable_minor;
    return { line: l, amount: Number.isFinite(amount) ? amount : 0, over };
  });

  const total = rows.reduce((s, r) => s + (r.amount > 0 ? r.amount : 0), 0);
  const anyOver = rows.some((r) => r.over);
  const hasPositive = rows.some((r) => r.amount > 0);
  // Adjustments can't exceed what's still owed on the invoice (backend caps at amount_due).
  const dueCap =
    kind === "adjustment" && invoice ? (invoice.amount_due_minor ?? invoice.total_minor) : null;
  const overDue = dueCap != null && total > dueCap;
  const canSubmit = Boolean(invoice) && hasPositive && !anyOver && !overDue;

  const invoiceLabel = invoice ? (invoice.number ?? invoice.id) : null;
  const lead = !invoice
    ? "Select an invoice to credit."
    : total === 0
      ? `${invoiceLabel} has no allocated credit yet.`
      : kind === "adjustment"
        ? `${money(total, currency)} credit. This reduces the amount due on ${invoiceLabel}.`
        : invoice.grant_credits_minor
          ? `${money(total, currency)} credit on ${invoiceLabel}. The part that credit grants paid goes back to the grants. The customer gets the rest as refundable credit.`
          : `${money(total, currency)} credit on ${invoiceLabel}. The customer gets this amount as refundable credit.`;

  return (
    <ActionForm
      action={createCreditNoteAction}
      onSuccess={(r) => r.redirectTo && router.push(r.redirectTo)}
    >
      <input type="hidden" name="biz" value={biz} />

      <SubFormFrame
        crumbs={crumbs}
        title="New credit note"
        description="Credit a customer against an invoice's line items."
        cancelHref={`/businesses/${biz}/credit_notes`}
        footerNote={
          !invoice ? "Select an invoice to continue" : `Credit note total ${money(total, currency)}`
        }
        footerFigure={<FooterFigure label="Credit total" value={money(total, currency)} />}
        primary={<SubmitButton disabled={!canSubmit}>Create credit note</SubmitButton>}
        aside={
          <SummaryCard
            lead={lead}
            rows={[
              { label: "Invoice", value: invoiceLabel ?? "—" },
              { label: "Type", value: kind === "adjustment" ? "Adjustment" : "Refundable" },
              invoice
                ? { label: "Invoice total", value: money(invoice.total_minor, currency) }
                : null,
              dueCap != null ? { label: "Amount due", value: money(dueCap, currency) } : null,
              { label: "Credit total", value: money(total, currency) },
            ]}
            note={
              kind === "adjustment"
                ? `The credit on a line cannot be more than its maximum. ${MAX_NOTE} The total cannot be more than the amount due.`
                : `The credit on a line cannot be more than its maximum. ${MAX_NOTE}`
            }
          />
        }
      >
        <RecordCard title="Invoice">
          <div className="flex flex-col gap-5">
            <FieldBlock label="Type">
              <ChoiceCardsField
                name="kind"
                ariaLabel="Credit note type"
                value={kind}
                onValueChange={(v) => {
                  const next = v as CreditNoteKind;
                  setKind(next);
                  // Drop a selection the new kind cannot credit.
                  if (invoice && !CREDITABLE_STATUSES[next].includes(invoice.status)) {
                    setInvoice(null);
                    setAlloc({});
                  }
                }}
                options={[
                  {
                    value: "adjustment",
                    label: "Adjustment",
                    hint: "Reduces an unpaid invoice’s balance.",
                  },
                  {
                    value: "refundable",
                    label: "Refundable",
                    hint: "Returns money that the customer paid. The customer gets credit that you can refund to the payment method that paid.",
                  },
                ]}
              />
            </FieldBlock>

            <Field
              name="invoice"
              label="Invoice"
              required
              help="You can credit only the lines of this invoice."
            >
              <Combobox
                name="invoice"
                required
                value={invoiceId}
                onValueChange={select}
                ariaLabel="Invoice"
                disabled={loadingInvoice}
                placeholder={loadingInvoice ? "Loading the invoice…" : "Select an invoice…"}
                searchPlaceholder="Search by number, customer or email"
                emptyMessage={
                  kind === "adjustment"
                    ? "No open invoice matches. You can create an adjustment only for an open invoice."
                    : "No paid invoice matches. You can create a refundable credit note only for a paid invoice."
                }
                onSearchChange={(q) => search(q)}
                loading={searching}
                selectedLabel={invoice ? (invoice.number ?? invoice.id) : undefined}
                contentClassName="w-(--radix-popover-trigger-width) min-w-80"
                options={choices.map((i) => ({
                  value: i.id,
                  label: [i.number ?? i.id, i.customer].filter(Boolean).join(" \u00b7 "),
                  hint: [
                    money(i.total_minor, i.currency),
                    i.status.replace(/_/g, " "),
                    i.created_at ? fmtDateShort(i.created_at, tz) : null,
                  ]
                    .filter(Boolean)
                    .join(" \u00b7 "),
                }))}
              />
            </Field>
          </div>
        </RecordCard>

        <RecordCard
          title="Line items"
          meta={invoice ? `${lines.length} line${lines.length === 1 ? "" : "s"}` : undefined}
          flush
          footer={
            anyOver ? (
              <p className="text-xs font-medium text-destructive">
                One or more credits are more than the line maximum.
              </p>
            ) : overDue ? (
              <p className="text-xs font-medium text-destructive">
                Total {money(total, currency)} exceeds the invoice&rsquo;s remaining amount due (
                {money(dueCap!, currency)}).
              </p>
            ) : invoice && !hasPositive ? (
              <p className="text-xs text-muted-foreground">
                Enter a positive credit on at least one line.
              </p>
            ) : undefined
          }
        >
          {!invoice ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              Select an invoice to allocate credit against its line items.
            </p>
          ) : lines.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              This invoice has no line items to credit.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50 text-left">
                    <th className="px-5 py-2 font-medium text-muted-foreground">Line item</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                      Line amount
                    </th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                      Maximum
                    </th>
                    <th className="px-5 py-2 text-right font-medium text-muted-foreground">
                      Credit
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ line, over }) => (
                    <tr key={line.id} className="border-b last:border-0">
                      <td className="px-5 py-2">
                        <div className="font-medium">{line.description}</div>
                        <div className="font-mono text-xs text-muted-foreground">{line.id}</div>
                        {/* Description travels alongside the amount as parallel arrays. */}
                        <input type="hidden" name="item_description" value={line.description} />
                        <input type="hidden" name="item_line" value={line.id} />
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                        {money(line.amount_minor, currency)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(line.creditable_minor, currency)}
                      </td>
                      <td className="px-5 py-2 text-right">
                        {/* Typed in MAJOR units, posts integer minor under `item_amount_minor`.
                            A blank row posts '' and is skipped by the action. */}
                        <MoneyInput
                          name="item_amount_minor"
                          currency={currency}
                          max={toMajor(line.creditable_minor, currency)}
                          invalid={over}
                          onMinorChange={(minor) => setAlloc((a) => ({ ...a, [line.id]: minor }))}
                          className="ml-auto w-40"
                          inputClassName="text-right"
                        />
                        {over ? (
                          <p className="mt-1 text-xs font-medium text-destructive">
                            More than the maximum
                          </p>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/30">
                    <td className="px-5 py-2 font-medium" colSpan={3}>
                      Credit note total
                    </td>
                    <td className="px-5 py-2 text-right font-semibold tabular-nums">
                      {money(total, currency)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </RecordCard>

        <RecordCard title="Reason">
          <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
            <Field
              name="reason_code"
              label="Reason"
              required={reasonCodeRequired}
              help={
                reasonCodeRequired
                  ? "This business requires a reason code for each credit note."
                  : undefined
              }
            >
              <SelectField
                name="reason_code"
                ariaLabel="Reason code"
                options={creditReasonOptions()}
              />
            </Field>
            <Field
              name="reason"
              label="Note"
              help="Optional. A free-text note that we keep on the credit note."
            >
              <Input name="reason" placeholder="e.g. Overcharged for March" maxLength={500} />
            </Field>
          </div>
        </RecordCard>
      </SubFormFrame>
    </ActionForm>
  );
}
