"use server";

import {
  getTransaction,
  listGatewayWebhooks,
  type Transaction,
  type GatewayWebhook,
} from "@/lib/api/payments";
import { requirePermission } from "@/lib/session";
import { listDisputes, type Dispute } from "@/lib/api/disputes";

export type RefreshTransactionResult =
  | { ok: true; transaction: Transaction; callbacks: GatewayWebhook[]; disputes: Dispute[] }
  | { ok: false; error: string };

/**
 * Re-reads this transaction and its gateway callback log — our own DB only, no
 * gateway call. That is what distinguishes it from `syncTransactionAction`
 * (transactions/actions.ts), which actually asks the gateway for a verdict.
 */
export async function refreshTransactionAction(
  biz: string,
  txn: string,
): Promise<RefreshTransactionResult> {
  await requirePermission("payments:collect", "ops"); // same gate as the page itself

  let transaction: Transaction;
  try {
    transaction = await getTransaction(biz, txn);
  } catch {
    return { ok: false, error: "We could not reload this transaction." };
  }

  // Best-effort, same as the page's initial load: a webhook-log hiccup should not
  // hide the money facts that just came back cleanly above.
  let callbacks: GatewayWebhook[] = [];
  try {
    callbacks = (
      await listGatewayWebhooks(biz, {
        limit: 50,
        filters: [{ field: "transaction", op: "is", value: transaction.id }],
      })
    ).data;
  } catch {
    callbacks = [];
  }

  let disputes: Dispute[] = [];
  if (transaction.type === "payment" && transaction.reference_payment) {
    try {
      disputes = (await listDisputes(biz, { payment: transaction.reference_payment, limit: 50 }))
        .data;
    } catch {
      disputes = [];
    }
  }

  return { ok: true, transaction, callbacks, disputes };
}
