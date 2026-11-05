"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SelectField } from "@/components/ui/select-field";
import { CurrencySelect } from "@/components/form/currency-select";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
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
}

const seedOf = (u: CreditUnit | null | undefined, currency: string): Values => ({
  name: u?.name ?? "",
  plural_name: u?.plural_name ?? "",
  key: u?.id ?? "",
  autoKey: !u,
  currency: u?.currency ?? currency,
  rate: u ? minorDecimalToMajor(u.minor_per_unit, u.currency) : "",
  decimals: String(u?.decimals ?? 0),
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
}: {
  biz: string;
  unit?: CreditUnit | null;
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
  const [v, set] = useFormModel(seedOf(unit, defaultCurrency), formRef);
  const keyError = editing ? undefined : slugError(v.key, "credit");
  const minor = majorRateToMinorDecimal(v.rate, v.currency);
  const lead =
    v.name && minor
      ? `${rateSentence({ name: v.name, currency: v.currency, minor_per_unit: minor })}.`
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

      <FormFrame
        crumbs={crumbs}
        title={editing ? "Edit credit unit" : "New credit unit"}
        description={
          editing
            ? locked
              ? "A credit grant uses this unit. You can change its names only. To use a different value, create a new unit."
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
                    : `${(1 / 10 ** Number(v.decimals)).toFixed(Number(v.decimals))} ${v.name || "unit"}`,
              },
            ]}
            note="The first credit grant in this unit fixes the currency, the value and the decimal places."
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
            placeholder="credit"
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
            placeholder="credits"
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
              value={minorDecimalToMajor(unit!.minor_per_unit, unit!.currency)}
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
            <Field name="currency" label="Currency" required>
              <CurrencySelect
                name="currency"
                value={v.currency}
                onValueChange={(c) => set("currency", c)}
                options={currencies}
              />
            </Field>
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
