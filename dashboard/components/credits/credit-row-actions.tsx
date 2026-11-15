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
import { CheckboxField } from "@/components/ui/checkbox";
import { RadioField } from "@/components/ui/radio-group";
import { MoneyField, majorToMinor } from "@/components/catalog/form-kit";
import {
  releaseHoldAction,
  saveCustomerCreditSettingsAction,
} from "@/app/(dashboard)/businesses/[biz]/customers/[cus]/credits/actions";
import { voidGrantWithReasonAction } from "@/app/(dashboard)/businesses/[biz]/customers/[cus]/credits/grant-actions";
import { SelectField } from "@/components/ui/select-field";
import { Textarea } from "@/components/ui/textarea";
import { VOID_REASON_OPTIONS } from "@/lib/credit-settings";
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

/**
 * Void a grant: the remainder is booked out. A paid grant leaves by credit note when the
 * customer gets money back; here it is voided with no refund, and the operator must select
 * that. The operator selects why; the reason is kept on the grant.
 */
export function VoidGrantButton({
  biz,
  cus,
  grant,
  remaining,
  paid = false,
}: {
  biz: string;
  cus: string;
  grant: string;
  remaining: string;
  /** A paid grant: the dialog asks for "Void without a refund". */
  paid?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [noRefund, setNoRefund] = React.useState(false);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={`Void credit grant, ${remaining} remaining`}
        onClick={() => {
          setReason("");
          setNoRefund(false);
          setOpen(true);
        }}
      >
        Void
      </Button>
      <EditDrawer
        open={open}
        onOpenChange={setOpen}
        title="Void this credit grant?"
        description={`The customer loses the remaining ${remaining}. You cannot undo this.`}
      >
        <ActionForm
          action={voidGrantWithReasonAction}
          onSuccess={(r) => {
            toast.success(r.message ?? "Credit grant voided.");
            setOpen(false);
            router.refresh();
          }}
          className="flex flex-col gap-4 py-2"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="cus" value={cus} />
          <input type="hidden" name="grant" value={grant} />
          {paid ? (
            <>
              <input type="hidden" name="paid" value="on" />
              <div className="flex flex-col gap-1">
                <CheckboxField
                  name="without_refund"
                  checked={noRefund}
                  onCheckedChange={setNoRefund}
                  label="Void without a refund"
                  hint="The customer gets no money back for the unused credit. To give money back, create a credit note on the invoice of this credit."
                />
                <NoRefundError />
              </div>
            </>
          ) : null}
          <Field name="reason" label="Reason" required>
            <SelectField
              name="reason"
              value={reason}
              onValueChange={setReason}
              ariaLabel="Reason"
              placeholder="Select a reason"
              options={VOID_REASON_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
          </Field>
          <Field
            name="note"
            label="Note"
            required={reason === "other"}
            help={reason === "other" ? "Say why you void the credit." : "Optional."}
          >
            <Textarea name="note" maxLength={500} rows={3} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton variant="destructive">Void credit grant</SubmitButton>
          </div>
        </ActionForm>
      </EditDrawer>
    </>
  );
}

/** The message under "Void without a refund" when the save refused it. */
function NoRefundError() {
  const error = useFieldError("without_refund");
  return error ? <p className="m-0 text-xs font-medium text-destructive">{error}</p> : null;
}

/** Release an open hold: it stops counting against the balance at once. */
export function ReleaseHoldButton({
  biz,
  hold,
  amount,
}: {
  biz: string;
  hold: string;
  /** What the hold still reserves: what the release returns. */
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
        description={`We return ${amount} to the balance. The app cannot capture the hold after this. You cannot undo this.`}
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
              Blocking is off for this business, so we do not refuse usage for lack of credit that
              has a money value. To set a policy or a money overdraft limit for this customer, turn
              on blocking in Settings → Credits. Credit with no money value has its own overdraft
              limit: set it in Credit in units on this page.
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
