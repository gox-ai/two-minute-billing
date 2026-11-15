"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SelectField } from "@/components/ui/select-field";
import { RadioField } from "@/components/ui/radio-group";
import { CurrencySelect } from "@/components/form/currency-select";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, X } from "lucide-react";
import {
  stepsFromUnits,
  unitsFromSteps,
  type CreditUnitPolicies,
  type PlanOverdraftRow,
  zeroOrMoreMessage,
} from "@/lib/credit-settings";
import type { Crumb } from "@/components/page-header";
import {
  FormCard,
  FormFrame,
  LockedField,
  SummaryCard,
  TextField,
  Wide,
  slugError,
  suggestSlug,
  useFormModel,
} from "@/components/catalog/form-kit";
import {
  archiveCreditUnitAction,
  createCreditUnitAction,
  updateCreditUnitAction,
} from "@/app/(dashboard)/businesses/[biz]/settings/credit-units/actions";
import {
  majorRateToMinorDecimal,
  minorDecimalToMajor,
  rateSentence,
  type CreditUnit,
} from "@/lib/credits";

interface Values {
  name: string;
  plural_name: string;
  key: string;
  autoKey: boolean;
  currency: string;
  rate: string;
  decimals: string;
  /** "1" = a unit with no money value. */
  noValue: string;
  /** Money for one credit past the balance, in major units; "" = none. */
  overage: string;
  /** The unit's overdraft limit in whole units. */
  overdraft: string;
  negativeAtReset: string;
  plans: PlanOverdraftRow[];
}

type UnitWithPolicies = CreditUnit & Partial<CreditUnitPolicies>;

const seedOf = (
  u: UnitWithPolicies | null | undefined,
  currency: string,
  plans: ReadonlyArray<{ product: string; overdraft_limit: number }>,
): Values => ({
  name: u?.name ?? "",
  plural_name: u?.plural_name ?? "",
  key: u?.id ?? "",
  autoKey: !u,
  currency: u?.currency ?? currency,
  rate: u?.minor_per_unit != null ? minorDecimalToMajor(u.minor_per_unit, u.currency) : "",
  decimals: String(u?.decimals ?? 0),
  noValue: u && u.minor_per_unit == null ? "1" : "",
  overage: u?.overage_minor_per_unit
    ? minorDecimalToMajor(u.overage_minor_per_unit, u.currency)
    : "",
  overdraft: unitsFromSteps(u?.overdraft_limit ?? 0, u?.decimals ?? 0),
  negativeAtReset: u?.negative_balance_at_reset ?? "carry",
  plans: plans.map((p) => ({
    product: p.product,
    limit: unitsFromSteps(p.overdraft_limit, u?.decimals ?? 0),
  })),
});

