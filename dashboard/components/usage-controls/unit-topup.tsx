"use client";

import * as React from "react";
import { ActionForm, useFieldError } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { useFormModel } from "@/components/catalog/form-kit";
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
import { RadioField } from "@/components/ui/radio-group";
import { SelectField } from "@/components/ui/select-field";
import { ConfirmActionButton } from "@/components/usage-controls/controls";
import {
  saveUnitAutoTopupAction,
  setAutoTopupEnabledAction,
} from "@/app/(dashboard)/businesses/[biz]/usage-controls-actions";
import { money } from "@/lib/format";
import { creditsLabel } from "@/lib/meter-credit-cost";
import {
  LIMIT_WINDOWS,
  LIMIT_WINDOW_LABEL,
  limitKey,
  unitTopupDraft,
  type UnitTopupConfig,
  type UnitTopupDraft,
} from "@/lib/unit-topup";

type Option = { value: string; label: string };

/** A one-time credit pack price that gives the unit. */
export interface UnitPack {
  value: string;
  label: string;
  /** Credits in one pack, as a decimal. */
  credits: string;
  /** The price of one pack in minor units; null when it is not a flat amount. */
  priceMinor: number | null;
}

/** The credit unit, as the form shows it. */
export interface TopupUnit {
  key: string;
  name: string;
  plural: string;
  decimals: number;
  currency: string;
}

