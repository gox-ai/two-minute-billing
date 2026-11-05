"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import type { ActionResult } from "@/lib/action-result";

export function HubSpotDisconnect({
  biz,
  portal,
  action,
}: {
  biz: string;
  portal: string;
  action: (biz: string) => Promise<ActionResult>;
}) {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Disconnect
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        destructive
        title="Disconnect HubSpot?"
        description={
          <>
            Changes stop syncing to {portal}. Records that are in HubSpot stay there. We keep the
            links between those records and your customers. If you reconnect the same portal, the
            sync continues from where it stopped.
          </>
        }
        confirmLabel="Disconnect"
        onConfirm={async () => {
          const r = await action(biz);
          if (r.ok) {
            toast.success(r.message ?? "HubSpot disconnected");
            router.refresh();
          } else {
            toast.error(r.message ?? "We could not disconnect HubSpot.");
          }
        }}
      />
    </>
  );
}
