"use client";

import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { portalSetAutoTopupAction } from "./credits-actions";

/**
 * Enable or disable one automatic top-up. The business sets what it buys; the buyer only
 * switches it. Outline: one of several rows, and to disable is a step away from a purchase.
 */
export function AutoTopupSwitch({ unit, enabled }: { unit: string; enabled: boolean }) {
  return (
    <ActionForm action={portalSetAutoTopupAction} className="shrink-0">
      <input type="hidden" name="unit" value={unit} />
      <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
      {/* 36px on a phone: a touch target, as the record pages' phone actions. */}
      <SubmitButton size="sm" variant="outline" className="max-sm:h-9 max-sm:px-4">
        {enabled ? "Disable automatic top-up" : "Enable automatic top-up"}
      </SubmitButton>
    </ActionForm>
  );
}
