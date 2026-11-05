import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Gateway-activity-log provenance ("Gateway Activity", LOG-1 stage 2). Threaded
 * via AsyncLocalStorage — modeled on
 * `src/platform/event-context.ts` — so `providerFetch` (src/providers/http.ts)
 * can stamp `business_id`/`gateway_account_id` on every outbound gateway
 * request log row without every adapter method having to forward them.
 *
 * Adapters run OUTSIDE tenant transactions (they're resolved from a plain
 * `gateway_accounts` row, not a `withTenant` callback), so this context — not
 * the request/event context's org scope — is what ties a gateway HTTP call
 * back to a business.
 */
export interface GatewayLogContext {
  businessId: string | null;
  gatewayAccountId: string | null;
}

const storage = new AsyncLocalStorage<GatewayLogContext>();

/** Run `fn` with the given gateway-log context bound for its entire async subtree. */
export function runWithGatewayLogContext<T>(ctx: GatewayLogContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The active gateway-log context, or undefined outside any wrapped adapter call. */
export function currentGatewayLogContext(): GatewayLogContext | undefined {
  return storage.getStore();
}
