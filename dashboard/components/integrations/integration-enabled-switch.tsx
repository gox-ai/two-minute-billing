"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/confirm-dialog";
import type { ActionResult } from "@/lib/action-result";

/**
 * Takes effect on toggle. Turning it off asks first: events that occur while it is off are
 * never sent. Not inside a form, so the React form reset cannot drag it back.
 */
export function IntegrationEnabledSwitch({
  biz,
  integrationKey,
  label,
  enabled,
  action,
}: {
  biz: string;
  integrationKey: string;
  label: string;
  enabled: boolean;
  action: (biz: string, key: string, enabled: boolean) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  async function apply(next: boolean) {
    setPending(true);
    try {
      const r = await action(biz, integrationKey, next);
      if (r.ok) {
        toast.success(r.message ?? (next ? "Integration enabled." : "Integration disabled."));
        router.refresh();
      } else toast.error(r.message ?? "We could not change the integration.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <span className="inline-flex items-center gap-2">
        <span className="text-sm">{enabled ? "Enabled" : "Disabled"}</span>
        <Switch
          checked={enabled}
          disabled={pending}
          aria-label={`Send events to ${label}`}
          onCheckedChange={(next) => (next ? void apply(true) : setConfirming(true))}
        />
      </span>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        destructive
        title={`Disable ${label}?`}
        description={
          <>
            We stop sending events to {label}. We do not queue the events that occur while it is
            disabled. When you enable it again, we do not send them.
          </>
        }
        confirmLabel="Disable"
        onConfirm={() => apply(false)}
      />
    </>
  );
}
