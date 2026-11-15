"use client";

import * as React from "react";
import { EditDrawer } from "@/components/edit-drawer";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveCustomerOverdraftAction } from "@/app/(dashboard)/businesses/[biz]/customers/[cus]/credits/grant-actions";
import { unitsFromSteps } from "@/lib/credit-settings";
import { useDefaultState } from "@/lib/use-default-state";

/** Set or remove this customer's own overdraft limit in a unit. */
export function CustomerOverdraftButton({
  biz,
  cus,
  unit,
  unitName,
  decimals,
  override,
}: {
  biz: string;
  cus: string;
  unit: string;
  unitName: string;
  decimals: number;
  override: number | null;
}) {
  const [open, setOpen] = React.useState(false);
  // Controlled, so a refused save keeps what was typed.
  const [limit, setLimit] = useDefaultState(
    override == null ? "" : unitsFromSteps(override, decimals),
  );
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={`Edit overdraft limit for ${unitName}`}
        onClick={() => setOpen(true)}
      >
        Edit
      </Button>
      <EditDrawer
        open={open}
        onOpenChange={setOpen}
        title={`Overdraft limit for ${unitName}`}
        description="When we do not bill usage at an overage price, it can take this customer's balance below 0, to this limit. The next grant pays the negative amount first, unless the unit forgives it when plan credits renew. A customer with no subscription: with an overage price, usage can go below 0 to this limit, and we bill it on a one-time invoice. With no price, we refuse usage at 0."
      >
        <ActionForm
          action={saveCustomerOverdraftAction}
          // ActionForm toasts the result and refreshes the page.
          onSuccess={() => setOpen(false)}
          className="flex flex-col gap-4 py-2"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="cus" value={cus} />
          <input type="hidden" name="unit" value={unit} />
          <input type="hidden" name="decimals" value={decimals} />
          <Field
            name="limit"
            label={`Overdraft limit, in ${unitName}`}
            help="Leave it empty to use the limit of the customer's plan or of the credit unit."
          >
            <Input
              name="limit"
              className="w-30 tabular-nums"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Save</SubmitButton>
          </div>
        </ActionForm>
      </EditDrawer>
    </>
  );
}
