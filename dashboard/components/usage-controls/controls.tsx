"use client";

import { TAX_TREATMENT_LABEL } from "@/lib/credits";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useDefaultState } from "@/lib/use-default-state";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EditDrawer } from "@/components/edit-drawer";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckboxField } from "@/components/ui/checkbox";
import { RadioField } from "@/components/ui/radio-group";
import { SelectField } from "@/components/ui/select-field";
import type { ActionResult } from "@/lib/action-result";
import { money } from "@/lib/format";
import { toMajorInput, toMinor } from "@/lib/money";
import {
  createSpendLimitAction,
  createSpendLimitTierAction,
  createUsageAlertAction,
  saveAutoTopupAction,
  setAutoTopupEnabledAction,
  updateSpendLimitAction,
} from "@/app/(dashboard)/businesses/[biz]/usage-controls-actions";
import type { AutoTopup, SpendLimit } from "@/lib/api/usage-controls";
import {
  ALERT_KIND_LABEL,
  INTERVAL_LABEL,
  WEEKDAYS,
  coverHours,
  leadCoverMinor,
  type AlertKind,
} from "@/lib/usage-controls";

type Action = (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
type Option = { value: string; label: string };

const INTERVAL_OPTIONS: Option[] = (["day", "week", "month", "period"] as const).map((k) => ({
  value: k,
  label: INTERVAL_LABEL[k],
}));

/** A button that runs one action after a confirmation (delete, turn off). */
export function ConfirmActionButton({
  action,
  fields,
  label,
  title,
  description,
  confirmLabel,
  destructive,
  variant = "outline",
}: {
  action: Action;
  fields: Record<string, string>;
  label: string;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  variant?: "outline" | "ghost" | "default";
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button type="button" size="sm" variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        confirmLabel={confirmLabel}
        destructive={destructive}
        onConfirm={async () => {
          const fd = new FormData();
          for (const [k, v] of Object.entries(fields)) fd.set(k, v);
          const res = await action(null, fd);
          if (res.ok) {
            toast.success(res.message ?? "Done.");
            router.refresh();
          } else toast.error(res.message ?? "We could not do the action.");
        }}
      />
    </>
  );
}

// ── Spend limits ───────────────────────────────────────────────────────────────

export function CreateSpendLimitButton({
  biz,
  cus,
  currency,
  subscriptions,
  propertyKeys,
}: {
  biz: string;
  cus: string;
  /** The customer's billing currency: a limit is in the currency of its usage. */
  currency: string;
  subscriptions: Option[];
  /** Limit properties from the business's meters (`limit_dimensions`). */
  propertyKeys: string[];
}) {
  const [open, setOpen] = React.useState(false);
  const [scope, setScope] = React.useState("");
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Create limit
      </Button>
      <EditDrawer
        open={open}
        onOpenChange={setOpen}
        title="Create spend limit"
        description="Spend is rated usage before tax and before credit. A hard limit makes the access check refuse new requests. A soft limit only sends a notification."
      >
        <ActionForm
          action={createSpendLimitAction}
          onSuccess={() => setOpen(false)}
          className="flex flex-col gap-4 py-2"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="cus" value={cus} />
          <input type="hidden" name="currency" value={currency} />
          <Field name="scope" label="Limit">
            <RadioField
              name="scope"
              value={scope}
              onValueChange={setScope}
              ariaLabel="Limit"
              options={[
                { value: "customer", label: "All usage of this customer" },
                {
                  value: "subscription",
                  label: "One subscription",
                  disabled: subscriptions.length === 0,
                },
                {
                  value: "property",
                  label: "Each value of a property",
                  hint: "For example each user, team or API key. It counts usage from the time the property was added to the meter.",
                  disabled: propertyKeys.length === 0,
                },
              ]}
            />
          </Field>
          {scope === "subscription" ? (
            <Field name="subscription" label="Subscription">
              <SelectField name="subscription" options={subscriptions} placeholder="Select" />
            </Field>
          ) : null}
          {scope === "property" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field name="property_key" label="Property">
                <SelectField
                  name="property_key"
                  options={propertyKeys.map((k) => ({ value: k, label: k }))}
                  placeholder="Select"
                />
              </Field>
              <Field
                name="property_value"
                label="Value"
                help="Leave empty to give each value the same limit."
              >
                <Input name="property_value" maxLength={255} />
              </Field>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field name="interval" label="Interval">
              <SelectField name="interval" options={INTERVAL_OPTIONS} placeholder="Select" />
            </Field>
            <Field name="amount" label={`Amount (${currency})`}>
              <Input name="amount" inputMode="decimal" className="tabular-nums" />
            </Field>
          </div>
          <Field name="mode" label="At the limit">
            <RadioField
              name="mode"
              ariaLabel="At the limit"
              options={[
                {
                  value: "hard",
                  label: "Stop new requests",
                  hint: "The access check answers spend_limit_reached. Usage already sent is billed.",
                },
                { value: "soft", label: "Send a notification only" },
              ]}
            />
          </Field>
          <div className="flex justify-end">
            <SubmitButton>Create limit</SubmitButton>
          </div>
        </ActionForm>
      </EditDrawer>
    </>
  );
}

export function EditSpendLimitButton({
  biz,
  cus,
  limit,
}: {
  biz: string;
  cus: string;
  limit: SpendLimit;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Edit
      </Button>
      <EditDrawer open={open} onOpenChange={setOpen} title="Edit spend limit">
        <ActionForm
          action={updateSpendLimitAction}
          onSuccess={() => setOpen(false)}
          className="flex flex-col gap-4 py-2"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="cus" value={cus} />
          <input type="hidden" name="id" value={limit.id} />
          <input type="hidden" name="currency" value={limit.currency} />
          <Field name="amount" label={`Amount (${limit.currency})`}>
            <Input
              name="amount"
              inputMode="decimal"
              defaultValue={toMajorInput(limit.amount_minor, limit.currency)}
              className="tabular-nums"
            />
          </Field>
          <div className="flex justify-end">
            <SubmitButton>Save</SubmitButton>
          </div>
        </ActionForm>
      </EditDrawer>
    </>
  );
}

// ── Limit tiers ────────────────────────────────────────────────────────────────

export function CreateTierButton({ biz, currencies }: { biz: string; currencies: string[] }) {
  const [open, setOpen] = React.useState(false);
  const [cur, setCur] = useDefaultState(currencies[0] ?? "");
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Create tier
      </Button>
      <EditDrawer
        open={open}
        onOpenChange={setOpen}
        title="Create limit tier"
        description="When a customer's lifetime paid amount reaches the level, its customer limits go up to these amounts. A tier never goes down after a refund."
      >
        <ActionForm
          action={createSpendLimitTierAction}
          onSuccess={() => setOpen(false)}
          className="flex flex-col gap-4 py-2"
        >
          <input type="hidden" name="biz" value={biz} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field name="currency" label="Currency">
              <SelectField
                name="currency"
                value={cur}
                onValueChange={setCur}
                options={currencies.map((c) => ({ value: c, label: c }))}
              />
            </Field>
            <Field name="level" label={`Lifetime paid (${cur})`}>
              <Input name="level" inputMode="decimal" className="tabular-nums" />
            </Field>
          </div>
          <p className="m-0 text-sm text-muted-foreground">
            Limits for the customer. Leave an interval empty to keep the customer&apos;s own limit
            for it.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {(["day", "week", "month", "period"] as const).map((k) => (
              <Field key={k} name={k} label={`${INTERVAL_LABEL[k]} (${cur})`}>
                <Input name={k} inputMode="decimal" className="tabular-nums" />
              </Field>
            ))}
          </div>
          <div className="flex justify-end">
            <SubmitButton>Create tier</SubmitButton>
          </div>
        </ActionForm>
      </EditDrawer>
    </>
  );
}

