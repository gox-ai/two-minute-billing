"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  forgetAllTrustedBrowsersAction,
  forgetTrustedBrowserAction,
} from "@/app/(dashboard)/account/actions";
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

/** "Forget" one trusted browser. */
export function ForgetBrowserButton({
  id,
  current,
  label,
}: {
  id: string;
  current: boolean;
  label: string;
}) {
  const run = useRun();
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`Forget ${label}`}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await run(forgetTrustedBrowserAction(id, current));
        setBusy(false);
      }}
    >
      Forget
    </Button>
  );
}

/** "Forget all", confirmed first. */
export function ForgetAllBrowsersButton() {
  const run = useRun();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Forget all
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Forget every trusted browser?"
        description="All browsers, and this browser too, will ask for a code at the next sign-in."
        confirmLabel="Forget all"
        onConfirm={() => run(forgetAllTrustedBrowsersAction())}
      />
    </>
  );
}
