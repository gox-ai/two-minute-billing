"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";
import { toast } from "sonner";
import * as React from "react";

/**
 * Small inline button that triggers a redeliver server action.
 * Separate client component so the delivery table rows can stay server-rendered.
 */
export function RedeliverButton({
  endpointId,
  deliveryId,
  redeliverAction,
  label = "Redeliver",
  queued = false,
}: {
  endpointId: string;
  deliveryId: string;
  redeliverAction: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
  label?: string;
  /** The event already has a pending delivery here; the engine would refuse a second one. */
  queued?: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    redeliverAction,
    null,
  );
  const seen = React.useRef<ActionResult | null>(null);

  React.useEffect(() => {
    if (!state || state === seen.current) return;
    seen.current = state;
    if (state.ok) toast.success(state.message ?? "Redelivery queued");
    else toast.error(state.message ?? "We could not redeliver the webhook.");
  }, [state]);

  return (
    <form action={formAction}>
      <input type="hidden" name="endpoint_id" value={endpointId} />
      <input type="hidden" name="delivery_id" value={deliveryId} />
      {/* The title sits on a wrapper: a disabled button receives no pointer events. */}
      <span title={queued ? "Automatic retry is queued" : undefined}>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={pending || queued}
          aria-label={queued ? `${label}: automatic retry is queued` : undefined}
        >
          {pending ? "…" : label}
        </Button>
      </span>
    </form>
  );
}
