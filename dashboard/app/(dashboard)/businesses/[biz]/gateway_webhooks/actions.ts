"use server";

import { revalidatePath } from "next/cache";
import { actionOk, actionError, type ActionResult } from "@/lib/action-result";
import { replayGatewayWebhook } from "@/lib/api/payments";
import { requirePermission } from "@/lib/session";

/**
 * Re-run a webhook stuck at `outcome: error`.
 *
 * A failed delivery is answered 502 so the gateway redelivers, but gateways cap their
 * own retries (Stripe gives up after ~3 days). Past that the event is stranded — the
 * money moved at the gateway and our ledger never learned — and this is the only handle.
 *
 * The API refuses anything not in `error` with a 409, so the button is deliberately
 * rendered only on errored rows: an always-visible Replay would imply settled events can
 * be re-run, which must never happen (the handlers book money).
 */
export async function replayGatewayWebhookAction(biz: string, id: string): Promise<ActionResult> {
  await requirePermission("payments:collect", "ops");

  const res = await replayGatewayWebhook(biz, id);
  if (!res.ok) {
    // 409 carries the reason the row is not replayable (settled, or predating the
    // stored normalized event) — surface it verbatim rather than a generic failure.
    return actionError(res.error ?? `We could not replay the webhook (${res.status}).`);
  }
  revalidatePath(`/businesses/${biz}/gateway_webhooks`);
  const outcome = (res.data as { outcome?: string } | undefined)?.outcome;
  // An honest message: a replay that runs and fails AGAIN is a successful replay of a
  // still-broken event, and saying "replayed" alone would read as fixed.
  return actionOk(
    outcome === "error"
      ? "Replayed. The webhook failed again. View the error on the row."
      : `Replayed. Outcome: ${outcome ?? "unknown"}.`,
  );
}
