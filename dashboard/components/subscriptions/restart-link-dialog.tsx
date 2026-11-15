"use client";

// Send restart link: a reactivating checkout for an ENDED subscription, emailed to the
// customer or shown once to copy. The customer pays the new term on that page; the
// subscription starts again only if the payment succeeds.

import * as React from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { RadioField } from "@/components/ui/radio-group";
import { CopyButton } from "@/components/patterns/copy-button";
import { useDefaultState } from "@/lib/use-default-state";
import { createRestartLinkAction } from "@/app/(dashboard)/businesses/[biz]/subscriptions/actions";
import { sendAdhocEmailAction } from "@/app/(dashboard)/businesses/[biz]/emails/actions";

type Outcome =
  | { kind: "link"; url: string; label: string }
  | { kind: "email"; to: string; transport: string | null };

export function RestartLinkDialog({
  biz,
  sub,
  defaultPrice,
  customerEmail,
  canEmail,
}: {
  biz: string;
  sub: string;
  /** The business's `restart_price` setting, preselected. */
  defaultPrice: "current" | "keep";
  /** The customer's billing email; no email option without one. */
  customerEmail: string | null;
  canEmail: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [price, setPrice] = useDefaultState<string>(defaultPrice);
  const [done, setDone] = React.useState<Outcome | null>(null);
  const [pending, startTransition] = React.useTransition();
  const restartPrice = price === "keep" ? "keep" : "current";

  const close = (o: boolean) => {
    setOpen(o);
    if (!o) {
      setDone(null);
      setPrice(defaultPrice);
    }
  };
  const create = () =>
    startTransition(async () => {
      const res = await createRestartLinkAction(biz, sub, restartPrice);
      if (res.ok) setDone({ kind: "link", url: res.url, label: res.label });
      else toast.error(res.error);
    });
  const email = () =>
    startTransition(async () => {
      const res = await sendAdhocEmailAction(biz, {
        type: "subscription_restart",
        subscription: sub,
        restart_price: restartPrice,
      });
      if (res.ok)
        setDone({ kind: "email", to: customerEmail ?? "", transport: res.transport ?? null });
      else toast.error(res.error ?? "We could not send the email.");
    });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md px-1 py-0.5 text-left text-sm text-primary hover:underline"
      >
        Send restart link
      </button>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent size="md">
          <DialogHeader className="pr-12">
            <DialogTitle>Send a restart link</DialogTitle>
            <DialogDescription>
              The customer pays for a new term on a checkout page. The subscription starts again
              only after the payment succeeds. If the payment fails, it stays cancelled.
            </DialogDescription>
          </DialogHeader>
          {done?.kind === "link" ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{done.label}</p>
              <Alert tone="warning">
                We do not show the link again after you close this dialog.
              </Alert>
              <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2">
                <span className="min-w-0 flex-1 font-mono text-xs break-all">{done.url}</span>
                <CopyButton value={done.url} />
              </div>
            </div>
          ) : done?.kind === "email" ? (
            // `ok` alone is not delivery: the console sink records the email and sends nothing.
            <Alert tone={done.transport === "console" ? "warning" : "success"}>
              {done.transport === "console"
                ? "Recorded in the email log. But this business has no email relay configured, so we did not deliver the email. Configure SMTP in email settings."
                : `Sent to ${done.to}.`}
            </Alert>
          ) : (
            <div className="space-y-2">
              <div className="text-sm font-medium">Price of the new term</div>
              <RadioField
                ariaLabel="Price of the new term"
                value={price}
                onValueChange={setPrice}
                options={[
                  {
                    value: "current",
                    label: "Current price of the plan",
                    hint: "A custom price that you set on the subscription stays.",
                  },
                  { value: "keep", label: "Price the subscription had" },
                ]}
              />
              {canEmail && customerEmail ? (
                <p className="pt-2 text-sm text-muted-foreground">
                  Email the link to {customerEmail}, or create the link to copy it.
                </p>
              ) : null}
            </div>
          )}
          <DialogFooter>
            {done ? (
              <Button type="button" onClick={() => close(false)}>
                Done
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => close(false)}>
                  Cancel
                </Button>
                {canEmail && customerEmail ? (
                  <Button type="button" variant="outline" onClick={create} disabled={pending}>
                    Create link
                  </Button>
                ) : null}
                <Button
                  type="button"
                  onClick={canEmail && customerEmail ? email : create}
                  disabled={pending}
                >
                  {pending
                    ? "Working…"
                    : canEmail && customerEmail
                      ? "Email the link"
                      : "Create link"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
