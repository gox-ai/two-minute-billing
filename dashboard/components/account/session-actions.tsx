"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { revokeOtherSessionsAction, revokeSessionAction } from "@/app/(dashboard)/account/actions";
import type { ActionResult } from "@/lib/action-result";

function useRun() {
  const router = useRouter();
  return async (r: Promise<ActionResult>) => {
    const res = await r;
    if (res.ok) {
      if (res.message) toast.success(res.message);
      router.refresh();
    } else toast.error(res.message ?? "The action did not complete");
  };
}

/** "Sign out" on one other browser. */
export function SignOutSessionButton({ id, label }: { id: string; label: string }) {
  const run = useRun();
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`Sign out ${label}`}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await run(revokeSessionAction(id));
        setBusy(false);
      }}
    >
      Sign out
    </Button>
  );
}

/** "Sign out of other browsers", confirmed first. */
export function SignOutOthersButton() {
  const run = useRun();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Sign out of other browsers
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Sign out of all other browsers?"
        description="This browser stays signed in. All other browsers must sign in again."
        confirmLabel="Sign out other browsers"
        onConfirm={() => run(revokeOtherSessionsAction())}
      />
    </>
  );
}
