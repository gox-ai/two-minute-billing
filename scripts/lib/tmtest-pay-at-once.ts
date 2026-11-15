import { listGatewayAccounts, updateGatewayAccount } from "@/modules/gateway/service";

/**
 * Make a business's TM Test accounts authorize a Pay with no instrument at once
 * (`buyer_auth_mode=none`), for suites that test something past the Approve/Decline
 * dialog. `verify:gateway-sdk-modes` covers the dialog itself.
 */
export async function tmtestPayAtOnce(organizationId: string, businessId: string): Promise<void> {
  for (const acct of await listGatewayAccounts(organizationId, businessId)) {
    if (acct.gatewayKey !== "tmtest") continue;
    await updateGatewayAccount({
      organizationId,
      businessId,
      gwaPublicId: acct.publicId,
      credentials: { buyer_auth_mode: "none" },
    });
  }
}
