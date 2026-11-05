"use client";

import * as React from "react";
import { useActionState } from "react";
import Link from "next/link";
import { Pencil } from "lucide-react";
import { EditDrawer } from "@/components/edit-drawer";
import { AddressFields } from "@/components/customers/address-fields";
import type { Country } from "@/lib/api/geo";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { DateTimeField } from "@/components/form/datetime-field";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CurrencySelect } from "@/components/form/currency-select";
import { MoneyInput } from "@/components/form/money-input";
import { CheckboxField } from "@/components/ui/checkbox";
import { money, toMajor, fmtDate } from "@/lib/format";
import { ActionButton } from "@/components/action-button";
import { RailButton, railItemClass, railToneClass } from "@/components/patterns/action-rail";
import { paymentMethodOptions } from "@/components/invoices/collect-invoice-dialog";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { editCustomerAction, archiveCustomerAction, restoreCustomerAction } from "@/app/actions";
import { offlineMethodOptions } from "@/lib/offline-methods";
import { BILLING_DATE_MODE_OPTIONS } from "@/lib/billing-date-mode";
import {
  managePromoCreditsAction,
  recordExcessPaymentAction,
  collectPaymentAction,
  assignPaymentMethodRoleAction,
  changeBillingDateAction,
  validateVatAction,
  clearPersonalDataAction,
  addChargeAction,
  recordOfflinePaymentAction,
} from "@/app/(dashboard)/businesses/[biz]/customers/[cus]/actions";
import type { Customer, CustomerBalance, PaymentMethod, Invoice } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";

// ── Inline form helpers ───────────────────────────────────────────────────────

