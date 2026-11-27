"use client";

import * as React from "react";
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

/**
 * Confirm an import or its undo. On a live business (`name` set) the name typed back enables
 * the one filled action.
 */
export function ConfirmTypedDialog({
  open,
  onOpenChange,
  title,
  description,
  name,
  busy,
  action,
  busyLabel,
  destructive,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  /** The business name to type; null: no typing (a test business). */
  name: string | null;
  busy: boolean;
  action: string;
  busyLabel: string;
  destructive?: boolean;
  onConfirm: (confirm?: string) => void;
}) {
  const [typed, setTyped] = React.useState("");
  const id = React.useId();
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
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {name != null && (
          <div className="space-y-1.5 text-sm">
            <Label htmlFor={id}>Type {name} to confirm</Label>
            <Input
              id={id}
              className="w-72 max-w-full"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={() => onConfirm(name != null ? typed : undefined)}
            disabled={(name != null && typed.trim() !== name) || busy}
          >
            {busy ? busyLabel : action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
