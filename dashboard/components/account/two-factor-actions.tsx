"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  disableMfaAction,
  enrollMfaAction,
  regenerateRecoveryCodesAction,
} from "@/app/auth-actions";
import type { ActionResult } from "@/lib/action-result";
import { useStepUp } from "@/components/account/step-up";

function useConfirmedAction(action: () => Promise<ActionResult>) {
  const router = useRouter();
  const { guard } = useStepUp();
  return () =>
    guard(action, (r) => {
      if (r.ok) {
        if (r.message) toast.success(r.message);
        router.refresh();
      } else toast.error(r.message ?? "The action did not complete");
    });
}

/** "Add" / "Change app": starts authenticator setup. The action redirects to the setup panel. */
export function AuthenticatorAppButton({
  label,
  variant,
}: {
  label: string;
  variant: "outline" | "default";
}) {
  const { guard } = useStepUp();
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await guard(enrollMfaAction, (r) => {
            if (!r.ok) toast.error(r.message ?? "We could not start setup.");
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </Button>
  );
}

/** "Disable 2FA" with its confirmation. `methods`: "your 2 passkeys and your authenticator app". */
export function TurnOffTwoFactorButton({ methods }: { methods: string }) {
  const [open, setOpen] = React.useState(false);
  const run = useConfirmedAction(disableMfaAction);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Disable 2FA
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Disable two-factor authentication?"
        description={`The sign-in will not ask for a second step. We remove ${methods || "your methods"} and your recovery codes. We also sign out your other browsers.`}
        confirmLabel="Disable 2FA"
        destructive
        onConfirm={run}
      />
    </>
  );
}

/** "Make new codes" — the old set stops working, so it asks first. */
export function RegenerateCodesButton({ label }: { label: string }) {
  const [open, setOpen] = React.useState(false);
  const run = useConfirmedAction(regenerateRecoveryCodesAction);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Make new recovery codes?"
        description="When you make new codes, the current codes stop operating."
        confirmLabel="Make new codes"
        onConfirm={run}
      />
    </>
  );
}
