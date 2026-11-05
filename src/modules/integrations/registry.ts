import { firstPromoter } from "./providers/firstpromoter";
import { hubspotIntegration } from "@/modules/hubspot/integration";
import { listIntegrations } from "./catalogue";
import type { PushIntegration, SyncIntegration } from "./types";

/** Push integrations by key — what `integration_connections.provider` stores. */
const PUSH: Readonly<Record<string, PushIntegration>> = Object.freeze({
  [firstPromoter.key]: firstPromoter,
});

/** Sync integrations: each runs its own engine over its own tables. */
const SYNC: readonly SyncIntegration[] = Object.freeze([hubspotIntegration]);

// Missing from the catalogue, an integration runs but is never offered; missing here, it is
// offered and does nothing. Fail at load rather than ship either.
{
  const listed = listIntegrations()
    .map((i) => `${i.kind}:${i.key}`)
    .sort()
    .join(",");
  const runtime = [
    ...Object.keys(PUSH).map((k) => `push:${k}`),
    ...SYNC.map((s) => `sync:${s.info.key}`),
  ]
    .sort()
    .join(",");
  if (listed !== runtime) {
    throw new Error(`integrations: catalogue [${listed}] != runtime [${runtime}]`);
  }
}

export function pushIntegration(key: string | null | undefined): PushIntegration | null {
  if (!key) return null;
  return PUSH[key] ?? null;
}

export function syncIntegrations(): readonly SyncIntegration[] {
  return SYNC;
}

export function syncIntegration(key: string): SyncIntegration | null {
  return SYNC.find((s) => s.info.key === key) ?? null;
}
