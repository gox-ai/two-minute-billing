"use client";

import { useDefaultState } from "@/lib/use-default-state";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { SelectAnswer } from "@/components/patterns/settings-page";
import { setNewMethodGatewayAction } from "./actions";

/** Payment methods card → where this customer's next NEW payment method goes. */
export function NewMethodGatewayForm({
  biz,
  cus,
  value,
  businessLabel,
  options,
  canManage,
}: {
  biz: string;
  cus: string;
  /** The stored `new_method_gateway_account`; "" = the business routing. */
  value: string;
  /** What the business routing picks for this customer's currency. */
  businessLabel: string | null;
  options: Array<{ id: string; label: string }>;
  canManage: boolean;
}) {
  const [pick, setPick] = useDefaultState(value);
  return (
    <ActionForm action={setNewMethodGatewayAction} className="flex flex-col gap-2">
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="cus" value={cus} />
      <label htmlFor="new_method_gateway_account" className="text-sm font-medium">
        Gateway for new payment methods
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <SelectAnswer
          name="new_method_gateway_account"
          value={pick}
          onValueChange={setPick}
          ariaLabel="Gateway for new payment methods"
          disabled={!canManage}
          className="min-w-0 flex-1"
          options={[
            { value: "", label: "Same as business setting" },
            ...options.map((o) => ({ value: o.id, label: o.label })),
          ]}
        />
        {canManage ? (
          <SubmitButton variant="outline" size="sm" disabled={pick === value}>
            Save
          </SubmitButton>
        ) : null}
      </div>
      <p className="m-0 text-xs text-muted-foreground">
        The next payment method this customer adds in the portal goes here. Saved methods stay where
        they are.
        {businessLabel ? ` Business setting: ${businessLabel}.` : null}
      </p>
    </ActionForm>
  );
}
