"use client";

import * as React from "react";
import { ActionForm } from "@/components/form/action-form";
import { ActionButton } from "@/components/action-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";
import type { SecretActionResult } from "@/app/actions";

type SecretAction = (prev: ActionResult | null, formData: FormData) => Promise<SecretActionResult>;
type Reveal = NonNullable<SecretActionResult["reveal"]>;

/** Shows a just-minted secret once. It lives only in this component's state. */
export function SecretDialog({ reveal, onClose }: { reveal: Reveal | null; onClose: () => void }) {
  return (
    <Dialog open={reveal != null} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{reveal?.label}</DialogTitle>
          <DialogDescription>Copy it now. We will not show it again.</DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted px-3 py-2 font-mono text-xs break-all select-all">
          {reveal?.secret}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => reveal && void navigator.clipboard?.writeText(reveal.secret)}
          >
            Copy
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const revealOf = (r: ActionResult) => (r as SecretActionResult).reveal ?? null;

/** An <ActionForm> whose action may return a one-time secret. */
export function SecretActionForm({
  action,
  className,
  children,
}: {
  action: SecretAction;
  className?: string;
  children: React.ReactNode;
}) {
  const [reveal, setReveal] = React.useState<Reveal | null>(null);
  return (
    <>
      <ActionForm
        action={action}
        className={className}
        resetOnSuccess
        onSuccess={(r) => setReveal(revealOf(r))}
      >
        {children}
      </ActionForm>
      <SecretDialog reveal={reveal} onClose={() => setReveal(null)} />
    </>
  );
}

/** An <ActionButton> whose action may return a one-time secret. */
export function SecretActionButton({
  action,
  ...props
}: Omit<React.ComponentProps<typeof ActionButton>, "action" | "resultAction" | "onSuccess"> & {
  action: SecretAction;
}) {
  const [reveal, setReveal] = React.useState<Reveal | null>(null);
  return (
    <>
      <ActionButton {...props} resultAction={action} onSuccess={(r) => setReveal(revealOf(r))} />
      <SecretDialog reveal={reveal} onClose={() => setReveal(null)} />
    </>
  );
}
