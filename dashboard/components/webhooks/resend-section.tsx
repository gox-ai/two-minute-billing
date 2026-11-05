"use client";

import * as React from "react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { RecordCard } from "@/components/patterns/record-page";
import { AttemptTranscript } from "@/components/webhooks/attempt-transcript";
import type { ActionResult } from "@/lib/action-result";
import type { RedeliveryAttempt } from "@/lib/api/developer";
import { toast } from "sonner";

type ResendState = (ActionResult & { attempt?: RedeliveryAttempt }) | null;

/**
 * One endpoint's card on the event screen: its heading, its Resend button, the server-rendered
 * delivery fields, and — after a resend — what that resend actually sent and got back.
 *
 * WHY THIS IS A CLIENT SHELL AROUND SERVER CHILDREN. The transcript is never stored (the engine
 * builds it, returns it and drops it), so it exists only in the action result held in this
 * component's state. It therefore cannot be server-rendered on the next paint like every other
 * field on this page — there is nothing to re-fetch it from. Everything that CAN be server
 * rendered still is: the delivery fields arrive as `children` and are untouched by this file.
 *
 * The panels are collapsed by default. An operator who pressed Resend wants the VERDICT first
 * ("HTTP 200 in 84ms"); the headers and bodies are what they open when the verdict is wrong.
 */
export function ResendSection({
  endpointId,
  deliveryId,
  heading,
  subheading,
  status,
  footer,
  queued = false,
  redeliverAction,
  children,
}: {
  endpointId: string;
  deliveryId: string;
  heading: React.ReactNode;
  subheading?: React.ReactNode;
  /** Status chip beside the heading. */
  status?: React.ReactNode;
  footer?: React.ReactNode;
  /**
   * A delivery of this event to this endpoint is already pending. The engine refuses a second
   * one ("already pending on this endpoint"), so Resend is disabled instead of failing on click.
   */
  queued?: boolean;
  redeliverAction: (
    prev: ResendState,
    formData: FormData,
  ) => Promise<ActionResult & { attempt?: RedeliveryAttempt }>;
  children: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState<ResendState, FormData>(redeliverAction, null);
  const seen = React.useRef<ResendState>(null);

  React.useEffect(() => {
    if (!state || state === seen.current) return;
    seen.current = state;
    if (state.ok) toast.success(state.message ?? "Resent");
    else toast.error(state.message ?? "We could not resend the notification.");
  }, [state]);

  const attempt = state?.ok ? state.attempt : undefined;

  return (
    <RecordCard
      title={<span className="wrap-anywhere">{heading}</span>}
      meta={
        status || subheading ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            {status}
            {subheading}
          </span>
        ) : undefined
      }
      actions={
        <form action={formAction} className="flex items-center gap-2">
          <input type="hidden" name="endpoint_id" value={endpointId} />
          <input type="hidden" name="delivery_id" value={deliveryId} />
          {queued ? (
            <span id={`${deliveryId}-queued`} className="text-xs text-muted-foreground">
              Automatic retry is queued
            </span>
          ) : null}
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={pending || queued}
            aria-describedby={queued ? `${deliveryId}-queued` : undefined}
          >
            {pending ? "Resending…" : "Resend"}
          </Button>
        </form>
      }
      footer={footer}
    >
      {children}

      {attempt ? (
        <div className="mt-3">
          <AttemptTranscript attempt={attempt} />
        </div>
      ) : null}
    </RecordCard>
  );
}
