"use client";

import * as React from "react";
import { useActionState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { AttentionCard } from "@/components/patterns/record-page";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { ActionButton } from "@/components/action-button";
import {
  cancelPendingDebitAction,
  syncTransactionAction,
  type SyncActionResult,
} from "@/app/(dashboard)/businesses/[biz]/transactions/actions";

/**
 * What the billing clock is doing about an in-progress charge, and a way to hurry it.
 *
 * This slot used to read "No operator action available for this status." That was true of
 * the UI and false of the engine: the clock polls the gateway on a per-rail schedule, and
 * an operator staring at a stuck payment could see none of it. Saying nothing is available
 * while a scheduled job works in the background is how a working system looks broken.
 *
 * Rendered as the transaction page's Needs attention card. It shows the SCHEDULE,
 * not just the button. "We will ask again at
 * 14:32" is the answer to the question someone actually has, and it is also what makes not
 * pressing the button a reasonable choice.
 */
export function TransactionSyncPanel({
  biz,
  txn,
  lastPolledAt,
  nextPollAt,
  attempts,
  gatewayName,
  cancelPayment,
}: {
  biz: string;
  txn: string;
  /** The payment to offer "Cancel debit" on (`transaction.pending_debit_cancel`), if allowed. */
  cancelPayment?: string | null;
  /** Null when the clock has never had to defer this row — see `settlement_poll`. */
  lastPolledAt: string | null;
  nextPollAt: string | null;
  attempts: number | null;
  gatewayName: string;
}) {
  const [state, formAction, pending] = useActionState<SyncActionResult | null, FormData>(
    syncTransactionAction,
    null,
  );

  const when = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : null;

  const facts = [
    // These describe the CLOCK, not this button: Check now is a read and does not move
    // the schedule. Absent is not "never" — an undeferred row is picked up on age alone.
    `Last scheduled check ${when(lastPolledAt) ?? "not yet"}`,
    `next ${when(nextPollAt) ?? "on the next run of the billing clock"}`,
    attempts != null && attempts > 0
      ? `${attempts} scheduled check${attempts === 1 ? "" : "s"} so far`
      : null,
  ].filter(Boolean);

  return (
    <AttentionCard
      items={[
        {
          key: "processing",
          tone: "warning",
          title: "This payment is still processing",
          detail: facts.join(" · "),
          actions: (
            <div className="flex flex-wrap items-center gap-2">
              {cancelPayment ? (
                <ActionButton
                  resultAction={cancelPendingDebitAction}
                  fields={{ biz, pay: cancelPayment, txn }}
                  label="Cancel debit"
                  size="sm"
                  confirm={{
                    title: "Cancel this debit?",
                    description: `We ask ${gatewayName} to stop this debit before the bank collects it. If ${gatewayName} cancels it, no money moves, and we stop automatic collection on the invoice. Then you can collect the invoice, record a payment or void it. If ${gatewayName} cannot cancel it, nothing changes. You cannot undo this.`,
                    confirmLabel: "Cancel debit",
                    cancelLabel: "Keep debit",
                    destructive: true,
                  }}
                />
              ) : null}
              <form action={formAction}>
                <input type="hidden" name="biz" value={biz} />
                <input type="hidden" name="txn" value={txn} />
                <Button type="submit" variant="outline" size="sm" disabled={pending}>
                  {pending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  <span className="ml-1">Check {gatewayName} now</span>
                </Button>
              </form>
            </div>
          ),
        },
      ]}
    >
      <div className="flex flex-col gap-3 px-5 py-4 text-sm">
        {/* The gateway's name never starts a sentence, so it never needs a capital. */}
        <p>
          There is no final answer from {gatewayName} yet. Most card payments finish in a few
          minutes. Bank debits can take several days. {gatewayName} usually tells us when the status
          changes. We also check on a schedule.
        </p>
        {/* Tone follows the gateway's answer: `still_pending` changed nothing, so it is
            not green; only `settled` is good news. */}
        {state?.ok === false ? (
          <Alert tone="error">{state.message}</Alert>
        ) : state?.ok ? (
          <Alert
            tone={
              state.outcome === "settled"
                ? "success"
                : state.outcome === "failed" || state.outcome === "unsupported"
                  ? "warning"
                  : "info"
            }
          >
            {state.message}
          </Alert>
        ) : null}
        {/* Settling is stated first: on a `succeeded` verdict this books cash and AR.
            The limit is the point — it records the GATEWAY's answer; Reconcile is where an
            operator supplies a verdict. */}
        <p className="text-xs text-muted-foreground">
          Asks {gatewayName} now and records the answer. If {gatewayName} says that the payment
          succeeded, this settles the payment. This check never decides the outcome. It does not
          change the schedule above.
        </p>
      </div>
    </AttentionCard>
  );
}
