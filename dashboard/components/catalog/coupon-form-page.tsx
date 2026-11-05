"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ActionForm } from "@/components/form/action-form";
import { DateTimeField } from "@/components/form/datetime-field";
import { Field } from "@/components/form/field";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { CheckboxField } from "@/components/ui/checkbox";
import { Alert } from "@/components/ui/alert";
import { CurrencySelect } from "@/components/form/currency-select";
import { Facts } from "@/components/patterns/record-page";
import type { Crumb } from "@/components/page-header";
import { money, fmtDate } from "@/lib/format";
import { LIMITS } from "@/lib/limits";
import { toMajorInput } from "@/lib/money";
import { useBusinessTz } from "@/components/business-tz";
import {
  createCouponExtAction,
  editCouponExtAction,
} from "@/app/(dashboard)/businesses/[biz]/catalog/coupons/actions";
import type { Product, CouponDetail } from "@/lib/api/coupons";
import {
  ChoiceCards,
  FormCard,
  FormFrame,
  LockedField,
  MetadataEditor,
  MoneyField,
  SummaryCard,
  TextField,
  Wide,
  majorToMinor,
  metaRows,
  couponCodeError,
  suggestCouponCode,
  useFormModel,
  type MetaRow,
} from "@/components/catalog/form-kit";

type Kind = "percentage" | "fixed_amount";
type Duration = "once" | "forever" | "repeating";
type ApplyOn = "invoice_amount" | "each_specified_item";
type ConstraintType = "all" | "specific" | "none";
type ItemKind = "plan" | "addon" | "charge";

interface ItemConstraint {
  item_kind: ItemKind;
  constraint_type: ConstraintType;
  product_ids: string[];
}
const ITEM_KINDS: ItemKind[] = ["plan", "addon", "charge"];
const KIND_PLURAL: Record<ItemKind, string> = {
  plan: "Plans",
  addon: "Addons",
  charge: "One-time products",
};

/**
 * A kind the API did NOT return has no constraint row, and the engine treats a
 * missing row as `none` — so absence seeds `none`, never `all`.
 */
function seedConstraints(c?: CouponDetail): ItemConstraint[] {
  return ITEM_KINDS.map((k) => {
    const row = c?.item_constraints?.find((x) => x.item_kind === k);
    return {
      item_kind: k,
      constraint_type: row?.constraint_type ?? (c ? "none" : "all"),
      product_ids: row?.product_ids ?? [],
    };
  });
}

interface Values {
  name: string;
  code: string;
  invoice_name: string;
  kind: Kind;
  percent: string;
  amount: string;
  currency: string;
  apply_on: ApplyOn;
  constraints: ItemConstraint[];
  duration: Duration;
  periods: string;
  valid_from: string;
  redeem_by: string;
  max_redemptions: string;
  max_per_customer: string;
  meta: MetaRow[];
}

/**
 * Coupon create / clone / edit. After the first redemption the discount math,
 * apply-on, items and duration are fixed (the engine refuses them) and show
 * read-only; name, invoice name, validity and limits stay editable.
 */
