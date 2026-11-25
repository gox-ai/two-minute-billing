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
import { LinkDaysField } from "@/components/form/link-days-field";

/**
 * Mint a one-time link and reveal it in a dialog, in place. The secret lives only in
 * this component's state — closing the dialog is the last time it is shown.
 * With `linkDays`, a first dialog asks how long the link works (preset to that value).
 */
export function SecretLinkButton({
  mint,
  children,
  variant = "button",
  size = "sm",
  linkDays,
  title = "Create a link",
}: {
  mint: (days?: number) => Promise<SecretLinkResult>;
  children: React.ReactNode;
  /** Ask for the link's lifetime first, preset to this many days. */
  linkDays?: number;
  /** Title of the lifetime dialog. */
  title?: string;
  /** `link` renders a text link, for a card's header actions. */
  variant?: "button" | "link";
  /** `default` matches the other buttons of a record header. */
  size?: "sm" | "default";
}) {
  const [pending, startTransition] = React.useTransition();
  const [revealed, setRevealed] = React.useState<{ label: string; secret: string } | null>(null);

  const [asking, setAsking] = React.useState(false);
  const run = (days?: number) =>
    startTransition(async () => {
      const res = await mint(days);
      if (res.ok) {
        setAsking(false);
        setRevealed({ label: res.label, secret: res.secret });
      } else toast.error(res.error);
    });
  const onClick = () => (linkDays ? setAsking(true) : run());

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
        <Button type="button" variant="outline" size={size} onClick={onClick} disabled={pending}>
          {children}
        </Button>
      )}
      {linkDays ? (
        <Dialog open={asking} onOpenChange={setAsking}>
          <DialogContent size="sm">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>
                Select how long the link works. It opens the customer portal.
              </DialogDescription>
            </DialogHeader>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(new FormData(e.currentTarget).get("link_valid_days"));
                run(Number.isInteger(n) ? n : undefined);
              }}
            >
              <LinkDaysField defaultDays={linkDays} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAsking(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                  Create link
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
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
