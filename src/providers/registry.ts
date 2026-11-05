import type { PaymentProvider } from "./types";
import { decryptCredentials } from "@/platform/secrets";
import type { gatewayAccounts } from "@db/schema";
import { runWithGatewayLogContext, type GatewayLogContext } from "./log-context";
import { config } from "@/platform/config";
import { GATEWAYS, gatewayDefinition } from "./gateway-catalog";
import { gatewayNotificationUrl } from "./notification-url";
import { GATEWAY_FACTORIES, GatewayResolveError, type GatewayCredentials } from "./gateways";

export { GatewayResolveError };

const envAdapters = new Map<string, PaymentProvider | undefined>();

/**
 * Resolve a payment provider adapter by key. The engine only ever talks to
 * providers through this — never imports an SDK directly.
 *
 * There is no fallback: an unconfigured/unknown key throws loudly rather than
 * silently faking success (the mock test-double was removed — use the TM Test
 * Gateway ('tmtest', via a gateway_accounts row + resolveAdapter) for testing).
 */
export function getProvider(key?: string): PaymentProvider {
  const def = gatewayDefinition(key);
  const fromEnv = def && GATEWAY_FACTORIES[def.key].fromEnv;
  if (!def || !fromEnv)
    throw new Error(
      `No payment provider configured for key '${key ?? ""}' . We cannot charge or refund the payment`,
    );
  if (!envAdapters.has(def.key)) envAdapters.set(def.key, fromEnv());
  const adapter = envAdapters.get(def.key);
  if (!adapter) throw new Error(`${def.displayName} is not configured in this environment`);
  return adapter;
}

type GatewayAccountRow = typeof gatewayAccounts.$inferSelect;

/**
 * Adapters built from `gateway_accounts` rows are LRU-cached by `(id, resource_version)`,
 * so an update to the row (which bumps `resource_version`) invalidates the old one.
 */
const ADAPTER_CACHE_MAX = 64;
const adapterCache = new Map<string, PaymentProvider>();

function cacheGet(key: string): PaymentProvider | undefined {
  const hit = adapterCache.get(key);
  if (hit) {
    // Refresh LRU recency.
    adapterCache.delete(key);
    adapterCache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, adapter: PaymentProvider): void {
  adapterCache.set(key, adapter);
  while (adapterCache.size > ADAPTER_CACHE_MAX) {
    const oldest = adapterCache.keys().next().value;
    if (oldest === undefined) break;
    adapterCache.delete(oldest);
  }
}

function buildAdapter(row: GatewayAccountRow): PaymentProvider {
  const def = gatewayDefinition(row.gatewayKey);
  if (!def) throw new GatewayResolveError(`Unknown gateway_key: ${row.gatewayKey}`);
  const creds = decryptCredentials(row.credentialsEnc) as GatewayCredentials;
  return GATEWAY_FACTORIES[def.key].build(creds, {
    businessId: row.businessId,
    livemode: row.livemode,
    ...(config.WEBHOOK_BASE_URL
      ? { notificationUrl: gatewayNotificationUrl(row.gatewayKey, row.publicId) }
      : {}),
  });
}

/**
 * Wrap every method of a PaymentProvider adapter so each call runs inside
 * `runWithGatewayLogContext(ctx, …)` (LOG-1 stage 2) — this is how
 * `providerFetch` (src/providers/http.ts) learns which business/gateway
 * account an outbound HTTP call belongs to, without adapters threading ids
 * through every call site.
 */
export function withGatewayLogging<T extends PaymentProvider>(
  adapter: T,
  ctx: GatewayLogContext,
): T {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return function (this: unknown, ...args: unknown[]) {
        return runWithGatewayLogContext(ctx, () =>
          (value as (...a: unknown[]) => unknown).apply(target, args),
        );
      };
    },
  }) as T;
}

/**
 * What each gateway can be ASKED for, keyed by gateway — without building an adapter.
 *
 * `capabilities.methods` is an instance field, so reading it means constructing a provider,
 * which decrypts credentials. A listing endpoint that only wants "which rails may I offer?"
 * must not do that: it is expensive, and a rotated `GATEWAY_CREDENTIALS_KEY` would turn a
 * gateway list into a 500. Declared on each gateway definition and PINNED by
 * `test/unit/advertised-methods.test.ts`, which asserts this table equals every adapter's
 * own `capabilities.methods` — the same trick the mandate ceilings use, because
 * `providers/` may not import `modules/` and a silent divergence is the real risk.
 */
export const ADVERTISED_METHODS: Record<string, readonly string[]> = Object.fromEntries(
  Object.values(GATEWAYS).map((g) => [g.key, g.advertisedMethods]),
);

/**
 * An uncached adapter for this row that verifies webhooks with `webhookSecret` instead of the
 * stored one. Only for checking a delivery against a fallback secret.
 */
export function resolveAdapterWithWebhookSecret(
  row: GatewayAccountRow,
  webhookSecret: string,
): PaymentProvider {
  const def = gatewayDefinition(row.gatewayKey);
  if (!def) throw new GatewayResolveError(`Unknown gateway_key: ${row.gatewayKey}`);
  const creds = decryptCredentials(row.credentialsEnc) as GatewayCredentials;
  const adapter = GATEWAY_FACTORIES[def.key].build(
    { ...creds, webhook_secret: webhookSecret },
    {
      businessId: row.businessId,
      livemode: row.livemode,
      ...(config.WEBHOOK_BASE_URL
        ? { notificationUrl: gatewayNotificationUrl(row.gatewayKey, row.publicId) }
        : {}),
    },
  );
  return withGatewayLogging(adapter, { businessId: row.businessId, gatewayAccountId: row.id });
}

/** Resolve (build + cache) the adapter for a gateway account row. */
export function resolveAdapter(row: GatewayAccountRow): PaymentProvider {
  const key = `${row.id}:${row.resourceVersion}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const adapter = withGatewayLogging(buildAdapter(row), {
    businessId: row.businessId,
    gatewayAccountId: row.id,
  });
  cacheSet(key, adapter);
  return adapter;
}