/** Credit unit create and edit. Once a grant uses the unit, only the names can change. */
export function CreditUnitForm({
  biz,
  unit,
  crumbs,
  returnTo,
  currencies,
  defaultCurrency,
  archive,
  planOptions = [],
  planOverdrafts = [],
}: {
  biz: string;
  unit?: UnitWithPolicies | null;
  /** Plans a plan overdraft limit can name. */
  planOptions?: Array<{ value: string; label: string }>;
  /** The stored plan overrides of the unit's overdraft limit. */
  planOverdrafts?: Array<{ product: string; overdraft_limit: number }>;
  /** Edit only: the archive control, in the Unit card header. */
  archive?: React.ReactNode;
  crumbs: Crumb[];
  returnTo: string;
  currencies: string[] | null;
  defaultCurrency: string;
}) {
  const router = useRouter();
  const formRef = React.useRef<HTMLFormElement>(null);
  const editing = !!unit;
  const locked = !!unit?.locked;
  const [v, set] = useFormModel(seedOf(unit, defaultCurrency, planOverdrafts), formRef);
  // Until the first grant the operator selects the kind. "1" posts `minor_per_unit: null`.
  const noValue = v.noValue === "1";
  const keyError = editing ? undefined : slugError(v.key, "credit");
  const decimals = Number(v.decimals);
  const overdraftError =
    v.overdraft.trim() !== "" && stepsFromUnits(v.overdraft, decimals) === null
      ? zeroOrMoreMessage(decimals)
      : undefined;
  const planRowBad = (limit: string) =>
    limit.trim() !== "" && stepsFromUnits(limit, decimals) === null;
  const usedPlans = new Set(v.plans.map((p) => p.product));
  const setPlan = (i: number, patch: Partial<PlanOverdraftRow>) =>
    set(
      "plans",
      v.plans.map((p, j) => (j === i ? { ...p, ...patch } : p)),
    );
  const minor = majorRateToMinorDecimal(v.rate, v.currency);
  const lead =
    v.name && minor && !noValue
      ? `${rateSentence({ name: v.name, currency: v.currency, minor_per_unit: minor })}.`
      : noValue
        ? "This unit has no money value."
        : "Enter the name and the value of one unit.";

  return (
    <ActionForm
      action={editing ? updateCreditUnitAction : createCreditUnitAction}
      onSuccess={(r) => router.push(r.redirectTo ?? returnTo)}
      formRef={formRef}
    >
      <input type="hidden" name="biz" value={biz} />
      {editing ? (
        <>
          <input type="hidden" name="unit" value={unit!.id} />
          {unit!.resource_version != null ? (
            <input type="hidden" name="expected_version" value={unit!.resource_version} />
          ) : null}
          {locked ? <input type="hidden" name="locked" value="1" /> : null}
        </>
      ) : null}
      {locked ? null : (
        <>
          <input type="hidden" name="decimals" value={v.decimals} />
        </>
      )}
      {noValue ? (
        <>
          <input type="hidden" name="unit_decimals" value={v.decimals} />
          <input type="hidden" name="unit_currency" value={v.currency} />
          <input type="hidden" name="plan_overdrafts" value={JSON.stringify(v.plans)} />
          <input
            type="hidden"
            name="plan_overdrafts_loaded"
            value={JSON.stringify(planOverdrafts.map((o) => o.product))}
          />
        </>
      ) : null}

      <FormFrame
        crumbs={crumbs}
        title={editing ? "Edit credit unit" : "New credit unit"}
        description={
          editing
            ? locked
              ? noValue
                ? "A credit grant uses this unit. You can change its names and what happens when credits run out. To use a different value, create a new unit."
                : "A credit grant uses this unit. You can change its names only. To use a different value, create a new unit."
              : "No credit grant uses this unit yet, so you can change all of it."
            : "Your own unit of credit. A credit grant or a credit pack can give credit in this unit."
        }
        cancelHref={returnTo}
        submitLabel={editing ? "Save changes" : "Create credit unit"}
        summary={
          <SummaryCard
            lead={lead}
            rows={[
              { label: "Currency", value: v.currency },
              {
                label: "Smallest amount",
                value:
                  v.decimals === "0"
                    ? `1 ${v.name || "unit"}`
                    : `${(1 / 10 ** Number(v.decimals)).toFixed(Number(v.decimals))} ${v.plural_name || "units"}`,
              },
            ]}
            note="The first credit grant in this unit fixes the currency, the money value (or no money value) and the decimal places."
          />
        }
      >
        <FormCard title="Unit" actions={archive}>
          <TextField
            name="name"
            label="Name"
            required
            value={v.name}
            maxLength={100}
            onChange={(x) => {
              set("name", x);
              if (!editing && v.autoKey) set("key", suggestSlug(x));
            }}
          />
          <TextField
            name="plural_name"
            label="Plural name"
            required
            value={v.plural_name}
            maxLength={100}
            onChange={(x) => set("plural_name", x)}
          />
          {editing ? (
            <LockedField label="Unit ID" value={unit!.id} mono />
          ) : (
            <TextField
              name="key"
              label="Unit ID"
              value={v.key}
              mono
              maxLength={100}
              error={keyError}
              help="We make one from the name. You cannot change it after you create the unit."
              onChange={(x) => {
                set("key", x);
                set("autoKey", false);
              }}
            />
          )}
        </FormCard>

        {locked ? (
          <FormCard title="Value · Locked" columns={3}>
            <LockedField label="Currency" value={unit!.currency} />
            <LockedField
              label="Value of one unit"
              value={
                unit!.minor_per_unit != null
                  ? minorDecimalToMajor(unit!.minor_per_unit, unit!.currency)
                  : "No money value"
              }
            />
            <LockedField label="Decimal places" value={String(unit!.decimals)} />
            <Wide>
              <p className="text-xs text-muted-foreground">
                A credit grant uses this unit, so we cannot change these values. Create a new unit
                to use different values.
              </p>
            </Wide>
          </FormCard>
        ) : (
          <FormCard title="Value">
            <Wide>
              <Field
                name="no_rate"
                label="Money value"
                required
                help="You can change this until the first credit grant in this unit."
              >
                <RadioField
                  name="no_rate"
                  value={v.noValue}
                  onValueChange={(x) => set("noValue", x)}
                  ariaLabel="Money value"
                  options={[
                    {
                      value: "",
                      label: "Has a money value",
                      hint: "One unit is worth a fixed amount of money.",
                    },
                    {
                      value: "1",
                      label: "No money value",
                      hint: "We count this credit in units, not in money.",
                    },
                  ]}
                />
              </Field>
            </Wide>
            <Field name="currency" label="Currency" required>
              <CurrencySelect
                name="currency"
                value={v.currency}
                onValueChange={(c) => set("currency", c)}
                options={currencies}
                className="w-full"
              />
            </Field>
            {noValue ? null : (
              <TextField
                name="rate"
                label={`Value of one unit, in ${v.currency}`}
                required
                value={v.rate}
                inputClassName="tabular-nums"
                placeholder="0.01"
                help="For example, 0.01 makes 100 units worth 1.00."
                onChange={(x) => set("rate", x)}
              />
            )}
            <Field
              name="decimals"
              label="Decimal places"
              help="How finely you can give this unit. 0 gives whole units only."
            >
              <SelectField
                id="decimals"
                value={v.decimals}
                onValueChange={(d) => set("decimals", d)}
                ariaLabel="Decimal places"
                options={["0", "1", "2", "3", "4"].map((d) => ({ value: d, label: d }))}
              />
            </Field>
          </FormCard>
        )}

        {noValue ? (
          <FormCard title="When credits run out">
            <TextField
              name="overage"
              label={`Overage price of one ${v.name || "credit"}, in ${v.currency}`}
              value={v.overage}
              inputClassName="tabular-nums"
              placeholder="0.05"
              help={`Optional. We bill this price for each ${v.name || "unit"} that the balance does not pay, unless the policy is Block usage. A meter that has its own usage price uses that price. With no price, we refuse usage past the overdraft limit. A customer with no subscription gets this usage on a one-time invoice.`}
              onChange={(x) => set("overage", x)}
            />
            <TextField
              name="overdraft"
              label={`Overdraft limit, in ${v.plural_name || "units"}`}
              value={v.overdraft}
              inputClassName="tabular-nums"
              error={overdraftError}
              help="When we do not bill usage at an overage price, it can take the balance below 0, to this limit. The next grant pays the negative amount first, unless the unit forgives it when plan credits renew. A plan or a customer can have a different limit. A customer with no subscription: with an overage price, usage can go below 0 to this limit, and we bill it on a one-time invoice. With no price, we refuse usage at 0."
              onChange={(x) => set("overdraft", x)}
            />
            <Wide>
              <Field
                name="negative_balance_at_reset"
                label="Negative balance when plan credits renew"
                help="Applies when a plan grant starts and the balance is below 0."
              >
                <RadioField
                  name="negative_balance_at_reset"
                  value={v.negativeAtReset}
                  onValueChange={(x) => set("negativeAtReset", x)}
                  ariaLabel="Negative balance when plan credits renew"
                  options={[
                    {
                      value: "carry",
                      label: "Carry it",
                      hint: "The new credits pay the negative balance first.",
                    },
                    {
                      value: "forgive",
                      label: "Forgive it",
                      hint: "The balance starts again at 0. We do not bill the difference.",
                    },
                  ]}
                />
              </Field>
            </Wide>
            <Wide>
              <div id="plan_overdrafts" className="flex flex-col gap-2">
                <span className="text-sm font-medium">Overdraft limit by plan</span>
                {v.plans.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <div className="grid grid-cols-[minmax(0,1fr)_7.5rem_2rem] gap-2 text-xs text-muted-foreground">
                      <span>Plan</span>
                      <span>Limit</span>
                      <span aria-hidden />
                    </div>
                    {v.plans.map((row, i) => (
                      <div
                        key={i}
                        className="grid grid-cols-[minmax(0,1fr)_7.5rem_2rem] items-center gap-2"
                      >
                        <div className="min-w-0">
                          <SelectField
                            id={`plan_overdraft_${i}`}
                            value={row.product}
                            onValueChange={(x) => setPlan(i, { product: x })}
                            ariaLabel={`Plan ${i + 1}`}
                            options={planOptions.filter(
                              (o) => o.value === row.product || !usedPlans.has(o.value),
                            )}
                          />
                        </div>
                        <Input
                          className="tabular-nums"
                          aria-label={`Plan ${i + 1} overdraft limit`}
                          aria-invalid={planRowBad(row.limit) || undefined}
                          aria-describedby={
                            planRowBad(row.limit) ? "plan_overdrafts_error" : undefined
                          }
                          value={row.limit}
                          onChange={(e) => setPlan(i, { limit: e.target.value })}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove plan ${i + 1}`}
                          onClick={() =>
                            set(
                              "plans",
                              v.plans.filter((_, j) => j !== i),
                            )
                          }
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Every plan uses the limit above.</p>
                )}
                {v.plans.some((p) => planRowBad(p.limit)) ? (
                  <p id="plan_overdrafts_error" className="text-xs text-destructive">
                    {zeroOrMoreMessage(decimals, "a plan limit")}
                  </p>
                ) : null}
                {planOptions.some((o) => !usedPlans.has(o.value)) ? (
                  <div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        set("plans", [
                          ...v.plans,
                          {
                            product: planOptions.find((o) => !usedPlans.has(o.value))!.value,
                            limit: v.overdraft || "0",
                          },
                        ])
                      }
                    >
                      <Plus className="size-4" />
                      Add plan limit
                    </Button>
                  </div>
                ) : null}
              </div>
            </Wide>
          </FormCard>
        ) : null}
      </FormFrame>
    </ActionForm>
  );
}

/** Archive: the unit takes no new grant. Grants that use it stay as they are. */
export function ArchiveCreditUnitButton({ biz, unit }: { biz: string; unit: CreditUnit }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  if (unit.status !== "active") return null;
  async function confirm() {
    const fd = new FormData();
    fd.set("biz", biz);
    fd.set("unit", unit.id);
    const res = await archiveCreditUnitAction(null, fd);
    if (res.ok) {
      toast.success(res.message ?? "Credit unit archived.");
      router.refresh();
    } else toast.error(res.message ?? "We could not archive the credit unit.");
  }
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Archive
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Archive ${unit.plural_name}?`}
        description="You cannot give new credit in an archived unit. Credit that customers have now stays and they can use it."
        confirmLabel="Archive unit"
        destructive
        onConfirm={confirm}
      />
    </>
  );
}
