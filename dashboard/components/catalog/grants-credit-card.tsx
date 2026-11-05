"use client";

import * as React from "react";
import { Field } from "@/components/form/field";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { RadioField } from "@/components/ui/radio-group";
import { FormCard, SwitchRow, Wide } from "@/components/catalog/form-kit";
import type { GrantsCreditDraft } from "@/lib/grants-credit-form";
import { draftOf } from "@/lib/reset";
import { RenewsField } from "@/components/catalog/renews-field";
import { FIRST_WINDOW_LABELS, type PlanCreditResets } from "@/lib/billing-rules";
import {
  DEFAULT_PRIORITY,
  POLICY_LABEL,
  TAX_TREATMENT_LABEL,
  amountDecimals,
  rateSentence,
  type CreditTaxTreatment,
  type CreditUnit,
  type PriceGrantsCredit,
} from "@/lib/credits";

/** What the price form needs to offer credit: loaded by the page, null when unreadable. */
export interface GrantsCreditContext {
  units: CreditUnit[];
  blockingEnabled: boolean;
  defaultTaxTreatment: CreditTaxTreatment | null;
  /** The business's resolved `plan_credits.first_window`: what a price without its own uses. */
  firstWindowDefault: PlanCreditResets["first_window"];
}

const asText = (n: number | null | undefined, decimals: number) =>
  n == null ? "" : String(n / 10 ** decimals);

function seedOf(
  g: PriceGrantsCredit | null | undefined,
  kind: "pack" | "per_cycle",
  units: CreditUnit[],
  currency: string,
  defaultTax: CreditTaxTreatment | null,
): GrantsCreditDraft {
  const unit = units.find((u) => u.id === g?.unit) ?? null;
  const decimals = amountDecimals(g?.unit ?? null, unit?.decimals ?? 0, currency);
  const pack = g?.kind === "pack" ? g : null;
  const cycle = g?.kind === "per_cycle" ? g : null;
  return {
    on: !!g && g.kind === kind,
    kind,
    unit: g?.unit ?? "",
    decimals,
    amount: asText(g?.amount, decimals),
    priority: String(g?.priority ?? DEFAULT_PRIORITY),
    expires_days: pack?.expires_after ? String(pack.expires_after.days) : "",
    // The business default, resolved, so the form shows what a pack will really use.
    tax_treatment:
      pack?.tax_treatment ?? (g?.unit && defaultTax === "taxed_at_use" ? "" : (defaultTax ?? "")),
    on_exhausted: g?.on_exhausted ?? "",
    roll_mode: cycle?.rollover?.mode ?? "none",
    roll_percent: String(cycle?.rollover?.percent ?? 100),
    roll_cap: asText(cycle?.rollover?.cap ?? null, decimals),
    roll_keep:
      cycle?.rollover?.mode === "carry" && cycle.rollover.expire_after_cycles === null
        ? "forever"
        : "cycles",
    roll_cycles: String(cycle?.rollover?.expire_after_cycles ?? 1),
    reset: draftOf(cycle?.reset),
    first_window: cycle?.first_window ?? null,
  };
}

/**
 * Price form → "Grants credit": a credit pack on a one-time price, credits per billing
 * period on a recurring one (`prices.grants_credit`). Posts one JSON field.
 * Applicability is "all usage lines"; per-price applicability has no control here.
 */
