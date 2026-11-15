"use client";

import * as React from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import type { ActionResult } from "@/lib/action-result";
import { ConfirmDialog } from "@/components/confirm-dialog";
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
import { SettingRow } from "@/components/settings/settings-layout";

type Action = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

/** Test mode only: delete the customers, or reset the whole business to a new test mode. */
export function TestDataSection({
  biz,
  bizName,
  canReset,
  deleteAction,
  resetAction,
}: {
  biz: string;
  bizName: string;
  /** A test business with no live business has no settings to copy, so it cannot be reset. */
  canReset: boolean;
  deleteAction: Action;
  resetAction: Action;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState<"delete" | "reset" | null>(null);
  const [loading, setLoading] = React.useState<"delete" | "reset" | null>(null);
  const [typed, setTyped] = React.useState("");

  async function run(kind: "delete" | "reset") {
    setLoading(kind);
    try {
      const fd = new FormData();
      fd.set("biz", biz);
      const result = await (kind === "delete" ? deleteAction : resetAction)(null, fd);
      if (result.ok && result.message) toast.success(result.message);
      else if (!result.ok && result.message) toast.error(result.message);
      router.refresh();
    } finally {
      setLoading(null);
      setOpen(null);
      setTyped("");
    }
  }

  return (
    <>
      <SettingRow
        label="Delete test data"
        placement="end"
        help="Deletes all customers in this test mode, and their subscriptions, invoices, payments and credit notes. The catalog, settings, gateways and webhook endpoints stay. Time travel stops."
        control={
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-destructive hover:text-destructive"
            onClick={() => setOpen("delete")}
            disabled={loading !== null}
          >
            {loading === "delete" && <Loader2 className="size-3 animate-spin" />}
            Delete test data
          </Button>
        }
      />
      <SettingRow
        label="Reset test business"
        placement="end"
        help={
          canReset
            ? "Deletes everything in this test mode and copies the settings of the live business again. The business ID, API keys and team members stay."
            : "This test business has no live business to copy the settings from. To start again, create a new business."
        }
        control={
          canReset ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-destructive hover:text-destructive"
              onClick={() => setOpen("reset")}
              disabled={loading !== null}
            >
              {loading === "reset" && <Loader2 className="size-3 animate-spin" />}
              Reset test business
            </Button>
          ) : null
        }
      />
      <ConfirmDialog
        open={open === "delete"}
        onOpenChange={(o) => setOpen(o ? "delete" : null)}
        title="Delete test data?"
        description="This permanently deletes all customers in this test mode and all their subscriptions, invoices, payments and credit notes. You cannot undo this."
        confirmLabel="Delete test data"
        destructive
        onConfirm={() => run("delete")}
      />
      <Dialog
        open={open === "reset"}
        onOpenChange={(o) => {
          setOpen(o ? "reset" : null);
          if (!o) setTyped("");
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Reset test business?</DialogTitle>
            <DialogDescription>
              This deletes all customers and their billing records, the catalog, coupons, taxes,
              webhook endpoints and gateways of this test mode. The test mode then gets the settings
              of the live business, a new TM Test Gateway, and document numbers that start at 1. You
              cannot undo this.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 text-sm">
            <Label htmlFor="reset-confirm">Type {bizName} to confirm</Label>
            <Input
              id="reset-confirm"
              className="w-72 max-w-full"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)} disabled={loading !== null}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => run("reset")}
              disabled={typed !== bizName || loading !== null}
            >
              {loading === "reset" && <Loader2 className="size-3 animate-spin" />}
              Reset test business
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
