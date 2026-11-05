"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { createInvoiceAction, type PickerCustomer } from "@/app/actions";
import { CustomerPicker } from "@/components/customers/customer-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ActionForm, useFieldError } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import type { Customer } from "@/lib/api";
import { accountHolderName } from "@/lib/names";
import { CurrencySelect } from "@/components/form/currency-select";
import { MoneyInput } from "@/components/form/money-input";
import { CheckboxField } from "@/components/ui/checkbox";

/**
 * A line row. `amount` holds integer MINOR units — that is what the API stores and
 * what `MoneyInput` reports back — while the operator types major units.
 *
 * `id` exists because the money field keeps its own text state: with `key={index}`
 * React reuses a row's DOM when an earlier row is deleted, so the amounts would
 * shift up a row while the state moved correctly, and the two would silently disagree.
 */
interface LineRow {
  id: string;
  description: string;
  amount: string;
  quantity: string;
}

let lineSeq = 0;
const newLine = (): LineRow => ({
  id: `line-${lineSeq++}`,
  description: "",
  amount: "",
  quantity: "1",
});

/** Server-side "add at least one line" error, rendered under the line-item rows.
 * Must be a child of the form's own <ActionForm> so useFieldError reads its errors. */
function LinesError() {
  const error = useFieldError("lines");
  return error ? <p className="text-xs font-medium text-destructive">{error}</p> : null;
}

/** One-off / manual invoice builder in a modal dialog: pick a customer, add line
 *  items, choose collect-now / net-D / tax. Lines are serialized to a hidden JSON input. */
export function ManualInvoiceForm({
  biz,
  customers,
  currencies,
}: {
  biz: string;
  customers: Customer[];
  currencies?: string[] | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<LineRow[]>([newLine()]);
  // Both controlled, so the money fields know which currency's exponent to use.
  const [cus, setCus] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * The CHOSEN customer, held whole. `customers` is the first page now, not a 1000-row
   * read, so a customer reached through the picker's server search is not in it and
   * `customers.find(...)` would resolve nothing — which for this form means the money
   * fields silently lose the currency exponent they are supposed to derive.
   */
  const [picked, setPicked] = useState<PickerCustomer | null>(null);
  /** The server-fetched first page, in picker shape — what the dialog shows before a query. */
  const initialRows: PickerCustomer[] = customers.map((c) => {
    // `accountHolderName`, not the wire's `name`: that key is a DERIVED echo of
    // first/last/company now (`customers.name` is deprecated) and it stops short of
    // the email, so reading it directly would show a nameless customer as their
    // public id with the email buried in the sub-line.
    const label = accountHolderName(c);
    return {
      id: c.id,
      label: label ?? c.id,
      // Only when the email is not already the label — otherwise the row printed the
      // same address twice.
      sub: label && label !== c.email ? (c.email ?? null) : null,
      effective_currency: c.effective_currency ?? null,
      auto_collection: (c.auto_collection as "on" | "off" | null | undefined) ?? null,
    };
  });
  const [pickedCurrency, setPickedCurrency] = useState("");
  /**
   * The currency the amounts are denominated in, driving each field's exponent.
   *
   * The picker is OPTIONAL here — blank means "let the engine resolve it from the
   * customer" — so rather than preselecting a made-up USD we try to resolve what the
   * engine will: the chosen customer's `effective_currency` (explicit currency, else
   * their live subscriptions'; see `src/modules/customers/serialize.ts`). Falling
   * back to '' rather than 'USD' is deliberate: an unknown currency must not be
   * asserted, and `currencyExponent('')` is the same 2 every call site assumed before.
   *
   * The LIST endpoint this form is fed from now carries `effective_currency` too
   * (one batched aggregate over the page — `getCurrencyWeightsForCustomers`), so
   * this arm resolves as soon as a customer is picked. It still falls back to ''
   * rather than 'USD' for a customer with no explicit currency and no live
   * subscription: an unknown currency must not be asserted.
   */
  const currency = pickedCurrency.trim() || picked?.effective_currency || "";
  const linesJson = JSON.stringify(
    lines
      .filter((l) => l.description && l.amount !== "")
      .map((l) => ({
        description: l.description,
        amount_minor: Number(l.amount),
        ...(l.quantity && Number(l.quantity) > 1 ? { quantity: Number(l.quantity) } : {}),
      })),
  );
  const upd = (id: string, k: "description" | "amount" | "quantity", v: string) =>
    setLines((rows) => rows.map((r) => (r.id === id ? { ...r, [k]: v } : r)));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Create invoice</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create invoice</DialogTitle>
          <DialogDescription>
            Leave net days blank to make the invoice due on receipt.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={createInvoiceAction}
          onSuccess={(r) => {
            if (r.redirectTo) router.push(r.redirectTo);
            setOpen(false);
            setLines([newLine()]);
            setCus("");
            setPickedCurrency("");
          }}
          className="space-y-4"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="lines" value={linesJson} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field name="customer" label="Customer" required>
              {/* A SEARCH, not a 1000-option select. The list this form was handed was
                  `listCustomers(biz, { limit: 1000 })`, so a business past that could
                  not invoice its newer customers at all — and a select gives no way to
                  find out, it just does not contain them. */}
              <input type="hidden" name="customer" value={cus} />
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                aria-label="Customer"
                className="flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-card px-3 text-left text-sm transition-colors hover:bg-accent"
              >
                <span className={picked ? "" : "text-muted-foreground"}>
                  {picked ? picked.label : "Search for a customer…"}
                </span>
                <Search className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </Field>
            <CustomerPicker
              biz={biz}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              initial={initialRows}
              onSelect={(c) => {
                setCus(c.id);
                setPicked(c);
              }}
              description="Select the customer to bill."
            />
            <Field
              name="currency"
              label="Currency"
              help="Optional. Leave blank to use the customer's currency."
            >
              <CurrencySelect
                allowEmpty
                placeholder="Currency (optional)"
                options={currencies}
                onValueChange={setPickedCurrency}
              />
            </Field>
          </div>
          {/* Amounts are typed in MAJOR units and reported back as integer minor,
              which is what `linesJson` puts on the wire — the server action is
              unchanged. Qty is a count, not money. */}
          <div className="space-y-2">
            {lines.map((l) => (
              <div key={l.id} className="flex gap-2">
                <Input
                  placeholder="description"
                  value={l.description}
                  onChange={(e) => upd(l.id, "description", e.target.value)}
                  maxLength={500}
                  className="flex-1"
                />
                <Input
                  placeholder="qty"
                  type="number"
                  min={1}
                  step={1}
                  value={l.quantity}
                  onChange={(e) => upd(l.id, "quantity", e.target.value)}
                  className="w-20 tabular-nums"
                />
                <MoneyInput
                  currency={currency}
                  onMinorChange={(minor) => upd(l.id, "amount", minor)}
                  className="w-40"
                  inputClassName="text-right"
                />
                {lines.length > 1 ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setLines((rows) => rows.filter((r) => r.id !== l.id))}
                  >
                    −
                  </Button>
                ) : null}
              </div>
            ))}
            <LinesError />
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLines((rows) => [...rows, newLine()])}
            >
              + Add line
            </Button>
            <CheckboxField name="collect" label="Collect now" />
            <CheckboxField name="apply_tax" label="Apply tax" />
            <Field name="net_days" label="Net days" help="Blank = due on receipt." className="w-28">
              <Input name="net_days" type="number" min={1} max={3650} step={1} placeholder="days" />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Create invoice</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
