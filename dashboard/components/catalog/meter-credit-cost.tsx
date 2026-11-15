"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { ActionForm, useFieldError } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { useFormModel } from "@/components/catalog/form-kit";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { ConfirmActionButton } from "@/components/usage-controls/controls";
import {
  removeMeterCreditCostAction,
  saveMeterCreditCostAction,
} from "@/app/(dashboard)/businesses/[biz]/catalog/meters/actions";
import {
  costBasis,
  creditCostDraft,
  planCostKey,
  type CreditCostDraft,
  type MeterCreditCost,
} from "@/lib/meter-credit-cost";

type Option = { value: string; label: string };

/** An active credit unit with no money value: the only kind a credit cost may name. */
export interface CostUnit {
  id: string;
  name: string;
  plural_name: string;
}

/** "Set credit cost" / "Edit": the meter's unit, cost and plan overrides in one dialog. */
export function MeterCreditCostButton({
  biz,
  meter,
  aggregation,
  valueProperty,
  cost,
  units,
  plans,
}: {
  biz: string;
  meter: string;
  aggregation: string;
  valueProperty: string | null;
  cost: MeterCreditCost | null;
  units: CostUnit[];
  plans: Option[];
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        type="button"
        size="sm"
        // Outline: the page's filled action is "Send test event".
        variant="outline"
        onClick={() => setOpen(true)}
      >
        {cost ? "Edit" : "Set credit cost"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md" className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0">
          {/* Mounted only while open, so the form model starts from the saved cost. */}
          {open ? (
            <CreditCostForm
              biz={biz}
              meter={meter}
              aggregation={aggregation}
              valueProperty={valueProperty}
              cost={cost}
              units={units}
              plans={plans}
              onDone={() => setOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function CreditCostForm({
  biz,
  meter,
  aggregation,
  valueProperty,
  cost,
  units,
  plans,
  onDone,
}: {
  biz: string;
  meter: string;
  aggregation: string;
  valueProperty: string | null;
  cost: MeterCreditCost | null;
  units: CostUnit[];
  plans: Option[];
  onDone: () => void;
}) {
  const formRef = React.useRef<HTMLFormElement>(null);
  const [v, set] = useFormModel<CreditCostDraft>(creditCostDraft(cost, units), formRef);
  const unit = units.find((u) => u.id === v.unit);
  const subscriptions = (cost?.overrides ?? []).flatMap((o) => ("subscription" in o ? [o] : []));
  const used = new Set(v.plans.map((p) => p.product));
  const setPlan = (i: number, patch: Partial<CreditCostDraft["plans"][number]>) =>
    set(
      "plans",
      v.plans.map((p, j) => (j === i ? { ...p, ...patch } : p)),
    );
  const per = `${unit?.plural_name ?? "credits"} for ${costBasis(aggregation, valueProperty)}`;

  return (
    <ActionForm
      action={saveMeterCreditCostAction}
      formRef={formRef}
      onSuccess={onDone}
      className="flex min-h-0 flex-1 flex-col"
    >
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="meter" value={meter} />
      <input type="hidden" name="unit" value={v.unit} />
      <input type="hidden" name="credits_per_unit" value={v.cost} />
      <input type="hidden" name="plans" value={JSON.stringify(v.plans)} />
      <input type="hidden" name="subscriptions" value={JSON.stringify(subscriptions)} />
      <DialogHeader className="border-b px-6 py-4 pr-12 text-left">
        <DialogTitle>{cost ? "Edit credit cost" : "Set credit cost"}</DialogTitle>
        <DialogDescription>
          Usage of this meter is paid with credits that have no money value. We take the credits
          when each event arrives, and we do not bill the usage on an invoice, unless the credit
          unit has an overage price.
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-4">
        <Field
          name="unit"
          label="Credit unit"
          required
          help={
            cost
              ? "After usage is paid in a unit, the meter keeps that unit."
              : "Only units with no money value. Credit with a money value pays usage through a usage price."
          }
        >
          <SelectField
            id="unit"
            value={v.unit}
            onValueChange={(x) => set("unit", x)}
            placeholder="Select a unit"
            ariaLabel="Credit unit"
            options={units.map((u) => ({ value: u.id, label: u.plural_name }))}
          />
        </Field>
        <Field
          name="credits_per_unit"
          label="Cost"
          required
          help="A number more than 0, with at most 6 decimal places. We round the credits of each event to the unit's smallest amount."
        >
          <CostInput
            id="credits_per_unit"
            ariaLabel="Cost"
            value={v.cost}
            onChange={(x) => set("cost", x)}
            suffix={per}
          />
        </Field>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Cost for each plan</span>
          <p className="m-0 text-xs text-muted-foreground">
            A customer on one of these plans pays this cost, in {per}. A customer on more than one
            plan pays the cost of the oldest subscription.
          </p>
          {v.plans.length > 0 ? (
            <div className="grid grid-cols-[minmax(0,1fr)_5rem_2rem] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_7.5rem_2rem]">
              <span className="text-xs text-muted-foreground">Plan</span>
              <span className="text-xs text-muted-foreground">Cost</span>
              <span aria-hidden />
              {v.plans.map((row, i) => (
                <PlanRow
                  key={i}
                  index={i}
                  product={row.product}
                  cost={row.cost}
                  options={plans.filter((o) => o.value === row.product || !used.has(o.value))}
                  onProduct={(x) => setPlan(i, { product: x })}
                  onCost={(x) => setPlan(i, { cost: x })}
                  onRemove={() =>
                    set(
                      "plans",
                      v.plans.filter((_, j) => j !== i),
                    )
                  }
                />
              ))}
            </div>
          ) : (
            <p className="m-0 text-xs text-muted-foreground">Every plan uses the cost above.</p>
          )}
          {plans.some((o) => !used.has(o.value)) ? (
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  set("plans", [
                    ...v.plans,
                    { product: plans.find((o) => !used.has(o.value))!.value, cost: v.cost },
                  ])
                }
              >
                <Plus className="size-4" />
                Add plan
              </Button>
            </div>
          ) : null}
        </div>
        {subscriptions.length > 0 ? (
          <Alert tone="neutral">
            {subscriptions.length === 1
              ? "1 subscription has its own cost."
              : `${subscriptions.length} subscriptions have their own cost.`}{" "}
            We keep them when you save. You can change them through the API.
          </Alert>
        ) : null}
      </div>
      <DialogFooter className="border-t px-6 py-4">
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <SubmitButton>Save</SubmitButton>
      </DialogFooter>
    </ActionForm>
  );
}

function PlanRow({
  index,
  product,
  cost,
  options,
  onProduct,
  onCost,
  onRemove,
}: {
  index: number;
  product: string;
  cost: string;
  options: Option[];
  onProduct: (v: string) => void;
  onCost: (v: string) => void;
  onRemove: () => void;
}) {
  const key = planCostKey(index);
  const error = useFieldError(key);
  const n = index + 1;
  return (
    <>
      {/* A long plan name wraps inside its column; the cost keeps its width. */}
      <div className="min-w-0">
        <SelectField
          id={`${key}_plan`}
          value={product}
          onValueChange={onProduct}
          ariaLabel={`Plan ${n}`}
          placeholder="Select a plan"
          options={options}
        />
      </div>
      <Input
        id={key}
        aria-label={`Plan ${n} cost`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${key}-error` : undefined}
        inputMode="decimal"
        value={cost}
        onChange={(e) => onCost(e.target.value)}
        className="w-full tabular-nums"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove plan ${n}`}
        onClick={onRemove}
      >
        <X className="size-4" />
      </Button>
      {error ? (
        <p id={`${key}-error`} className="col-span-3 m-0 text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** A 120px number box with what it counts beside it; the text wraps, the box does not. */
function CostInput({
  id,
  ariaLabel,
  value,
  onChange,
  suffix,
  ...rest
}: {
  id: string;
  ariaLabel: string;
  value: string;
  onChange: (v: string) => void;
  suffix: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Input
        id={id}
        aria-label={ariaLabel}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-30 shrink-0 tabular-nums"
        {...rest}
      />
      <span className="min-w-0 text-sm wrap-anywhere text-muted-foreground">{suffix}</span>
    </span>
  );
}

/** Remove the credit cost, after a confirm: events then spend no credits. */
export function RemoveCreditCostButton({ biz, meter }: { biz: string; meter: string }) {
  return (
    <ConfirmActionButton
      action={removeMeterCreditCostAction}
      fields={{ biz, meter }}
      label="Remove"
      title="Remove the credit cost?"
      description="Events of this meter then take no credits, and we do not bill them in money. Credits that events took before stay taken. You can set a cost again later. After events took credits, the meter keeps its unit."
      confirmLabel="Remove credit cost"
      destructive
    />
  );
}