// ── Alerts ─────────────────────────────────────────────────────────────────────

const UNIT_OPTIONS: Record<AlertKind, Option[]> = {
  usage_quantity: [
    { value: "units", label: "Units" },
    { value: "percent", label: "Percent of the feature limit" },
  ],
  spend: [
    { value: "minor", label: "Amount" },
    { value: "percent", label: "Percent of the spend limit" },
  ],
  credit_balance: [
    { value: "minor", label: "Amount" },
    { value: "percent", label: "Percent of the credit given" },
  ],
  credit_runway: [{ value: "days", label: "Days left" }],
};

export function CreateAlertButton({
  biz,
  customer,
  products,
  meters,
  currencies,
}: {
  biz: string;
  /** Set: a customer alert. Unset: a plan alert, from `products`. */
  customer?: string;
  products?: Option[];
  meters: Option[];
  currencies: string[];
}) {
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<AlertKind | "">("");
  const [unit, setUnit] = React.useState("");
  const [cur, setCur] = useDefaultState(currencies[0] ?? "");
  const units = kind ? UNIT_OPTIONS[kind] : [];
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Create alert
      </Button>
      <EditDrawer
        open={open}
        onOpenChange={setOpen}
        title={customer ? "Create alert" : "Create plan alert"}
        description={
          customer
            ? "Each threshold fires once per period and resolves when the value goes back, or at the end of the period."
            : "A plan alert applies to every subscription to the plan, also to new ones. A customer alert of the same kind wins."
        }
      >
        <ActionForm
          action={createUsageAlertAction}
          onSuccess={() => setOpen(false)}
          className="flex flex-col gap-4 py-2"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="scope" value={customer ? "customer" : "plan"} />
          {customer ? <input type="hidden" name="customer" value={customer} /> : null}
          {!customer ? (
            <Field name="product" label="Plan">
              <SelectField name="product" options={products ?? []} placeholder="Select" />
            </Field>
          ) : null}
          <Field name="kind" label="Watch">
            <SelectField
              name="kind"
              value={kind}
              placeholder="Select"
              onValueChange={(v) => {
                const k = v as AlertKind;
                setKind(k);
                setUnit(UNIT_OPTIONS[k][0]!.value);
              }}
              options={(Object.keys(ALERT_KIND_LABEL) as AlertKind[]).map((k) => ({
                value: k,
                label: ALERT_KIND_LABEL[k],
              }))}
            />
          </Field>
          {kind === "usage_quantity" ? (
            <Field name="meter" label="Meter">
              <SelectField name="meter" options={meters} placeholder="Select" />
            </Field>
          ) : null}
          {kind === "usage_quantity" || kind === "spend" ? (
            <Field name="interval" label="Interval">
              <SelectField name="interval" options={INTERVAL_OPTIONS} placeholder="Select" />
            </Field>
          ) : null}
          {kind && kind !== "usage_quantity" ? (
            <Field name="currency" label="Currency">
              <SelectField
                name="currency"
                value={cur}
                onValueChange={setCur}
                options={currencies.map((c) => ({ value: c, label: c }))}
              />
            </Field>
          ) : null}
          {kind ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field name="threshold_unit" label="Thresholds in">
                <SelectField
                  name="threshold_unit"
                  value={unit}
                  onValueChange={setUnit}
                  options={units}
                />
              </Field>
              <Field
                name="thresholds"
                label="Thresholds"
                help={
                  unit === "minor"
                    ? `Amounts in ${cur}, for example 100, 400, 500.`
                    : unit === "percent"
                      ? "For example 50, 80, 100."
                      : "1 to 10 numbers, with commas between them."
                }
              >
                <Input name="thresholds" maxLength={200} />
              </Field>
            </div>
          ) : null}
          <CheckboxField
            name="email"
            label="Send an email to the customer"
            hint="To the customer's billing email, when a threshold fires."
          />
          <div className="flex justify-end">
            <SubmitButton>Create alert</SubmitButton>
          </div>
        </ActionForm>
      </EditDrawer>
    </>
  );
}

