"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import { cancelPendingDebit, reconcileTransaction, syncTransaction } from "@/lib/api/payments";

// Refunds reuse the existing app-level action (app/actions.ts). Do not redefine.

/** Map an apiWrite failure to an ActionResult (409 → conflict toast w/ Reload). */
function failure(
  res: { status: number; error?: string; requestId?: string },
  fallback: string,
): ActionResult {
  const msg = res.error ?? fallback;
  return res.status === 409
    ? actionError(msg, { code: "conflict" })
    : actionError(msg, { requestId: res.requestId });
}

// --- Transactions: reconcile a needs_attention / timeout transaction --------

export async function reconcileTransactionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("payments:collect", "ops");
  const biz = String(formData.get("biz") ?? "").trim();
  const txn = String(formData.get("txn") ?? "").trim();
  const outcome = String(formData.get("outcome") ?? "").trim();
  if (!biz || !txn) return actionError("The transaction ID is missing. Reload the page.");
  if (outcome !== "succeeded" && outcome !== "failed") return actionError("Select a verdict");

  const res = await reconcileTransaction(txn, outcome);
  if (!res.ok) return failure(res, "We could not reconcile the transaction.");
  revalidatePath(`/businesses/${biz}/transactions`);
  return actionOk(
    `Transaction ${outcome === "succeeded" ? "settled as succeeded" : "marked as failed"}`,
  );
}

// --- Transactions: ask the gateway about an in-progress charge --------------

/**
 * The counterpart to reconcile, and deliberately unlike it: reconcile SENDS a verdict,
 * this one asks for one. `ops` on both, but only reconcile can assert something the
 * gateway never said.
 */
/**
 * The gateway's answer, carried alongside the message so the panel can pick a tone.
 * Extends `ActionResult` locally rather than widening its `code`, which is documented as
 * meaning "conflict → offer Reload" and is read that way elsewhere.
 */
export type SyncActionResult = ActionResult & {
  outcome?: "settled" | "failed" | "still_pending" | "unsupported";
};

export async function syncTransactionAction(
  _prev: SyncActionResult | null,
  formData: FormData,
): Promise<SyncActionResult> {
  await requirePermission("payments:collect", "ops");
  const biz = String(formData.get("biz") ?? "").trim();
  const txn = String(formData.get("txn") ?? "").trim();
  if (!biz || !txn) return actionError("The transaction ID is missing. Reload the page.");

  const res = await syncTransaction(biz, txn);
  if (!res.ok) return failure(res, "We could not reach the gateway. Try again later.");
  revalidatePath(`/businesses/${biz}/transactions/${txn}`);
  const outcome = (res.data as { outcome?: SyncActionResult["outcome"] } | undefined)?.outcome;
  /**
   * The gateway's answer, said plainly — and carried alongside the message so the panel can
   * pick a TONE.
   *
   * "Still processing" is a real RESULT and not a failure of the button: reporting it as one
   * would push an operator toward reconcile, the route that CAN assert an outcome nothing
   * verified. But it is not a success either, and rendering it green claimed something good
   * had happened when nothing had happened at all.
   */
  return {
    ...actionOk(
      outcome === "settled"
        ? "The gateway confirmed this payment. The payment is now settled."
        : outcome === "failed"
          ? "The gateway reported that this payment failed."
          : outcome === "unsupported"
            ? "This gateway does not let us ask about the status of a charge later."
            : "The payment is still processing at the gateway. Nothing changed yet.",
    ),
    ...(outcome ? { outcome } : {}),
  };
}

// --- Payments: cancel a debit the gateway has not collected yet --------------

/** Same key as the engine route: stopping a debit sits with refunds and voids. */
export async function cancelPendingDebitAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("payments:refund", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const pay = String(formData.get("pay") ?? "").trim();
  const txn = String(formData.get("txn") ?? "").trim();
  if (!biz || !pay) return actionError("The payment ID is missing. Reload the page.");
  const res = await cancelPendingDebit(biz, pay);
  revalidatePath(`/businesses/${biz}/transactions`);
  if (txn) revalidatePath(`/businesses/${biz}/transactions/${txn}`);
  if (!res.ok) return failure(res, "We could not cancel the debit.");
  const outcome = (res.data as { outcome?: string } | undefined)?.outcome;
  if (outcome === "settled")
    return actionOk("The debit succeeded before the cancel. We recorded the payment.");
  if (outcome === "failed")
    return actionOk("The debit failed before the cancel. We recorded the failure.");
  return actionOk("Debit cancelled.");
}
