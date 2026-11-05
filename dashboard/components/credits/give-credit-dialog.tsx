"use client";

import { useDefaultState } from "@/lib/use-default-state";
import * as React from "react";
import Link from "next/link";
import { EditDrawer } from "@/components/edit-drawer";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { DateTimeField } from "@/components/form/datetime-field";
import { CurrencySelect } from "@/components/form/currency-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { RadioField } from "@/components/ui/radio-group";
import { CheckboxField } from "@/components/ui/checkbox";
import { Alert } from "@/components/ui/alert";
import { MoneyField } from "@/components/catalog/form-kit";
import { giveCreditAction } from "@/app/(dashboard)/businesses/[biz]/customers/[cus]/credits/actions";
import { offlineMethodOptions } from "@/lib/offline-methods";
import {
  DEFAULT_PRIORITY,
  POLICY_LABEL,
  TAX_TREATMENT_LABEL,
  amountDecimals,
  rateSentence,
  type CreditTaxTreatment,
  type CreditUnit,
} from "@/lib/credits";

/**
 * "Give credit": promotional books at once; paid raises an invoice (C4) that can be
 * marked paid in the same step. On a paid grant the dialog ends on a link to that invoice.
 */
export function GiveCreditButton({
  biz,
  cus,
  units,
  currencies,
  defaultCurrency,
  canGivePaid,
  blockingEnabled,
  defaultTaxTreatment,
}: {
  biz: string;
  cus: string;
  /** Active units only. */
  units: CreditUnit[];
  currencies: string[] | null;
  defaultCurrency: string;
  /** Paid credit also needs `invoices:manage`. */
  canGivePaid: boolean;
  /** The policy control does nothing while blocking is off. */
  blockingEnabled: boolean;
  defaultTaxTreatment: CreditTaxTreatment | null;
}) {
  const [open, setOpen] = React.useState(false);
  const [invoiceHref, setInvoiceHref] = React.useState<string | null>(null);
  const [category, setCategory] = React.useState("promotional");
  const [unitKey, setUnitKey] = React.useState("");
  const [currency, setCurrency] = useDefaultState(defaultCurrency);
  const [price, setPrice] = React.useState("");
  const [markPaid, setMarkPaid] = React.useState(false);
  const [method, setMethod] = React.useState("");
  const unit = units.find((u) => u.id === unitKey) ?? null;
  const cur = unit?.currency ?? currency;
  const decimals = amountDecimals(unit ? unit.id : null, unit?.decimals ?? 0, cur);
  // The business default; a custom unit clears "at use" (it is always taxed at purchase).
  const [tax, setTax] = useDefaultState<string>(defaultTaxTreatment ?? "");
  const [policy, setPolicy] = React.useState("");

  const reset = () => {
    setInvoiceHref(null);
    setCategory("promotional");
    setUnitKey("");
    setCurrency(defaultCurrency);
    setPrice("");
    setMarkPaid(false);
    setMethod("");
    setTax(defaultTaxTreatment ?? "");
    setPolicy("");
  };

  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        Give credit
      </Button>
      <EditDrawer
        open={open}
        onOpenChange={setOpen}
        title="Give credit"
        description="Promotional credit is free for the customer. Paid credit creates an invoice, and the credit starts when the invoice is paid."
      >
        {invoiceHref ? (
          <div className="flex flex-col gap-4 py-2">
            <Alert tone="success">
              We created an invoice for the paid credit.{" "}
              <Link href={invoiceHref} className="font-medium text-primary hover:underline">
                View invoice
              </Link>
            </Alert>
            <div className="flex justify-end">
              <Button type="button" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <ActionForm
            action={giveCreditAction}
            onSuccess={(r) => (r.redirectTo ? setInvoiceHref(r.redirectTo) : setOpen(false))}
            className="flex flex-col gap-4 py-2"
          >
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="cus" value={cus} />
            <input type="hidden" name="decimals" value={decimals} />
            {unit ? <input type="hidden" name="currency" value={unit.currency} /> : null}

            <Field name="category" label="Type of credit" required>
              <RadioField
                name="category"
                value={category}
                onValueChange={setCategory}
                ariaLabel="Type of credit"
                options={[
                  {
                    value: "promotional",
                    label: "Promotional",
                    hint: "Free credit. We apply it before tax.",
                  },
                  {
                    value: "paid",
                    label: "Paid",
                    hint: canGivePaid
                      ? "The customer pays for it. We create an invoice."
                      : "You need permission to manage invoices.",
                    disabled: !canGivePaid,
                  },
                ]}
              />
            </Field>

            <Field
              name="unit"
              label="Unit"
              help={unit ? rateSentence(unit) : "The credit is an amount of money."}
            >
              <SelectField
                name="unit"
                value={unitKey}
                onValueChange={(k) => {
                  setUnitKey(k);
                  if (k && tax === "taxed_at_use") setTax("");
                }}
                ariaLabel="Unit"
                options={[
                  { value: "", label: "Money" },
                  ...units.map((u) => ({ value: u.id, label: `${u.plural_name} (${u.currency})` })),
                ]}
              />
            </Field>

            {unit ? null : (
              <Field name="currency" label="Currency" required>
                <CurrencySelect
                  name="currency"
                  value={currency}
                  onValueChange={setCurrency}
                  options={currencies}
                />
              </Field>
            )}

            <Field
              name="amount"
              label={unit ? `Amount of ${unit.plural_name}` : `Amount in ${cur}`}
              required
              help={
                decimals === 0
                  ? "A whole number."
                  : `Up to ${decimals} decimal place${decimals === 1 ? "" : "s"}.`
              }
            >
              <Input name="amount" required inputMode="decimal" className="tabular-nums" />
            </Field>

            {category === "paid" ? (
              <>
                <Field
                  name="price_minor"
                  label="Price, before tax"
                  required
                  help="What the customer pays for this credit. It is the cost basis of the credit."
                >
                  <MoneyField name="price_minor" currency={cur} value={price} onChange={setPrice} />
                </Field>
                <Field name="tax_treatment" label="Tax" required>
                  <RadioField
                    name="tax_treatment"
                    value={tax}
                    onValueChange={setTax}
                    ariaLabel="Tax treatment"
                    options={[
                      {
                        value: "taxed_at_purchase",
                        label: TAX_TREATMENT_LABEL.taxed_at_purchase,
                        hint: "The invoice for the credit includes tax.",
                      },
                      {
                        value: "taxed_at_use",
                        label: TAX_TREATMENT_LABEL.taxed_at_use,
                        hint: unit
                          ? "Not for credit in your own units."
                          : "The invoice for the credit has no tax. The credit pays tax on usage.",
                        disabled: !!unit,
                      },
                    ]}
                  />
                </Field>
                <CheckboxField
                  name="mark_paid"
                  label="Mark the invoice as paid"
                  hint="Use this when you already received the money. The credit starts now."
                  checked={markPaid}
                  onCheckedChange={setMarkPaid}
                />
                {markPaid ? (
                  <div className="grid grid-cols-1 gap-4 rounded-md bg-muted/50 p-3 sm:grid-cols-2">
                    <Field name="paid_method" label="Payment method" required>
                      <SelectField
                        name="paid_method"
                        value={method}
                        onValueChange={setMethod}
                        placeholder="Select a method"
                        ariaLabel="Payment method"
                        options={offlineMethodOptions()}
                      />
                    </Field>
                    <Field name="paid_reference" label="Reference">
                      <Input name="paid_reference" maxLength={200} />
                    </Field>
                    <div className="sm:col-span-2">
                      <Field name="paid_at" label="Paid on" help="Leave empty to use the time now.">
                        <DateTimeField name="paid_at" />
                      </Field>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                name="priority"
                label="Priority"
                help="0 to 100. Credit with a lower number is used first."
              >
                <Input
                  name="priority"
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={DEFAULT_PRIORITY}
                  className="tabular-nums"
                />
              </Field>
              <Field name="expires_at" label="Expires on" help="Leave empty for no expiry.">
                <DateTimeField name="expires_at" granularity="date" minToday />
              </Field>
            </div>

            {blockingEnabled ? (
              <Field name="on_exhausted" label="When this credit is used up">
                <RadioField
                  name="on_exhausted"
                  value={policy}
                  onValueChange={setPolicy}
                  ariaLabel="When this credit is used up"
                  options={[
                    {
                      value: "",
                      label: "Not set on this credit",
                      hint: "The customer, the plan or the business setting decides.",
                    },
                    { value: "block", label: POLICY_LABEL.block },
                    { value: "bill", label: POLICY_LABEL.bill },
                  ]}
                />
              </Field>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton>{category === "paid" ? "Create invoice" : "Give credit"}</SubmitButton>
            </div>
          </ActionForm>
        )}
      </EditDrawer>
    </>
  );
}
