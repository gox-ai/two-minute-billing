"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PaymentDialog } from "../../payment-dialog";
import { ADD_METHOD_ANCHOR, CLOSE_ADD_METHOD_EVENT, OPEN_ADD_METHOD_EVENT } from "./section-link";

/**
 * "Add a payment method" at the top right of Payment methods. Opens the popup below through
 * the same event every other "Add a payment method" / "Update payment method" uses.
 */
export function AddMethodButton() {
  return (
    <Button
      id={ADD_METHOD_ANCHOR}
      variant="outline"
      size="sm"
      onClick={() => window.dispatchEvent(new Event(OPEN_ADD_METHOD_EVENT))}
    >
      <Plus aria-hidden />
      Add a payment method
    </Button>
  );
}

/**
 * The Add a payment method popup (option C: the same list as Pay now). Opens on load when
 * the buyer has no method, comes back from a setup, or followed an email's "Change payment
 * method" link; otherwise from `AddMethodButton` or any link that fires the event.
 */
export function AddMethodDisclosure({
  defaultOpen,
  children,
}: {
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  React.useEffect(() => {
    const onOpen = () => setOpen(true);
    const onClose = () => setOpen(false);
    window.addEventListener(OPEN_ADD_METHOD_EVENT, onOpen);
    window.addEventListener(CLOSE_ADD_METHOD_EVENT, onClose);
    return () => {
      window.removeEventListener(OPEN_ADD_METHOD_EVENT, onOpen);
      window.removeEventListener(CLOSE_ADD_METHOD_EVENT, onClose);
    };
  }, []);
  return (
    <PaymentDialog
      open={open}
      onClose={() => setOpen(false)}
      title="Add a payment method"
      description="Select how to pay future invoices."
    >
      {children}
    </PaymentDialog>
  );
}
