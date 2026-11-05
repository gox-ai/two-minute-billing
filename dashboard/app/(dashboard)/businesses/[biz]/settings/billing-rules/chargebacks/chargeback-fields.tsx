"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useDefaultState } from "@/lib/use-default-state";
import { SettingRow, SettingsCard } from "@/components/settings/settings-layout";
import { SettingSwitch } from "@/components/settings/setting-switch";
import { ChoiceRow, type Choice } from "../_parts/rows";

export interface ChargebackDefaults {
  onLostInvoice: string;
  onInitiated: string;
  onLost: string;
  cascade: boolean;
  stopCollecting: boolean;
}

const INVOICE_OPTIONS: Choice[] = [
  {
    value: "no_action",
    label: "Take no action",
    consequence: "The invoice stays paid, and we raise nothing else.",
  },
  {
    value: "credit_note",
    label: "Raise a credit note documenting the loss",
    consequence:
      "A credit note records the loss for your books. It books nothing to the ledger and does not reopen the invoice.",
  },
];

const subOptions = (when: string): Choice[] => [
  { value: "no_action", label: "Take no action", consequence: `Nothing changes ${when}.` },
  {
    value: "cancel_immediately",
    label: "Cancel immediately",
    consequence: `We cancel the subscription ${when}. Your cancellation defaults for credits and amounts owed apply.`,
  },
  {
    value: "cancel_end_of_term",
    label: "Cancel at end of term",
    consequence: `We schedule the subscription to cancel at the end of its term ${when}.`,
  },
  {
    value: "pause_indefinitely",
    label: "Pause indefinitely",
    consequence: `We pause the subscription ${when}, with no resume date.`,
  },
  {
    value: "pause_end_of_term",
    label: "Pause at end of term",
    consequence: `The subscription pauses at the end of its term ${when}, with no resume date.`,
  },
];

const OPENED = subOptions("as soon as the dispute is opened");
const LOST = subOptions("when the dispute is lost");

/**
 * The chargeback policy. "Apply to other subscriptions" does nothing unless a
 * subscription action is set, so it hides then — mounted, so its value still posts.
 */
export function ChargebackFields({ d }: { d: ChargebackDefaults }) {
  const [opened, setOpened] = useDefaultState(d.onInitiated);
  const [lost, setLost] = useDefaultState(d.onLost);
  const [cascade, setCascade] = useDefaultState(d.cascade);
  const [stop, setStop] = useDefaultState(d.stopCollecting);
  const acts = opened !== "no_action" || lost !== "no_action";

  return (
    <>
      <SettingsCard title="Invoice" meta="When the dispute is lost">
        <ChoiceRow
          name="on_lost_invoice"
          label="If the dispute is lost"
          help="The invoice stays paid in both cases. The customer paid, and the bank then took the funds back as a separate loss."
          defaultValue={d.onLostInvoice}
          options={INVOICE_OPTIONS}
        />
      </SettingsCard>

      <SettingsCard title="Subscription" meta="The one on the disputed invoice">
        <ChoiceRow
          name="on_initiated_subscription"
          label="As soon as a dispute is opened"
          help="Before the outcome is known."
          value={opened}
          onValueChange={setOpened}
          options={OPENED}
          more="If you win the dispute later, the funds come back. But we do not undo a pause or cancellation done here."
        />
        <ChoiceRow
          name="on_lost_subscription"
          label="If the dispute is lost"
          value={lost}
          onValueChange={setLost}
          options={LOST}
        />
        <div className={cn(!acts && "hidden")}>
          <SettingRow
            label="Apply this to the customer's other subscriptions too"
            help="Every other subscription the customer holds that is not already cancelled."
            placement="end"
            control={
              <SettingSwitch
                name="cascade_to_other_subscriptions"
                label="Apply the subscription action to the customer's other subscriptions too"
                checked={cascade}
                onCheckedChange={setCascade}
              />
            }
            consequence={
              cascade
                ? "On: one dispute cancels or pauses all of this customer's subscriptions. If you disable this later, we do not undo a cancellation."
                : "Off: we change only the subscription on the disputed invoice."
            }
          />
        </div>
      </SettingsCard>

      <SettingsCard title="Collection" meta="The customer's other invoices">
        <SettingRow
          label="Stop collecting payment from the customer"
          help="Unpaid invoices and unbilled charges across all their subscriptions."
          placement="end"
          control={
            <SettingSwitch
              name="stop_collecting_all"
              label="Stop collecting payment on the customer's other unpaid invoices and unbilled charges"
              checked={stop}
              onCheckedChange={setStop}
            />
          }
          consequence={
            stop
              ? "On: as soon as a dispute is opened, we disable automatic collection for the customer. We write off nothing. If you disable this setting later, collection stays disabled. Enable it again on the customer."
              : "Off: we continue to collect the customer's other invoices as usual."
          }
        />
      </SettingsCard>
    </>
  );
}
