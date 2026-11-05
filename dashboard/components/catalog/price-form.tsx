"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { createPriceV2Action, editPriceAction } from "@/app/actions";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SelectField } from "@/components/ui/select-field";
import { CheckboxField } from "@/components/ui/checkbox";
import { CurrencySelect } from "@/components/form/currency-select";
import type { Crumb } from "@/components/page-header";
import type { Price, Product } from "@/lib/api";
import { toMajorInput } from "@/lib/money";
import {
  ChoiceCards,
  FormCard,
  FormFrame,
  FrequencyField,
  LockedField,
  MetadataEditor,
  MoneyField,
  SummaryCard,
  SwitchRow,
  TextField,
  Wide,
  adjective,
  defaultFrequency,
  everyLabel,
  everyPhrase,
  majorToMinor,
  metaRows,
  slugError,
  useFormModel,
  type Interval,
  type MetaRow,
} from "@/components/catalog/form-kit";
import {
  MODEL_LABEL,
  PricingFields,
  priceSentence,
  pricingSeed,
  type PricingValues,
} from "@/components/catalog/pricing-fields";
import {
  meterPriceSentence,
  meterPricingSeed,
  type MeterOption,
  type MeterPricing,
} from "@/components/catalog/meter-rate-card";
import {
  GrantsCreditCard,
  type GrantsCreditContext,
} from "@/components/catalog/grants-credit-card";
import type { PriceGrantsCredit } from "@/lib/credits";

interface Values {
  currency: string;
  type: "recurring" | "one_time";
  interval: string;
  count: string;
  id: string;
  pricing: PricingValues;
  metering: MeterPricing;
  cycles: "forever" | "fixed";
  billing_cycles: string;
  portal_min: string;
  portal_max: string;
  trial_period: string;
  trial_unit: string;
  trial_end_action: string;
  name: string;
  external_name: string;
  description: string;
  is_taxable: boolean;
  tax_behavior: string;
  tax_code: string;
  sku: string;
  accounting_code: string;
  accounting_category_code: string;
  meta: MetaRow[];
  bill_usage_monthly: boolean;
  /** Minimum commitment per billing period, major units; blank = none. */
  commitment: string;
}

/** Monthly usage billing needs a term of 2+ months, in months or years. */
const monthlyUsageAllowed = (interval: string, count: number) =>
  (interval === "month" && count >= 2) || interval === "year";

/**
 * Price create and edit. Edit locks currency, frequency, type and pricing
 * model (the engine cannot change them) and sends `expected_version`.
 */
