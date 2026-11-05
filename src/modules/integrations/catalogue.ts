import { firstPromoterInfo } from "./providers/firstpromoter-info";
import { hubspotInfo } from "./providers/hubspot-info";
import type { IntegrationInfo } from "./types";

/**
 * Every integration an operator may connect, without its runtime code. Imported by the API
 * reference and the SDK generator, so it must not reach the database layer. `registry.ts`
 * checks at load that the runtime registry names the same set.
 */
const CATALOGUE: readonly IntegrationInfo[] = Object.freeze([hubspotInfo, firstPromoterInfo]);

export function listIntegrations(): IntegrationInfo[] {
  return [...CATALOGUE];
}

export function integrationInfo(key: string): IntegrationInfo | null {
  return CATALOGUE.find((i) => i.key === key) ?? null;
}