export function GrantsCreditCard({
  context,
  recurring,
  currency,
  initial,
}: {
  context: GrantsCreditContext;
  recurring: boolean;
  currency: string;
  initial?: PriceGrantsCredit | null;
}) {
  const kind = recurring ? "per_cycle" : "pack";
  const [v, setV] = React.useState<GrantsCreditDraft>(() =>
    seedOf(initial, kind, context.units, currency, context.defaultTaxTreatment),
  );
  const set = <K extends keyof GrantsCreditDraft>(k: K, val: GrantsCreditDraft[K]) =>
    setV((p) => ({ ...p, [k]: val }));
  const units = context.units.filter(
    (u) => u.currency === currency && (u.status === "active" || u.id === v.unit),
  );
  const unit = units.find((u) => u.id === v.unit) ?? null;
  const decimals = amountDecimals(unit ? unit.id : null, unit?.decimals ?? 0, currency);
  const draft = { ...v, kind, decimals, unit: unit ? unit.id : "" } as GrantsCreditDraft;
  const unitWord = unit ? unit.plural_name : currency;
  const ownClock = !!v.reset && v.reset.every !== "term";
  const periodEnd = ownClock ? "When the credits renew" : "At the end of the billing period";

  return (
    <FormCard title="Grants credit">
      {/* Posted only when there is something to write: a price with no credit stays untouched. */}
      {v.on || initial ? (
        <>
          <input type="hidden" name="grants_credit_present" value="1" />
          <input type="hidden" name="grants_credit" value={JSON.stringify(draft)} />
        </>
      ) : null}
      <Wide>
        <SwitchRow
          label={recurring ? "Give credit each billing period" : "Sell this price as a credit pack"}
          hint={
            recurring
              ? "Credit that is part of the plan fee. It is promotional credit, so it has no cost basis."
              : "The customer gets paid credit when the invoice for this price is paid."
          }
          checked={v.on}
          onCheckedChange={(c) => set("on", c)}
        />
      </Wide>
      {v.on ? (
        <>
          <Field
            name="gc_unit"
            label="Unit"
            help={unit ? rateSentence(unit) : `The credit is an amount in ${currency}.`}
          >
            <SelectField
              id="gc_unit"
              value={unit ? unit.id : ""}
              onValueChange={(k) => {
                setV((p) => ({
                  ...p,
                  unit: k,
                  tax_treatment: k && p.tax_treatment === "taxed_at_use" ? "" : p.tax_treatment,
                }));
              }}
              ariaLabel="Unit"
              options={[
                { value: "", label: `Money (${currency})` },
                ...units.map((u) => ({ value: u.id, label: u.plural_name })),
              ]}
            />
          </Field>
          <Field
            name="gc_amount"
            label={recurring ? `${unitWord} each period` : `${unitWord} in the pack`}
            required
            help={
              recurring
                ? "We multiply it by the quantity on the subscription."
                : "We multiply it by the quantity bought."
            }
          >
            <Input
              id="gc_amount"
              inputMode="decimal"
              value={v.amount}
              onChange={(e) => set("amount", e.target.value)}
              className="tabular-nums"
            />
          </Field>
          <Field name="gc_priority" label="Priority" help="0 to 100. Lower is used first.">
            <Input
              id="gc_priority"
              type="number"
              min={0}
              max={100}
              value={v.priority}
              onChange={(e) => set("priority", e.target.value)}
              className="tabular-nums"
            />
          </Field>
          {recurring ? null : (
            <Field
              name="gc_expires_days"
              label="Expires after"
              help="Days after the payment. Leave empty for no expiry."
            >
              <div className="flex items-center gap-2">
                <Input
                  id="gc_expires_days"
                  type="number"
                  min={1}
                  value={v.expires_days}
                  onChange={(e) => set("expires_days", e.target.value)}
                  className="w-28 tabular-nums"
                />
                <span className="text-sm text-muted-foreground">days</span>
              </div>
            </Field>
          )}
          {recurring ? null : (
            <Wide>
              <Field
                name="gc_tax_treatment"
                label="Tax on the credit"
                required
                help={
                  context.defaultTaxTreatment
                    ? `The business default is ${TAX_TREATMENT_LABEL[context.defaultTaxTreatment].toLowerCase()}.`
                    : "The business has no default, so select one."
                }
              >
                <RadioField
                  value={v.tax_treatment}
                  onValueChange={(t) => set("tax_treatment", t)}
                  ariaLabel="Tax on the credit"
                  options={[
                    {
                      value: "taxed_at_purchase",
                      label: TAX_TREATMENT_LABEL.taxed_at_purchase,
                      hint: "We charge tax on the purchase. Usage paid by the credit has no tax.",
                    },
                    {
                      value: "taxed_at_use",
                      label: TAX_TREATMENT_LABEL.taxed_at_use,
                      hint: unit
                        ? "Not for credit in your own units."
                        : "The purchase has no tax. We charge tax on the usage, and the credit pays it.",
                      disabled: !!unit,
                    },
                  ]}
                />
              </Field>
            </Wide>
          )}
          {recurring ? (
            <Wide>
              <RenewsField
                name="gc_reset"
                target="credits"
                value={v.reset ?? draftOf(null)}
                onChange={(r) => set("reset", r)}
                help="Each renewal gives a new grant. The grant pays only the usage in its window, also when the bill is yearly. Credits cannot renew every hour."
              />
            </Wide>
          ) : null}
          {/* Only a calendar window can start before the subscription, so only then is the
              first window short. */}
          {recurring &&
          v.reset?.anchor === "calendar" &&
          v.reset.every !== "term" &&
          v.reset.every !== "never" ? (
            <Wide>
              <Field
                name="gc_first_window"
                label="Short first window"
                help="When the subscription starts after the calendar window starts, this is what the customer gets for that first window."
              >
                <SelectField
                  value={v.first_window ?? "business"}
                  onValueChange={(f) =>
                    set(
                      "first_window",
                      f === "business"
                        ? null
                        : (f as NonNullable<GrantsCreditDraft["first_window"]>),
                    )
                  }
                  ariaLabel="Short first window"
                  options={[
                    {
                      value: "business",
                      label: `Same as the business setting: ${FIRST_WINDOW_LABELS[context.firstWindowDefault].toLowerCase()}`,
                    },
                    { value: "full", label: FIRST_WINDOW_LABELS.full },
                    { value: "prorated", label: FIRST_WINDOW_LABELS.prorated },
                    { value: "next_full_window", label: FIRST_WINDOW_LABELS.next_full_window },
                  ]}
                />
              </Field>
            </Wide>
          ) : null}
          {recurring && v.reset?.every !== "never" ? (
            <Wide>
              <Field name="gc_roll_mode" label={periodEnd}>
                <RadioField
                  value={v.roll_mode}
                  onValueChange={(m) => set("roll_mode", m as GrantsCreditDraft["roll_mode"])}
                  ariaLabel={periodEnd}
                  options={[
                    {
                      value: "none",
                      label: "Unused credit expires",
                      hint: ownClock
                        ? "Each renewal starts with the new credit only."
                        : "Each period starts with the new credit only.",
                    },
                    {
                      value: "carry",
                      label: "Carry unused credit to the next period",
                      hint: "A part of the unused credit moves to a new grant. It does not move a second time.",
                    },
                  ]}
                />
              </Field>
            </Wide>
          ) : null}
          {recurring && v.roll_mode === "carry" ? (
            <>
              <Field name="gc_roll_percent" label="Part to carry" help="1 to 100.">
                <div className="flex items-center gap-2">
                  <Input
                    id="gc_roll_percent"
                    type="number"
                    min={1}
                    max={100}
                    value={v.roll_percent}
                    onChange={(e) => set("roll_percent", e.target.value)}
                    className="w-28 tabular-nums"
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </Field>
              <Field
                name="gc_roll_cap"
                label="Maximum to carry"
                help={`In ${unitWord}. Leave empty for no maximum.`}
              >
                <Input
                  id="gc_roll_cap"
                  inputMode="decimal"
                  value={v.roll_cap}
                  onChange={(e) => set("roll_cap", e.target.value)}
                  className="tabular-nums"
                />
              </Field>
              <Field name="gc_roll_cycles" label="Carried credit lasts">
                <div className="flex gap-2">
                  <SelectField
                    value={v.roll_keep}
                    onValueChange={(k) => set("roll_keep", k as GrantsCreditDraft["roll_keep"])}
                    ariaLabel="Carried credit lasts"
                    options={[
                      {
                        value: "cycles",
                        label: ownClock ? "A number of renewals" : "A number of periods",
                      },
                      { value: "forever", label: "Until it is used" },
                    ]}
                  />
                  {v.roll_keep === "cycles" ? (
                    <Input
                      id="gc_roll_cycles"
                      aria-label="Number of billing periods"
                      type="number"
                      min={1}
                      value={v.roll_cycles}
                      onChange={(e) => set("roll_cycles", e.target.value)}
                      className="w-24 tabular-nums"
                    />
                  ) : null}
                </div>
              </Field>
            </>
          ) : null}
          {/* The policy does nothing while the business has blocking off. */}
          {context.blockingEnabled ? (
            <Wide>
              <Field name="gc_on_exhausted" label="When this credit is used up">
                <RadioField
                  value={v.on_exhausted}
                  onValueChange={(p) => set("on_exhausted", p)}
                  ariaLabel="When this credit is used up"
                  options={[
                    {
                      value: "",
                      label: "Not set on this price",
                      hint: "The customer override or the business setting decides.",
                    },
                    { value: "block", label: POLICY_LABEL.block },
                    { value: "bill", label: POLICY_LABEL.bill },
                  ]}
                />
              </Field>
            </Wide>
          ) : null}
        </>
      ) : null}
    </FormCard>
  );
}