export function PriceForm({
  biz,
  product,
  price,
  crumbs,
  returnTo,
  currencies,
  billingFrequencies,
  defaultCurrency,
  defaultInterval,
  defaultType,
  defaultTaxBehavior = "exclusive",
  taxBehaviorByCurrency,
  meters,
  credits,
}: {
  biz: string;
  product: Product;
  /** present → edit mode */
  price?: Price;
  crumbs: Crumb[];
  returnTo: string;
  currencies?: string[] | null;
  billingFrequencies?: Array<{ interval: Interval; count: number }> | null;
  defaultCurrency?: string;
  defaultInterval?: string;
  defaultType?: "recurring" | "one_time";
  defaultTaxBehavior?: string;
  /** The business's price type per currency; a currency here overrides `defaultTaxBehavior`. */
  taxBehaviorByCurrency?: Record<string, string> | null;
  /** Active meters a new Usage price can bill from. */
  meters?: MeterOption[];
  /** Credit units and settings for "Grants credit"; absent hides the card. */
  credits?: GrantsCreditContext | null;
}) {
  const router = useRouter();
  const formRef = React.useRef<HTMLFormElement>(null);
  const editing = !!price;
  const freq = defaultFrequency(billingFrequencies, defaultInterval);
  const seedCurrency = (
    price?.currency ??
    defaultCurrency ??
    currencies?.[0] ??
    "USD"
  ).toUpperCase();
  const taxBehaviorFor = (cur: string) => taxBehaviorByCurrency?.[cur] ?? defaultTaxBehavior;
  const seed: Values = {
    currency: seedCurrency,
    type:
      (price?.type as Values["type"]) ??
      defaultType ??
      (product.kind === "charge" ? "one_time" : "recurring"),
    interval: price?.interval ?? freq.interval,
    count: String(price?.interval_count ?? freq.count),
    id: price?.id ?? "",
    pricing: pricingSeed(price, product.kind === "plan" ? "per_unit" : "flat"),
    metering: meterPricingSeed(price),
    cycles: price?.billing_cycles ? "fixed" : "forever",
    billing_cycles: price?.billing_cycles ? String(price.billing_cycles) : "",
    portal_min: price?.portal_min_quantity != null ? String(price.portal_min_quantity) : "",
    portal_max: price?.portal_max_quantity != null ? String(price.portal_max_quantity) : "",
    trial_period: price?.trial_period != null ? String(price.trial_period) : "",
    trial_unit: price?.trial_period_unit ?? "day",
    trial_end_action: price?.trial_end_action ?? "activate_subscription",
    name: price?.name ?? "",
    external_name: price?.external_name ?? "",
    description: price?.description ?? "",
    is_taxable: price ? price.is_taxable !== false : true,
    tax_behavior: price?.tax_behavior ?? taxBehaviorFor(seedCurrency),
    tax_code: price?.tax_code ?? "",
    sku: price?.sku ?? "",
    accounting_code: price?.accounting_code ?? "",
    accounting_category_code: price?.accounting_category_code ?? "",
    meta: metaRows(price?.metadata),
    bill_usage_monthly: price?.bill_usage_monthly ?? false,
    commitment:
      price?.commitment_amount_minor != null
        ? toMajorInput(price.commitment_amount_minor, price.currency)
        : "",
  };
  const [v, set] = useFormModel(seed, formRef);
  const recurring = v.type === "recurring";
  const count = Number(v.count) || 1;
  const unit = product.unit_of_measure?.trim() || undefined;
  const meterOn = v.pricing.model === "usage" && recurring && !!v.metering.meter;
  const meterName = meters?.find((m) => m.id === v.metering.meter)?.name;
  const cost = meterOn
    ? meterPriceSentence(v.metering, v.currency, meterName)
    : priceSentence(
        v.pricing,
        v.currency,
        unit,
        recurring ? everyPhrase(v.interval, count) : "once",
      );
  const tiers = v.pricing.tiers.filter((t) => t.upTo || t.unit || t.flat || t.rate).length;
  const trialN = Number(v.trial_period);
  const freqText = recurring ? everyLabel(v.interval, count) : "One-time";
  const idError = editing ? undefined : slugError(v.id, `${product.id}-${v.currency}-monthly`);

  return (
    <ActionForm
      action={editing ? editPriceAction : createPriceV2Action}
      onSuccess={() => router.push(returnTo)}
      formRef={formRef}
    >
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="return_to" value={returnTo} />
      <input type="hidden" name="is_taxable_present" value="1" />
      {editing ? (
        <>
          <input type="hidden" name="price" value={price!.id} />
          <input type="hidden" name="trial_present" value="1" />
          <input type="hidden" name="billing_cycles_present" value="1" />
          {price!.resource_version != null ? (
            <input type="hidden" name="expected_version" value={price!.resource_version} />
          ) : null}
        </>
      ) : (
        <>
          <input type="hidden" name="product" value={product.id} />
          <input type="hidden" name="type" value={v.type} />
        </>
      )}

      <FormFrame
        crumbs={crumbs}
        title={editing ? "Edit price" : "New price"}
        description={
          editing
            ? `${product.name} · ${price!.currency}, ${freqText}. Existing subscriptions on this price keep their original price. Edits apply to new subscriptions.`
            : `${product.name}. One price per currency and frequency.`
        }
        cancelHref={returnTo}
        submitLabel={editing ? "Save changes" : "Create price"}
        summary={
          <SummaryCard
            lead={cost ? `${cost}.` : "Enter the price to see what customers pay."}
            rows={[
              {
                label: "Model",
                value: `${MODEL_LABEL[v.pricing.model] ?? v.pricing.model}${tiers && ["tiered", "volume", "stairstep", "graduated_percentage"].includes(v.pricing.model) ? ` · ${tiers} tier${tiers === 1 ? "" : "s"}` : ""}`,
              },
              {
                label: "Price",
                value: `${v.currency} · ${recurring ? adjective(v.interval, count) : "one-time"}`,
              },
              recurring && {
                label: "Trial",
                value:
                  trialN > 0
                    ? `${trialN} ${v.trial_unit}${trialN === 1 ? "" : "s"}, then ${v.trial_end_action === "cancel_subscription" ? "cancel" : "activate"}`
                    : "None",
              },
              recurring && {
                label: "Renews",
                value:
                  v.cycles === "fixed" && v.billing_cycles
                    ? `${v.billing_cycles} cycles`
                    : "Forever",
              },
              {
                label: "Tax",
                value: `${v.tax_behavior === "inclusive" ? "Inclusive" : "Exclusive"} · ${v.is_taxable ? "taxable" : "not taxable"}`,
              },
              editing && { label: "Applies to", value: "New subscriptions" },
            ]}
            note={
              editing
                ? "If another person saves this price after you open it, Save stops. You can then load their version."
                : undefined
            }
          />
        }
      >
        {editing ? (
          <FormCard title="Locked after create" columns={3}>
            <LockedField label="Currency" value={price!.currency} />
            <LockedField label="Frequency" value={freqText} />
            <LockedField label="Pricing model" value={MODEL_LABEL[price!.model] ?? price!.model} />
            <Wide>
              <LockedField
                label="Price ID"
                value={price!.id}
                mono
                reason="We bill subscriptions on these values. To change one, create a new price and move subscriptions to it."
              />
            </Wide>
          </FormCard>
        ) : (
          <FormCard title="Price">
            <Field name="currency" label="Currency" required>
              <CurrencySelect
                name="currency"
                value={v.currency}
                onValueChange={(c) => {
                  set("currency", c);
                  // A new price follows the selected currency's price type.
                  if (!editing) set("tax_behavior", taxBehaviorFor(c.toUpperCase()));
                }}
                options={currencies}
              />
            </Field>
            <Field name="type" label="Billed">
              <SelectField
                value={v.type}
                onValueChange={(t) => set("type", t as Values["type"])}
                ariaLabel="Billed"
                options={[
                  { value: "recurring", label: "Recurring" },
                  { value: "one_time", label: "Once" },
                ]}
              />
            </Field>
            {recurring ? (
              <Field name="interval" label="Frequency">
                <FrequencyField
                  allowed={billingFrequencies}
                  interval={v.interval}
                  count={v.count}
                  onChange={(i, c) => {
                    set("interval", i);
                    set("count", c);
                  }}
                />
              </Field>
            ) : null}
            <TextField
              name="id"
              label="Price ID"
              value={v.id}
              onChange={(x) => set("id", x)}
              error={idError}
              help="If empty, we make one from the product, currency and frequency."
              maxLength={100}
              mono
            />
          </FormCard>
        )}

        <FormCard title="Pricing">
          <PricingFields
            values={v.pricing}
            onChange={(patch) => set("pricing", { ...v.pricing, ...patch })}
            currency={v.currency}
            lockedModel={editing}
            lockedAggregation={editing}
            unitLabel={unit}
            recurring={recurring}
            meter={
              // A new price may take a meter; an existing one keeps what it was created with.
              (editing ? !!price?.meter : !!meters?.length)
                ? {
                    values: v.metering,
                    onChange: (patch) => set("metering", { ...v.metering, ...patch }),
                    meters: meters ?? [],
                    locked: editing,
                  }
                : undefined
            }
          />
          {recurring ? (
            <Field name="billing_cycles" label="Billing cycles">
              <div className="flex gap-2">
                <SelectField
                  value={v.cycles}
                  onValueChange={(x) => set("cycles", x as Values["cycles"])}
                  ariaLabel="Billing cycles"
                  options={[
                    { value: "forever", label: "Forever" },
                    { value: "fixed", label: "A fixed number" },
                  ]}
                />
                {v.cycles === "fixed" ? (
                  <Input
                    name="billing_cycles"
                    aria-label="Number of billing cycles"
                    type="number"
                    min={1}
                    required
                    value={v.billing_cycles}
                    onChange={(e) => set("billing_cycles", e.target.value)}
                    className="w-24 tabular-nums"
                  />
                ) : editing ? (
                  <input type="hidden" name="billing_cycles" value="" />
                ) : null}
              </div>
            </Field>
          ) : null}
        </FormCard>

        {recurring && product.kind === "plan" ? (
          <FormCard title="Billing period">
            <input type="hidden" name="term_billing_present" value="1" />
            {monthlyUsageAllowed(v.interval, count) ? (
              <Wide>
                <SwitchRow
                  name="bill_usage_monthly"
                  label="Bill usage every month"
                  hint="We invoice metered usage at the end of each month. The plan fee stays on the billing period. Applies to new subscriptions"
                  checked={v.bill_usage_monthly}
                  onCheckedChange={(c) => set("bill_usage_monthly", c)}
                />
              </Wide>
            ) : null}
            <input
              type="hidden"
              name="commitment_amount_minor"
              value={majorToMinor(v.commitment, v.currency)}
            />
            <Field
              name="commitment_amount_minor"
              label="Minimum commitment per billing period"
              help="At the end of the billing period, we bill the difference if the fees are less. Leave empty for no commitment"
            >
              <MoneyField
                currency={v.currency}
                value={v.commitment}
                onChange={(x) => set("commitment", x)}
              />
            </Field>
          </FormCard>
        ) : null}

        {recurring && product.kind === "plan" && v.pricing.model === "per_unit" ? (
          <FormCard title="Seats in the customer portal">
            <input type="hidden" name="portal_seats_present" value="1" />
            <Wide>
              <p className="text-xs text-muted-foreground">
                These limits apply to customers in the portal. Your team can set any quantity. Leave
                empty to use the limits in Settings → Hosted pages.
              </p>
            </Wide>
            <Field name="portal_min_quantity" label="Minimum seats">
              <Input
                name="portal_min_quantity"
                type="number"
                min={1}
                value={v.portal_min}
                onChange={(e) => set("portal_min", e.target.value)}
                className="w-24 tabular-nums"
              />
            </Field>
            <Field name="portal_max_quantity" label="Maximum seats">
              <Input
                name="portal_max_quantity"
                type="number"
                min={1}
                value={v.portal_max}
                onChange={(e) => set("portal_max", e.target.value)}
                className="w-24 tabular-nums"
              />
            </Field>
          </FormCard>
        ) : null}

        {recurring ? (
          <FormCard title="Trial">
            <Field name="trial_period" label="Trial period" help="Leave empty for no trial">
              <div className="flex gap-2">
                <Input
                  name="trial_period"
                  type="number"
                  min={0}
                  value={v.trial_period}
                  onChange={(e) => set("trial_period", e.target.value)}
                  className="w-24 tabular-nums"
                />
                <SelectField
                  name="trial_period_unit"
                  value={v.trial_unit}
                  onValueChange={(x) => set("trial_unit", x)}
                  ariaLabel="Trial period unit"
                  options={["day", "week", "month", "year"].map((u) => ({
                    value: u,
                    label: `${u}s`,
                  }))}
                />
              </div>
            </Field>
            <Field name="trial_end_action" label="When the trial ends">
              <SelectField
                name="trial_end_action"
                value={v.trial_end_action}
                onValueChange={(x) => set("trial_end_action", x)}
                ariaLabel="When the trial ends"
                options={[
                  { value: "activate_subscription", label: "Activate and charge" },
                  { value: "cancel_subscription", label: "Cancel the subscription" },
                ]}
              />
            </Field>
          </FormCard>
        ) : null}

        {/* A plan's one-time price cannot be sold as a pack: the engine refuses it. */}
        {credits && (recurring || product.kind !== "plan") ? (
          <GrantsCreditCard
            key={`${v.type}-${v.currency}`}
            context={credits}
            recurring={recurring}
            currency={v.currency}
            initial={
              (price as { grants_credit?: PriceGrantsCredit | null } | undefined)?.grants_credit
            }
          />
        ) : null}

        <FormCard title="Customer-facing info">
          <TextField
            name="name"
            label="Internal name"
            value={v.name}
            onChange={(x) => set("name", x)}
            maxLength={200}
          />
          <TextField
            name="external_name"
            label="External name"
            value={v.external_name}
            onChange={(x) => set("external_name", x)}
            help="On invoices, Checkout and the portal"
            maxLength={200}
          />
          <Wide>
            <Field name={editing ? "description" : "price_description"} label="Description">
              <Textarea
                name={editing ? "description" : "price_description"}
                value={v.description}
                onChange={(e) => set("description", e.target.value)}
                rows={2}
                maxLength={2000}
              />
            </Field>
          </Wide>
          {/* The price also stores "show description on invoices/quotes" and "invoice notes",
              but no invoice prints them (invoices print the customer's or the business's
              notes), so there is no control for them. The API still accepts all three. */}
        </FormCard>

        <FormCard title="Tax">
          <Wide>
            <CheckboxField
              name="is_taxable"
              label="This charge is subject to taxes"
              checked={v.is_taxable}
              onCheckedChange={(c) => set("is_taxable", c)}
            />
          </Wide>
          <Field name="tax_behavior" label="Tax behavior">
            <ChoiceCards
              name="tax_behavior"
              value={v.tax_behavior}
              onValueChange={(x) => set("tax_behavior", x)}
              ariaLabel="Tax behavior"
              options={[
                { value: "exclusive", label: "Exclusive", hint: "Price excludes tax" },
                { value: "inclusive", label: "Inclusive", hint: "Price includes tax" },
              ]}
            />
          </Field>
          <TextField
            name="tax_code"
            label="HSN/SAC code"
            value={v.tax_code}
            onChange={(x) => set("tax_code", x)}
            help="Overrides the product's code. If empty, we use the product's code, then the business default."
            maxLength={20}
            mono
          />
        </FormCard>

        <FormCard title="Accounting and metadata">
          <TextField
            name="sku"
            label="SKU / Alternative name"
            value={v.sku}
            onChange={(x) => set("sku", x)}
            help="Your own reference. We do not post anything from it."
            maxLength={200}
          />
          <TextField
            name="accounting_code"
            label="Account name"
            value={v.accounting_code}
            onChange={(x) => set("accounting_code", x)}
            help="For your accounting export. It is not a ledger account."
            maxLength={200}
          />
          <TextField
            name="accounting_category_code"
            label="Class"
            value={v.accounting_category_code}
            onChange={(x) => set("accounting_category_code", x)}
            maxLength={200}
          />
          <Wide>
            <MetadataEditor rows={v.meta} onChange={(rows) => set("meta", rows)} />
          </Wide>
        </FormCard>
      </FormFrame>
    </ActionForm>
  );
}
