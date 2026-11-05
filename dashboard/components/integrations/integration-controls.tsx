"use client";

import * as React from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { AttemptTranscript } from "@/components/webhooks/attempt-transcript";
import type { ActionResult } from "@/lib/action-result";
import type { IntegrationAttempt } from "@/lib/api/integrations";

type Direct = (biz: string, key: string) => Promise<ActionResult>;

export function IntegrationDisconnect({
  biz,
  integrationKey,
  label,
  action,
}: {
  biz: string;
  integrationKey: string;
  label: string;
  action: Direct;
}) {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Disconnect
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        destructive
        title={`Disconnect ${label}?`}
        description={
          <>
            We delete the stored credentials and stop sending events. We do not send the deliveries
            that wait to send. The delivery log stays. Nothing changes in {label}. You cannot undo
            this. To connect again, you must enter the credentials again. To stop sending for a
            short time, disable the integration.
          </>
        }
        confirmLabel="Disconnect"
        onConfirm={async () => {
          const r = await action(biz, integrationKey);
          if (r.ok) {
            toast.success(r.message ?? "Integration disconnected.");
            router.refresh();
          } else toast.error(r.message ?? "We could not disconnect the integration.");
        }}
      />
    </>
  );
}

type ResendState = (ActionResult & { attempt?: IntegrationAttempt }) | null;

/** Per-row Resend. The transcript opens in a dialog, because the table row has no room. */
export function IntegrationResendButton({
  biz,
  integrationKey,
  label,
  deliveryId,
  queued,
  action,
}: {
  biz: string;
  integrationKey: string;
  label: string;
  deliveryId: string;
  /** A delivery of this event waits to send; the API refuses a second one. */
  queued: boolean;
  action: (
    prev: ResendState,
    fd: FormData,
  ) => Promise<ActionResult & { attempt?: IntegrationAttempt }>;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  // Handled as the action returns, not in an effect: the result drives a toast and the dialog.
  const run = async (prev: ResendState, fd: FormData) => {
    const r = await action(prev, fd);
    if (r.ok) {
      if (r.attempt) setOpen(true);
      else toast.success(r.message ?? "Delivery resent.");
      router.refresh();
    } else if (r.code === "conflict") toast.message(r.message ?? "Already waiting to send.");
    else toast.error(r.message ?? "We could not resend the delivery.");
    return r;
  };
  const [state, formAction, pending] = useActionState<ResendState, FormData>(run, null);

  const attempt = state?.ok ? state.attempt : undefined;

  return (
    <>
      <form action={formAction}>
        <input type="hidden" name="biz" value={biz} />
        <input type="hidden" name="key" value={integrationKey} />
        <input type="hidden" name="delivery" value={deliveryId} />
        {/* The title sits on a wrapper: a disabled button receives no pointer events. */}
        <span title={queued ? "Waiting to send" : undefined}>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={pending || queued}
            aria-label={queued ? "Resend: waiting to send" : undefined}
          >
            {pending ? "Resending…" : "Resend"}
          </Button>
        </span>
      </form>
      {attempt ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent size="lg" className="flex max-h-[85vh] flex-col overflow-hidden">
            <DialogHeader>
              <DialogTitle>Delivery resent</DialogTitle>
              <DialogDescription>What we sent to {label}, and what came back.</DialogDescription>
            </DialogHeader>
            <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
              <AttemptTranscript attempt={attempt} subject="the delivery" />
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
