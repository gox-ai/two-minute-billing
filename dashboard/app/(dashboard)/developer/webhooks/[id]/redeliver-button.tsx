"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";
import { toast } from "sonner";
import { Loader2, RotateCcw } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  ghost = false,
}: {
  endpointId: string;
  deliveryId: string;
  redeliverAction: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
  label?: string;
  /** The event already has a pending delivery here; the engine would refuse a second one. */
  queued?: boolean;
  /** The row-action look of the log tables: a ghost button with an icon. */
  ghost?: boolean;
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
    <form action={formAction} className={ghost ? "flex" : undefined}>
      <input type="hidden" name="endpoint_id" value={endpointId} />
      <input type="hidden" name="delivery_id" value={deliveryId} />
      {/* The tooltip sits on a wrapper: a disabled button receives no pointer events. */}
      <Tooltip open={queued ? undefined : false}>
        <TooltipTrigger asChild>
          <span className={ghost ? "flex" : "inline-flex"}>
            <Button
              type="submit"
              variant={ghost ? "ghost" : "outline"}
              size="sm"
              disabled={pending || queued}
              aria-label={queued ? `${label}: automatic retry is queued` : undefined}
            >
              {ghost ? (
                <>
                  {pending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="size-3.5" />
                  )}
                  {/* Icon-only in a narrow list, where the row's title needs the width. */}
                  <span className="list-narrow:sr-only">{label}</span>
                </>
              ) : pending ? (
                "…"
              ) : (
                label
              )}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Automatic retry is queued</TooltipContent>
      </Tooltip>
    </form>
  );
}
