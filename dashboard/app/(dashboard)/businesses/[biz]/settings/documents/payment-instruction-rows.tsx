"use client";

import { useDefaultState } from "@/lib/use-default-state";
import { SelectField } from "@/components/ui/select-field";
import { SettingRow } from "@/components/settings/settings-layout";
import { SettingSwitch } from "@/components/settings/setting-switch";

/** Mirrors `selectPaymentInstructions`: targeting first, then the rail. */
export function PaymentInstructionRows({
  mode: savedMode,
  personalize: savedPersonalize,
}: {
  mode: "all" | "preferred_offline";
  personalize: boolean;
}) {
  const [mode, setMode] = useDefaultState<string>(savedMode);
  const [personalize, setPersonalize] = useDefaultState(savedPersonalize);
  return (
    <>
      <SettingRow
        label="Which instructions to show"
        htmlFor="pi_mode"
        control={
          <SelectField
            name="pi_mode"
            value={mode}
            onValueChange={setMode}
            className="w-full sm:w-72"
            options={[
              { value: "all", label: "All instructions" },
              { value: "preferred_offline", label: "Customer's preferred method" },
            ]}
          />
        }
        consequence={
          mode === "preferred_offline"
            ? "Only the instructions for the method the customer pays with show. When none match, all of them show, because an invoice that nobody can pay is worse."
            : personalize
              ? "Every instruction that matches the invoice shows."
              : "Every instruction shows on every invoice."
        }
      />
      <SettingRow
        label="Match instructions to the invoice"
        help="Apply the currency and country targeting of each instruction."
        placement="end"
        control={
          <SettingSwitch
            name="pi_personalize"
            label="Match instructions to the invoice"
            checked={personalize}
            onCheckedChange={setPersonalize}
          />
        }
        consequence={
          personalize
            ? "The invoice does not show an instruction that targets other currencies or countries."
            : "We ignore targeting. An instruction shows, whatever currencies or countries it lists."
        }
      />
    </>
  );
}
