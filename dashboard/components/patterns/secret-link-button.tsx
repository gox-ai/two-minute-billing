"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { CopyButton } from "@/components/patterns/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SecretLinkResult } from "@/lib/secret-link";

/**
 * Mint a one-time link and reveal it in a dialog, in place. The secret lives only in
 * this component's state — closing the dialog is the last time it is shown.
 */
export function SecretLinkButton({
  mint,
  children,
  variant = "button",
}: {
  mint: () => Promise<SecretLinkResult>;
  children: React.ReactNode;
  /** `link` renders a text link, for a card's header actions. */
  variant?: "button" | "link";
}) {
  const [pending, startTransition] = React.useTransition();
  const [revealed, setRevealed] = React.useState<{ label: string; secret: string } | null>(null);

  const onClick = () =>
    startTransition(async () => {
      const res = await mint();
      if (res.ok) setRevealed({ label: res.label, secret: res.secret });
      else toast.error(res.error);
    });

  return (
    <>
      {variant === "link" ? (
        <button
          type="button"
          onClick={onClick}
          disabled={pending}
          className="text-sm text-primary hover:underline disabled:opacity-60"
        >
          {children}
        </button>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={onClick} disabled={pending}>
          {children}
        </Button>
      )}
      <Dialog open={revealed !== null} onOpenChange={(o) => !o && setRevealed(null)}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Copy it now</DialogTitle>
            <DialogDescription>{revealed?.label}</DialogDescription>
          </DialogHeader>
          <Alert tone="warning">We do not show it again after you close this dialog.</Alert>
          <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2">
            <span className="min-w-0 flex-1 font-mono text-xs break-all">{revealed?.secret}</span>
            {revealed ? <CopyButton value={revealed.secret} /> : null}
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setRevealed(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
