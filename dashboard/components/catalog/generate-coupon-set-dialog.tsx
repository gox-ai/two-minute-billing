"use client";

import * as React from "react";
import { createCouponSetAction } from "@/app/actions";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useFormModel } from "@/components/catalog/form-kit";
import { money } from "@/lib/format";
import type { Coupon } from "@/lib/api";

function couponLabel(c: Coupon): string {
  const off =
    c.kind === "percentage"
      ? `${(c.percent_off_bps ?? 0) / 100}% off`
      : `${money(c.amount_off_minor ?? 0, c.currency ?? "USD")} off`;
  const dur =
    c.duration_type === "once"
      ? "once"
      : c.duration_type === "forever"
        ? "forever"
        : "limited period";
  return `${c.name || c.code} · ${off}, ${dur}`;
}

/** The coupon-set list's create action: a batch of single-use codes for one coupon. */
export function GenerateCouponSetDialog({ biz, coupons }: { biz: string; coupons: Coupon[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Generate coupon set</Button>
      </DialogTrigger>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Generate a coupon set</DialogTitle>
          <DialogDescription>
            A customer can redeem each code one time. Each code gives the parent coupon&rsquo;s
            discount.
          </DialogDescription>
        </DialogHeader>
        {open ? <GenerateForm biz={biz} coupons={coupons} onDone={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function GenerateForm({
  biz,
  coupons,
  onDone,
}: {
  biz: string;
  coupons: Coupon[];
  onDone: () => void;
}) {
  const formRef = React.useRef<HTMLFormElement>(null);
  const [v, set] = useFormModel(
    { coupon: coupons[0]?.id ?? "", name: "", count: "100", code_prefix: "" },
    formRef,
  );
  return (
    <ActionForm
      action={createCouponSetAction}
      onSuccess={onDone}
      formRef={formRef}
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="biz" value={biz} />
      <Field name="coupon" label="Parent coupon" required>
        <SelectField
          name="coupon"
          required
          value={v.coupon}
          onValueChange={(x) => set("coupon", x)}
          ariaLabel="Parent coupon"
          placeholder="Select a coupon…"
          options={coupons.map((c) => ({ value: c.id, label: couponLabel(c) }))}
        />
      </Field>
      <Field name="name" label="Set name" required>
        <Input
          name="name"
          value={v.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="For example, Spring launch codes"
          required
          maxLength={200}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="count" label="Number of codes" required help="Up to 10,000 codes per request.">
          <Input
            name="count"
            type="number"
            min={1}
            max={10000}
            value={v.count}
            onChange={(e) => set("count", e.target.value)}
            required
            className="tabular-nums"
          />
        </Field>
        <Field name="code_prefix" label="Code prefix" help="Optional, up to 20 characters">
          <Input
            name="code_prefix"
            value={v.code_prefix}
            onChange={(e) => set("code_prefix", e.target.value)}
            maxLength={20}
            className="font-mono"
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton>Generate codes</SubmitButton>
      </div>
    </ActionForm>
  );
}
