"use client";

import * as React from "react";
import { setSubscriptionBillingCyclesAction } from "@/app/actions";
import { ActionForm, useFieldError } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";

/**
 * `useFieldError` reads the enclosing ActionForm's result, so it has to be called from a
 * CHILD of the form — not from the component that returns it.
 */
function CountError() {
  const error = useFieldError("count");
  if (!error) return null;
  return <p className="w-full text-xs font-medium text-destructive">{error}</p>;
}

/**
 * Read and edit `remaining_billing_cycles` (SUB-4) in place.
 *
 * ── WHAT THE NUMBER MEANS ───────────────────────────────────────────────────────
 * Cycles remaining AFTER the current one — NOT a total. It is the same counter the
 * clock decrements at each renewal (`subscriptions/renewal.ts`), and at 0 it is what
 * derives the `non_renewing` status and cancels the subscription at term end. `null`
 * renews forever. During a TRIAL the current period is unbilled, so the value counts
 * PAID cycles still to come and 0 makes the trial the last term. The copy below states
 * the resolved outcome for exactly this reason: "2" alone is ambiguous about whether
 * the current term is included, and getting it wrong ends a paying subscription early.
 *
 * ── WHY TWO CONTROLS ────────────────────────────────────────────────────────────
 * A lone number box cannot say "forever": blank would have to mean either unlimited or
 * no-change. The mode select makes the clearing case explicit.
 *
 * This row was read-only until 2026-08-22 — correctly so, per Rule 0, because the PATCH
 * route accepted only auto_collection / po_number / invoice_notes / custom_fields and
 * there was no field to post to. The route takes `remaining_billing_cycles` now.
 */
export function BillingCyclesInline({
  biz,
  sub,
  value,
  periodEndLabel,
  canEdit,
}: {
  biz: string;
  sub: string;
  /** Cycles after the current one; null = renews forever. */
  value: number | null | undefined;
  /** Formatted current term end, for the "Last cycle ends …" reading. */
  periodEndLabel: string;
  canEdit: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const [mode, setMode] = React.useState(value == null ? "forever" : "count");

  if (!editing) {
    return (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-medium text-foreground">
        <span>
          {value == null ? (
            "Renews forever"
          ) : value === 0 ? (
            <>
              Last cycle
              <span className="ml-1.5 font-normal text-muted-foreground">
                ends {periodEndLabel}
              </span>
            </>
          ) : (
            <>
              {value} more renewal{value === 1 ? "" : "s"}
              <span className="ml-1.5 font-normal text-muted-foreground">
                after the current term
              </span>
            </>
          )}
        </span>
        {canEdit ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => {
              setMode(value == null ? "forever" : "count");
              setEditing(true);
            }}
          >
            Change
          </Button>
        ) : null}
      </span>
    );
  }

  return (
    <ActionForm
      action={setSubscriptionBillingCyclesAction}
      className="flex flex-wrap items-center gap-2"
      onSuccess={() => setEditing(false)}
    >
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="sub" value={sub} />
      <SelectField
        name="mode"
        value={mode}
        onValueChange={setMode}
        ariaLabel="Billing cycles"
        className="h-7 w-auto min-w-44 text-xs"
        options={[
          { value: "forever", label: "Renews forever" },
          { value: "count", label: "A set number of renewals" },
        ]}
      />
      {mode === "count" ? (
        <span className="flex items-center gap-1.5">
          <Input
            name="count"
            type="number"
            min={0}
            step={1}
            defaultValue={value ?? 1}
            className="h-7 w-20 text-xs tabular-nums"
            aria-label="Renewals remaining after the current term"
          />
          <span className="text-xs text-muted-foreground">after the current term</span>
        </span>
      ) : null}
      <SubmitButton size="sm" className="h-7 px-2 text-xs">
        Save
      </SubmitButton>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() => setEditing(false)}
      >
        Cancel
      </Button>
      <CountError />
    </ActionForm>
  );
}
