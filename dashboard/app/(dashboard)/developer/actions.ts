"use server";

import { revalidatePath } from "next/cache";
import { actionOk, actionError } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-result";
import {
  patchWebhookEndpoint,
  redeliverDelivery,
  redeliverLatest,
  testSendWebhook,
  redeliverFailed,
} from "@/lib/api/developer";
import type { RedeliveryAttempt, RedeliveryResponse } from "@/lib/api/developer";
import { requirePermission } from "@/lib/session";

/** Update description and/or event_types subscription for a webhook endpoint. */
export async function redeliverFailedAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("webhooks:manage", "developer");
  const id = String(formData.get("endpoint_id") ?? "").trim();
  if (!id) return actionError("The endpoint ID is missing. Reload the page.");
  const res = await redeliverFailed(id);
  if (!res.ok) return actionError(res.error ?? "We could not requeue the deliveries.");
  const n = (res.data as { requeued?: number } | undefined)?.requeued ?? 0;
  revalidatePath(`/developer/webhooks/${id}`);
  // Say the number, including zero: "requeued" with nothing behind it reads as success on a
  // backlog that is still sitting there.
  return actionOk(
    n === 0
      ? "Nothing to requeue. This endpoint has no failed deliveries."
      : `Requeued ${n} failed ${n === 1 ? "delivery" : "deliveries"}. The clock sends them.`,
  );
}

export async function updateWebhookEndpointAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("webhooks:manage", "developer");

  const id = formData.get("id") as string;
  if (!id) return actionError("The endpoint ID is missing. Reload the page.");

  const description = formData.get("description") as string | null;

  const allEvents = formData.get("all_events") === "true";
  let event_types: string[] | null = null;

  if (!allEvents) {
    // Collect all checked event_type[] entries from the form
    const raw = formData.getAll("event_type") as string[];
    event_types = raw.length > 0 ? raw : [];
  }

  const result = await patchWebhookEndpoint(id, {
    description: description ?? null,
    event_types,
  });

  if (!result.ok) {
    return actionError(result.error ?? "We could not save the endpoint.");
  }

  revalidatePath(`/developer/webhooks/${id}`);
  return actionOk("Endpoint saved.");
}

/** Test send for a webhook endpoint. Returns the result inline via ActionResult message. */
export async function testSendAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult & { response_status?: number; latency_ms?: number; delivered?: boolean }> {
  await requirePermission("webhooks:manage", "developer");

  const id = formData.get("id") as string;
  const type = formData.get("type") as string;
  if (!id || !type)
    return actionError("The endpoint ID or event type is missing. Reload the page.");

  const result = await testSendWebhook(id, type);

  if (!result.ok) {
    return actionError(result.error ?? "We could not send the test webhook.");
  }

  const data = result.data as { response_status: number; latency_ms: number; delivered: boolean };
  return {
    ok: true,
    message: `HTTP ${data.response_status} · ${data.latency_ms}ms · ${data.delivered ? "delivered" : "failed"}`,
    response_status: data.response_status,
    latency_ms: data.latency_ms,
    delivered: data.delivered,
  };
}

/** Redeliver a single delivery. */
/**
 * Resend the endpoint's MOST RECENT delivery — the one-click health check after fixing a
 * receiver. Goes through the real outbox, so unlike the test-send above it exercises the retry
 * path and leaves a delivery record.
 *
 * A brand-new endpoint has no history and the engine answers 409 saying exactly that. On a fresh
 * endpoint that is the NORMAL outcome, not a failure, so the engine's own sentence is surfaced
 * rather than a generic "Redeliver failed" that would send someone hunting a receiver bug.
 */
export async function redeliverLatestAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("webhooks:manage", "developer");

  const endpointId = formData.get("endpoint_id") as string;
  if (!endpointId) return actionError("The endpoint ID is missing. Reload the page.");

  const result = await redeliverLatest(endpointId);

  if (!result.ok) {
    if (result.status === 409)
      return actionError(result.error ?? "Nothing to resend yet", { code: "conflict" });
    return actionError(result.error ?? "We could not resend the delivery.");
  }
  revalidatePath(`/developer/webhooks/${endpointId}`);
  return actionOk("Latest delivery queued for resend. The result shows in the list below.");
}

/**
 * Resend one delivery and hand the caller what actually happened.
 *
 * The engine calls the subscriber inline now, so this returns the real outcome instead of
 * "queued" — and it carries `attempt`, the request/response transcript, which exists ONLY in this
 * response. Nothing stores it, so a caller that drops it cannot get it back; the button renders it
 * straight from here.
 *
 * The message states the mechanism rather than just success, because "Resent" and "Resent, and
 * your receiver answered 200" are different facts and only the second one answers the question
 * the operator pressed the button to ask.
 */
export async function redeliverAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult & { attempt?: RedeliveryAttempt }> {
  await requirePermission("webhooks:manage", "developer");

  const endpointId = formData.get("endpoint_id") as string;
  const deliveryId = formData.get("delivery_id") as string;
  if (!endpointId || !deliveryId)
    return actionError("The endpoint ID or delivery ID is missing. Reload the page.");

  const result = await redeliverDelivery(endpointId, deliveryId);

  if (!result.ok) {
    if (result.status === 409) {
      return actionError(result.error ?? "This delivery is already pending.", { code: "conflict" });
    }
    return actionError(result.error ?? "We could not redeliver the webhook.");
  }

  revalidatePath(`/developer/webhooks/${endpointId}`);
  const body = result.data as RedeliveryResponse | undefined;
  const attempt = body?.attempt;
  if (!attempt) {
    // A 200 with no `attempt` means the engine and this dashboard disagree about the contract.
    // Say so plainly rather than reporting a bare success — the resend DID happen, and claiming
    // more than we can see is how a green message ends up covering a broken receiver.
    return { ...actionOk("Resent. The engine returned no attempt details."), attempt: undefined };
  }
  const what = attempt.response
    ? `receiver answered HTTP ${attempt.response.status} in ${attempt.latency_ms}ms`
    : `no response: ${attempt.error ?? "the request failed"}`;
  return { ...actionOk(`Resent · ${what}`), attempt };
}
