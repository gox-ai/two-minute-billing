"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { createPaymentLinkAction } from "@/app/(dashboard)/businesses/[biz]/catalog/payment_links/actions";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField, type SelectOption } from "@/components/ui/select-field";
import { SwitchField } from "@/components/ui/switch";
import { CheckboxField } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export interface PaymentLinkPriceMeta {
  /** `recurring` or `one_time`. */
  type: string;
  /** The product kind: `plan`, `addon` or `charge`. */
  kind: string;
}

interface Row {
  key: number;
  price: string;
  quantity: string;
  adjustable: boolean;
  min: string;
  max: string;
  optional: boolean;
}

const newRow = (key: number, price = ""): Row => ({
  key,
  price,
  quantity: "1",
  adjustable: false,
  min: "1",
  max: "10",
  optional: false,
});

/** Create a reusable payment link: a name, the items, and what the buyer may change. */
export function PaymentLinkDialog({
  biz,
  options,
  meta,
  initialPrice,
  trigger = "Create payment link",
}: {
  biz: string;
  options: SelectOption[];
  meta: Record<string, PaymentLinkPriceMeta>;
  /** Preselect this price on the first row (the product page passes its own). */
  initialPrice?: string;
  trigger?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">{trigger}</Button>
      </DialogTrigger>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Create a payment link</DialogTitle>
          <DialogDescription>
            Any visitor can open the link. Each visitor gets their own checkout.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <LinkForm
            biz={biz}
            options={options}
            meta={meta}
            {...(initialPrice ? { initialPrice } : {})}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function LinkForm({
  biz,
  options,
  meta,
  initialPrice,
  onDone,
}: {
  biz: string;
  options: SelectOption[];
  meta: Record<string, PaymentLinkPriceMeta>;
  initialPrice?: string;
  onDone: () => void;
}) {
  const nextKey = React.useRef(1);
  const [rows, setRows] = React.useState<Row[]>([newRow(0, initialPrice ?? "")]);
  const update = (key: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const chosen = rows.filter((r) => r.price);
  const subscribes = chosen.some((r) => meta[r.price]?.type === "recurring");
  const plans = chosen.filter((r) => meta[r.price]?.kind === "plan").length;
  const items = chosen.map((r) => ({
    price: r.price,
    quantity: Number(r.quantity) || 0,
    ...(r.adjustable ? { min_quantity: Number(r.min) || 0, max_quantity: Number(r.max) || 1 } : {}),
    ...(r.optional ? { optional: true } : {}),
  }));

  return (
    <ActionForm action={createPaymentLinkAction} onSuccess={onDone} className="flex flex-col gap-4">
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="items" value={JSON.stringify(items)} />
      <Field name="name" label="Name" required help="For you only. Buyers see the product names.">
        <Input name="name" required maxLength={200} placeholder="For example, Spring offer" />
      </Field>

      <div className="flex flex-col gap-3">
        <span className="text-sm font-medium">Items</span>
        {rows.map((r) => (
          <div key={r.key} className="flex flex-col gap-3 rounded-md bg-muted/50 p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <SelectField
                  ariaLabel="Price"
                  placeholder="Select a price…"
                  options={options}
                  value={r.price}
                  onValueChange={(v) => update(r.key, { price: v })}
                />
              </div>
              <Input
                aria-label="Quantity"
                type="number"
                min={0}
                value={r.quantity}
                onChange={(e) => update(r.key, { quantity: e.target.value })}
                className="w-20 tabular-nums"
              />
              {rows.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove item"
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                >
                  <X className="size-4" />
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="flex items-center gap-2">
                <SwitchField
                  checked={r.adjustable}
                  onCheckedChange={(v) => update(r.key, { adjustable: v })}
                  ariaLabel="Buyer can change the quantity"
                />
                <span className="text-sm">Buyer can change the quantity</span>
              </div>
              <CheckboxField
                checked={r.optional}
                onCheckedChange={(v) => update(r.key, { optional: v })}
                label="Optional"
                hint="The buyer can remove it"
              />
            </div>
            {r.adjustable ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">From</span>
                <Input
                  aria-label="Minimum quantity"
                  type="number"
                  min={0}
                  value={r.min}
                  onChange={(e) => update(r.key, { min: e.target.value })}
                  className="w-20 tabular-nums"
                />
                <span className="text-muted-foreground">to</span>
                <Input
                  aria-label="Maximum quantity"
                  type="number"
                  min={1}
                  value={r.max}
                  onChange={(e) => update(r.key, { max: e.target.value })}
                  className="w-20 tabular-nums"
                />
              </div>
            ) : null}
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setRows((rs) => [...rs, newRow(nextKey.current++)])}
        >
          <Plus className="size-4" /> Add item
        </Button>
        {chosen.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {subscribes
              ? plans === 1
                ? "Buyers subscribe to the plan. One-time items go on the first invoice."
                : "A link with a recurring price needs exactly one plan."
              : "Buyers pay once. We do not create a subscription."}
          </p>
        ) : null}
      </div>

      <div className="flex items-start gap-2.5">
        <SwitchField name="show_on_pricing_page" ariaLabel="Show on your pricing page" />
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Show on your pricing page</span>
          <span className="text-xs text-muted-foreground">
            Your public pricing page lists each link that has this on.
          </span>
        </div>
      </div>
      <div className="flex justify-end">
        <SubmitButton>Create payment link</SubmitButton>
      </div>
    </ActionForm>
  );
}
