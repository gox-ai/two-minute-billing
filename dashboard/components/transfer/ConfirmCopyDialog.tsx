"use client";

import * as React from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Start a copy (or a retry). A live destination's changes need its name typed back. */
export function ConfirmCopyDialog({
  open,
  onOpenChange,
  title,
  summary,
  destName,
  typedConfirm,
  clearFirst,
  blocked,
  busy,
  action,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  summary: React.ReactNode;
  destName: string;
  /** The run changes records of a live business. */
  typedConfirm: boolean;
  clearFirst?: boolean;
  /** Why the signed-in person cannot start it, if they cannot. */
  blocked?: string | null;
  busy: boolean;
  action: string;
  onConfirm: (confirm?: string) => void;
}) {
  const [typed, setTyped] = React.useState("");
  const ok = !blocked && (!typedConfirm || typed === destName);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTyped("");
      }}
    >
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{summary} You cannot undo this.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {clearFirst && (
            <Alert tone="warning">
              The catalog, coupons and taxes of {destName} are deleted before the copy.
            </Alert>
          )}
          {blocked && <Alert tone="error">{blocked}</Alert>}
          {typedConfirm && !blocked && (
            <div className="space-y-3">
              <p>
                The live business {destName} changes. The audit log records each value that changes.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="copy-confirm">Type {destName} to confirm</Label>
                <Input
                  id="copy-confirm"
                  className="w-72 max-w-full"
                  autoComplete="off"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(typedConfirm ? typed : undefined)}
            disabled={!ok || busy}
          >
            {busy ? "Starting…" : action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
