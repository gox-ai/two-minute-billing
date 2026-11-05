"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { portalRemoveAction } from "./actions";

/**
 * "Remove" on a saved payment method, behind a confirmation.
 *
 * It used to be a one-click ghost button sitting next to "Make primary", and the two
 * are a keystroke apart on a phone. What it does is irreversible in a way the buyer
 * cannot see from the row: `detachPaymentMethod` deletes the instrument at the gateway
 * AND the local row, and the audit note is explicit that afterwards "nothing else can
 * tell you which card this was". There is also no guard on removing the PRIMARY or the
 * LAST method — auto-collection is simply left with nothing to charge — so the dialog
 * says that where it applies rather than letting the buyer discover it at renewal.
 */
export function RemovePaymentMethod({
  pm,
  label,
  isPrimary,
  mandateRail,
}: {
  /** `pm_…` public id. */
  pm: string;
  /** What the row calls this method ("Visa •••• 3184"), so the dialog names the same thing. */
  label: string;
  /** The card charged first — named `primary` on every surface and in `role`. */
  isPrimary: boolean;
  /** Set when this is a mandate the payer authorized at their bank (UPI / e-mandate / card). */
  mandateRail?: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();

  const remove = async () => {
    const data = new FormData();
    data.set("pm", pm);
    const res = await portalRemoveAction(null, data);
    if (!res.ok) return void toast.error(res.message ?? "We could not remove that payment method.");
    toast.success(res.message ?? "Payment method removed");
    // The action revalidates the route; refresh so the list re-renders without it.
    router.refresh();
  };

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        brand
        destructive
        title={`Remove ${label}?`}
        confirmLabel="Remove"
        description={
          <span className="flex flex-col gap-2">
            <span>
              This business can no longer charge it. You cannot undo this. To use the card again,
              you must add it again.
            </span>
            {/* Same fact as the note under the row, repeated HERE because this is the
                moment it matters: removing a mandate stops us charging it, but the
                authorization survives at the bank and only the payer can revoke it. */}
            {mandateRail ? (
              <span>
                The auto-debit authorization ({mandateRail}) stays active at your bank. If you
                remove it here, the authorization does not stop. To cancel the mandate, revoke it in
                your UPI app or bank portal.
              </span>
            ) : null}
            {isPrimary ? (
              <span>
                This is your primary payment method. Until you add another one, we cannot take
                automatic payments.
              </span>
            ) : null}
          </span>
        }
        onConfirm={remove}
      />
    </>
  );
}
