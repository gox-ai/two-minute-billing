"use client";

import { useDefaultState } from "@/lib/use-default-state";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EditDrawer } from "@/components/edit-drawer";
import { ActionForm, useFieldError } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { DateTimeField } from "@/components/form/datetime-field";
import { Button } from "@/components/ui/button";
import { RadioField } from "@/components/ui/radio-group";
import { MoneyField, majorToMinor } from "@/components/catalog/form-kit";
import {
  releaseHoldAction,
  saveCustomerCreditSettingsAction,
  voidGrantAction,
} from "@/app/(dashboard)/businesses/[biz]/customers/[cus]/credits/actions";
import type { ActionResult } from "@/lib/action-result";
import { toMajorInput } from "@/lib/money";
import { money } from "@/lib/format";
import { POLICY_LABEL, type CustomerCreditSettings } from "@/lib/credits";

function useConfirmAction(
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>,
  fields: Record<string, string>,
) {
  const router = useRouter();
  return async () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const res = await action(null, fd);
    if (res.ok) {
      toast.success(res.message ?? "Done.");
      router.refresh();
    } else toast.error(res.message ?? "We could not do the action.");
  };
}

/** Void a promotional grant: the remainder is booked out. Paid grants leave by credit note. */
export function VoidGrantButton({
  biz,
  cus,
  grant,
  remaining,
}: {
  biz: string;
  cus: string;
  grant: string;
  remaining: string;
}) {
  const [open, setOpen] = React.useState(false);
  const confirm = useConfirmAction(voidGrantAction, { biz, cus, grant });
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Void
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Void this credit grant?"
        description={`The customer loses the remaining ${remaining}. You cannot undo this.`}
        confirmLabel="Void grant"
        destructive
        onConfirm={confirm}
      />
    </>
  );
}

/** Release an open hold: it stops counting against the balance at once. */
export function ReleaseHoldButton({
  biz,
  hold,
  amount,
}: {
  biz: string;
  hold: string;
  amount: string;
}) {
  const [open, setOpen] = React.useState(false);
  const confirm = useConfirmAction(releaseHoldAction, { biz, hold });
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Release
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Release this hold?"
        description={`${amount} becomes available again. The app cannot capture the hold after this. You cannot undo this.`}
        confirmLabel="Release hold"
        destructive
        onConfirm={confirm}
      />
    </>
  );
}

/**
 * The customer override: a policy with an optional end date, and overdraft limits per
 * currency. The policy is offered only while the business blocks (it does nothing otherwise).
 */
export function CustomerCreditSettingsButton({
  biz,
  cus,
  settings,
  currencies,
  blockingEnabled,
  businessOverdraft,
}: {
  biz: string;
  cus: string;
  settings: CustomerCreditSettings | null;
  currencies: string[];
  blockingEnabled: boolean;
  /** The business default per currency, shown as the value that applies when empty. */
  businessOverdraft: Record<string, number>;
}) {
  const [open, setOpen] = React.useState(false);
  const [policy, setPolicy] = useDefaultState<string>(settings?.on_exhausted ?? "");
  const seedOverdraft = () =>
    Object.fromEntries(
      currencies.map((c) => [
        c,
        settings?.overdraft_limit_minor?.[c] != null
          ? toMajorInput(settings.overdraft_limit_minor[c], c)
          : "",
      ]),
    );
  const [overdraft, setOverdraft] = React.useState<Record<string, string>>(seedOverdraft);
  const posted = Object.fromEntries(
    Object.entries(overdraft).map(([c, v]) => [c, majorToMinor(v, c)]),
  );
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          setPolicy(settings?.on_exhausted ?? "");
          setOverdraft(seedOverdraft());
          setOpen(true);
        }}
      >
        Edit
      </Button>
      <EditDrawer
        open={open}
        onOpenChange={setOpen}
        title="Credit settings for this customer"
        description="These settings apply to this customer instead of the business settings."
      >
        <ActionForm
          action={saveCustomerCreditSettingsAction}
          onSuccess={() => setOpen(false)}
          className="flex flex-col gap-4 py-2"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="cus" value={cus} />
          <input type="hidden" name="overdraft" value={JSON.stringify(posted)} />
          {blockingEnabled ? (
            <>
              <Field name="on_exhausted" label="When credit is used up">
                <RadioField
                  name="on_exhausted"
                  value={policy}
                  onValueChange={setPolicy}
                  ariaLabel="When credit is used up"
                  options={[
                    {
                      value: "",
                      label: "No override",
                      hint: "The credit grant, the plan or the business setting decides.",
                    },
                    {
                      value: "block",
                      label: POLICY_LABEL.block,
                      hint: "The access check refuses when no credit is available.",
                    },
                    {
                      value: "bill",
                      label: POLICY_LABEL.bill,
                      hint: "The customer can continue. We bill the usage on the invoice.",
                    },
                  ]}
                />
              </Field>
              {policy ? (
                <Field
                  name="override_expires_at"
                  label="Override ends on"
                  help="Leave empty to keep the override until you change it."
                >
                  <DateTimeField
                    name="override_expires_at"
                    granularity="date"
                    minToday
                    defaultValue={settings?.override_expires_at ?? null}
                  />
                </Field>
              ) : null}
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Overdraft limit</span>
                <span className="text-xs text-muted-foreground">
                  How far below zero the balance can go before we block. Leave empty to use the
                  business limit.
                </span>
                {currencies.map((c) => (
                  <OverdraftRow
                    key={c}
                    currency={c}
                    value={overdraft[c] ?? ""}
                    onChange={(v) => setOverdraft((o) => ({ ...o, [c]: v }))}
                    businessDefault={businessOverdraft[c] ?? 0}
                  />
                ))}
              </div>
            </>
          ) : (
            <p className="m-0 text-sm text-muted-foreground">
              Blocking is off for this business, so we never refuse usage for lack of credit. To set
              a policy or an overdraft limit for this customer, turn on blocking in Settings →
              Credits.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {blockingEnabled ? <SubmitButton>Save</SubmitButton> : null}
          </div>
        </ActionForm>
      </EditDrawer>
    </>
  );
}

function OverdraftRow({
  currency,
  value,
  onChange,
  businessDefault,
}: {
  currency: string;
  value: string;
  onChange: (v: string) => void;
  businessDefault: number;
}) {
  const error = useFieldError(`overdraft_${currency}`);
  return (
    <div className="flex flex-col gap-1">
      <MoneyField
        id={`overdraft_${currency}`}
        currency={currency}
        value={value}
        onChange={onChange}
        placeholder={toMajorInput(businessDefault, currency)}
        aria-invalid={!!error}
      />
      <span className="text-xs text-muted-foreground">
        Business limit: {money(businessDefault, currency)}
      </span>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
