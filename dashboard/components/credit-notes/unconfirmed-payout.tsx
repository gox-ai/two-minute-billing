"use client";

import * as React from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ActionForm } from "@/components/form/action-form";
import { resolvePayoutAction } from "@/app/(dashboard)/businesses/[biz]/credit_notes/actions";

/** A payout refund the gateway could not confirm, and the two ways to resolve it. */
export function UnconfirmedPayoutAlert({
  biz,
  cn,
  amount,
}: {
  biz: string;
  cn: string;
  /** Already formatted with its currency. */
  amount: string;
}) {
  const [pick, setPick] = React.useState<"return_as_credit" | "mark_paid" | null>(null);
  const submitRef = React.useRef<HTMLButtonElement>(null);
  return (
    <>
      <Alert
        tone="warning"
        title={`We could not confirm a refund of ${amount}`}
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setPick("mark_paid")}>
              Mark the refund paid
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPick("return_as_credit")}>
              Return as credit
            </Button>
          </div>
        }
      >
        We could not confirm this refund with the payment gateway. Check the gateway, then mark the
        refund paid or return the amount as credit.
      </Alert>
      <ConfirmDialog
        open={pick !== null}
        onOpenChange={(o) => (o ? null : setPick(null))}
        title={pick === "mark_paid" ? "Mark the refund paid?" : "Return the amount as credit?"}
        description={
          pick === "mark_paid"
            ? `Do this only if the gateway shows that the customer received ${amount}. You cannot undo this.`
            : `Do this only if the gateway shows no refund. The customer gets ${amount} back as credit on this note. You cannot undo this.`
        }
        confirmLabel={pick === "mark_paid" ? "Mark paid" : "Return as credit"}
        onConfirm={() => submitRef.current?.click()}
      />
      <ActionForm action={resolvePayoutAction} className="hidden" onSuccess={() => setPick(null)}>
        <input type="hidden" name="biz" value={biz} />
        <input type="hidden" name="cn" value={cn} />
        <input type="hidden" name="resolution" value={pick ?? ""} />
        <button ref={submitRef} type="submit" aria-hidden tabIndex={-1} />
      </ActionForm>
    </>
  );
}
