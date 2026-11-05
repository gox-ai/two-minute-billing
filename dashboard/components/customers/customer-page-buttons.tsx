"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { RailButton } from "@/components/patterns/action-rail";
import {
  PromoCreditDrawer,
  ExcessPaymentDrawer,
  CollectPaymentDialog,
  ChangeBillingDateDialog,
  ClearPersonalDataDialog,
  RecordOfflinePaymentDialog,
} from "@/components/customers/customer-actions";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { Customer, CustomerBalance, PaymentMethod, Invoice } from "@/lib/api";

/**
 * Generic trigger + dialog wrapper for a plain server-action `<form>`. Keeps
 * bulky create-forms off the page surface without rewriting
 * the underlying actions. Closes on submit; revalidation refreshes the list.
 */
export function FormDialogButton({
  label,
  title,
  description,
  triggerVariant = "outline",
  children,
}: {
  label: string;
  title: string;
  description?: string;
  /** 'rail' renders the trigger as a rail text link instead of a box. */
  triggerVariant?: "outline" | "default" | "ghost" | "rail";
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {triggerVariant === "rail" ? (
          <RailButton opensDialog expanded={open}>
            {label}
          </RailButton>
        ) : (
          <Button variant={triggerVariant} size="sm">
            {label}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div onSubmit={() => setOpen(false)}>{children}</div>
      </DialogContent>
    </Dialog>
  );
}

export function ChangeBillingDateButton({
  biz,
  cus,
  currentDate,
  currentMode,
}: {
  biz: string;
  cus: string;
  currentDate?: number | null;
  currentMode?: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Change billing date
      </Button>
      <ChangeBillingDateDialog
        biz={biz}
        cus={cus}
        currentDate={currentDate}
        currentMode={currentMode}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

export function CollectPaymentRailButton({
  biz,
  cus,
  invoices,
  pms,
}: {
  biz: string;
  cus: string;
  /** The customer's invoices; the dialog lists the unpaid ones to tick. */
  invoices: Invoice[];
  pms: PaymentMethod[];
}) {
  const [open, setOpen] = React.useState(false);
  const due = invoices.some(
    (i) =>
      ["posted", "payment_due", "not_paid"].includes(i.status) &&
      (i.amount_due_minor ?? i.total_minor) > 0,
  );
  return (
    <>
      <RailButton opensDialog expanded={open} onClick={() => setOpen(true)} disabled={!due}>
        Collect payment
      </RailButton>
      <CollectPaymentDialog
        biz={biz}
        cus={cus}
        invoices={invoices}
        pms={pms}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

export function PromoCreditRailButton({
  biz,
  cus,
  defaultCurrency,
  bizCurrencies,
  balances,
}: {
  biz: string;
  cus: string;
  defaultCurrency: string;
  bizCurrencies: string[] | null;
  balances?: CustomerBalance[];
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <RailButton opensDialog expanded={open} onClick={() => setOpen(true)}>
        Manage credits
      </RailButton>
      <PromoCreditDrawer
        biz={biz}
        cus={cus}
        defaultCurrency={defaultCurrency}
        bizCurrencies={bizCurrencies}
        balances={balances}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

export function ExcessPaymentRailButton({
  biz,
  cus,
  defaultCurrency,
  bizCurrencies,
  balances,
  hasPaymentMethod,
}: {
  biz: string;
  cus: string;
  defaultCurrency: string;
  bizCurrencies: string[] | null;
  balances?: CustomerBalance[];
  hasPaymentMethod: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <RailButton opensDialog expanded={open} onClick={() => setOpen(true)}>
        Record excess payment
      </RailButton>
      <ExcessPaymentDrawer
        biz={biz}
        cus={cus}
        defaultCurrency={defaultCurrency}
        bizCurrencies={bizCurrencies}
        balances={balances}
        hasPaymentMethod={hasPaymentMethod}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

// `_AddChargeRailButton` + `AddChargeDialog` removed: one dialog stood in for two
// distinct flows (catalog `Add Charge` vs ad-hoc `Create Quick Charge`) and labelled
// its collect-now checkbox "Quick Charge", which is not what that means. Both are now
// takeover routes linked straight from the rail —
// `customers/[cus]/add_charge_price` and `customers/[cus]/add_charge`.

export function RecordOfflinePaymentRailButton({
  biz,
  cus,
  invoices,
}: {
  biz: string;
  cus: string;
  invoices: Invoice[];
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <RailButton opensDialog expanded={open} onClick={() => setOpen(true)}>
        Record offline payment
      </RailButton>
      <RecordOfflinePaymentDialog
        biz={biz}
        cus={cus}
        invoices={invoices}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

export function ClearPersonalDataButton({
  biz,
  cus,
  disabled,
}: {
  biz: string;
  cus: string;
  disabled: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        className="shrink-0"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        Clear personal data
      </Button>
      <ClearPersonalDataDialog biz={biz} cus={cus} open={open} onOpenChange={setOpen} />
    </>
  );
}
