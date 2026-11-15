"use client";

import * as React from "react";
import { SettingRow } from "@/components/settings/settings-layout";
import { SwitchField } from "@/components/ui/switch";
import { useDefaultState } from "@/lib/use-default-state";
import { ASSISTANT_NAME } from "@/lib/assistant";

/** The two action switches. Money actions stay disabled while actions are off. */
export function ActionsFields({
  actionsEnabled,
  moneyActionsEnabled,
  canManage,
}: {
  actionsEnabled: boolean;
  moneyActionsEnabled: boolean;
  canManage: boolean;
}) {
  // Mirrors the first switch so the second can follow it before the form is saved.
  const [actionsOn, setActionsOn] = useDefaultState(actionsEnabled);
  return (
    <>
      <SettingRow
        label={`Let ${ASSISTANT_NAME} take actions`}
        help={`${ASSISTANT_NAME} prepares a change and you confirm it. It uses your own permissions. Off by default.`}
        placement="end"
        control={
          <SwitchField
            name="actions_enabled"
            defaultChecked={actionsEnabled}
            onCheckedChange={setActionsOn}
            disabled={!canManage}
            ariaLabel={`Let ${ASSISTANT_NAME} take actions`}
          />
        }
      />
      <SettingRow
        label="Allow money actions"
        help="Refunds, collecting payments, voiding or writing off invoices. Each one needs a second confirmation."
        placement="end"
        control={
          <SwitchField
            name="money_actions_enabled"
            defaultChecked={moneyActionsEnabled}
            disabled={!canManage || !actionsOn}
            ariaLabel="Allow money actions"
          />
        }
      />
    </>
  );
}
