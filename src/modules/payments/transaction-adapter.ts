import { eq } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { resolveAdapter, getProvider } from "@/providers/registry";
import { gatewayAccounts, type transactions } from "@db/schema";

/**
 * The adapter that placed this charge — its gateway account, or the legacy env-configured
 * provider. A leaf module so `pending-debit` and `stale-pending` can both use it without
 * importing each other.
 *
 * A repair script must ask the SAME gateway account the attempt was made through — resolving it
 * a second way is how a one-off tool ends up polling the wrong account.
 */
export async function adapterForTransaction(txn: typeof transactions.$inferSelect) {
  if (txn.gatewayAccountId) {
    const [acc] = await systemDb
      .select()
      .from(gatewayAccounts)
      .where(eq(gatewayAccounts.id, txn.gatewayAccountId))
      .limit(1);
    if (acc) return resolveAdapter(acc);
  }
  // Pre-gateway-accounts rows carry only the key. `getProvider` throws for an
  // unconfigured one, which the caller counts as unsupported.
  return txn.gatewayKey ? getProvider(txn.gatewayKey) : null;
}