/** "Set up" / "Edit" for the top-up of one credit unit with no money value. */
export function UnitTopupButton({
  biz,
  cus,
  unit,
  config,
  packs,
  paymentMethods,
  retryHelp,
}: {
  biz: string;
  cus: string;
  unit: TopupUnit;
  config: UnitTopupConfig | null;
  packs: UnitPack[];
  paymentMethods: Option[];
  /** What a declined payment does, and where the retry schedule is. */
  retryHelp: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={`${config ? "Edit" : "Set up"} automatic top-up of ${unit.plural}`}
        onClick={() => setOpen(true)}
      >
        {config ? "Edit" : "Set up"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md" className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0">
          {open ? (
            <UnitTopupForm
              biz={biz}
              cus={cus}
              unit={unit}
              config={config}
              packs={packs}
              paymentMethods={paymentMethods}
              retryHelp={retryHelp}
              onDone={() => setOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function UnitTopupForm({
  biz,
  cus,
  unit,
  config,
  packs,
  paymentMethods,
  retryHelp,
  onDone,
}: {
  biz: string;
  cus: string;
  unit: TopupUnit;
  config: UnitTopupConfig | null;
  packs: UnitPack[];
  paymentMethods: Option[];
  retryHelp: string;
  onDone: () => void;
}) {
  const formRef = React.useRef<HTMLFormElement>(null);
  const cur = unit.currency;
  const [v, set] = useFormModel<UnitTopupDraft>(unitTopupDraft(config, packs, cur), formRef);
  const pack = packs.find((p) => p.value === v.pack_price) ?? null;
  const names = { name: unit.name, plural: unit.plural };
  const qty = /^\d+$/.test(v.pack_quantity) ? Number(v.pack_quantity) : null;
  // "That is 2,000 credits for $40.00": exact only for a flat pack price.
  const total =
    pack && qty && qty >= 1
      ? `That is ${creditsLabel((Number(pack.credits) * qty).toFixed(unit.decimals), names)}${
          pack.priceMinor != null ? ` for ${money(pack.priceMinor * qty, cur)} before tax` : ""
        } for each top-up.`
      : undefined;
  const setLimit = (w: (typeof LIMIT_WINDOWS)[number], f: "count" | "amount", x: string) =>
    set("limits", { ...v.limits, [w]: { ...v.limits[w], [f]: x } });

  return (
    <ActionForm
      action={saveUnitAutoTopupAction}
      formRef={formRef}
      onSuccess={onDone}
      className="flex min-h-0 flex-1 flex-col"
    >
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="cus" value={cus} />
      <input type="hidden" name="unit" value={unit.key} />
      <input type="hidden" name="currency" value={cur} />
      <input type="hidden" name="decimals" value={unit.decimals} />
      <input type="hidden" name="pack_minor" value={pack?.priceMinor ?? ""} />
      <input type="hidden" name="pack_price" value={v.pack_price} />
      <input type="hidden" name="method" value={v.method} />
      <input type="hidden" name="pack_quantity" value={v.pack_quantity} />
      <input type="hidden" name="target_units" value={v.target_units} />
      <input type="hidden" name="threshold_units" value={v.threshold_units} />
      <input type="hidden" name="monthly_cap" value={v.monthly_cap} />
      <input type="hidden" name="max_runs_per_day" value={v.max_runs_per_day} />
      <input type="hidden" name="payment_method" value={v.payment_method} />
      <input type="hidden" name="limits" value={JSON.stringify(v.limits)} />
      <DialogHeader className="border-b px-6 py-4 pr-12 text-left">
        <DialogTitle>Automatic top-up of {unit.plural}</DialogTitle>
        <DialogDescription>
          When the balance is at or below the amount that you set, we buy a credit pack for the
          customer and charge their payment method. We add the credits only after the payment
          succeeds.
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-4">
        <Field
          name="pack_price"
          label="Credit pack"
          required
          help="A one-time pack that gives this unit. The pack sets the price, the credits and when they expire."
        >
          <SelectField
            id="pack_price"
            value={v.pack_price}
            onValueChange={(x) => set("pack_price", x)}
            placeholder="Select a pack"
            ariaLabel="Credit pack"
            options={packs.map((p) => ({ value: p.value, label: p.label }))}
          />
        </Field>
        <Field name="threshold_units" label="Balance that starts a top-up" required>
          <UnitsInput
            id="threshold_units"
            ariaLabel="Balance that starts a top-up"
            value={v.threshold_units}
            onChange={(x) => set("threshold_units", x)}
            suffix={`${unit.plural} or less`}
          />
        </Field>
        <Field name="method" label="How much to buy" required>
          <RadioField
            value={v.method}
            onValueChange={(x) => set("method", x as UnitTopupDraft["method"])}
            ariaLabel="How much to buy"
            options={[
              {
                value: "fixed",
                label: "Buy a fixed number of packs",
                hint: "Each top-up buys the same number of packs.",
              },
              {
                value: "target",
                label: "Recharge to an amount",
                hint: "We buy whole packs until the balance is this amount or more.",
              },
            ]}
          />
        </Field>
        {v.method === "fixed" ? (
          <Field name="pack_quantity" label="Packs for each top-up" required help={total}>
            <UnitsInput
              id="pack_quantity"
              ariaLabel="Packs for each top-up"
              value={v.pack_quantity}
              onChange={(x) => set("pack_quantity", x)}
              suffix="packs"
              narrow
            />
          </Field>
        ) : v.method === "target" ? (
          <Field
            name="target_units"
            label="Recharge to"
            required
            help="More than the balance that starts a top-up."
          >
            <UnitsInput
              id="target_units"
              ariaLabel="Recharge to"
              value={v.target_units}
              onChange={(x) => set("target_units", x)}
              suffix={`${unit.plural} or more`}
            />
          </Field>
        ) : null}
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field
            name="monthly_cap"
            label={`Monthly limit (${cur})`}
            required
            help="The most we charge in one calendar month. At least the price of one top-up."
          >
            <Input
              inputMode="decimal"
              value={v.monthly_cap}
              onChange={(e) => set("monthly_cap", e.target.value)}
              className="w-30 tabular-nums"
            />
          </Field>
          <Field name="max_runs_per_day" label="Top-ups per day" required help="1 to 10.">
            <Input
              inputMode="numeric"
              value={v.max_runs_per_day}
              onChange={(e) => set("max_runs_per_day", e.target.value)}
              className="w-20 tabular-nums"
            />
          </Field>
        </div>
        <Field name="payment_method" label="Payment method" help={retryHelp}>
          <SelectField
            id="payment_method"
            value={v.payment_method}
            onValueChange={(x) => set("payment_method", x)}
            ariaLabel="Payment method"
            options={[
              { value: "", label: "The customer's payment methods, in their order" },
              ...paymentMethods,
            ]}
          />
        </Field>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Purchase limits</span>
          <p className="m-0 text-xs text-muted-foreground">
            We do not buy more than these in each period. Leave a field empty for no limit.
          </p>
          <div className="grid grid-cols-[minmax(0,1fr)_5rem_5rem] items-center gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_7.5rem_7.5rem]">
            <span className="text-xs text-muted-foreground">Period</span>
            <span className="text-xs text-muted-foreground">Purchases</span>
            <span className="text-xs text-muted-foreground">Amount ({cur})</span>
            {LIMIT_WINDOWS.map((w) => (
              <LimitRow
                key={w}
                label={LIMIT_WINDOW_LABEL[w]}
                countKey={limitKey(w, "count")}
                amountKey={limitKey(w, "amount")}
                count={v.limits[w].count}
                amount={v.limits[w].amount}
                onCount={(x) => setLimit(w, "count", x)}
                onAmount={(x) => setLimit(w, "amount", x)}
              />
            ))}
          </div>
        </div>
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

function LimitRow({
  label,
  countKey,
  amountKey,
  count,
  amount,
  onCount,
  onAmount,
}: {
  label: string;
  countKey: string;
  amountKey: string;
  count: string;
  amount: string;
  onCount: (v: string) => void;
  onAmount: (v: string) => void;
}) {
  const countError = useFieldError(countKey);
  const amountError = useFieldError(amountKey);
  const error = countError ?? amountError;
  return (
    <>
      <span className="min-w-0 text-sm wrap-anywhere">{label}</span>
      <Input
        id={countKey}
        aria-label={`${label}: purchases`}
        aria-invalid={countError ? true : undefined}
        inputMode="numeric"
        value={count}
        onChange={(e) => onCount(e.target.value)}
        className="w-full tabular-nums"
      />
      <Input
        id={amountKey}
        aria-label={`${label}: amount`}
        aria-invalid={amountError ? true : undefined}
        inputMode="decimal"
        value={amount}
        onChange={(e) => onAmount(e.target.value)}
        className="w-full tabular-nums"
      />
      {error ? (
        <p className="col-span-3 m-0 text-xs font-medium text-destructive">{error}</p>
      ) : null}
    </>
  );
}

/** A fixed-width number box with its unit beside it; a long unit name wraps, the box does not. */
function UnitsInput({
  id,
  ariaLabel,
  value,
  onChange,
  suffix,
  narrow,
  ...rest
}: {
  id: string;
  ariaLabel: string;
  value: string;
  onChange: (v: string) => void;
  suffix: string;
  narrow?: boolean;
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
        className={`${narrow ? "w-20" : "w-30"} shrink-0 tabular-nums`}
        {...rest}
      />
      <span className="min-w-0 text-sm wrap-anywhere text-muted-foreground">{suffix}</span>
    </span>
  );
}

/** Enable or disable the top-up of one unit, after a confirm. */
export function UnitTopupToggle({
  biz,
  cus,
  unit,
  on,
  canEnable,
}: {
  biz: string;
  cus: string;
  unit: TopupUnit;
  on: boolean;
  /** False while the customer has no payment method we can charge. */
  canEnable: boolean;
}) {
  if (!on && !canEnable) return null;
  return (
    <ConfirmActionButton
      action={setAutoTopupEnabledAction}
      fields={{ biz, cus, currency: unit.currency, unit: unit.key, on: on ? "false" : "true" }}
      label={on ? "Disable" : "Enable"}
      title={
        on
          ? `Disable automatic top-up of ${unit.plural}?`
          : `Enable automatic top-up of ${unit.plural}?`
      }
      description={
        on
          ? "We stop buying credit packs for this customer."
          : "We buy a credit pack again when the balance falls to the amount you set. The payment method must be able to pay."
      }
      confirmLabel={on ? "Disable" : "Enable"}
    />
  );
}
