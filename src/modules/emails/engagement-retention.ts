import { and, lt } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { emailEngagements, emailLinks } from "@db/schema";
import { notPlatformOrg } from "@/modules/tenancy/platform-org";

/** Opens, clicks and stored link targets older than 13 months go: a year plus one month. */
export const EMAIL_ENGAGEMENT_RETENTION_MS = 396 * 24 * 60 * 60 * 1000;

/** Runs in the `sweep_buyer_rejections` clock pass. Never touches a platform organization. */
export async function sweepEmailEngagement(now: Date): Promise<{ deleted: number }> {
  const before = new Date(now.getTime() - EMAIL_ENGAGEMENT_RETENTION_MS);
  const events = await systemDb
    .delete(emailEngagements)
    .where(
      and(lt(emailEngagements.createdAt, before), notPlatformOrg(emailEngagements.organizationId)),
    )
    .returning({ id: emailEngagements.id });
  const links = await systemDb
    .delete(emailLinks)
    .where(and(lt(emailLinks.createdAt, before), notPlatformOrg(emailLinks.organizationId)))
    .returning({ id: emailLinks.position });
  return { deleted: events.length + links.length };
}
