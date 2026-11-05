"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import { isZoneQualified } from "@/lib/tz";
import { recordDispute, setDisputeOutcome } from "@/lib/api/disputes";
import { DISPUTE_REASON_OPTIONS, type DisputeReason } from "@/lib/dispute-vocab";

// Same key as the engine routes: recording a chargeback takes money out of cash, like a refund.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function revalidate(biz: string, txn?: string) {
  revalidatePath(`/businesses/${biz}/disputes`);
  if (txn) revalidatePath(`/businesses/${biz}/transactions/${txn}`);
}

export async function recordDisputeAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("payments:refund", "manager");
  const biz = str(fd, "biz");
  const pay = str(fd, "pay");
  if (!biz || !pay) return actionError("The business or payment ID is missing. Reload the page.");
  const errors: Record<string, string> = {};
  // MoneyInput posts integer MINOR units.
  const rawAmount = str(fd, "amount_minor");
  const amount = Number(rawAmount);
  if (!rawAmount || !Number.isSafeInteger(amount) || amount <= 0)
    errors.amount_minor = "Enter an amount that is more than zero.";
  const reason = str(fd, "reason");
  if (!DISPUTE_REASON_OPTIONS.some((o) => o.value === reason)) errors.reason = "Select a reason.";
  const reference = str(fd, "processor_reference");
  if (reference.length > 200) errors.processor_reference = "Use 200 characters or fewer.";
  // DateTimeField posts a UTC instant; the API takes unix seconds.
  const rawDate = str(fd, "opened_at");
  let openedAt: number | undefined;
  if (rawDate) {
    if (!isZoneQualified(rawDate)) errors.opened_at = "Select the date with the date field.";
    else openedAt = Math.floor(Date.parse(rawDate) / 1000);
  }
  if (Object.keys(errors).length) return actionError("Correct the highlighted fields.", { errors });

  const res = await recordDispute(biz, pay, {
    amount_minor: amount,
    reason: reason as DisputeReason,
    ...(reference ? { processor_reference: reference } : {}),
    ...(openedAt ? { opened_at: openedAt } : {}),
  });
  revalidate(biz, str(fd, "txn") || undefined);
  if (!res.ok)
    return actionError(
      `We could not record the dispute. ${res.error ?? "The server did not give a reason."}`,
    );
  return actionOk("Dispute recorded.");
}

export async function disputeOutcomeAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("payments:refund", "manager");
  const biz = str(fd, "biz");
  const dsp = str(fd, "dsp");
  const outcome = str(fd, "outcome");
  if (!biz || !dsp) return actionError("The business or dispute ID is missing. Reload the page.");
  if (outcome !== "won" && outcome !== "lost") return actionError("Select won or lost.");
  const res = await setDisputeOutcome(biz, dsp, outcome);
  revalidate(biz, str(fd, "txn") || undefined);
  if (!res.ok)
    return actionError(
      `We could not change the dispute. ${res.error ?? "The server did not give a reason."}`,
    );
  return actionOk(outcome === "won" ? "Dispute marked as won." : "Dispute marked as lost.");
}
