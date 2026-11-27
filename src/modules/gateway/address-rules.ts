import { and, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { businesses, gatewayAccounts } from "@db/schema";
import { resolveAdapter } from "@/providers/registry";
import type { GatewayAddressRules } from "@/modules/checkout/address-field-rules";
import { resolveStorefrontConfig } from "@/modules/checkout/storefront-config";

const log = createLogger("gateway");

/**
 * The address rules this business's payment gateways add to its buyer forms. Any active
 * account counts: the checkout routes by currency only at payment time, and a foreign card
 * can reach an India Stripe account in any currency.
 *
 * Fails open: an account whose answer we cannot read adds no rule, so a slow gateway never
 * blocks a buyer's details step. The gateway then refuses as it did before.
 */
export async function gatewayAddressRules(
  organizationId: string,
  businessId: string,
): Promise<GatewayAddressRules> {
  return (await gatewayAddressRulesByBusiness(organizationId, [businessId])).get(businessId) ?? {};
}

/** `gatewayAddressRules` for several businesses, with one read of their accounts. */
export async function gatewayAddressRulesByBusiness(
  organizationId: string,
  businessIds: readonly string[],
): Promise<Map<string, GatewayAddressRules>> {
  const out = new Map<string, GatewayAddressRules>();
  const fills = new Set<string>();
  if (businessIds.length === 0) return out;
  const accounts = await withTenant(organizationId, async (tx) => {
    const bizRows = await tx
      .select({
        id: businesses.id,
        livemode: businesses.livemode,
        storefrontConfig: businesses.storefrontConfig,
      })
      .from(businesses)
      .where(inArray(businesses.id, [...businessIds]));
    const live = new Map(bizRows.map((b) => [b.id, b.livemode === "live"]));
    for (const b of bizRows) if (resolveStorefrontConfig(b).fillExportStreet) fills.add(b.id);
    const rows = await tx
      .select()
      .from(gatewayAccounts)
      .where(
        and(
          inArray(gatewayAccounts.businessId, [...businessIds]),
          eq(gatewayAccounts.status, "active"),
        ),
      );
    return rows.filter((a) => !live.has(a.businessId) || a.livemode === live.get(a.businessId));
  });
  for (const acc of accounts) {
    if (out.get(acc.businessId)?.streetRequiredOutside) continue;
    try {
      const home = await resolveAdapter(acc).streetAddressRequiredOutside?.();
      if (home)
        out.set(acc.businessId, {
          streetRequiredOutside: home,
          ...(fills.has(acc.businessId) ? { streetFill: true } : {}),
        });
    } catch (e) {
      log.warn("could not read a gateway's address rule; adding none", {
        gateway_account: acc.publicId,
        error: String(e),
      });
    }
  }
  return out;
}

/**
 * The home country to fill line 1 against for this business and gateway, else null: the gateway
 * needs a street from buyers outside it and the business turned on `fill_export_street`.
 */
export async function exportStreetFillHome(
  organizationId: string,
  businessId: string,
  provider: { streetAddressRequiredOutside?: () => Promise<string | null> },
): Promise<string | null> {
  if (!provider.streetAddressRequiredOutside) return null;
  const [biz] = await withTenant(organizationId, (tx) =>
    tx
      .select({ storefrontConfig: businesses.storefrontConfig })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1),
  );
  if (!biz || !resolveStorefrontConfig(biz).fillExportStreet) return null;
  try {
    return await provider.streetAddressRequiredOutside();
  } catch {
    return null;
  }
}
