/**
 * Test mode sends email only to the organization's own team members, so a test business
 * can never mail a real customer. Applies to customer-facing recipients (To and contact
 * copies); the business's own configured copies are its own addresses and still go out.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { memberships, users } from "@db/schema";

export const TEST_MODE_SKIP_REASON =
  "Test mode: we send email only to the addresses of team members.";

/** Is `address` the email of a member of the organization? Case-insensitive. */
export async function isTeamAddress(organizationId: string, address: string): Promise<boolean> {
  const [row] = await systemDb
    .select({ id: users.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        isNotNull(memberships.acceptedAt),
        sql`lower(${users.email}) = lower(${address.trim()})`,
      ),
    )
    .limit(1);
  return !!row;
}

/** May a business in this mode send to `address`? Live businesses always may. */
export async function testModeAllows(
  biz: { organizationId: string; livemode: string } | null | undefined,
  address: string,
): Promise<boolean> {
  if (!biz || biz.livemode !== "test") return true;
  return isTeamAddress(biz.organizationId, address);
}
