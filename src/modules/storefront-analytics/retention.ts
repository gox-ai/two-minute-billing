import { notPlatformOrg } from "@/modules/tenancy/platform-org";
import { lt, and } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { storefrontVisits } from "@db/schema";

/** Visits older than 13 months are deleted: a year plus one month for year-on-year reports. */
export const STOREFRONT_VISIT_RETENTION_MS = 396 * 24 * 60 * 60 * 1000;

/** Retention across all organizations. Runs in the `sweep_buyer_rejections` clock pass. */
export async function sweepStorefrontVisits(now: Date): Promise<{ deleted: number }> {
  const deleted = await systemDb
    .delete(storefrontVisits)
    .where(
      and(
        lt(storefrontVisits.createdAt, new Date(now.getTime() - STOREFRONT_VISIT_RETENTION_MS)),
        notPlatformOrg(storefrontVisits.organizationId),
      ),
    )
    .returning({ id: storefrontVisits.id });
  return { deleted: deleted.length };
}