// ── Automatic top-up ───────────────────────────────────────────────────────────

export function AutoTopupButton({
  biz,
  cus,
  currency,
  config,
  paymentMethods,
  burnPerDay,
  leadHours,
  limits,
  defaultTaxTreatment,
  defaultPriority,
}: {
  biz: string;
  cus: string;
  currency: string;
  config: AutoTopup | null;
  paymentMethods: Option[];
  burnPerDay: number | null;
  /** Hours from notice to charge on the payment method, when known; null otherwise. */
  leadHours: number | null;
  limits: { min_minor?: number | null; max_minor?: number | null } | null;
  defaultTaxTreatment: string | null;
  defaultPriority: number;
}) {
  const [open, setOpen] = React.useState(false);
  const [trigger, setTrigger] = useDefaultState<string>(config?.trigger ?? "");
  const [method, setMethod] = useDefaultState<string>(config?.method ?? "");
  const [every, setEvery] = useDefaultState<string>(config?.schedule?.every ?? "");
  const [threshold, setThreshold] = useDefaultState(
    toMajorInput(config?.threshold_minor ?? null, currency),
  );
  const thresholdMinor = threshold.trim() ? toMinor(Number(threshold), currency) : null;
  const hours = thresholdMinor != null ? coverHours(thresholdMinor, burnPerDay) : null;
  const needed = leadHours != null && burnPerDay ? leadCoverMinor(leadHours, burnPerDay) : null;
  const tooLow = needed != null && thresholdMinor != null && thresholdMinor < needed;
  const range = [
    limits?.min_minor != null ? `at least ${money(limits.min_minor, currency)}` : null,
    limits?.max_minor != null ? `at most ${money(limits.max_minor, currency)}` : null,
  ].filter(Boolean);
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        {config ? "Edit" : "Set up"}
      </Button>
      <EditDrawer
        open={open}
        onOpenChange={setOpen}
        title="Automatic top-up"
        description="We buy credit for the customer and add it only after the payment succeeds. If the payment is declined, automatic top-up turns off."
        wide
      >
        <ActionForm
          action={saveAutoTopupAction}
          onSuccess={() => setOpen(false)}
          className="flex flex-col gap-4 py-2"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="cus" value={cus} />
          <input type="hidden" name="currency" value={currency} />
          <Field name="trigger" label="When">
            <RadioField
              name="trigger"
              value={trigger}
              onValueChange={setTrigger}
              ariaLabel="When"
              options={[
                { value: "threshold", label: "When the balance falls to an amount" },
                { value: "schedule", label: "On a schedule" },
              ]}
            />
          </Field>
          {trigger === "threshold" ? (
            <Field
              name="threshold"
              label={`Balance (${currency})`}
              help={
                hours != null
                  ? `Covers about ${hours} hours of usage at the current rate.`
                  : "We show how many hours of usage this covers when the customer has 24 hours of usage."
              }
            >
              <Input
                name="threshold"
                inputMode="decimal"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                className="tabular-nums"
              />
            </Field>
          ) : trigger === "schedule" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field name="schedule_every" label="Repeat">
                <SelectField
                  name="schedule_every"
                  value={every}
                  onValueChange={setEvery}
                  placeholder="Select"
                  options={[
                    { value: "week", label: "Every week" },
                    { value: "month", label: "Every month" },
                  ]}
                />
              </Field>
              {every === "" ? null : every === "week" ? (
                <Field name="weekday" label="Day">
                  <SelectField
                    name="weekday"
                    defaultValue={
                      config?.schedule?.every === "week" ? String(config.schedule.weekday) : ""
                    }
                    options={WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: d }))}
                    placeholder="Select"
                  />
                </Field>
              ) : (
                <Field
                  name="month_day"
                  label="Day of the month"
                  help="1 to 31. In a shorter month, the last day."
                >
                  <Input
                    name="month_day"
                    inputMode="numeric"
                    defaultValue={
                      config?.schedule?.every === "month" ? String(config.schedule.day) : ""
                    }
                  />
                </Field>
              )}
            </div>
          ) : null}
          {trigger === "threshold" && tooLow && leadHours != null ? (
            <Alert tone="warning">
              On this payment method, the charge can happen up to {leadHours} hours after we send
              the notice. Set a balance of {money(needed!, currency)} or more. This covers{" "}
              {leadHours} hours of usage at the current rate.
            </Alert>
          ) : trigger === "threshold" && hours != null && hours < 48 ? (
            <Alert tone="warning">
              The balance covers less than 2 days of usage. A notice to the payer can delay the
              charge, and requests can stop when credit runs out.
            </Alert>
          ) : null}
          <Field name="method" label="How much">
            <RadioField
              name="method"
              value={method}
              onValueChange={setMethod}
              ariaLabel="How much"
              options={[
                { value: "fixed", label: "Add a fixed amount" },
                { value: "target", label: "Fill up to a balance" },
              ]}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {method === "" ? null : method === "fixed" ? (
              <Field
                name="amount"
                label={`Amount (${currency})`}
                help={range.length ? `Each purchase is ${range.join(" and ")}.` : undefined}
              >
                <Input
                  name="amount"
                  inputMode="decimal"
                  defaultValue={toMajorInput(config?.amount_minor ?? null, currency)}
                  className="tabular-nums"
                />
              </Field>
            ) : (
              <Field
                name="target"
                label={`Balance after the top-up (${currency})`}
                help={range.length ? `Each purchase is ${range.join(" and ")}.` : undefined}
              >
                <Input
                  name="target"
                  inputMode="decimal"
                  defaultValue={toMajorInput(config?.target_minor ?? null, currency)}
                  className="tabular-nums"
                />
              </Field>
            )}
            <Field
              name="monthly_cap"
              label={`Monthly limit (${currency})`}
              help="The most we buy in one calendar month."
            >
              <Input
                name="monthly_cap"
                inputMode="decimal"
                defaultValue={toMajorInput(config?.monthly_cap_minor ?? null, currency)}
                className="tabular-nums"
              />
            </Field>
            <Field name="max_runs_per_day" label="Top-ups per day" help="1 to 10.">
              <Input
                name="max_runs_per_day"
                type="number"
                min={1}
                max={10}
                defaultValue={config?.max_runs_per_day ?? 3}
                className="tabular-nums"
              />
            </Field>
            <Field name="payment_method" label="Payment method">
              <SelectField
                name="payment_method"
                defaultValue={config?.payment_method ?? ""}
                options={[
                  { value: "", label: "The customer's payment methods, in their order" },
                  ...paymentMethods,
                ]}
              />
            </Field>
          </div>
          <Field name="tax_treatment" label="Tax on the credit">
            <RadioField
              name="tax_treatment"
              defaultValue={config?.grant.tax_treatment ?? defaultTaxTreatment ?? ""}
              ariaLabel="Tax on the credit"
              options={(["taxed_at_purchase", "taxed_at_use"] as const).map((v) => ({
                value: v,
                label: TAX_TREATMENT_LABEL[v],
              }))}
            />
          </Field>
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
                defaultValue={config?.grant.priority ?? defaultPriority}
                className="tabular-nums"
              />
            </Field>
            <Field
              name="expires_after_months"
              label="Credit expires after (months)"
              help="Leave empty for no expiry."
            >
              <Input
                name="expires_after_months"
                inputMode="numeric"
                defaultValue={config?.grant.expires_after_months ?? ""}
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <SubmitButton>Save</SubmitButton>
          </div>
        </ActionForm>
      </EditDrawer>
    </>
  );
}

export function AutoTopupToggle({
  biz,
  cus,
  currency,
  on,
}: {
  biz: string;
  cus: string;
  currency: string;
  on: boolean;
}) {
  return (
    <ConfirmActionButton
      action={setAutoTopupEnabledAction}
      fields={{ biz, cus, currency, on: on ? "false" : "true" }}
      label={on ? "Turn off" : "Turn on"}
      title={on ? "Turn off automatic top-up?" : "Turn on automatic top-up?"}
      description={
        on
          ? "We stop buying credit for this customer. A top-up that already has a notice out is cancelled."
          : "We buy credit again when the rule applies. The payment method must be able to pay."
      }
      confirmLabel={on ? "Turn off" : "Turn on"}
    />
  );
}
