"use client";

import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Input } from "@/components/ui/input";
import { portalBuyCreditsAction } from "./credits-actions";

/** "Buy" for one credit pack: opens the purchase checkout for the quantity selected. */
export function BuyCreditsForm({ price, label }: { price: string; label: string }) {
  return (
    <ActionForm
      action={portalBuyCreditsAction}
      onSuccess={(r) => {
        if (r.redirectTo) window.location.assign(r.redirectTo);
      }}
      className="flex items-center gap-2 sm:justify-end"
    >
      <input type="hidden" name="price" value={price} />
      <Input
        name="quantity"
        type="number"
        min={1}
        max={100}
        defaultValue={1}
        aria-label={`Quantity of ${label}`}
        className="h-8 w-20 tabular-nums"
      />
      <SubmitButton size="sm">Buy</SubmitButton>
    </ActionForm>
  );
}
