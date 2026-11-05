"use client";

import * as React from "react";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { setSubscriptionAutoCollectionAction } from "@/app/actions";

/**
 * CP-1: inline auto-collection display + Change control on the subscription
 * detail: value + a "Change" link that flips to a tiny form.
 */
export function AutoCollectionInline({
  biz,
  sub,
  value,
  overridden,
  canEdit,
}: {
  biz: string;
  sub: string;
  /** Effective value ('on'/'off'); null = inherits the customer setting. */
  value: "on" | "off" | null | undefined;
  /** True when the subscription overrides the customer-level setting. */
  overridden: boolean;
  canEdit: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const current = value ?? "on";

  if (!editing) {
    return (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-medium text-foreground">
        {/* Same shape as the rows below it: the value, its source in muted text, Change. */}
        <span>
          <span className="capitalize">{current}</span>
          <span className="ml-1.5 font-normal text-muted-foreground">
            {overridden ? "set on this subscription" : "follows the customer setting"}
          </span>
        </span>
        {canEdit ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => setEditing(true)}
          >
            Change
          </Button>
        ) : null}
      </span>
    );
  }

  return (
    <ActionForm
      action={setSubscriptionAutoCollectionAction}
      className="flex items-center gap-2"
      onSuccess={() => setEditing(false)}
    >
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="sub" value={sub} />
      <SelectField
        name="auto_collection"
        defaultValue={current}
        ariaLabel="Auto collection"
        className="h-7 w-auto min-w-56 text-xs"
        options={[
          { value: "on", label: "On: charge the card automatically" },
          { value: "off", label: "Off: send the invoice" },
        ]}
      />
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
    </ActionForm>
  );
}
