"use client";

import * as React from "react";
import { updateInvoiceFieldsAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EditDrawer } from "@/components/edit-drawer";
import { Field } from "@/components/form/field";
import { ActionForm } from "@/components/form/action-form";

/** The address shape the invoice snapshot stores (matches the PATCH route). */
export interface InvoiceAddress {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  line1?: string | null;
  line2?: string | null;
  line3?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

/** Saves in place: the drawer closes on success and the result is toasted. */
function DrawerForm({
  open,
  onOpenChange,
  title,
  description,
  biz,
  inv,
  children,
  submitLabel,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  biz: string;
  inv: string;
  children: React.ReactNode;
  submitLabel: string;
}) {
  return (
    <EditDrawer open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <ActionForm
        action={updateInvoiceFieldsAction}
        onSuccess={() => onOpenChange(false)}
        className="space-y-4"
      >
        <input type="hidden" name="biz" value={biz} />
        <input type="hidden" name="inv" value={inv} />
        {children}
        <Button type="submit" size="sm">
          {submitLabel}
        </Button>
      </ActionForm>
    </EditDrawer>
  );
}

/** Update PO Number — one free-text field, blank clears it. */
export function UpdatePoNumberButton({
  biz,
  inv,
  current,
}: {
  biz: string;
  inv: string;
  current: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        className="rounded px-1 py-0.5 text-left text-sm text-primary hover:underline"
        onClick={() => setOpen(true)}
      >
        Edit PO number…
      </button>
      <DrawerForm
        open={open}
        onOpenChange={setOpen}
        title="Edit PO number"
        description="The buyer's purchase order reference. We print it on the invoice. You can search for it."
        biz={biz}
        inv={inv}
        submitLabel="Save PO number"
      >
        <Field name="po_number" label="PO number" help="Leave blank to clear it.">
          <Input
            name="po_number"
            defaultValue={current ?? ""}
            maxLength={200}
            placeholder="e.g. 4500123"
          />
        </Field>
      </DrawerForm>
    </>
  );
}

/**
 * Set expected payment date — a collections FORECAST.
 *
 * The help text says so explicitly because the field sits next to `due_date` and
 * looks like it: changing this must not change when dunning runs, and an
 * operator who believes otherwise would mis-manage the invoice.
 */
export function SetExpectedPaymentDateButton({
  biz,
  inv,
  current,
}: {
  biz: string;
  inv: string;
  current: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const value = current ? current.slice(0, 10) : "";
  return (
    <>
      <button
        type="button"
        className="rounded px-1 py-0.5 text-left text-sm text-primary hover:underline"
        onClick={() => setOpen(true)}
      >
        Set expected payment date…
      </button>
      <DrawerForm
        open={open}
        onOpenChange={setOpen}
        title="Set expected payment date"
        description="The date when you expect the money to arrive."
        biz={biz}
        inv={inv}
        submitLabel="Save date"
      >
        <Field
          name="expected_payment_date"
          label="Expected payment date"
          help="This is only a forecast. It does NOT change the due date or when dunning retries. Leave blank to clear it."
        >
          <Input name="expected_payment_date" type="date" defaultValue={value} />
        </Field>
      </DrawerForm>
    </>
  );
}

const ADDRESS_FIELDS: Array<{ key: keyof InvoiceAddress; label: string; maxLength?: number }> = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "company", label: "Company" },
  { key: "line1", label: "Address line 1" },
  { key: "line2", label: "Address line 2" },
  { key: "line3", label: "Address line 3" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "postal_code", label: "Zip / postal code" },
  { key: "country", label: "Country (2-letter)", maxLength: 2 },
];

/**
 * Update Address — edits the invoice's OWN address snapshot, not the
 * customer's. That separation is the point: correcting a typo on one invoice
 * must not rewrite the customer, and a customer moving house must not rewrite
 * invoices already issued.
 */
export function UpdateAddressButton({
  biz,
  inv,
  billing,
  shipping,
  label = "Edit address…",
}: {
  biz: string;
  inv: string;
  billing: InvoiceAddress | null;
  shipping: InvoiceAddress | null;
  label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        className="rounded px-1 py-0.5 text-left text-sm text-primary hover:underline"
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      <DrawerForm
        open={open}
        onOpenChange={setOpen}
        title="Edit address"
        description="We store this on this invoice only. We do not change the customer record."
        biz={biz}
        inv={inv}
        submitLabel="Save addresses"
      >
        <div className="space-y-4">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Billing address
          </p>
          {ADDRESS_FIELDS.map((f) => (
            <Field key={`billing_${f.key}`} name={`billing_${f.key}`} label={f.label}>
              <Input
                name={`billing_${f.key}`}
                defaultValue={billing?.[f.key] ?? ""}
                maxLength={f.maxLength}
              />
            </Field>
          ))}
          <p className="pt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Shipping address
          </p>
          {ADDRESS_FIELDS.map((f) => (
            <Field key={`shipping_${f.key}`} name={`shipping_${f.key}`} label={f.label}>
              <Input
                name={`shipping_${f.key}`}
                defaultValue={shipping?.[f.key] ?? ""}
                maxLength={f.maxLength}
              />
            </Field>
          ))}
        </div>
      </DrawerForm>
    </>
  );
}
