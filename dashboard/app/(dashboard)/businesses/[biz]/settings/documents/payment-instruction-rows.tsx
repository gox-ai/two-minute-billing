"use client";

import * as React from "react";
import Link from "next/link";
import { useDefaultState } from "@/lib/use-default-state";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingRow, SettingsCard } from "@/components/settings/settings-layout";
import { SelectAnswer, ToggleAnswer } from "@/components/patterns/settings-page";
import { savePaymentInstructionSettingsAction } from "../actions";

type Mode = "all" | "preferred_offline";

const MODE_LABEL: Record<Mode, string> = {
  all: "All instructions",
  preferred_offline: "Customer's preferred method",
};

/**
 * The payment-instruction card of Settings → Documents. The two switches have their own
 * action, so they save from a dialog: its form renders in a portal, outside the page's
 * document-fields form, and the page keeps one Save bar.
 */
export function PaymentInstructionSettings({
  biz,
  version,
  mode,
  personalize,
  manageHref,
}: {
  biz: string;
  version: number | null | undefined;
  mode: Mode;
  personalize: boolean;
  manageHref: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <SettingsCard
      title="Payment instructions"
      meta="Which of your instructions print on an invoice"
      actions={
        <>
          <Link href={manageHref} className="text-primary hover:underline">
            Manage instructions
          </Link>
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
            Change
          </Button>
        </>
      }
    >
      <SettingRow
        label="Which instructions to show"
        placement="end"
        control={<span className="text-sm font-medium">{MODE_LABEL[mode]}</span>}
      />
      <SettingRow
        label="Match instructions to the invoice"
        help="Apply the currency and country targeting of each instruction."
        placement="end"
        control={<span className="text-sm font-medium">{personalize ? "On" : "Off"}</span>}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Payment instructions</DialogTitle>
            <DialogDescription>Which of your instructions print on an invoice.</DialogDescription>
          </DialogHeader>
          <ActionForm
            action={savePaymentInstructionSettingsAction}
            onSuccess={() => setOpen(false)}
            className="flex flex-col gap-4"
          >
            <input type="hidden" name="biz" value={biz} />
            {version != null ? (
              <input type="hidden" name="expected_version" value={version} />
            ) : null}
            <div className="divide-y overflow-hidden rounded-xl border">
              <PaymentInstructionRows mode={mode} personalize={personalize} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton>Save</SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </SettingsCard>
  );
}

/** Mirrors `selectPaymentInstructions`: targeting first, then the rail. */
function PaymentInstructionRows({
  mode: savedMode,
  personalize: savedPersonalize,
}: {
  mode: Mode;
  personalize: boolean;
}) {
  const [mode, setMode] = useDefaultState<string>(savedMode);
  const [personalize, setPersonalize] = useDefaultState(savedPersonalize);
  return (
    <>
      <SettingRow
        label="Which instructions to show"
        htmlFor="pi_mode"
        placement="end"
        control={
          <SelectAnswer
            name="pi_mode"
            ariaLabel="Which instructions to show"
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "all", label: MODE_LABEL.all },
              { value: "preferred_offline", label: MODE_LABEL.preferred_offline },
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
          <ToggleAnswer
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
