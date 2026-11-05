"use client";

import * as React from "react";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { useOptionalSubscriptionRefresh } from "@/components/subscriptions/subscription-refresh-context";
import { removeScheduledCancellationAction } from "@/app/(dashboard)/businesses/[biz]/subscriptions/actions";

/**
 * "Remove scheduled cancellation". On success the form toasts, refreshes the page, and
 * refreshes the status strip, so the subscription stops reading Non renewing at once.
 */
export function RemoveScheduledCancellationButton({
  biz,
  sub,
  size,
}: {
  biz: string;
  sub: string;
  size?: "sm";
}) {
  const live = useOptionalSubscriptionRefresh();
  return (
    <ActionForm action={removeScheduledCancellationAction} onSuccess={() => live?.refresh()}>
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="sub" value={sub} />
      <SubmitButton variant="outline" {...(size ? { size } : {})}>
        Remove scheduled cancellation
      </SubmitButton>
    </ActionForm>
  );
}