function HiddenFields({ fields }: { fields: Record<string, string> }) {
  return (
    <>
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

// ── Credit dialogs ────────────────────────────────────────────────────────────

/** The customer's balance in `currency`, or all-zero when they've never transacted in it. */
function balanceFor(balances: CustomerBalance[] | undefined, currency: string): CustomerBalance {
  return (
    balances?.find((b) => b.currency_code === currency) ?? {
      currency_code: currency,
      promotional_credits: 0,
      refundable_credits: 0,
      excess_payments: 0,
    }
  );
}

/**
 * Amount + currency pair shared by both credit dialogs.
 *
 * Amount is MAJOR units with the currency prefixed inside the field, e.g. `INR 0.00`.
 * `MoneyInput` submits
 * integer minor units under `amount_minor`, so the server contract is unchanged —
 * only the human-facing unit is. It used to read "Amount (minor units)", so granting
 * ₹800 meant typing 80000, and typing 800 granted ₹8.
 */
function AmountAndCurrency({
  currency,
  setCurrency,
  bizCurrencies,
  min,
}: {
  currency: string;
  setCurrency: (v: string) => void;
  bizCurrencies: string[] | null;
  /** In MAJOR units. 0 for promo (so "Set balance to 0" is expressible). */
  min: number;
}) {
  return (
    <div className="flex gap-2">
      <Field name="amount_minor" label="Amount" required className="flex-1">
        <MoneyInput name="amount_minor" currency={currency} min={min} required />
      </Field>
      <Field name="currency" label="Currency">
        {/* Scoped to the business's enabled currencies — crediting a currency the
            business never invoices in strands the balance where no invoice can draw it. */}
        <CurrencySelect
          value={currency}
          onValueChange={setCurrency}
          options={bizCurrencies}
          className="w-44"
        />
      </Field>
    </div>
  );
}

export function PromoCreditDrawer({
  biz,
  cus,
  defaultCurrency,
  bizCurrencies,
  balances,
  open,
  onOpenChange,
}: {
  biz: string;
  cus: string;
  defaultCurrency: string;
  bizCurrencies: string[] | null;
  balances?: CustomerBalance[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [currency, setCurrency] = React.useState(defaultCurrency);
  const [action, setAction] = React.useState("add");
  const current = balanceFor(balances, currency).promotional_credits;
  return (
    <EditDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Manage promotional credits"
      description="Credit that you give to the customer. We apply it before tax on the next invoice. It cannot be more than the discounted subtotal. You cannot refund it. It expires with the customer."
    >
      <ActionForm
        action={managePromoCreditsAction}
        onSuccess={() => onOpenChange(false)}
        className="flex flex-col gap-4 py-4"
      >
        <HiddenFields fields={{ biz, cus }} />
        <Field name="action" label="Action">
          <SelectField
            name="action"
            value={action}
            onValueChange={setAction}
            ariaLabel="Credit action"
            options={[
              { value: "add", label: "Add credits" },
              { value: "deduct", label: "Deduct credits" },
              { value: "set", label: "Set balance to" },
            ]}
          />
        </Field>
        <AmountAndCurrency
          currency={currency}
          setCurrency={setCurrency}
          bizCurrencies={bizCurrencies}
          min={0}
        />
        <p className="text-xs text-muted-foreground">
          Current promotional balance:{" "}
          <b className="text-foreground tabular-nums">{money(current, currency)}</b>
          {action === "deduct" && current === 0 ? ". There is nothing to deduct." : null}
        </p>
        {/* Required here — a promotional grant is a manual money decision and the
            ledger memo is the only record of why. The API keeps it optional (other
            callers exist), so this is a UI-level requirement. */}
        <Field name="description" label="Description" required>
          <Input name="description" required placeholder="e.g. Referral bonus" maxLength={500} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <SubmitButton>Save</SubmitButton>
        </div>
      </ActionForm>
    </EditDrawer>
  );
}

/**
 * Add to the excess-payment bucket — money we actually hold for the customer.
 *
 * Two sources, because they differ in whether money moves: "received offline"
 * books cash we've already been handed, while "charge the card on file" runs a
 * real gateway charge first. The card option is the one capability the old inline
 * "Wallet top-up" form had that the rail actions didn't, folded in here rather
 * than kept as a duplicate surface.
 */
export function ExcessPaymentDrawer({
  biz,
  cus,
  defaultCurrency,
  bizCurrencies,
  balances,
  hasPaymentMethod,
  open,
  onOpenChange,
}: {
  biz: string;
  cus: string;
  defaultCurrency: string;
  bizCurrencies: string[] | null;
  balances?: CustomerBalance[];
  /** No vaulted card → the backend rejects a card charge, so don't offer it. */
  hasPaymentMethod: boolean;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [currency, setCurrency] = React.useState(defaultCurrency);
  const [source, setSource] = React.useState("offline");
  const current = balanceFor(balances, currency).excess_payments;
  return (
    <EditDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Record excess payment"
      description="Money that we hold for the customer, more than the amount due now. We apply it after tax to future invoices automatically. You can refund it."
    >
      <ActionForm
        action={recordExcessPaymentAction}
        onSuccess={() => onOpenChange(false)}
        className="flex flex-col gap-4 py-4"
      >
        <HiddenFields fields={{ biz, cus }} />
        <Field
          name="source"
          label="Source"
          help={
            source === "card"
              ? "We charge the customer’s most recently added card now. The balance shows only if the charge succeeds."
              : "Records money that you already received. We do not charge a card."
          }
        >
          <SelectField
            name="source"
            value={source}
            onValueChange={setSource}
            ariaLabel="Payment source"
            options={[
              { value: "offline", label: "Received offline: cash, check or bank transfer" },
              {
                value: "card",
                label: `Charge the card on file${hasPaymentMethod ? "" : " (no saved card)"}`,
                disabled: !hasPaymentMethod,
              },
            ]}
          />
        </Field>
        {/* min is MAJOR units. 0 rather than a computed one-minor-unit floor: the
            smallest positive amount is currency-dependent, and the API already
            rejects a non-positive amount with a clear message. */}
        <AmountAndCurrency
          currency={currency}
          setCurrency={setCurrency}
          bizCurrencies={bizCurrencies}
          min={0}
        />
        <p className="text-xs text-muted-foreground">
          Current excess-payment balance:{" "}
          <b className="text-foreground tabular-nums">{money(current, currency)}</b>
        </p>
        <Field name="description" label="Description (optional)">
          {/* The card path posts to the wallet top-up endpoint, which has no description
              field — so don't pretend the note is kept. */}
          <Input
            name="description"
            placeholder={
              source === "card" ? "Not recorded for card top-ups" : "e.g. Pre-payment Q2"
            }
            maxLength={500}
            disabled={source === "card"}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <SubmitButton>{source === "card" ? "Charge card" : "Record"}</SubmitButton>
        </div>
      </ActionForm>
    </EditDrawer>
  );
}

// ── Collect payment dialog ────────────────────────────────────────────────────

export function CollectPaymentDialog({
  biz,
  cus,
  invoices,
  pms,
  open,
  onOpenChange,
}: {
  biz: string;
  cus: string;
  /** The customer's unpaid invoices, oldest first — each is charged on its own. */
  invoices: Invoice[];
  pms: PaymentMethod[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const unpaid = invoices.filter(
    (i) =>
      ["posted", "payment_due", "not_paid"].includes(i.status) &&
      (i.amount_due_minor ?? i.total_minor) > 0,
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Collect payment</DialogTitle>
          <DialogDescription>
            We charge each invoice separately, oldest first. We apply credit on file first. A
            decline stops the remaining charges.
          </DialogDescription>
        </DialogHeader>
        {unpaid.length === 0 ? (
          <>
            <p className="rounded bg-muted px-3 py-2 text-sm text-muted-foreground">
              No amount is due. There is nothing to collect.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          // The body remounts on every open, so every unpaid invoice starts ticked.
          <CollectPaymentForm
            biz={biz}
            cus={cus}
            unpaid={unpaid}
            pms={pms}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CollectPaymentForm({
  biz,
  cus,
  unpaid,
  pms,
  onDone,
}: {
  biz: string;
  cus: string;
  unpaid: Invoice[];
  pms: PaymentMethod[];
  onDone: () => void;
}) {
  const [picked, setPicked] = React.useState<Set<string>>(() => new Set(unpaid.map((i) => i.id)));
  const totals = new Map<string, number>();
  for (const i of unpaid) {
    if (!picked.has(i.id)) continue;
    totals.set(i.currency, (totals.get(i.currency) ?? 0) + (i.amount_due_minor ?? i.total_minor));
  }
  return (
    <ActionForm action={collectPaymentAction} onSuccess={onDone} className="flex flex-col gap-4">
      <HiddenFields fields={{ biz, cus }} />
      <div className="flex flex-col divide-y rounded-md border">
        {unpaid.map((i) => (
          <div key={i.id} className="flex items-center gap-3 px-3 py-2.5">
            <CheckboxField
              name="invoice_ids"
              value={i.id}
              checked={picked.has(i.id)}
              onCheckedChange={(on) =>
                setPicked((prev) => {
                  const next = new Set(prev);
                  if (on) next.add(i.id);
                  else next.delete(i.id);
                  return next;
                })
              }
              label={<span className="font-mono text-xs">{i.number ?? i.id}</span>}
              hint={i.created_at ? `Created ${fmtDate(i.created_at, null)}` : undefined}
              className="flex-1"
            />
            <span className="text-sm font-medium tabular-nums">
              {money(i.amount_due_minor ?? i.total_minor, i.currency)}
            </span>
          </div>
        ))}
      </div>
      <p className="text-sm">
        <span className="text-muted-foreground">Selected: </span>
        <span className="font-semibold tabular-nums">
          {totals.size ? [...totals].map(([c, v]) => money(v, c)).join(" · ") : "nothing"}
        </span>
      </p>
      {pms.length > 0 ? (
        <Field
          name="payment_method_id"
          label="Payment method"
          help="Automatic tries each backup card if the first card declines. If you select one card, we try only that card."
        >
          <SelectField
            name="payment_method_id"
            ariaLabel="Payment method"
            options={paymentMethodOptions(pms)}
          />
        </Field>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton disabled={picked.size === 0}>
          {picked.size > 1 ? `Collect ${picked.size} invoices` : "Collect"}
        </SubmitButton>
      </DialogFooter>
    </ActionForm>
  );
}

// ── Assign PM role (inline button, ActionButton-style) ─────────────────────────

export function AssignRoleButton({
  biz,
  cus,
  pm,
  role,
  label,
}: {
  biz: string;
  cus: string;
  pm: string;
  role: "primary" | "backup" | "none";
  label: string;
}) {
  const [, formAction, pending] = useActionState(assignPaymentMethodRoleAction, null);
  return (
    <form action={formAction} style={{ display: "inline" }}>
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="cus" value={cus} />
      <input type="hidden" name="pm" value={pm} />
      <input type="hidden" name="role" value={role} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "…" : label}
      </Button>
    </form>
  );
}

// ── Change billing date dialog ────────────────────────────────────────────────

export function ChangeBillingDateDialog({
  biz,
  cus,
  currentDate,
  currentMode,
  open,
  onOpenChange,
}: {
  biz: string;
  cus: string;
  currentDate?: number | null;
  currentMode?: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change billing date</DialogTitle>
          <DialogDescription>
            Set the day of the month when subscriptions renew. This applies only to new renewal
            cycles.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={changeBillingDateAction}
          onSuccess={() => onOpenChange(false)}
          className="flex flex-col gap-4"
        >
          <HiddenFields fields={{ biz, cus }} />
          <Field
            name="billing_date"
            label="Day of month"
            help="Enter 1–31. Leave blank to use the default."
          >
            <Input
              name="billing_date"
              type="number"
              min={1}
              max={31}
              step={1}
              defaultValue={currentDate ?? ""}
              placeholder="e.g. 1 = first of month"
            />
          </Field>
          <Field name="billing_date_mode" label="Mode">
            <SelectField
              name="billing_date_mode"
              defaultValue={currentMode ?? "manually_set"}
              ariaLabel="Billing date mode"
              options={BILLING_DATE_MODE_OPTIONS}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <SubmitButton>Save</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

// ── Add charge dialog (one-time invoice; optional immediate collect) ──────────

/*
 * `AddChargeDialog` removed — replaced by two takeover routes that split the flow:
 * `customers/[cus]/add_charge_price` (pick a catalog Charge item) and
 * `customers/[cus]/add_charge` (ad-hoc amount + service period + description).
 *
 * The dialog was wrong in three ways beyond being the wrong archetype: it asked for
 * "Amount (minor units)", so typing 800 for ₹800 billed ₹8.00; its currency was a
 * free-text 3-char box that could mint a line in a currency the business never
 * invoices; and its checkbox called collect-now "Quick Charge", which means an ad-hoc
 * charge and has nothing to do with when money moves.
 */

// ── Record offline payment dialog ─────────────────────────────────────────────

export function RecordOfflinePaymentDialog({
  biz,
  cus,
  invoices,
  open,
  onOpenChange,
}: {
  biz: string;
  cus: string;
  invoices: Invoice[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  // Only invoices that still owe money can accept a payment.
  const payable = invoices.filter(
    (i) => (i.amount_due_minor ?? i.total_minor) > 0 && i.status !== "void",
  );
  // The amount is in the SELECTED invoice's currency (a customer can hold invoices
  // in several), so the picker has to be controlled — the exponent and the "at most
  // what's still due" cap both come from the chosen row.
  const [invoiceId, setInvoiceId] = React.useState(payable[0]?.id ?? "");
  const selected = payable.find((i) => i.id === invoiceId) ?? payable[0];
  const dueMinor = selected ? (selected.amount_due_minor ?? selected.total_minor) : 0;
  const currency = selected?.currency ?? "USD";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record offline payment</DialogTitle>
          <DialogDescription>
            Mark an outstanding invoice as paid by an external method, such as bank transfer, cash
            or cheque. We record the payment in the ledger and do not charge a gateway. Leave the
            amount blank to mark the full balance as paid.
          </DialogDescription>
        </DialogHeader>
        {payable.length === 0 ? (
          <>
            <p className="rounded bg-muted px-3 py-2 text-sm text-muted-foreground">
              This customer has no outstanding invoices.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <ActionForm
            action={recordOfflinePaymentAction}
            onSuccess={() => onOpenChange(false)}
            className="flex flex-col gap-4"
          >
            <HiddenFields fields={{ biz, cus }} />
            <Field name="invoice" label="Invoice" required>
              <SelectField
                name="invoice"
                required
                ariaLabel="Invoice"
                value={invoiceId}
                onValueChange={setInvoiceId}
                placeholder="Select an invoice…"
                options={payable.map((i) => ({
                  value: i.id,
                  label: `${i.id} \u2014 ${money(i.amount_due_minor ?? i.total_minor, i.currency)} due`,
                }))}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Amount in MAJOR units, capped at the selected invoice's remaining
                  balance. Blank posts '' — `recordOfflinePaymentAction` then omits
                  `amount_minor`, which the engine reads as "mark the full balance
                  paid". That is why MoneyInput must never substitute a 0. */}
              <Field name="amount_minor" label="Amount" help="Leave blank for the full balance.">
                <MoneyInput
                  name="amount_minor"
                  currency={currency}
                  max={toMajor(dueMinor, currency)}
                  placeholder="full balance"
                />
              </Field>
              {/* Same control, same reason as the invoice's — see lib/offline-methods.
                  Its placeholder was `bank_transfer`, a value from the refund enum, which
                  is a good sign the closed set was always the intent here. */}
              <Field name="method" label="Method">
                <SelectField
                  name="method"
                  ariaLabel="Payment method"
                  placeholder="Select…"
                  options={offlineMethodOptions()}
                />
              </Field>
            </div>
            <Field
              name="date"
              label="Payment date"
              help="The date when the money arrived. Leave blank to use the current time."
            >
              <DateTimeField name="date" />
            </Field>
            <Field
              name="reference"
              label="Reference number"
              help="Optional. For example, a check number or a bank transaction ID."
            >
              <Input name="reference" placeholder="optional" maxLength={100} />
            </Field>
            <Field
              name="comment"
              label="Note"
              help="Optional. We add this text to the Comments timeline."
            >
              <Input name="comment" maxLength={500} placeholder="optional" />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <SubmitButton>Record payment</SubmitButton>
            </DialogFooter>
          </ActionForm>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Validate VAT button ───────────────────────────────────────────────────────

export function ValidateVatButton({ biz, cus }: { biz: string; cus: string }) {
  const [result, formAction, pending] = useActionState(validateVatAction, null);
  return (
    <span className="inline-flex items-center gap-2">
      <form action={formAction} style={{ display: "inline" }}>
        <HiddenFields fields={{ biz, cus }} />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? "Validating…" : "Validate VAT"}
        </Button>
      </form>
      {result?.message ? (
        <span className={`text-xs ${result.ok ? "text-success" : "text-destructive"}`}>
          {result.message}
        </span>
      ) : null}
    </span>
  );
}

// ── Clear personal data (GDPR) dialog ─────────────────────────────────────────

export function ClearPersonalDataDialog({
  biz,
  cus,
  open,
  onOpenChange,
}: {
  biz: string;
  cus: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [confirmId, setConfirmId] = React.useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-destructive">Clear personal data</DialogTitle>
          <DialogDescription>
            <strong>You cannot undo this.</strong> We delete all PII from this customer record:
            name, email, address and phone. We also delete all saved payment methods at the gateway.
            We keep invoices and subscriptions for accounting. The customer then shows as
            &ldquo;[deleted]&rdquo;.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={clearPersonalDataAction}
          onSuccess={() => onOpenChange(false)}
          className="flex flex-col gap-4"
        >
          <HiddenFields fields={{ biz, cus }} />
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            To confirm, type the customer ID exactly:{" "}
            <code className="font-mono font-bold">{cus}</code>
          </div>
          <Field name="confirm_id" label="Customer ID">
            <Input
              name="confirm_id"
              placeholder={cus}
              value={confirmId}
              onChange={(e) => setConfirmId(e.target.value)}
              className="font-mono"
              autoComplete="off"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <SubmitButton variant="destructive" disabled={confirmId !== cus}>
              Clear personal data
            </SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit billing address (section-level button) ──────────────────────────────

/**
 * Focused "Edit" for the Billing Address section on the customer page. Drives
 * the same editCustomerAction as the full drawer, but posts only the addr_*
 * fields so the PATCH is an address-only partial update.
 */
export function EditBillingAddressButton({
  biz,
  customer,
  countries,
  rail,
  label,
}: {
  biz: string;
  customer: Customer;
  /** Country reference data, fetched server-side by the customer page. */
  countries: Country[];
  /** Render as a rail text link, labelled "Edit Billing Info". */
  rail?: boolean;
  label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const a = customer.address;
  return (
    <>
      {rail ? (
        <RailButton opensDialog expanded={open} onClick={() => setOpen(true)}>
          {label ?? "Edit Billing Info"}
        </RailButton>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          <Pencil className="size-4" />
          {label ?? "Edit"}
        </Button>
      )}
      <EditDrawer
        open={open}
        onOpenChange={setOpen}
        wide
        title="Edit billing address"
        description={<span className="font-mono text-xs">{customer.id}</span>}
      >
        <ActionForm
          action={editCustomerAction}
          onSuccess={() => setOpen(false)}
          className="flex flex-col gap-4 py-2"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="cus" value={customer.id} />
          {customer.resource_version != null ? (
            <input type="hidden" name="expected_version" value={customer.resource_version} />
          ) : null}

          {/* Operators are held to no address rule; the API still rejects a bad value. */}
          <AddressFields
            countries={countries}
            value={a}
            prefix="addr_"
            requireCore={false}
            requireRest={false}
          />

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Save address</Button>
          </div>
        </ActionForm>
      </EditDrawer>
    </>
  );
}

// ── Main CustomerActions component (header rail) ─────────────────────────────

/**
 * Customer Actions group for the right rail: edit (full page) + archive / restore.
 * Rendered as a vertical stack of text links, matching every other rail item —
 * these were boxed buttons in a horizontal row, which is what made the rail read
 * as two different kinds of control stacked together.
 */
export function CustomerActions({
  biz,
  customer,
  showEdit = true,
}: {
  biz: string;
  customer: Customer;
  /** Off where the page already offers Edit customer as its main action. */
  showEdit?: boolean;
}) {
  const archived = customer.active === false;

  return (
    <>
      {showEdit ? (
        <Link
          href={`/businesses/${biz}/customers/${customer.id}/edit`}
          className={cn(railItemClass, railToneClass())}
        >
          Edit Customer
        </Link>
      ) : null}
      {archived ? (
        <ActionButton
          resultAction={restoreCustomerAction}
          fields={{ biz, cus: customer.id }}
          label="Restore"
          variant="link"
          size="sm"
          className={cn(railItemClass, railToneClass(), "h-auto px-1 py-0.5 font-normal")}
          confirm={{
            title: "Restore customer?",
            description: "The customer shows again in active lists.",
            confirmLabel: "Restore",
          }}
        />
      ) : (
        <ActionButton
          resultAction={archiveCustomerAction}
          fields={{ biz, cus: customer.id }}
          label="Archive"
          variant="link"
          size="sm"
          className={cn(railItemClass, railToneClass(), "h-auto px-1 py-0.5 font-normal")}
          confirm={{
            title: "Archive customer?",
            description:
              "We hide the customer from active lists. Existing subscriptions continue to work. You can restore the customer later.",
            confirmLabel: "Archive",
            destructive: true,
          }}
        />
      )}
    </>
  );
}
