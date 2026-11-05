"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/form/field";
import { Textarea } from "@/components/ui/textarea";
import { SelectField } from "@/components/ui/select-field";
import { cn } from "@/lib/utils";
import { useDefaultState } from "@/lib/use-default-state";
import type { PaymentInstruction } from "@/lib/api/payment-instructions";

/**
 * The label/value rows a bank block is made of, plus the instruction's own fields.
 *
 * Rows post as PARALLEL repeated inputs (`pi_field_label` / `pi_field_value`) rather than
 * indexed names, so adding or removing a row never has to renumber anything — the action
 * zips the two `getAll()` lists. Pairs with a blank half are dropped server-side, so a
 * half-filled row cannot reach an invoice.
 */
export function PaymentInstructionFormFields({
  instruction,
  targeting = true,
}: {
  /** Absent for a create form. */
  instruction?: PaymentInstruction;
  /**
   * Whether "Match instructions to the invoice" is on. Off, the currency/country
   * fields are ignored by the engine, so they are hidden — but stay mounted, so a
   * save keeps what is stored.
   */
  targeting?: boolean;
}) {
  const [rows, setRows] = useDefaultState<Array<{ label: string; value: string }>>(
    instruction?.fields?.length ? instruction.fields : [{ label: "", value: "" }],
    (r) => JSON.stringify(r),
  );

  const set = (i: number, half: "label" | "value", v: string) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, [half]: v } : r)));

  return (
    <div className="space-y-5">
      {instruction ? null : (
        <Field
          name="pi_kind"
          label="Payment method"
          /* Create-only: the `preferred_offline` mode is meant to key off `kind`. Documents
             pass no preferred kind today, so it labels the instruction and selects nothing. */
          help="You choose this one time. It labels the instruction. The targeting below sets which invoices show it."
        >
          <SelectField
            name="pi_kind"
            defaultValue="bank_transfer"
            ariaLabel="Payment method"
            options={[
              { value: "bank_transfer", label: "Bank transfer" },
              { value: "paypal", label: "PayPal" },
            ]}
            className="w-56"
          />
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="pi_section_title" label="Section title" required>
          <Input
            name="pi_section_title"
            defaultValue={instruction?.section_title ?? ""}
            required
            maxLength={200}
            placeholder="Bank transfer (INR)"
          />
        </Field>
        <Field
          name="pi_section_id"
          label="Your reference"
          help="Optional. For your use only. We never show it to the customer."
        >
          <Input
            name="pi_section_id"
            defaultValue={instruction?.section_id ?? ""}
            maxLength={100}
            placeholder="hdfc-inr"
          />
        </Field>
      </div>

      <Field name="pi_description" label="Description" help="Shown above the details. Plain text.">
        <Textarea
          name="pi_description"
          defaultValue={instruction?.description ?? ""}
          rows={2}
          maxLength={2000}
          placeholder="Pay by NEFT, RTGS or IMPS. Quote the invoice number as the reference."
        />
      </Field>

      <div className="space-y-2">
        <div className="text-sm font-medium">Details</div>
        <p className="text-xs text-muted-foreground">
          We print the details in order, one line each. A row appears only if it has a label and a
          value.
        </p>
        {rows.map((r, i) => (
          <div
            key={i}
            className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2"
          >
            <Input
              name="pi_field_label"
              value={r.label}
              onChange={(e) => set(i, "label", e.target.value)}
              maxLength={100}
              placeholder="Account name"
              aria-label={`Detail ${i + 1} label`}
            />
            <Input
              name="pi_field_value"
              value={r.value}
              onChange={(e) => set(i, "value", e.target.value)}
              maxLength={300}
              placeholder="Acme Billing Pvt. Ltd."
              aria-label={`Detail ${i + 1} value`}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove detail ${i + 1}`}
              className="size-8"
              // Never remove the last row: an instruction with no details prints an empty
              // block, and the action refuses to save one anyway.
              disabled={rows.length === 1}
              onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
            >
              <X className="size-4" aria-hidden />
            </Button>
          </div>
        ))}
        {rows.length < 12 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRows((prev) => [...prev, { label: "", value: "" }])}
          >
            <Plus className="size-4" aria-hidden /> Add a detail
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">The maximum is twelve details.</p>
        )}
      </div>

      <div className={cn("grid gap-4 sm:grid-cols-2", !targeting && "hidden")}>
        <Field
          name="pi_currencies"
          label="Only for these currencies"
          /* Empty means EVERY invoice, never "no invoice" — the same representation the
             engine resolver reads. And it only bites once "Match instructions to the
             invoice" is on, which is why that is said here rather than left implicit. */
          help="Leave blank for all invoices. For example: INR, USD, EUR."
        >
          <Input
            name="pi_currencies"
            defaultValue={(instruction?.currencies ?? []).join(", ")}
            placeholder="INR, USD"
            className="font-mono"
          />
        </Field>
        <Field
          name="pi_countries"
          label="Only for these countries"
          help="Leave blank for all countries. Use two-letter codes. For example: IN, US, DE."
        >
          <Input
            name="pi_countries"
            defaultValue={(instruction?.countries ?? []).join(", ")}
            placeholder="IN, DE"
            className="font-mono"
          />
        </Field>
      </div>

      <Field name="pi_position" label="Order" help="Lower numbers print first.">
        <Input
          name="pi_position"
          type="number"
          min={0}
          max={1000}
          step={1}
          defaultValue={instruction?.position ?? 0}
          className="w-24 tabular-nums"
        />
      </Field>
    </div>
  );
}
