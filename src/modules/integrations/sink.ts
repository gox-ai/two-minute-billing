import { registerEventSink, type EventRow } from "@/modules/events/emit";
import type { Tx } from "@/platform/db";
import { enqueueIntegrationDeliveries } from "./outbox";
import { syncIntegrations } from "./registry";

/**
 * THE event sink for every integration, run inside the emit transaction (ADR-007). Sync
 * integrations get their hook (each contains its own failures); push integrations get a
 * delivery row per connected, subscribed connection.
 *
 * Registered by import: the API (`src/index.ts`) and the worker (`platform/jobs.ts`) import
 * this module. A script that emits events without importing it queues nothing.
 */
export async function dispatchIntegrations(tx: Tx, event: EventRow): Promise<void> {
  if (!event.businessId) return;
  for (const sync of syncIntegrations()) await sync.onEvent(tx, event);
  await enqueueIntegrationDeliveries(tx, event);
}

registerEventSink(dispatchIntegrations);