export function CouponFormPage({
  biz,
  currencies,
  defaultCurrency,
  products = [],
  existing,
  clone,
  backHref,
  crumbs,
}: {
  biz: string;
  currencies?: string[] | null;
  defaultCurrency?: string | null;
  products?: Product[];
  /** edit mode when set */
  existing?: CouponDetail;
  /** clone source — prefills the discount on a fresh create */
  clone?: CouponDetail;
  backHref: string;
  crumbs: Crumb[];
}) {
  const router = useRouter();
  const tz = useBusinessTz();
  const formRef = React.useRef<HTMLFormElement>(null);
  const isEdit = !!existing;
  const seedFrom = existing ?? clone;
  const locked = isEdit && (existing!.times_redeemed ?? 0) > 0;
  const cur = (seedFrom?.currency ?? defaultCurrency ?? currencies?.[0] ?? "USD").toUpperCase();

  const [v, set] = useFormModel<Values>(
    {
      name: seedFrom?.name ?? "",
      code: isEdit ? existing!.code : "",
      invoice_name: seedFrom?.invoice_name ?? "",
      kind: (seedFrom?.kind as Kind) ?? "percentage",
      percent: seedFrom?.percent_off_bps != null ? String(seedFrom.percent_off_bps / 100) : "",
      amount:
        seedFrom?.amount_off_minor != null ? toMajorInput(seedFrom.amount_off_minor, cur) : "",
      currency: cur,
      apply_on:
        seedFrom?.apply_on === "each_specified_item" ? "each_specified_item" : "invoice_amount",
      constraints: seedConstraints(seedFrom),
      duration: (seedFrom?.duration_type as Duration) ?? "once",
      periods: seedFrom?.duration_in_periods != null ? String(seedFrom.duration_in_periods) : "",
      valid_from: existing?.valid_from ?? "",
      redeem_by: existing?.redeem_by ?? "",
      max_redemptions: existing?.max_redemptions != null ? String(existing.max_redemptions) : "",
      max_per_customer:
        existing?.max_redemptions_per_customer != null
          ? String(existing.max_redemptions_per_customer)
          : "",
      meta: metaRows(isEdit ? existing!.metadata : clone?.metadata),
    },
    formRef,
  );
  const onFrom = React.useCallback((iso: string) => set("valid_from", iso), [set]);
  const onTill = React.useCallback((iso: string) => set("redeem_by", iso), [set]);

  const byKind: Record<ItemKind, Product[]> = {
    plan: products.filter((p) => p.kind === "plan" || !p.kind),
    addon: products.filter((p) => p.kind === "addon"),
    charge: products.filter((p) => p.kind === "charge"),
  };
  const updC = (i: number, patch: Partial<ItemConstraint>) =>
    set(
      "constraints",
      v.constraints.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    );
  // 'none' rows are dropped: the engine reads a missing row as none.
  const constraintsJson = JSON.stringify(
    v.constraints
      .filter((c) => c.constraint_type !== "none")
      .map((c) => ({
        item_kind: c.item_kind,
        constraint_type: c.constraint_type,
        ...(c.constraint_type === "specific" ? { product_ids: c.product_ids } : {}),
      })),
  );

  // ── summary ──
  const off =
    v.kind === "percentage"
      ? v.percent
        ? `${v.percent}% off`
        : null
      : v.amount
        ? `${money(Number(majorToMinor(v.amount, v.currency) || 0), v.currency)} off`
        : null;
  const names = (c: ItemConstraint) =>
    c.constraint_type === "all"
      ? `every ${c.item_kind}`
      : c.product_ids.map((id) => products.find((p) => p.id === id)?.name ?? id).join(" or ");
  const scoped = v.constraints.filter(
    (c) =>
      c.constraint_type === "all" || (c.constraint_type === "specific" && c.product_ids.length),
  );
  const where =
    v.apply_on === "invoice_amount"
      ? "the invoice total"
      : scoped.length
        ? `each ${scoped.map(names).join(", ")} line`
        : "no lines until you select items";
  const when =
    v.duration === "once"
      ? "on the first invoice"
      : v.duration === "forever"
        ? "on every invoice"
        : `for ${v.periods || "N"} billing periods`;
  const lead = off ? `${off} ${where}, ${when}.` : "Enter the discount to see what it does.";
  const validText = `${v.valid_from ? fmtDate(v.valid_from, tz) : "Now"}, ${v.redeem_by ? `until ${fmtDate(v.redeem_by, tz)}` : "no end"}`;
  const limit = [
    v.max_redemptions ? `${v.max_redemptions} redemptions` : "Unlimited",
    v.max_per_customer ? `${v.max_per_customer} per customer` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const codeError = isEdit
    ? undefined
    : couponCodeError(v.code, suggestCouponCode(v.name) || "LOYAL20");

  const lockedReason = locked ? (
    <Alert tone="warning" className="text-xs">
      Locked after {existing!.times_redeemed} redemption{existing!.times_redeemed === 1 ? "" : "s"}.
      A change would re-price every subscription that has this coupon. Clone it to create a new
      coupon.
    </Alert>
  ) : null;

  return (
    <ActionForm
      action={isEdit ? editCouponExtAction : createCouponExtAction}
      onSuccess={(r) => router.push(r.redirectTo ?? backHref)}
      formRef={formRef}
    >
      <input type="hidden" name="biz" value={biz} />
      {isEdit ? <input type="hidden" name="cpn" value={existing!.id} /> : null}

      <FormFrame
        crumbs={crumbs}
        title={
          isEdit
            ? `Edit ${existing!.name ?? existing!.code}`
            : clone
              ? `Clone ${clone.name ?? clone.code}`
              : "New coupon"
        }
        description="A discount that customers or operators apply to a subscription."
        cancelHref={backHref}
        submitLabel={isEdit ? "Save changes" : "Create coupon"}
        summary={
          <SummaryCard
            lead={lead}
            rows={[
              { label: "Code", value: <span className="font-mono">{v.code || "—"}</span> },
              {
                label: "Currency",
                value: v.kind === "fixed_amount" ? `${v.currency} only` : "Any",
              },
              { label: "Valid", value: validText },
              { label: "Limit", value: limit },
              isEdit && { label: "Redeemed", value: String(existing!.times_redeemed ?? 0) },
            ]}
            note={
              isEdit
                ? undefined
                : "After the first redemption, you can edit only the name, invoice name, validity and limits."
            }
          />
        }
      >
        <FormCard title="Coupon info">
          <TextField
            name="name"
            label="Name"
            required={!isEdit}
            value={v.name}
            onChange={(x) => set("name", x)}
            maxLength={200}
          />
          {isEdit ? (
            <LockedField
              label="ID"
              value={existing!.code}
              mono
              reason="Customers enter this at checkout. You cannot change it."
            />
          ) : (
            <TextField
              name="code"
              label="ID"
              required
              value={v.code}
              onChange={(x) => set("code", x)}
              error={codeError}
              help="Customers enter this at checkout. Use only letters, digits, underscores or hyphens. You cannot change it later."
              placeholder={suggestCouponCode(v.name).toUpperCase() || "LOYAL20"}
              maxLength={LIMITS.code}
              mono
            />
          )}
          <TextField
            name="invoice_name"
            label="Invoice name (optional)"
            value={v.invoice_name}
            onChange={(x) => set("invoice_name", x)}
            help="The invoice shows this instead of the name"
            maxLength={200}
          />
        </FormCard>

        <FormCard title="Discount">
          {locked ? (
            <Wide>
              <div className="flex flex-col gap-3">
                <Facts
                  rows={[
                    {
                      label: "Discount",
                      value:
                        existing!.kind === "percentage"
                          ? `${(existing!.percent_off_bps ?? 0) / 100}%`
                          : money(existing!.amount_off_minor ?? 0, existing!.currency ?? "USD"),
                    },
                  ]}
                />
                {lockedReason}
              </div>
            </Wide>
          ) : (
            <>
              <Wide>
                <ChoiceCards
                  name="kind"
                  value={v.kind}
                  onValueChange={(x) => set("kind", x as Kind)}
                  ariaLabel="Discount type"
                  options={[
                    { value: "percentage", label: "Percentage", hint: "For example, 20% off" },
                    {
                      value: "fixed_amount",
                      label: "Fixed amount",
                      hint: "For example, 20.00 off",
                    },
                  ]}
                />
              </Wide>
              {v.kind === "percentage" ? (
                <>
                  <input
                    type="hidden"
                    name="percent_off_bps"
                    value={v.percent.trim() ? String(Math.round(Number(v.percent) * 100)) : ""}
                  />
                  <Field name="percent_off_bps" label="Percentage" required>
                    <div className="flex h-9 items-center rounded-md border border-input focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50">
                      <input
                        id="percent_off_bps"
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min={0.01}
                        max={100}
                        required
                        value={v.percent}
                        onChange={(e) => set("percent", e.target.value)}
                        className="w-full min-w-0 flex-1 self-stretch rounded-l-md bg-transparent pl-3 text-sm tabular-nums outline-none"
                      />
                      <span className="px-3 text-sm font-medium text-muted-foreground">%</span>
                    </div>
                  </Field>
                </>
              ) : (
                <>
                  <Field name="amount_off_minor" label="Amount" required>
                    <MoneyField
                      name="amount_off_minor"
                      currency={v.currency}
                      value={v.amount}
                      onChange={(x) => set("amount", x)}
                      required
                    />
                  </Field>
                  <Field
                    name="currency"
                    label="Currency"
                    help="Fixed amounts apply only in this currency"
                  >
                    <CurrencySelect
                      name="currency"
                      value={v.currency}
                      onValueChange={(c) => set("currency", c)}
                      options={currencies}
                    />
                  </Field>
                </>
              )}
            </>
          )}
        </FormCard>

        <FormCard title="Applies to" columns={1}>
          {locked ? null : (
            <ChoiceCards
              name="apply_on"
              value={v.apply_on}
              onValueChange={(x) => set("apply_on", x as ApplyOn)}
              ariaLabel="Apply on"
              options={[
                { value: "invoice_amount", label: "Invoice amount", hint: "Off the invoice total" },
                {
                  value: "each_specified_item",
                  label: "Each specified item",
                  hint: "Off each matching line",
                },
              ]}
            />
          )}
          {locked ? (
            <Facts
              rows={[
                {
                  label: "Apply on",
                  value:
                    v.apply_on === "each_specified_item" ? "Each specified item" : "Invoice amount",
                },
              ]}
            />
          ) : null}
          {/* Item scope stays editable after redemption — only the math is frozen. */}
          {v.apply_on === "each_specified_item" ? (
            <div id="item_constraints" className="flex flex-col gap-3">
              <input type="hidden" name="item_constraints" value={constraintsJson} />
              {v.constraints.map((c, i) => (
                <div
                  key={c.item_kind}
                  className="grid grid-cols-1 gap-2 sm:grid-cols-[8rem_14rem_minmax(0,1fr)] sm:items-start"
                >
                  <span className="pt-2 text-sm font-medium">{KIND_PLURAL[c.item_kind]}</span>
                  <SelectField
                    value={c.constraint_type}
                    onValueChange={(x) =>
                      updC(i, { constraint_type: x as ConstraintType, product_ids: [] })
                    }
                    ariaLabel={`${KIND_PLURAL[c.item_kind]} this coupon applies to`}
                    options={[
                      { value: "none", label: "None" },
                      { value: "all", label: "All" },
                      { value: "specific", label: "Specific" },
                    ]}
                  />
                  {c.constraint_type === "specific" ? (
                    byKind[c.item_kind].length ? (
                      <div className="flex flex-wrap gap-x-4 gap-y-2 pt-2">
                        {byKind[c.item_kind].map((p) => (
                          <CheckboxField
                            key={p.id}
                            checked={c.product_ids.includes(p.id)}
                            onCheckedChange={(on) =>
                              updC(i, {
                                product_ids: on
                                  ? [...c.product_ids, p.id]
                                  : c.product_ids.filter((x) => x !== p.id),
                              })
                            }
                            label={p.name}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="pt-2 text-sm text-muted-foreground">No {c.item_kind}s yet.</p>
                    )
                  ) : (
                    <span className="pt-2 text-sm text-muted-foreground">
                      {c.constraint_type === "all" ? `Every ${c.item_kind}` : "—"}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </FormCard>

        <FormCard title="Duration" columns={1}>
          {locked ? (
            <Facts
              rows={[
                {
                  label: "Duration",
                  value:
                    v.duration === "repeating"
                      ? `${v.periods} periods`
                      : v.duration === "forever"
                        ? "Forever"
                        : "Once",
                },
              ]}
            />
          ) : (
            <>
              <ChoiceCards
                name="duration_type"
                value={v.duration}
                onValueChange={(x) => set("duration", x as Duration)}
                ariaLabel="Duration"
                columns={3}
                options={[
                  { value: "once", label: "Once", hint: "First invoice only" },
                  { value: "forever", label: "Forever", hint: "Every invoice" },
                  { value: "repeating", label: "Repeating", hint: "A set number of periods" },
                ]}
              />
              {v.duration === "repeating" ? (
                <TextField
                  name="duration_in_periods"
                  label="Billing periods"
                  required
                  type="number"
                  value={v.periods}
                  onChange={(x) => set("periods", x)}
                  className="max-w-48"
                />
              ) : null}
            </>
          )}
        </FormCard>

        <FormCard title="Validity">
          <Field name="valid_from" label="Valid from" help="If empty, customers can use it now">
            <DateTimeField
              name="valid_from"
              defaultValue={existing?.valid_from}
              onUtcChange={onFrom}
            />
          </Field>
          <Field name="redeem_by" label="Valid till" help="If empty, there is no end date">
            <DateTimeField
              name="redeem_by"
              defaultValue={existing?.redeem_by}
              onUtcChange={onTill}
            />
          </Field>
          <TextField
            name="max_redemptions"
            label="Maximum redemptions"
            type="number"
            value={v.max_redemptions}
            onChange={(x) => set("max_redemptions", x)}
            placeholder="Unlimited"
          />
          <TextField
            name="max_redemptions_per_customer"
            label="Redemptions per customer"
            type="number"
            value={v.max_per_customer}
            onChange={(x) => set("max_per_customer", x)}
            placeholder="Unlimited"
            help="1 stops a customer from using it two times"
          />
        </FormCard>

        <FormCard title="Metadata" columns={1}>
          <MetadataEditor rows={v.meta} onChange={(rows) => set("meta", rows)} />
        </FormCard>
      </FormFrame>
    </ActionForm>
  );
}
