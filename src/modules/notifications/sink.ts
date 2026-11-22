/**
 * THE notification event sink, run inside the emit transaction (ADR-007). A type lookup for
 * every event; one queue insert only for catalogue types. Registered by import: the API
 * (`src/index.ts`) and the worker (`platform/jobs.ts`).
 */
import { registerEventSink, type EventRow } from "@/modules/events/emit";
import type { Tx } from "@/platform/db";
import { candidateKinds } from "./catalogue";
import { enqueueNotification } from "./enqueue";

/** One automatic top-up run emits `…_failed` and then `…_hard_declined` or `…_retries_exhausted`. */
const AUTO_TOPUP_FAILURES = new Set([
  "credit_auto_topup_failed",
  "credit_auto_topup_hard_declined",
  "credit_auto_topup_retries_exhausted",
]);

/** The run's public id from the event's resource object, when it has one. */
export function autoTopupRunId(event: Pick<EventRow, "data" | "resourceType">): string | null {
  const data = event.data as Record<string, unknown> | null;
  const res = (event.resourceType ? data?.[event.resourceType] : undefined) as
    | Record<string, unknown>
    | undefined;
  const run = res?.run ?? data?.run;
  return typeof run === "string" && run ? run : null;
}

/** The dedupe key: the event, or the run for the automatic top-up failures (one notification a run). */
export function sinkDedupeKey(event: Pick<EventRow, "id" | "type" | "data" | "resourceType">) {
  if (AUTO_TOPUP_FAILURES.has(event.type)) {
    const run = autoTopupRunId(event);
    if (run) return `auto_topup:${run}`;
  }
  return `evt:${event.id}`;
}

export async function notificationSink(tx: Tx, event: EventRow): Promise<void> {
  if (!event.businessId || !event.id) return;
  const kinds = candidateKinds({ type: event.type, source: event.source });
  if (kinds.length === 0) return;
  await enqueueNotification(tx, {
    organizationId: event.organizationId,
    businessId: event.businessId,
    kinds,
    eventId: event.id,
    dedupeKey: sinkDedupeKey(event),
  });
}

registerEventSink(notificationSink);
