"use client";

// Banner shown when a cancellation is scheduled (cancel_at_period_end or the
// derived non_renewing status): explains when the subscription stops and
// offers "Remove scheduled cancellation" (SUB-2).

import { RemoveScheduledCancellationButton } from "@/components/subscriptions/remove-scheduled-cancellation";
import { Alert } from "@/components/ui/alert";

export function ScheduledCancellationBanner({
  biz,
  sub,
  cancelsOn,
  reasonCode,
  canEdit,
}: {
  biz: string;
  sub: string;
  /** Pre-formatted date the subscription cancels on. */
  cancelsOn?: string;
  reasonCode?: string | null;
  canEdit: boolean;
}) {
  return (
    <Alert
      tone="warning"
      className="mb-4"
      action={canEdit ? <RemoveScheduledCancellationButton biz={biz} sub={sub} size="sm" /> : null}
    >
      Cancellation scheduled. This subscription will not renew
      {cancelsOn ? (
        <>
          {" "}
          and cancels on <strong>{cancelsOn}</strong>
        </>
      ) : null}
      .{reasonCode ? <span className="ml-1 font-mono text-xs">({reasonCode})</span> : null}
    </Alert>
  );
}
