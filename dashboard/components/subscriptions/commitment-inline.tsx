"use client";

import * as React from "react";
import { setSubscriptionCommitmentAction } from "@/app/actions";
import { ActionForm, useFieldError } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { majorStep, minorPerMajor, toMajorInput } from "@/lib/money";
import { money } from "@/lib/format";

function AmountError() {
  const error = useFieldError("amount");
  if (!error) return null;
  return <p className="w-full text-xs font-medium text-destructive">{error}</p>;
}

/**
 * The minimum commitment of one subscription: the amount per billing period, what counts
 * toward it this term, and the shortfall the term-end invoice would bill now. A change
 * applies from now; the term-end charge weighs each amount by the time it applied.
 */
export function CommitmentInline({
  biz,
  sub,
  currency,
  amountMinor,
  countedMinor,
  shortfallMinor,
  canEdit,
}: {
  biz: string;
  sub: string;
  currency: string;
  amountMinor: number | null;
  countedMinor: number | null;
  shortfallMinor: number | null;
  canEdit: boolean;
}) {
  const [editing, setEditing] = React.useState(false);

  if (!editing) {
    return (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-medium text-foreground">
        <span>
          {amountMinor == null ? (
            "None"
          ) : (
            <>
              {money(amountMinor, currency)} per billing period
              {countedMinor != null && shortfallMinor != null ? (
                <span className="ml-1.5 font-normal text-muted-foreground">
                  {money(countedMinor, currency)} counted this term ·{" "}
                  {money(shortfallMinor, currency)} short
                </span>
              ) : null}
            </>
          )}
        </span>
        {canEdit ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        ) : null}
      </span>
    );
  }

  return (
    <ActionForm
      action={setSubscriptionCommitmentAction}
      className="flex flex-wrap items-center gap-2"
      onSuccess={() => setEditing(false)}
    >
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="sub" value={sub} />
      <input type="hidden" name="minor_per_major" value={minorPerMajor(currency)} />
      <span className="flex items-center gap-1.5">
        <Input
          name="amount"
          type="number"
          min={0}
          step={majorStep(currency)}
          defaultValue={amountMinor != null ? toMajorInput(amountMinor, currency) : ""}
          className="h-7 w-32 text-right text-xs tabular-nums"
          aria-label="Minimum commitment per billing period"
        />
        <span className="text-xs text-muted-foreground">
          {currency} per billing period. Leave empty for none. Applies from now
        </span>
      </span>
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
      <AmountError />
    </ActionForm>
  );
}
